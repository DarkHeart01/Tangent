"""Shared message-history compaction algorithm.

Used by both memory.scratchpad.Scratchpad (per-agent task loops) and
core.chat_session.ChatSession (long-lived interactive sessions) so there is
exactly one compaction policy applied to two different storage shapes.
"""

from __future__ import annotations

import json
from typing import Any

from observability.logutil import get_logger

log = get_logger("memory.compaction")

_APPROX_TOKENS_PER_CHAR = 0.25


def token_estimate(messages: list[dict[str, Any]]) -> int:
    total = sum(len(json.dumps(m)) for m in messages)
    return int(total * _APPROX_TOKENS_PER_CHAR)


def maybe_compact(messages: list[dict[str, Any]], max_tokens: int) -> list[dict[str, Any]]:
    """Return `messages` unchanged if under budget, else a compacted copy.

    Keeps the original (non-compaction) system message, drops all but the
    last few messages, and inserts a `[COMPACTED: N omitted]` marker so the
    model knows history was trimmed.
    """
    if token_estimate(messages) < max_tokens:
        return messages

    original_system = next(
        (m for m in messages
         if m.get("role") == "system"
         and not str(m.get("content", "")).startswith("[COMPACTED:")),
        None,
    )
    rest = [m for m in messages if m.get("role") != "system"]
    # Always drop at least 1 message so the list shrinks on every compact call
    keep_count = max(1, min(8, len(rest) - 1))
    keep_tail = rest[-keep_count:]
    dropped = len(messages) - (1 if original_system else 0) - len(keep_tail)
    if dropped <= 0:
        return messages

    summary = {
        "role": "system",
        "content": f"[COMPACTED: {dropped} earlier messages omitted to stay within context limit.]",
    }
    new_messages = []
    if original_system:
        new_messages.append(original_system)
    new_messages.append(summary)
    new_messages.extend(keep_tail)
    log.debug("messages_compacted", dropped=dropped)
    return new_messages
