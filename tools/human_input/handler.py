"""Human input tool — pauses execution and asks the operator a question.

Priority order:
  1. WebSocket path (when a frontend is connected and a requester is registered)
  2. CLI stdin via rich.Prompt (when running from the terminal)
  3. Auto-approve fallback (non-TTY, e.g. CI) — logs a warning and returns "proceed"
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any, Awaitable, Callable, List, Optional

from tools.base import ToolHandler

# Injected by api/server.py at startup.
# Signature: async (prompt: str, options: list[str] | None, timeout: float) -> str
_ws_requester: Optional[Callable[[str, Optional[List[str]], float], Awaitable[str]]] = None
_safety_mode: str = "interactive"


def set_ws_requester(
    fn: Callable[[str, Optional[List[str]], float], Awaitable[str]],
) -> None:
    """Register the WebSocket-backed human input function from the API server."""
    global _ws_requester
    _ws_requester = fn


def set_safety_mode(mode: str) -> None:
    """Set safety mode ('auto' skips blocking human prompts)."""
    global _safety_mode
    _safety_mode = mode


class HumanInputHandler(ToolHandler):
    async def _run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        prompt_text: str = inputs["prompt"]
        options: Optional[List[str]] = inputs.get("options")

        # _safety_mode alone used to short-circuit here ("== auto"), but every
        # daemon-launched session runs with --safety-mode auto regardless of
        # whether a real requester is registered (pyengine.go's
        # LaunchSwarmProcess hardcodes it) — so this silently auto-approved
        # every human_input call in daemon mode, the same shape of bug fixed
        # for the lifecycle phase gate. _ws_requester being set means a real
        # answer channel exists (the daemon's WS/question gate, or a real
        # frontend), so auto-mode must only short-circuit when there is no
        # requester to actually ask. Do not "simplify" this back to
        # `_safety_mode == "auto"` alone.
        if _safety_mode == "auto" and _ws_requester is None:
            _log_warn("human_input skipped in auto safety mode — auto-approving")
            return {"response": "proceed", "auto_approved": True}

        # Leave headroom so the outer tool timeout does not race the WS wait.
        timeout: float = max(30.0, float(self.spec.timeout) - 10.0)

        # ── Path 1: WebSocket → frontend ──────────────────────────────────────
        if _ws_requester is not None:
            try:
                response = await _ws_requester(prompt_text, options, timeout)
                return {"response": response}
            except asyncio.TimeoutError:
                if _safety_mode == "auto":
                    _log_warn("human_input WS timeout in auto mode — auto-approving")
                    return {"response": "proceed", "auto_approved": True}
                return {
                    "response": "proceed",
                    "auto_approved": True,
                    "warning": "No response from user within the timeout window; proceeding.",
                }
            except Exception as exc:
                _log_warn(f"WS human_input failed ({exc}), falling back to CLI")

        # ── Path 2: CLI stdin via rich.Prompt ────────────────────────────────
        if sys.stdin.isatty():
            try:
                from rich.console import Console
                from rich.prompt import Prompt

                console = Console()
                console.print("\n[bold yellow]⏸  Human input required:[/bold yellow]")
                console.print(f"[cyan]{prompt_text}[/cyan]")

                if options:
                    choices_str = " / ".join(f"[green]{o}[/green]" for o in options)
                    console.print(f"Options: {choices_str}")

                loop = asyncio.get_event_loop()
                response = await loop.run_in_executor(
                    None,
                    lambda: (
                        Prompt.ask("[bold]Your response[/bold]", choices=options)
                        if options
                        else Prompt.ask("[bold]Your response[/bold]")
                    ),
                )
                return {"response": response}
            except Exception as exc:
                _log_warn(f"CLI human_input failed ({exc}), using auto-approve")

        # ── Path 3: Non-interactive fallback ─────────────────────────────────
        _log_warn(
            "human_input called in a non-interactive environment with no WebSocket "
            "client connected. Auto-approving with 'proceed'. Connect the DevForge "
            "frontend to enable real-time human input from the UI."
        )
        return {"response": "proceed", "auto_approved": True}

    async def self_test(self) -> bool:
        return True  # Skip interactive prompt in automated tests


def _log_warn(msg: str) -> None:
    try:
        from observability.logutil import get_logger
        get_logger("tools.human_input").warning(msg)
    except Exception:
        print(f"[human_input] WARNING: {msg}", file=sys.stderr)


handler = HumanInputHandler()
