"""Unit tests for indexer/store.py — vector CRUD and the file-hash manifest."""

from __future__ import annotations

from indexer.chunker import CodeChunk
from indexer.store import CodeIndexStore


def _chunk(file_path: str, symbol: str) -> CodeChunk:
    return CodeChunk(
        file_path=file_path, start_line=1, end_line=5,
        symbol=symbol, kind="function", language="python",
        text=f"def {symbol}(): pass",
    )


def test_manifest_round_trip(tmp_path):
    store = CodeIndexStore(index_dir=str(tmp_path / "index"))
    assert store.get_file_hashes() == {}

    store.record_file_hash("a.py", "hash1")
    store.record_file_hash("b.py", "hash2")
    assert store.get_file_hashes() == {"a.py": "hash1", "b.py": "hash2"}

    store.forget_file("a.py")
    assert store.get_file_hashes() == {"b.py": "hash2"}


def test_manifest_persists_across_instances(tmp_path):
    index_dir = str(tmp_path / "index")
    store1 = CodeIndexStore(index_dir=index_dir)
    store1.record_file_hash("a.py", "hash1")

    store2 = CodeIndexStore(index_dir=index_dir)
    assert store2.get_file_hashes() == {"a.py": "hash1"}


def test_upsert_and_query_returns_closest_match(tmp_path):
    store = CodeIndexStore(index_dir=str(tmp_path / "index"))
    chunks = [_chunk("a.py", "alpha"), _chunk("b.py", "beta")]
    # Orthogonal vectors so cosine similarity deterministically ranks "alpha" first.
    embeddings = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]]
    store.upsert(chunks, embeddings)

    results = store.query([1.0, 0.0, 0.0, 0.0], k=2)
    assert results
    assert results[0]["metadata"]["symbol"] == "alpha"


def test_delete_file_removes_its_chunks(tmp_path):
    store = CodeIndexStore(index_dir=str(tmp_path / "index"))
    chunks = [_chunk("a.py", "alpha"), _chunk("b.py", "beta")]
    embeddings = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]]
    store.upsert(chunks, embeddings)

    store.delete_file("a.py")
    results = store.query([1.0, 0.0, 0.0, 0.0], k=5)
    files = {r["metadata"]["file_path"] for r in results}
    assert "a.py" not in files
    assert "b.py" in files
