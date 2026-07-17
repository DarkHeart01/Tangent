"""Unit tests for indexer/chunker.py."""

from __future__ import annotations

from pathlib import Path

from indexer.chunker import chunk_file, detect_language


def test_detect_language():
    assert detect_language(Path("foo.py")) == "python"
    assert detect_language(Path("foo.ts")) == "typescript"
    assert detect_language(Path("foo.unknownext")) == "text"


def test_chunk_python_splits_by_function():
    source = (
        "import os\n\n\n"
        + "def add(a, b):\n    return a + b\n\n\n"
        + "def subtract(a, b):\n    return a - b\n\n\n"
        + "class Thing:\n    def method(self):\n        return 1\n"
        + "\n".join(f"# padding line {i}" for i in range(40))  # push file over the 40-line floor
    )
    chunks = chunk_file(Path("mod.py"), source)
    symbols = {c.symbol for c in chunks}

    assert "add" in symbols
    assert "subtract" in symbols
    assert "Thing" in symbols

    add_chunk = next(c for c in chunks if c.symbol == "add")
    assert add_chunk.kind == "function"
    assert add_chunk.language == "python"
    assert "return a + b" in add_chunk.text
    assert add_chunk.start_line <= add_chunk.end_line


def test_chunk_python_small_file_stays_whole():
    source = "x = 1\ny = 2\n"
    chunks = chunk_file(Path("tiny.py"), source)
    assert len(chunks) == 1
    assert chunks[0].kind == "module"


def test_chunk_python_syntax_error_falls_back_to_sliding_window():
    source = "def broken(:\n" + "\n".join(f"line {i}" for i in range(60))
    chunks = chunk_file(Path("broken.py"), source)
    assert len(chunks) >= 1
    assert all(c.language == "python" for c in chunks)


def test_chunk_javascript_by_declaration():
    source = (
        "export function foo() {\n  return 1;\n}\n\n"
        "class Bar {\n  constructor() {}\n}\n"
    )
    chunks = chunk_file(Path("mod.js"), source)
    symbols = {c.symbol for c in chunks}
    assert "foo" in symbols
    assert "Bar" in symbols


def test_chunk_empty_file_returns_nothing():
    assert chunk_file(Path("empty.py"), "") == []
    assert chunk_file(Path("empty.py"), "   \n  \n") == []


def test_chunk_content_hash_is_deterministic():
    chunks_a = chunk_file(Path("a.py"), "x = 1\ny = 2\n")
    chunks_b = chunk_file(Path("a.py"), "x = 1\ny = 2\n")
    assert chunks_a[0].content_hash == chunks_b[0].content_hash


def test_chunk_sliding_window_fallback_for_unknown_language():
    source = "\n".join(f"line {i}" for i in range(500))
    chunks = chunk_file(Path("data.txt"), source, chunk_lines=100, chunk_overlap=10)
    assert len(chunks) > 1
    assert chunks[0].start_line == 1
    assert chunks[0].kind == "block"
