"""Unit tests for indexer/build.py — incremental rebuild behavior."""

from __future__ import annotations

import pytest

from indexer.build import IndexBuilder
from indexer.embedder import Embedder
from indexer.store import CodeIndexStore
from providers.base import EmbeddingProvider


class _FakeEmbeddingProvider(EmbeddingProvider):
    def __init__(self) -> None:
        self.call_count = 0

    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        self.call_count += 1
        return [[float(len(t) % 7), 0.0, 0.0] for t in texts]


@pytest.mark.asyncio
async def test_build_skips_unchanged_files(tmp_path):
    (tmp_path / "a.py").write_text("def a():\n    return 1\n", encoding="utf-8")

    store = CodeIndexStore(index_dir=str(tmp_path / ".index"))
    provider = _FakeEmbeddingProvider()
    embedder = Embedder(provider, "text-embedding-004")
    builder = IndexBuilder(store, embedder, root=tmp_path, exclude_dirs=[".index"])

    stats1 = await builder.build()
    assert stats1.files_indexed == 1
    assert stats1.files_skipped == 0

    stats2 = await builder.build()
    assert stats2.files_indexed == 0
    assert stats2.files_skipped == 1


@pytest.mark.asyncio
async def test_build_reindexes_changed_files(tmp_path):
    target = tmp_path / "a.py"
    target.write_text("def a():\n    return 1\n", encoding="utf-8")

    store = CodeIndexStore(index_dir=str(tmp_path / ".index"))
    provider = _FakeEmbeddingProvider()
    embedder = Embedder(provider, "text-embedding-004")
    builder = IndexBuilder(store, embedder, root=tmp_path, exclude_dirs=[".index"])

    await builder.build()
    target.write_text("def a():\n    return 2\n", encoding="utf-8")
    stats = await builder.build()

    assert stats.files_indexed == 1
    assert stats.files_skipped == 0


@pytest.mark.asyncio
async def test_build_removes_deleted_files(tmp_path):
    target = tmp_path / "a.py"
    target.write_text("def a():\n    return 1\n", encoding="utf-8")

    store = CodeIndexStore(index_dir=str(tmp_path / ".index"))
    provider = _FakeEmbeddingProvider()
    embedder = Embedder(provider, "text-embedding-004")
    builder = IndexBuilder(store, embedder, root=tmp_path, exclude_dirs=[".index"])

    await builder.build()
    target.unlink()
    stats = await builder.build()

    assert stats.files_removed == 1
    assert store.get_file_hashes() == {}


@pytest.mark.asyncio
async def test_build_excludes_configured_dirs(tmp_path):
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "dep.js").write_text("function dep() {}\n", encoding="utf-8")
    (tmp_path / "real.py").write_text("def real():\n    return 1\n", encoding="utf-8")

    store = CodeIndexStore(index_dir=str(tmp_path / ".index"))
    provider = _FakeEmbeddingProvider()
    embedder = Embedder(provider, "text-embedding-004")
    builder = IndexBuilder(store, embedder, root=tmp_path,
                            exclude_dirs=[".index", "node_modules"])

    stats = await builder.build()
    assert stats.files_indexed == 1
    assert "node_modules/dep.js" not in store.get_file_hashes()
    assert "real.py" in store.get_file_hashes()
