"""Persisted vector store for code chunks.

Same chromadb-backed / in-memory-fallback pattern as memory/longterm.py's
LocalChromaMemory, but embeddings are supplied by the caller (Gemini, via
Embedder) rather than chroma's own default embedding function — this lets
the code index and the chat model be on entirely different providers.

A small JSON manifest (file_path -> whole-file content hash) lives alongside
the chroma collection and drives incremental rebuilds in indexer/build.py.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional

from observability.logutil import get_logger

log = get_logger("indexer.store")

_COLLECTION = "code_chunks"


class CodeIndexStore:
    def __init__(self, index_dir: str) -> None:
        self._index_dir = Path(index_dir)
        self._manifest_path = self._index_dir / "manifest.json"
        self._client: Any = None
        self._collection: Any = None
        self._fallback: dict[str, dict] = {}
        self._use_fallback = False
        self._manifest: dict[str, str] = {}
        self._init()
        self._load_manifest()

    def _init(self) -> None:
        try:
            import chromadb

            self._index_dir.mkdir(parents=True, exist_ok=True)
            self._client = chromadb.PersistentClient(path=str(self._index_dir))
            self._collection = self._client.get_or_create_collection(
                name=_COLLECTION, metadata={"hnsw:space": "cosine"},
            )
            log.info("code_index_ready", backend="chroma", dir=str(self._index_dir))
        except ImportError:
            log.warning("chromadb_missing", fallback="in-memory")
            self._use_fallback = True

    def _load_manifest(self) -> None:
        if self._manifest_path.exists():
            try:
                self._manifest = json.loads(self._manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self._manifest = {}

    def _save_manifest(self) -> None:
        try:
            self._index_dir.mkdir(parents=True, exist_ok=True)
            self._manifest_path.write_text(json.dumps(self._manifest), encoding="utf-8")
        except OSError as exc:
            log.error("manifest_write_error", error=str(exc))

    @staticmethod
    def chunk_id(file_path: str, start_line: int, symbol: str) -> str:
        return hashlib.sha1(f"{file_path}:{start_line}:{symbol}".encode()).hexdigest()[:16]

    # ── File-hash manifest (incremental rebuild) ────────────────────────────────

    def get_file_hashes(self) -> dict[str, str]:
        return dict(self._manifest)

    def record_file_hash(self, file_path: str, content_hash: str) -> None:
        self._manifest[file_path] = content_hash
        self._save_manifest()

    def forget_file(self, file_path: str) -> None:
        self._manifest.pop(file_path, None)
        self._save_manifest()

    # ── Vector CRUD ──────────────────────────────────────────────────────────────

    def upsert(self, chunks: list[Any], embeddings: list[list[float]]) -> None:
        if not chunks:
            return
        ids = [self.chunk_id(c.file_path, c.start_line, c.symbol) for c in chunks]
        documents = [c.text for c in chunks]
        metadatas = [
            {
                "file_path": c.file_path, "start_line": c.start_line, "end_line": c.end_line,
                "symbol": c.symbol, "kind": c.kind, "language": c.language,
                "content_hash": c.content_hash,
            }
            for c in chunks
        ]
        if self._use_fallback:
            for i, id_ in enumerate(ids):
                self._fallback[id_] = {
                    "embedding": embeddings[i], "document": documents[i], "metadata": metadatas[i],
                }
            return
        try:
            self._collection.upsert(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)
        except Exception as exc:
            log.error("index_upsert_error", error=str(exc))

    def delete_file(self, file_path: str) -> None:
        if self._use_fallback:
            for id_ in [k for k, v in self._fallback.items() if v["metadata"]["file_path"] == file_path]:
                del self._fallback[id_]
            return
        try:
            self._collection.delete(where={"file_path": file_path})
        except Exception as exc:
            log.error("index_delete_error", file_path=file_path, error=str(exc))

    def query(self, embedding: list[float], k: int = 6, path_filter: Optional[str] = None) -> list[dict[str, Any]]:
        if self._use_fallback:
            return self._query_fallback(embedding, k, path_filter)
        try:
            where = {"file_path": path_filter} if path_filter else None
            n = min(k, max(1, self._collection.count()))
            result = self._collection.query(query_embeddings=[embedding], n_results=n, where=where)
            docs = result.get("documents", [[]])[0]
            metas = result.get("metadatas", [[]])[0]
            distances = result.get("distances", [[]])[0]
            return [
                {"document": d, "metadata": m, "score": 1 - dist}
                for d, m, dist in zip(docs, metas, distances)
            ]
        except Exception as exc:
            log.error("index_query_error", error=str(exc))
            return []

    def _query_fallback(self, embedding: list[float], k: int, path_filter: Optional[str]) -> list[dict[str, Any]]:
        import math

        def cos(a: list[float], b: list[float]) -> float:
            dot = sum(x * y for x, y in zip(a, b))
            na = math.sqrt(sum(x * x for x in a))
            nb = math.sqrt(sum(x * x for x in b))
            return dot / (na * nb) if na and nb else 0.0

        scored = []
        for v in self._fallback.values():
            if path_filter and path_filter not in v["metadata"]["file_path"]:
                continue
            scored.append((cos(embedding, v["embedding"]), v))
        scored.sort(key=lambda x: -x[0])
        return [{"document": v["document"], "metadata": v["metadata"], "score": s} for s, v in scored[:k]]
