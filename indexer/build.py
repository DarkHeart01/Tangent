"""Incremental repo indexer — walks the tree, chunks changed files, embeds, upserts.

Unchanged files (by whole-file content hash, tracked in CodeIndexStore's
manifest) are skipped, so repeat builds on a mostly-unchanged repo are cheap.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

from indexer.chunker import chunk_file
from indexer.embedder import Embedder
from indexer.store import CodeIndexStore
from observability.logutil import get_logger

log = get_logger("indexer.build")

_BINARY_SUFFIX_DENYLIST = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot",
    ".pdf", ".zip", ".exe", ".dll", ".so", ".pyc", ".db", ".sqlite", ".sqlite3",
    ".lock", ".bin", ".mp4", ".mp3", ".wav", ".svg",
}
_MAX_FILE_BYTES = 512_000  # skip anything bigger than ~500KB (binary/minified/data dumps)


@dataclass
class BuildStats:
    files_indexed: int = 0
    files_skipped: int = 0
    files_removed: int = 0
    chunks_total: int = 0
    duration_s: float = 0.0


class IndexBuilder:
    def __init__(
        self,
        store: CodeIndexStore,
        embedder: Embedder,
        root: Optional[Path] = None,
        exclude_dirs: Optional[list[str]] = None,
        chunk_lines: int = 200,
        chunk_overlap: int = 20,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._root = (root or Path.cwd()).resolve()
        self._exclude_dirs = set(exclude_dirs or [])
        self._chunk_lines = chunk_lines
        self._chunk_overlap = chunk_overlap

    def _iter_files(self) -> Iterator[Path]:
        for p in self._root.rglob("*"):
            if not p.is_file():
                continue
            parts = p.relative_to(self._root).parts[:-1]
            if any(part in self._exclude_dirs or part.startswith(".") for part in parts):
                continue
            if p.suffix.lower() in _BINARY_SUFFIX_DENYLIST:
                continue
            try:
                if p.stat().st_size > _MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            yield p

    async def build(self, force: bool = False) -> BuildStats:
        start = time.time()
        stats = BuildStats()
        known_hashes = self._store.get_file_hashes()
        seen: set[str] = set()

        for path in self._iter_files():
            rel = str(path.relative_to(self._root))
            seen.add(rel)
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue

            file_hash = hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()
            if not force and known_hashes.get(rel) == file_hash:
                stats.files_skipped += 1
                continue

            chunks = chunk_file(path, text, chunk_lines=self._chunk_lines, chunk_overlap=self._chunk_overlap)
            if not chunks:
                continue

            embeddings = await self._embedder.embed_texts([c.text for c in chunks])
            if len(embeddings) != len(chunks):
                log.warning("embedding_count_mismatch", file=rel,
                            expected=len(chunks), got=len(embeddings))
                continue

            self._store.delete_file(rel)
            self._store.upsert(chunks, embeddings)
            self._store.record_file_hash(rel, file_hash)
            stats.files_indexed += 1
            stats.chunks_total += len(chunks)

        for rel in set(known_hashes) - seen:
            self._store.delete_file(rel)
            self._store.forget_file(rel)
            stats.files_removed += 1

        stats.duration_s = round(time.time() - start, 2)
        log.info("index_build_complete", files_indexed=stats.files_indexed,
                  files_skipped=stats.files_skipped, files_removed=stats.files_removed,
                  chunks_total=stats.chunks_total, duration_s=stats.duration_s)
        return stats
