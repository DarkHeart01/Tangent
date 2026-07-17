"""Batches text -> embedding-vector calls against an EmbeddingProvider.

Retry-on-rate-limit is handled inside the provider adapter itself
(see providers/gemini/adapter.py::embed), so this stays a thin batcher.
"""

from __future__ import annotations

from providers.base import EmbeddingProvider

_BATCH_SIZE = 100


class Embedder:
    def __init__(self, provider: EmbeddingProvider, model: str) -> None:
        self._provider = provider
        self._model = model

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors: list[list[float]] = []
        for i in range(0, len(texts), _BATCH_SIZE):
            batch = texts[i:i + _BATCH_SIZE]
            vectors.extend(await self._provider.embed(batch, self._model))
        return vectors
