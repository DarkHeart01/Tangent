"""Hybrid (semantic + literal-keyword boost) search over the code index."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from indexer.embedder import Embedder
from indexer.store import CodeIndexStore

_SNIPPET_MAX_CHARS = 800


@dataclass
class SearchResult:
    file: str
    start_line: int
    end_line: int
    symbol: str
    kind: str
    language: str
    snippet: str
    score: float


class CodeIndexSearcher:
    def __init__(self, store: CodeIndexStore, embedder: Embedder) -> None:
        self._store = store
        self._embedder = embedder

    async def search(self, query: str, k: int = 6, path_filter: Optional[str] = None) -> list[SearchResult]:
        vectors = await self._embedder.embed_texts([query])
        if not vectors:
            return []

        raw = self._store.query(vectors[0], k=max(k * 3, k), path_filter=path_filter)

        keywords = [w.lower() for w in query.split() if len(w) > 2]
        results: list[SearchResult] = []
        for r in raw:
            meta = r["metadata"]
            haystack = f"{meta.get('symbol', '')} {meta.get('file_path', '')}".lower()
            boost = sum(0.05 for kw in keywords if kw in haystack)
            results.append(SearchResult(
                file=meta.get("file_path", ""),
                start_line=meta.get("start_line", 0),
                end_line=meta.get("end_line", 0),
                symbol=meta.get("symbol", ""),
                kind=meta.get("kind", ""),
                language=meta.get("language", ""),
                snippet=r["document"],
                score=round(r["score"] + boost, 4),
            ))

        results.sort(key=lambda x: -x.score)
        return results[:k]


def format_for_prompt(results: list[SearchResult]) -> str:
    if not results:
        return ""
    lines: list[str] = []
    for i, r in enumerate(results, start=1):
        header = f"{i}. {r.file}:{r.start_line}-{r.end_line}"
        if r.symbol:
            header += f" ({r.kind} {r.symbol})"
        lines.append(header)
        snippet = r.snippet.strip()
        if len(snippet) > _SNIPPET_MAX_CHARS:
            snippet = snippet[:_SNIPPET_MAX_CHARS] + "\n... (truncated)"
        lines.append(snippet)
        lines.append("")
    return "\n".join(lines).rstrip()


def format_repo_overview(overview: dict) -> str:
    """Format a repo_inspect tool result (tree + languages + deps) for a prompt."""
    if overview.get("error") or not overview.get("tree"):
        return ""
    lines = [f"Root: {overview.get('root', '.')}"]

    langs = overview.get("languages") or {}
    if langs:
        lines.append("Languages: " + ", ".join(f"{lang} ({n})" for lang, n in langs.items()))

    deps = overview.get("dependency_files") or {}
    if deps:
        lines.append("Dependency files: " + ", ".join(deps.keys()))

    lines.append("")
    lines.extend(overview["tree"])
    return "\n".join(lines)
