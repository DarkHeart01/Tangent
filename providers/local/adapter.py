"""Local (offline) embedding provider — the code indexer's fallback when no
GEMINI_API_KEY is configured.

Wraps the ONNX MiniLM-L6-v2 model bundled with chromadb (already a required
dependency, see pyproject.toml), so no extra install and no API key is
needed. The ~80MB model is downloaded once and cached by chromadb on first
use, then runs entirely on-CPU. Quality is lower than Gemini's
text-embedding-004 and the vector dimensionality differs (384 vs 768), so an
index built with one provider should be rebuilt with `--force` after
switching to the other.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from core.exceptions import ProviderError
from observability.logutil import get_logger
from providers.base import EmbeddingProvider

log = get_logger("providers.local")

DEFAULT_MODEL = "all-MiniLM-L6-v2"


class LocalEmbeddingAdapter(EmbeddingProvider):
    """CPU-local embeddings via chromadb's bundled ONNX sentence-transformer.

    `model` is accepted for EmbeddingProvider interface compatibility but
    ignored — this always serves the bundled MiniLM-L6-v2 ONNX model.
    """

    def __init__(self) -> None:
        self._fn: Optional[Any] = None

    def _ensure_loaded(self) -> Any:
        if self._fn is None:
            from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2
            self._fn = ONNXMiniLM_L6_V2()
        return self._fn

    async def embed(self, texts: list[str], model: str = DEFAULT_MODEL) -> list[list[float]]:
        if not texts:
            return []
        try:
            fn = await asyncio.to_thread(self._ensure_loaded)
            vectors = await asyncio.to_thread(fn, texts)
        except Exception as exc:
            log.error("local_embedding_error", error=str(exc))
            raise ProviderError(str(exc)) from exc
        return [[float(x) for x in v] for v in vectors]
