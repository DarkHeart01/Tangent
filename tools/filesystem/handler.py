"""Filesystem operations — jailed to the working directory."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from core.daemon_client import DAEMON_TOKEN as _DAEMON_TOKEN
from core.daemon_client import DAEMON_URL as _DAEMON_URL
from core.daemon_client import SESSION_ID as _SESSION_ID
from core.exceptions import SafetyError
from observability.logutil import get_logger
from tools.base import ToolHandler

log = get_logger("tools.filesystem")

_CWD = Path.cwd()
_BUILT = _CWD / "built"

# Paths that are always read-only project internals — never rerouted to built/
_INTERNAL_PREFIXES = ("traces", "memory_store", "configs", "agents", "tools",
                      "coordination", "core", "providers", "observability",
                      "memory", "api", "cli", "tests", "built")

# Optional hooks a host app (e.g. devforge-frontend's backend) can wire up to
# mirror generated files into its own durable store (Mongo) as they're
# written/deleted, so it never has to depend on this process's local disk
# state. Best-effort: failures here never break the underlying file op, which
# has already succeeded on disk by the time these are called.
_on_write: Optional[Callable[[str, str], Awaitable[None]]] = None
_on_delete: Optional[Callable[[str], Awaitable[None]]] = None


def set_artifact_sink(
    on_write: Optional[Callable[[str, str], Awaitable[None]]] = None,
    on_delete: Optional[Callable[[str], Awaitable[None]]] = None,
) -> None:
    global _on_write, _on_delete
    _on_write = on_write
    _on_delete = on_delete


def _rel_to_built(path: Path) -> Optional[str]:
    try:
        return str(path.relative_to(_BUILT)).replace("\\", "/")
    except ValueError:
        return None  # not under built/ — not a displayed artifact, don't mirror


async def _mirror_write(path: Path) -> None:
    if _on_write is None:
        return
    rel = _rel_to_built(path)
    if rel is None:
        return
    try:
        await _on_write(rel, path.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:
        log.warning("artifact_sink_write_failed", path=rel, error=str(exc))


async def _mirror_delete(paths: list[Path]) -> None:
    if _on_delete is None:
        return
    for p in paths:
        rel = _rel_to_built(p)
        if rel is None:
            continue
        try:
            await _on_delete(rel)
        except Exception as exc:
            log.warning("artifact_sink_delete_failed", path=rel, error=str(exc))


def _safe_path(rel: str) -> Path:
    p = (_CWD / rel).resolve()
    if not str(p).startswith(str(_CWD)):
        raise SafetyError(f"Path escape attempt: {rel!r} resolves outside working directory")
    return p


def _build_path(rel: str) -> Path:
    """For write/append operations: redirect bare paths into built/ unless
    they already target an internal swarm directory or built/ itself."""
    parts = Path(rel).parts
    first = parts[0] if parts else ""
    if first in _INTERNAL_PREFIXES or rel.startswith("/"):
        return _safe_path(rel)
    # Already inside built/
    if first == "built":
        return _safe_path(rel)
    # Redirect to built/
    redirected = str(Path("built") / rel)
    return _safe_path(redirected)


class FilesystemHandler(ToolHandler):
    async def _run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        op = inputs["operation"]
        raw_path = inputs["path"]

        # Write operations go into built/; reads/lists/searches use the path as-is
        if op in ("write", "append", "replace", "delete"):
            path = _build_path(raw_path)
        else:
            path = _safe_path(raw_path)

        if op == "read":
            if _DAEMON_URL:
                return await self._read_via_daemon(path)
            if not path.exists():
                return {"error": f"File not found: {path}"}
            return {"content": path.read_text(encoding="utf-8", errors="replace"),
                    "path": str(path.relative_to(_CWD))}

        elif op == "write":
            if _DAEMON_URL:
                return await self._write_via_daemon(path, inputs.get("content", ""))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(inputs.get("content", ""), encoding="utf-8")
            await _mirror_write(path)
            return {"written": str(path.relative_to(_CWD)), "bytes": path.stat().st_size}

        elif op == "replace":
            old_string = inputs.get("old_string")
            if old_string:
                # Precise unique-match edit: never blind-overwrites the rest of the file.
                if not path.exists():
                    return {"error": f"File not found: {path}"}
                new_string = inputs.get("new_string", "")
                current = path.read_text(encoding="utf-8", errors="replace")
                count = current.count(old_string)
                if count == 0:
                    return {"error": "old_string not found in file"}
                if count > 1 and not inputs.get("replace_all"):
                    return {"error": f"old_string is not unique ({count} matches) — "
                                      "add more surrounding context, or set replace_all"}
                updated = (current.replace(old_string, new_string) if inputs.get("replace_all")
                           else current.replace(old_string, new_string, 1))
                path.write_text(updated, encoding="utf-8")
                await _mirror_write(path)
                return {"replaced": str(path.relative_to(_CWD)), "bytes": path.stat().st_size,
                        "occurrences": count if inputs.get("replace_all") else 1}

            # Legacy full-file overwrite — only when old_string isn't given.
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(inputs.get("content", ""), encoding="utf-8")
            await _mirror_write(path)
            return {"replaced": str(path.relative_to(_CWD)), "bytes": path.stat().st_size}

        elif op == "append":
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write(inputs.get("content", ""))
            await _mirror_write(path)
            return {"appended": str(path.relative_to(_CWD))}

        elif op == "list":
            if not path.exists():
                return {"entries": [], "error": "Path not found"}
            recursive = inputs.get("recursive", False)
            entries = (
                [str(p.relative_to(_CWD)) for p in sorted(path.rglob("*"))]
                if recursive
                else [str(p.relative_to(_CWD)) for p in sorted(path.iterdir())]
            )
            return {"entries": entries[: inputs.get("max_results", 20)]}

        elif op == "search":
            query = inputs.get("query", "").lower()
            recursive = inputs.get("recursive", False)
            base = path if path.is_dir() else path.parent
            pattern = "**/*" if recursive else "*"
            matches = []
            for fp in sorted(base.glob(pattern)):
                if not fp.is_file():
                    continue
                try:
                    text = fp.read_text(encoding="utf-8", errors="replace")
                    if query in text.lower() or query in fp.name.lower():
                        matches.append(str(fp.relative_to(_CWD)))
                except OSError:
                    pass
                if len(matches) >= inputs.get("max_results", 20):
                    break
            return {"matches": matches}

        elif op == "delete":
            if path.exists():
                if path.is_dir():
                    import shutil
                    removed_files = [p for p in path.rglob("*") if p.is_file()]
                    shutil.rmtree(path)
                    await _mirror_delete(removed_files)
                else:
                    path.unlink()
                    await _mirror_delete([path])
                return {"deleted": str(path.relative_to(_CWD))}
            return {"error": "Path not found"}

        elif op == "exists":
            return {"exists": path.exists(), "is_file": path.is_file(), "is_dir": path.is_dir()}

        return {"error": f"Unknown operation: {op}"}

    async def _read_via_daemon(self, path: Path) -> dict[str, Any]:
        """Reads via the Go daemon's execapi instead of directly off disk.
        Functionally equivalent either way — this process already has
        direct host access to the same bind-mounted worktree the daemon
        operates on — done for Dashboard tool-call visibility. path is
        already resolved+jailed by _safe_path above; the daemon applies its
        own independent path-jail check on top (defense in depth, not a
        replacement for the check already done here).
        """
        import httpx

        rel = str(path.relative_to(_CWD)).replace("\\", "/")
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{_DAEMON_URL}/sessions/{_SESSION_ID}/fs",
                    params={"path": rel},
                    headers={"Authorization": f"Bearer {_DAEMON_TOKEN}"},
                    timeout=15,
                )
            if resp.status_code == 404:
                return {"error": f"File not found: {path}"}
            resp.raise_for_status()
            return {"content": resp.content.decode("utf-8", errors="replace"), "path": rel}
        except httpx.HTTPError as exc:
            return {"error": f"daemon read failed: {exc}"}

    async def _write_via_daemon(self, path: Path, content: str) -> dict[str, Any]:
        import httpx

        rel = str(path.relative_to(_CWD)).replace("\\", "/")
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.put(
                    f"{_DAEMON_URL}/sessions/{_SESSION_ID}/fs",
                    params={"path": rel},
                    content=content.encode("utf-8"),
                    headers={"Authorization": f"Bearer {_DAEMON_TOKEN}"},
                    timeout=15,
                )
            resp.raise_for_status()
            data = resp.json()
            await _mirror_write(path)  # same artifact-sink hook the local write path calls
            return {"written": rel, "bytes": data.get("bytes_written", len(content))}
        except httpx.HTTPError as exc:
            return {"error": f"daemon write failed: {exc}"}

    async def self_test(self) -> bool:
        import tempfile, os
        with tempfile.NamedTemporaryFile(dir=_CWD, suffix=".txt", delete=False) as f:
            fname = Path(f.name).name
        try:
            await self._run({"operation": "write", "path": fname, "content": "hello"})
            r = await self._run({"operation": "read", "path": fname})
            return r.get("content") == "hello"
        finally:
            (_CWD / fname).unlink(missing_ok=True)


handler = FilesystemHandler()
