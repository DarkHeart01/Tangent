"""Reads Claude Code's local session transcripts.

Claude Code stores one JSONL file per session under
``~/.claude/projects/<encoded-project-dir>/<session-id>.jsonl``. The directory
name encoding (``/`` and ``:`` replaced with ``-``) is lossy to reverse, so we
never try to decode it -- each record already carries the real ``cwd`` the
session ran in, and we read that instead.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from mcp_server.ingest import ContextRecord
from observability.logutil import get_logger

log = get_logger("mcp_server.claude_code")

SESSIONS_DIR = Path.home() / ".claude" / "projects"

# Tool call inputs are summarized, not dumped in full, to keep memory entries small.
MAX_TOOL_INPUT_CHARS = 300


def _project_dirs() -> list[Path]:
    if not SESSIONS_DIR.exists():
        return []
    return [p for p in SESSIONS_DIR.iterdir() if p.is_dir()]


def _peek_cwd(jsonl_path: Path) -> Optional[str]:
    """Read just enough lines to find the real project path a session ran in."""
    try:
        with jsonl_path.open("r", encoding="utf-8") as f:
            for _ in range(20):
                line = f.readline()
                if not line:
                    break
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                cwd = record.get("cwd")
                if cwd:
                    return cwd
    except OSError as exc:
        log.warning("claude_code_peek_failed", path=str(jsonl_path), error=str(exc))
    return None


def discover_sessions() -> list[dict[str, Any]]:
    """List locally available Claude Code sessions without loading their full content."""
    sessions: list[dict[str, Any]] = []
    for project_dir in _project_dirs():
        for jsonl_path in project_dir.glob("*.jsonl"):
            try:
                stat = jsonl_path.stat()
            except OSError:
                continue
            sessions.append({
                "source": "claude_code",
                "session_id": jsonl_path.stem,
                "project_dir": project_dir.name,
                "project_path": _peek_cwd(jsonl_path) or "(unknown)",
                "updated_at": stat.st_mtime,
                "size_bytes": stat.st_size,
            })
    sessions.sort(key=lambda s: s["updated_at"], reverse=True)
    return sessions


def _find_session_file(session_id: str, project_dir: Optional[str] = None) -> Optional[Path]:
    if project_dir:
        candidate = SESSIONS_DIR / project_dir / f"{session_id}.jsonl"
        return candidate if candidate.exists() else None

    for pdir in _project_dirs():
        candidate = pdir / f"{session_id}.jsonl"
        if candidate.exists():
            return candidate
    return None


def _block_text(block: dict[str, Any]) -> str:
    block_type = block.get("type")
    if block_type == "text":
        return str(block.get("text", ""))
    if block_type == "tool_use":
        name = block.get("name", "?")
        raw_input = json.dumps(block.get("input", {}))
        if len(raw_input) > MAX_TOOL_INPUT_CHARS:
            raw_input = raw_input[:MAX_TOOL_INPUT_CHARS] + "…"
        return f"[tool_call: {name}({raw_input})]"
    if block_type == "tool_result":
        content = block.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(
                str(c.get("text", "")) for c in content if isinstance(c, dict)
            )
        return ""
    return ""


def load_session(session_id: str, project_dir: Optional[str] = None) -> list[ContextRecord]:
    """Parse a session transcript into ordered (role, text) context records."""
    path = _find_session_file(session_id, project_dir)
    if path is None:
        raise FileNotFoundError(f"No Claude Code session found for id '{session_id}'")

    project_path = _peek_cwd(path) or "(unknown)"
    records: list[ContextRecord] = []

    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            if entry.get("type") not in ("user", "assistant"):
                continue

            message = entry.get("message") or {}
            content = message.get("content")
            role = message.get("role", entry.get("type", "unknown"))

            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = "\n".join(
                    t for t in (_block_text(b) for b in content if isinstance(b, dict)) if t
                )
            else:
                continue

            if not text.strip():
                continue

            records.append(ContextRecord(
                role=role,
                text=text,
                source="claude_code",
                session_id=session_id,
                project_path=project_path,
                timestamp=entry.get("timestamp"),
                extra={"git_branch": entry.get("gitBranch")},
            ))

    return records
