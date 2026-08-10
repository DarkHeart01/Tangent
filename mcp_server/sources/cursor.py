"""Reads Cursor's local chat/composer history out of its SQLite state stores.

Cursor's on-disk schema is internal and undocumented, and has changed shape
across versions (bubble-based conversations, composer records with inline
history, etc.). Every read here is best-effort: a row that doesn't parse the
way we expect is skipped rather than allowed to fail the whole import, and we
always fall back to the simpler, more stable ``aiService.prompts`` list so an
import still yields *something* even if the richer composer/bubble format has
drifted on the caller's Cursor version.
"""

from __future__ import annotations

import json
import platform
import sqlite3
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote, urlparse

from mcp_server.ingest import ContextRecord
from observability.logutil import get_logger

log = get_logger("mcp_server.cursor")


def _user_dir() -> Optional[Path]:
    system = platform.system()
    if system == "Windows":
        import os
        appdata = os.environ.get("APPDATA")
        return Path(appdata) / "Cursor" / "User" if appdata else None
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "Cursor" / "User"
    return Path.home() / ".config" / "Cursor" / "User"


def _folder_from_uri(uri: str) -> str:
    parsed = urlparse(uri)
    path = unquote(parsed.path)
    # file:///c%3A/Users/... -> /c:/Users/... on Windows; strip the leading slash.
    if len(path) > 2 and path[0] == "/" and path[2] == ":":
        path = path[1:]
    return path


def _read_item_table(db_path: Path, key: str) -> Optional[Any]:
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            cur = con.cursor()
            cur.execute("SELECT value FROM ItemTable WHERE key = ?", (key,))
            row = cur.fetchone()
            if not row:
                return None
            return json.loads(row[0])
        finally:
            con.close()
    except (sqlite3.Error, json.JSONDecodeError, OSError) as exc:
        log.warning("cursor_read_item_failed", db=str(db_path), key=key, error=str(exc))
        return None


def _read_disk_kv(db_path: Path, key: str) -> Optional[Any]:
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            cur = con.cursor()
            cur.execute("SELECT value FROM cursorDiskKV WHERE key = ?", (key,))
            row = cur.fetchone()
            if not row:
                return None
            value = row[0]
            if isinstance(value, (bytes, bytearray)):
                value = value.decode("utf-8", errors="replace")
            return json.loads(value)
        finally:
            con.close()
    except (sqlite3.Error, json.JSONDecodeError, OSError) as exc:
        log.warning("cursor_read_kv_failed", db=str(db_path), key=key, error=str(exc))
        return None


def discover_sessions() -> list[dict[str, Any]]:
    """List local Cursor workspaces that have chat/composer history."""
    user_dir = _user_dir()
    if user_dir is None or not user_dir.exists():
        return []

    workspace_root = user_dir / "workspaceStorage"
    if not workspace_root.exists():
        return []

    sessions: list[dict[str, Any]] = []
    for ws_dir in workspace_root.iterdir():
        if not ws_dir.is_dir():
            continue
        workspace_json = ws_dir / "workspace.json"
        db_path = ws_dir / "state.vscdb"
        if not workspace_json.exists() or not db_path.exists():
            continue

        try:
            meta = json.loads(workspace_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        folder_uri = meta.get("folder")
        if not folder_uri:
            continue

        prompts = _read_item_table(db_path, "aiService.prompts") or []
        composer_meta = _read_item_table(db_path, "composer.composerData") or {}
        composer_ids = composer_meta.get("allComposers") or composer_meta.get("selectedComposerIds") or []

        if not prompts and not composer_ids:
            continue

        try:
            stat = db_path.stat()
        except OSError:
            continue

        sessions.append({
            "source": "cursor",
            "workspace_hash": ws_dir.name,
            "project_path": _folder_from_uri(folder_uri),
            "prompt_count": len(prompts) if isinstance(prompts, list) else 0,
            "composer_count": len(composer_ids) if isinstance(composer_ids, list) else 0,
            "updated_at": stat.st_mtime,
        })

    sessions.sort(key=lambda s: s["updated_at"], reverse=True)
    return sessions


def _bubble_text(bubble: dict[str, Any]) -> str:
    for field in ("text", "content"):
        value = bubble.get(field)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _bubble_role(bubble: dict[str, Any]) -> str:
    raw = bubble.get("type")
    if raw in (1, "user"):
        return "user"
    if raw in (2, "ai", "assistant"):
        return "assistant"
    return str(raw or "unknown")


def _load_composer_records(
    global_db: Path, composer_id: str, project_path: str, workspace_hash: str
) -> list[ContextRecord]:
    records: list[ContextRecord] = []
    composer = _read_disk_kv(global_db, f"composerData:{composer_id}")
    if not isinstance(composer, dict):
        return records

    # Some versions inline the full conversation; others only store bubble
    # references and require a second lookup per message.
    inline = composer.get("conversation")
    if isinstance(inline, list) and inline:
        bubbles = [b for b in inline if isinstance(b, dict)]
    else:
        headers = composer.get("fullConversationHeadersOnly") or []
        bubbles = []
        for header in headers:
            bubble_id = header.get("bubbleId") if isinstance(header, dict) else header
            if not bubble_id:
                continue
            bubble = _read_disk_kv(global_db, f"bubbleId:{composer_id}:{bubble_id}")
            if isinstance(bubble, dict):
                bubbles.append(bubble)

    for bubble in bubbles:
        try:
            text = _bubble_text(bubble)
            if not text.strip():
                continue
            records.append(ContextRecord(
                role=_bubble_role(bubble),
                text=text,
                source="cursor",
                session_id=workspace_hash,
                project_path=project_path,
                extra={"composer_id": composer_id},
            ))
        except Exception as exc:  # noqa: BLE001 - one bad bubble must not kill the import
            log.warning("cursor_bubble_parse_failed", composer_id=composer_id, error=str(exc))
            continue

    return records


def load_session(workspace_hash: str) -> list[ContextRecord]:
    user_dir = _user_dir()
    if user_dir is None:
        raise FileNotFoundError("Cursor's user data directory could not be located on this platform")

    ws_dir = user_dir / "workspaceStorage" / workspace_hash
    db_path = ws_dir / "state.vscdb"
    workspace_json = ws_dir / "workspace.json"
    if not db_path.exists() or not workspace_json.exists():
        raise FileNotFoundError(f"No Cursor workspace found for hash '{workspace_hash}'")

    meta = json.loads(workspace_json.read_text(encoding="utf-8"))
    project_path = _folder_from_uri(meta.get("folder", ""))

    records: list[ContextRecord] = []

    prompts = _read_item_table(db_path, "aiService.prompts") or []
    if isinstance(prompts, list):
        for prompt in prompts:
            if not isinstance(prompt, dict):
                continue
            text = prompt.get("text", "")
            if text.strip():
                records.append(ContextRecord(
                    role="user",
                    text=text,
                    source="cursor",
                    session_id=workspace_hash,
                    project_path=project_path,
                ))

    global_db = user_dir / "globalStorage" / "state.vscdb"
    if global_db.exists():
        composer_meta = _read_item_table(db_path, "composer.composerData") or {}
        composer_ids = composer_meta.get("allComposers") or composer_meta.get("selectedComposerIds") or []
        for composer_id in composer_ids:
            if isinstance(composer_id, dict):
                composer_id = composer_id.get("composerId")
            if not composer_id:
                continue
            records.extend(_load_composer_records(global_db, composer_id, project_path, workspace_hash))

    return records
