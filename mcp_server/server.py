"""Tangent context-import MCP server.

Exposes tools over stdio (register it in Claude Code's or Cursor's own MCP
config -- see docs/mcp-context-import.md) that pull local session/chat history
out of those tools and write it into the same long-term memory store the
swarm reads from (``memory.longterm.LocalChromaMemory``, at ``SWARM_MEMORY_DIR``).
Once imported, any swarm agent can find it again via the existing
``memory_retrieve`` tool -- this server only owns the import path.
"""

from __future__ import annotations

import os
from typing import Any

from mcp.server.mcpserver import MCPServer

from memory.longterm import LocalChromaMemory
from mcp_server.ingest import ingest_records
from mcp_server.sources import claude_code, cursor
from observability.logutil import get_logger

log = get_logger("mcp_server.server")

mcp = MCPServer("tangent-context")

_memory: LocalChromaMemory | None = None


def _get_memory() -> LocalChromaMemory:
    global _memory
    if _memory is None:
        persist_dir = os.environ.get("SWARM_MEMORY_DIR", "./memory_store")
        _memory = LocalChromaMemory(persist_dir=persist_dir)
    return _memory


@mcp.tool()
def list_context_sources() -> dict[str, Any]:
    """List locally available Claude Code sessions and Cursor workspaces that can be imported.

    Call this first -- it returns the session_id / workspace_hash values the
    import tools need, along with each session's project path and recency, so
    you don't have to guess an id.
    """
    claude_sessions = claude_code.discover_sessions()
    cursor_sessions = cursor.discover_sessions()
    return {
        "claude_code_sessions": claude_sessions,
        "cursor_workspaces": cursor_sessions,
        "total": len(claude_sessions) + len(cursor_sessions),
    }


@mcp.tool()
async def import_claude_code_session(session_id: str, project_dir: str | None = None) -> dict[str, Any]:
    """Import a Claude Code session transcript into Tangent's long-term memory.

    Args:
        session_id: The session's UUID (the filename minus ``.jsonl``), from list_context_sources.
        project_dir: Optional encoded project directory name if disambiguation is needed.
    """
    records = claude_code.load_session(session_id, project_dir)
    if not records:
        return {"ok": False, "error": "No importable messages found in that session."}

    result = await ingest_records(
        _get_memory(),
        records,
        source="claude_code",
        session_id=session_id,
        project_path=records[0].project_path,
    )
    result["ok"] = True
    return result


@mcp.tool()
async def import_cursor_session(workspace_hash: str) -> dict[str, Any]:
    """Import a Cursor workspace's chat/composer history into Tangent's long-term memory.

    Args:
        workspace_hash: The workspace storage folder name, from list_context_sources.
    """
    records = cursor.load_session(workspace_hash)
    if not records:
        return {
            "ok": False,
            "error": "No importable messages found for that workspace "
                     "(Cursor's local chat storage format varies by version).",
        }

    result = await ingest_records(
        _get_memory(),
        records,
        source="cursor",
        session_id=workspace_hash,
        project_path=records[0].project_path,
    )
    result["ok"] = True
    return result


@mcp.tool()
async def search_imported_context(query: str, limit: int = 5) -> dict[str, Any]:
    """Search context previously imported by this server (semantic search over the memory store)."""
    results = await _get_memory().search(query, limit=limit)
    imported_only = [r for r in results if r.get("metadata", {}).get("kind") == "context_import"]
    return {"results": imported_only}


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
