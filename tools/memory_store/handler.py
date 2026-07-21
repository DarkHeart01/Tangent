"""Write to long-term memory. Counterpart to tools/memory_retrieve."""

from __future__ import annotations

from typing import Any, Optional

from memory.longterm import LocalChromaMemory
from tools.base import ToolHandler

_memory: Optional[LocalChromaMemory] = None


def set_memory(mem: LocalChromaMemory) -> None:
    global _memory
    _memory = mem


class MemoryStoreHandler(ToolHandler):
    async def _run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        if _memory is None:
            return {"stored": False, "key": inputs["key"], "error": "Long-term memory not configured"}
        await _memory.write(inputs["key"], inputs["value"])
        return {"stored": True, "key": inputs["key"]}

    async def self_test(self) -> bool:
        return True


handler = MemoryStoreHandler()
