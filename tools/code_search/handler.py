"""Semantic + keyword search over the local code index (see indexer/).

The searcher is a runtime-injected singleton, wired up by
SwarmRuntime._wire_tools() -> set_searcher() once indexing is configured.
Embeddings come from Gemini if GEMINI_API_KEY is set, otherwise from a local
offline model (see providers/local/adapter.py). If neither could be set up,
the tool degrades to a clear error instead of crashing the agent.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from tools.base import ToolHandler

if TYPE_CHECKING:
    from indexer.search import CodeIndexSearcher

_searcher: Optional["CodeIndexSearcher"] = None


def set_searcher(searcher: "CodeIndexSearcher") -> None:
    global _searcher
    _searcher = searcher


class CodeSearchHandler(ToolHandler):
    async def _run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        if _searcher is None:
            return {
                "error": "Code index is not available. Run 'swarm index build' before using code_search.",
                "results": [],
                "count": 0,
            }

        query = inputs["query"]
        k = int(inputs.get("k", 6))
        path_filter = inputs.get("path_filter") or None

        results = await _searcher.search(query, k=k, path_filter=path_filter)
        return {
            "results": [
                {
                    "file": r.file,
                    "start_line": r.start_line,
                    "end_line": r.end_line,
                    "symbol": r.symbol,
                    "kind": r.kind,
                    "language": r.language,
                    "snippet": r.snippet,
                    "score": r.score,
                }
                for r in results
            ],
            "count": len(results),
        }

    async def self_test(self) -> bool:
        # Searcher is runtime-injected; nothing meaningful to test without a live index.
        return True


handler = CodeSearchHandler()
