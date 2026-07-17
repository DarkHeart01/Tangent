"""Trigger an (incremental) rebuild of the local code index (see indexer/).

The builder is a runtime-injected singleton, wired up by
SwarmRuntime._wire_tools() -> set_builder() once indexing is configured.
Embeddings come from Gemini if GEMINI_API_KEY is set, otherwise from a local
offline model (see providers/local/adapter.py).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from tools.base import ToolHandler

if TYPE_CHECKING:
    from indexer.build import IndexBuilder

_builder: Optional["IndexBuilder"] = None


def set_builder(builder: "IndexBuilder") -> None:
    global _builder
    _builder = builder


class CodeIndexBuildHandler(ToolHandler):
    async def _run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        if _builder is None:
            return {"error": "Code indexing is not configured (disabled in config, or chromadb is missing)."}

        force = bool(inputs.get("force", False))
        stats = await _builder.build(force=force)
        return {
            "files_indexed": stats.files_indexed,
            "files_skipped": stats.files_skipped,
            "files_removed": stats.files_removed,
            "chunks_total": stats.chunks_total,
            "duration_s": stats.duration_s,
        }

    async def self_test(self) -> bool:
        # Builder is runtime-injected; nothing meaningful to test without a live index.
        return True


handler = CodeIndexBuildHandler()
