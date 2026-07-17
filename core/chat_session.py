"""Stateful single-agent chat session — the interactive back-and-forth mode for `swarm chat`.

Unlike core.agent.Agent (which rebuilds its message list fresh for every Task and is
meant for one-shot lifecycle-phase work), ChatSession keeps one growing `messages` list
across turns, so the model retains context between user inputs the way an interactive
coding assistant does. It intentionally skips Agent's Task/TaskResult/scratchpad
machinery — for a REPL there's no phase, no budget-per-task, just a running conversation.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from core.context_utils import cap_tool_output
from indexer.search import format_repo_overview
from memory.compaction import maybe_compact
from observability.cost import CostLedger
from observability.logutil import get_logger
from providers.base import LLMProvider
from tools.base import ToolHandler

log = get_logger("chat_session")

_SYSTEM_PROMPT = """You are DevForge's interactive coding assistant, working directly \
in the project at {root}.

You have direct tool access — filesystem, shell, git, linting, tests, and semantic code \
search. Use them freely to investigate and fix things yourself; don't ask permission \
before reading a file or making a small, well-scoped edit, just do it and report what \
you changed.

Scope discipline:
- Bug fixes, edits, questions, small features, refactors -> do this directly, right here,
  using your tools. Read before you write; don't blindly regenerate working code.
- A substantial NEW build (a full backend+frontend, a new service from scratch) -> don't
  try to build the whole thing yourself in this conversation. Tell the user to run
  `/swarm <goal>` instead, which spins up the full multi-agent build pipeline
  (architecture, backend, frontend, tests, review, devops).

Be direct and concise. Report concrete file paths and line numbers when relevant."""


class ChatSession:
    def __init__(
        self,
        provider: LLMProvider,
        model: str,
        tool_handlers: dict[str, ToolHandler],
        ledger: Optional[CostLedger] = None,
        max_tool_iterations: int = 20,
        context_window_tokens: int = 60000,
    ) -> None:
        self.provider = provider
        self.model = model
        self._tools = tool_handlers
        self._ledger = ledger
        self._max_tool_iterations = max_tool_iterations
        self._context_window_tokens = context_window_tokens
        self.id = str(uuid.uuid4())
        self.messages: list[dict[str, Any]] = []
        self._seed_system_prompt()

    def _seed_system_prompt(self) -> None:
        self.messages = [{"role": "system", "content": _SYSTEM_PROMPT.format(root=Path.cwd())}]

    async def seed_repo_overview(self) -> None:
        """Best-effort: inject a directory-tree overview so the assistant starts grounded."""
        handler = self._tools.get("repo_inspect")
        if not handler:
            return
        try:
            overview = await handler.run({}, agent_id=self.id)
            block = format_repo_overview(overview)
            if block:
                self.messages[0]["content"] += f"\n\n## Repository overview\n{block}"
        except Exception as exc:
            log.warning("chat_repo_overview_failed", error=str(exc))

    def clear(self) -> None:
        self._seed_system_prompt()

    def switch_model(self, model: str) -> None:
        self.model = model

    def switch_provider(self, provider: LLMProvider) -> None:
        self.provider = provider

    @property
    def total_cost(self) -> float:
        return self._ledger.total_cost if self._ledger else 0.0

    def _tool_schemas(self) -> list[dict[str, Any]]:
        return [h.get_openai_schema() for h in self._tools.values()]

    async def send(
        self,
        user_text: str,
        on_tool_call: Optional[Callable[[str, dict[str, Any]], None]] = None,
        on_tool_result: Optional[Callable[[str, dict[str, Any]], None]] = None,
    ) -> str:
        """Run one user turn: append the message, loop tool calls until a final answer."""
        self.messages.append({"role": "user", "content": user_text})
        self.messages = maybe_compact(self.messages, max_tokens=self._context_window_tokens)
        tools = self._tool_schemas()

        for _ in range(self._max_tool_iterations):
            result = await self.provider.complete(
                messages=self.messages, model=self.model, tools=tools or None, temperature=0.2,
            )
            if self._ledger:
                self._ledger.record(self.id, self.model, result.usage, self.id)

            if not result.tool_calls:
                text = result.content or ""
                self.messages.append({"role": "assistant", "content": text})
                return text

            assistant_msg: dict[str, Any] = {"role": "assistant"}
            if result.content:
                assistant_msg["content"] = result.content
            assistant_msg["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
                }
                for tc in result.tool_calls
            ]
            self.messages.append(assistant_msg)

            for tc in result.tool_calls:
                if on_tool_call:
                    on_tool_call(tc.name, tc.arguments)
                tool_result = await self._execute_tool(tc.name, tc.arguments)
                if on_tool_result:
                    on_tool_result(tc.name, tool_result)
                tool_result = cap_tool_output(tool_result)
                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(tool_result),
                })
                self.messages = maybe_compact(self.messages, max_tokens=self._context_window_tokens)

        return "(stopped: too many tool calls in one turn — ask me to continue.)"

    async def _execute_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        handler = self._tools.get(name)
        if handler is None:
            return {"error": f"Tool '{name}' not available in chat mode"}
        try:
            return await handler.run(arguments, agent_id=self.id)
        except Exception as exc:
            log.error("chat_tool_error", tool=name, error=str(exc))
            return {"error": str(exc)}
