"""Unit tests for the safe unique-match `replace` op in tools/filesystem/handler.py."""

from __future__ import annotations

import pytest

import tools.filesystem.handler as fsh
from tools.filesystem.handler import FilesystemHandler


@pytest.mark.asyncio
async def test_replace_unique_match(tmp_path, monkeypatch):
    monkeypatch.setattr(fsh, "_CWD", tmp_path)
    monkeypatch.setattr(fsh, "_INTERNAL_PREFIXES", fsh._INTERNAL_PREFIXES + ("file.py",))
    (tmp_path / "file.py").write_text("def a():\n    return 1\n\ndef b():\n    return 2\n", encoding="utf-8")

    h = FilesystemHandler()
    result = await h._run({
        "operation": "replace", "path": "file.py",
        "old_string": "return 1", "new_string": "return 100",
    })

    assert "error" not in result
    content = (tmp_path / "file.py").read_text(encoding="utf-8")
    assert "return 100" in content
    assert "return 2" in content  # rest of the file untouched


@pytest.mark.asyncio
async def test_replace_ambiguous_match_without_replace_all_errors(tmp_path, monkeypatch):
    monkeypatch.setattr(fsh, "_CWD", tmp_path)
    monkeypatch.setattr(fsh, "_INTERNAL_PREFIXES", fsh._INTERNAL_PREFIXES + ("file.py",))
    (tmp_path / "file.py").write_text("pass\npass\n", encoding="utf-8")

    h = FilesystemHandler()
    result = await h._run({
        "operation": "replace", "path": "file.py",
        "old_string": "pass", "new_string": "return",
    })

    assert "error" in result
    # File must be untouched on ambiguous match
    assert (tmp_path / "file.py").read_text(encoding="utf-8") == "pass\npass\n"


@pytest.mark.asyncio
async def test_replace_all_replaces_every_occurrence(tmp_path, monkeypatch):
    monkeypatch.setattr(fsh, "_CWD", tmp_path)
    monkeypatch.setattr(fsh, "_INTERNAL_PREFIXES", fsh._INTERNAL_PREFIXES + ("file.py",))
    (tmp_path / "file.py").write_text("pass\npass\n", encoding="utf-8")

    h = FilesystemHandler()
    result = await h._run({
        "operation": "replace", "path": "file.py",
        "old_string": "pass", "new_string": "return", "replace_all": True,
    })

    assert "error" not in result
    assert (tmp_path / "file.py").read_text(encoding="utf-8") == "return\nreturn\n"


@pytest.mark.asyncio
async def test_replace_no_match_errors(tmp_path, monkeypatch):
    monkeypatch.setattr(fsh, "_CWD", tmp_path)
    monkeypatch.setattr(fsh, "_INTERNAL_PREFIXES", fsh._INTERNAL_PREFIXES + ("file.py",))
    (tmp_path / "file.py").write_text("pass\n", encoding="utf-8")

    h = FilesystemHandler()
    result = await h._run({
        "operation": "replace", "path": "file.py",
        "old_string": "does_not_exist", "new_string": "x",
    })

    assert "error" in result


@pytest.mark.asyncio
async def test_replace_without_old_string_is_legacy_full_overwrite(tmp_path, monkeypatch):
    monkeypatch.setattr(fsh, "_CWD", tmp_path)
    monkeypatch.setattr(fsh, "_INTERNAL_PREFIXES", fsh._INTERNAL_PREFIXES + ("file.py",))
    (tmp_path / "file.py").write_text("old content\n", encoding="utf-8")

    h = FilesystemHandler()
    result = await h._run({
        "operation": "replace", "path": "file.py", "content": "brand new content\n",
    })

    assert "error" not in result
    assert (tmp_path / "file.py").read_text(encoding="utf-8") == "brand new content\n"
