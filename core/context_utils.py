"""Helpers for keeping tool output out of unbounded context growth."""

from __future__ import annotations

from typing import Any


def cap_tool_output(result: Any, max_chars: int = 4000) -> Any:
    """Truncate long string values in a tool result before it enters message history.

    Walks string-valued keys of a dict result (the shape every tool handler in
    this repo returns) and truncates any value exceeding max_chars, appending a
    marker. Truncating individual string fields rather than the whole
    serialized blob keeps the surrounding structure parseable.
    """
    if not isinstance(result, dict):
        return result

    capped: dict[str, Any] = {}
    for key, value in result.items():
        if isinstance(value, str) and len(value) > max_chars:
            shown = value[:max_chars]
            capped[key] = f"{shown}...[truncated, {max_chars} of {len(value)} chars shown]"
        else:
            capped[key] = value
    return capped
