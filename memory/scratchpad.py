"""Per-agent ephemeral working memory.  Destroyed when the agent completes.

Auto-summarizes when approaching the configured token limit so the agent's
conversation history never exceeds context window size.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from memory.base import MemoryInterface
from memory.compaction import maybe_compact, token_estimate as _token_estimate
from observability.logutil import get_logger

log = get_logger("memory.scratchpad")


class Scratchpad(MemoryInterface):
    """
    Simple in-memory KV store + text buffer.

    .write / .read are for structured notes (dict).
    .append_message / .get_messages track the agent's conversation history.
    """

    def __init__(self, agent_id: str, max_tokens: int = 6000) -> None:
        self._agent_id = agent_id
        self._max_tokens = max_tokens
        self._store: dict[str, Any] = {}
        self._messages: list[dict[str, Any]] = []

    # ── MemoryInterface impl ───────────────────────────────────────────────────

    async def write(self, key: str, value: Any, metadata: Optional[dict] = None) -> None:
        self._store[key] = {"value": value, "metadata": metadata or {}}

    async def read(self, key: str) -> Optional[Any]:
        entry = self._store.get(key)
        return entry["value"] if entry else None

    async def search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        q = query.lower()
        results = []
        for k, v in self._store.items():
            text = json.dumps(v).lower()
            if q in text or q in k.lower():
                results.append({"key": k, **v})
        return results[:limit]

    async def delete(self, key: str) -> None:
        self._store.pop(key, None)

    async def clear(self) -> None:
        self._store.clear()
        self._messages.clear()

    # ── Conversation history ──────────────────────────────────────────────────

    def seed(self, messages: list[dict[str, Any]]) -> None:
        """Bulk-set the initial conversation (system + user) without a compaction check."""
        self._messages = list(messages)

    def append_message(self, message: dict[str, Any]) -> None:
        self._messages.append(message)
        self._maybe_compact()

    def get_messages(self) -> list[dict[str, Any]]:
        return list(self._messages)

    def token_estimate(self) -> int:
        return _token_estimate(self._messages)

    def _maybe_compact(self) -> None:
        compacted = maybe_compact(self._messages, self._max_tokens)
        if compacted is not self._messages:
            self._messages = compacted
            log.debug("scratchpad_compacted", agent_id=self._agent_id)
