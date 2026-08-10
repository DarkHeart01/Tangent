# MCP context import

Tangent ships an MCP server that pulls local session/chat history out of other
coding assistants (Claude Code, Cursor) and writes it into the same long-term
memory store the swarm reads from (`memory.longterm.LocalChromaMemory`, at
`SWARM_MEMORY_DIR`, default `./memory_store`). Once imported, any swarm agent
finds it again through the existing `memory_retrieve` tool -- this server only
owns the import path, not a separate store.

It runs over stdio, so it's registered as an MCP server inside the *other*
tool, not the other way around: you add it to Claude Code's or Cursor's own
MCP config, then ask that tool's agent to pull a session into Tangent.

## Tools exposed

| Tool | Purpose |
|---|---|
| `list_context_sources` | Lists locally available Claude Code sessions and Cursor workspaces, with their ids and project paths. Call this first. |
| `import_claude_code_session` | Parses one Claude Code session transcript (`~/.claude/projects/**/*.jsonl`) and writes each message into memory. |
| `import_cursor_session` | Parses one Cursor workspace's chat/composer history and writes each message into memory. |
| `search_imported_context` | Semantic search over everything imported so far, scoped to `kind: context_import`. |

## Registering in Claude Code

Add to your project's `.mcp.json` (or `~/.claude.json` for a user-wide server):

```json
{
  "mcpServers": {
    "tangent-context": {
      "command": "swarm",
      "args": ["mcp"],
      "env": { "SWARM_MEMORY_DIR": "./memory_store" }
    }
  }
}
```

Then, from within Claude Code: *"use the tangent-context MCP server to list
available sessions, then import this one."*

## Registering in Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tangent-context": {
      "command": "swarm",
      "args": ["mcp"],
      "env": { "SWARM_MEMORY_DIR": "./memory_store" }
    }
  }
}
```

`command` must resolve on PATH -- if `swarm` isn't globally on PATH (e.g. it's
only installed in a project venv), point `command` at the venv's `swarm`
executable directly (e.g. `C:\path\to\tangent\.venv\Scripts\swarm.exe`).

## Running it standalone

```bash
swarm mcp --memory-dir ./memory_store
```

This blocks on stdio, waiting for an MCP client to connect -- it's meant to be
launched by Claude Code/Cursor themselves, not run interactively. To exercise
it without either tool installed, use the `mcp` Python SDK's client:

```python
import asyncio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    params = StdioServerParameters(command="swarm", args=["mcp"])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("list_context_sources", {})
            print(result.content)

asyncio.run(main())
```

## Notes on fragility

- Claude Code's transcript format (JSONL, one file per session under
  `~/.claude/projects/<encoded-dir>/`) is stable and documented by observation
  in `mcp_server/sources/claude_code.py`.
- Cursor's local SQLite schema (`workspaceStorage/*/state.vscdb`,
  `globalStorage/state.vscdb`) is internal and undocumented, and has changed
  shape across Cursor versions. `mcp_server/sources/cursor.py` reads it
  best-effort: it always falls back to the simpler, more stable
  `aiService.prompts` list (user prompts only, no assistant replies) if the
  richer composer/bubble conversation format doesn't parse. A failed import
  logs a warning per bad row rather than raising, so one malformed record
  never blocks the rest of a session from importing.
