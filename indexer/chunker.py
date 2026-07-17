"""Splits source files into function/class-sized chunks for embedding & retrieval.

Python gets real AST-based splitting (reusing the ast.walk approach already
proven in tools/ast_inspect). Other languages get regex-based top-level
declaration splitting. Anything left over — or oversized — falls back to a
sliding line window.
"""

from __future__ import annotations

import ast
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

_LANG_MAP = {
    ".py": "python", ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby", ".php": "php",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp",
    ".kt": "kotlin", ".swift": "swift", ".yaml": "yaml", ".yml": "yaml",
    ".json": "json", ".md": "markdown", ".sql": "sql", ".sh": "shell",
}

# Every alternative below has exactly one capture group — the declared identifier —
# so `next(g for g in m.groups() if g)` reliably extracts the symbol name.
_DECL_PATTERNS: dict[str, re.Pattern] = {
    "javascript": re.compile(
        r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)"
        r"|^\s*(?:export\s+)?class\s+(\w+)"
        r"|^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:\(|async\s*\()"
    ),
    "typescript": re.compile(
        r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)"
        r"|^\s*(?:export\s+)?class\s+(\w+)"
        r"|^\s*(?:export\s+)?(?:interface|type)\s+(\w+)"
        r"|^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:\(|async\s*\()"
    ),
    "go": re.compile(
        r"^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)"
        r"|^\s*type\s+(\w+)\s+(?:struct|interface)"
    ),
    "java": re.compile(
        r"^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface)\s+(\w+)"
        r"|^\s*(?:public|private|protected)\s+[\w<>\[\],\s]+?\s+(\w+)\s*\("
    ),
    "rust": re.compile(
        r"^\s*(?:pub\s+)?fn\s+(\w+)"
        r"|^\s*(?:pub\s+)?struct\s+(\w+)"
        r"|^\s*(?:pub\s+)?enum\s+(\w+)"
        r"|^\s*impl(?:<[^>]*>)?\s+(\w+)"
    ),
    "ruby": re.compile(
        r"^\s*def\s+(\w+)"
        r"|^\s*class\s+(\w+)"
        r"|^\s*module\s+(\w+)"
    ),
    "php": re.compile(
        r"^\s*(?:public|private|protected)?\s*function\s+(\w+)"
        r"|^\s*class\s+(\w+)"
    ),
}

_MAX_CHUNK_LINES = 400  # oversized AST/declaration chunks get sub-split


@dataclass
class CodeChunk:
    file_path: str
    start_line: int
    end_line: int
    symbol: str
    kind: str  # "function" | "class" | "module" | "block"
    language: str
    text: str
    content_hash: str = field(default="")

    def __post_init__(self) -> None:
        if not self.content_hash:
            self.content_hash = hashlib.sha1(self.text.encode("utf-8", "replace")).hexdigest()


def detect_language(path: Path) -> str:
    return _LANG_MAP.get(path.suffix.lower(), "text")


def chunk_file(
    path: Path, text: str, *, chunk_lines: int = 200, chunk_overlap: int = 20
) -> list[CodeChunk]:
    if not text.strip():
        return []

    language = detect_language(path)
    rel = str(path)

    if language == "python":
        chunks = _chunk_python(rel, text)
    elif language in _DECL_PATTERNS:
        chunks = _chunk_by_declarations(rel, text, language)
    else:
        chunks = []

    if not chunks:
        return _chunk_sliding_window(rel, text, language, chunk_lines, chunk_overlap)

    # Sub-split anything too large to be a useful retrieval unit.
    final: list[CodeChunk] = []
    for c in chunks:
        if c.end_line - c.start_line + 1 > _MAX_CHUNK_LINES:
            final.extend(_chunk_sliding_window(
                rel, c.text, language, chunk_lines, chunk_overlap,
                base_line=c.start_line, symbol_prefix=c.symbol,
            ))
        else:
            final.append(c)
    return final


def _chunk_python(rel: str, text: str) -> list[CodeChunk]:
    lines = text.splitlines()
    if len(lines) < 40:
        return [CodeChunk(rel, 1, len(lines), Path(rel).stem, "module", "python", text)]

    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []

    chunks: list[CodeChunk] = []
    covered: set[int] = set()
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start, end = node.lineno, node.end_lineno or node.lineno
            segment = "\n".join(lines[start - 1:end])
            kind = "class" if isinstance(node, ast.ClassDef) else "function"
            chunks.append(CodeChunk(rel, start, end, node.name, kind, "python", segment))
            covered.update(range(start, end + 1))

    leftover_lines = [ln for i, ln in enumerate(lines, start=1) if i not in covered and ln.strip()]
    leftover_text = "\n".join(leftover_lines)
    if leftover_text.strip():
        chunks.append(CodeChunk(rel, 1, len(lines), Path(rel).stem, "module", "python", leftover_text))

    return chunks


def _chunk_by_declarations(rel: str, text: str, language: str) -> list[CodeChunk]:
    pattern = _DECL_PATTERNS[language]
    lines = text.splitlines()
    matches: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        m = pattern.match(line)
        if m:
            name = next((g for g in m.groups() if g), "anonymous")
            matches.append((i, name))

    if not matches:
        return []

    chunks = []
    for idx, (start_i, name) in enumerate(matches):
        end_i = matches[idx + 1][0] - 1 if idx + 1 < len(matches) else len(lines) - 1
        segment = "\n".join(lines[start_i:end_i + 1])
        if segment.strip():
            chunks.append(CodeChunk(rel, start_i + 1, end_i + 1, name, "function", language, segment))
    return chunks


def _chunk_sliding_window(
    rel: str, text: str, language: str, chunk_lines: int, overlap: int,
    *, base_line: int = 1, symbol_prefix: str = "",
) -> list[CodeChunk]:
    lines = text.splitlines()
    if not lines:
        return []
    step = max(1, chunk_lines - overlap)
    chunks = []
    i = 0
    idx = 0
    while i < len(lines):
        window = lines[i:i + chunk_lines]
        start = base_line + i
        end = start + len(window) - 1
        symbol = f"{symbol_prefix}#{idx}" if symbol_prefix else Path(rel).stem
        chunks.append(CodeChunk(rel, start, end, symbol, "block", language, "\n".join(window)))
        idx += 1
        if i + chunk_lines >= len(lines):
            break
        i += step
    return chunks
