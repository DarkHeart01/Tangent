"""Shared shape for imported context and the write path into long-term memory."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from memory.longterm import LocalChromaMemory

# Individual chat messages get truncated to this length before embedding so one
# giant tool-result dump doesn't blow out the ChromaDB document size / cost.
MAX_RECORD_CHARS = 4000


@dataclass
class ContextRecord:
    role: str                    # "user" | "assistant" | "tool"
    text: str
    source: str                  # "claude_code" | "cursor"
    session_id: str
    project_path: str
    timestamp: Optional[str] = None
    extra: dict[str, Any] = field(default_factory=dict)


async def ingest_records(
    memory: LocalChromaMemory,
    records: list[ContextRecord],
    *,
    source: str,
    session_id: str,
    project_path: str,
) -> dict[str, Any]:
    """Write each record as its own memory entry, tagged so it can be filtered/found later."""
    written = 0
    for i, rec in enumerate(records):
        text = rec.text.strip()
        if not text:
            continue
        if len(text) > MAX_RECORD_CHARS:
            text = text[:MAX_RECORD_CHARS] + "…[truncated]"

        key = f"context_import:{source}:{session_id}:{i}"
        metadata = {
            "kind": "context_import",
            "source": source,
            "session_id": session_id,
            "project_path": project_path,
            "role": rec.role,
            "index": i,
        }
        if rec.timestamp:
            metadata["timestamp"] = rec.timestamp

        await memory.write(key, text, metadata=metadata)
        written += 1

    return {
        "records_written": written,
        "records_seen": len(records),
        "source": source,
        "session_id": session_id,
        "project_path": project_path,
    }
