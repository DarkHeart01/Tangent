"""Execute shell commands with working-directory jail and command denylist."""

from __future__ import annotations

import asyncio
import os
import shlex
from pathlib import Path
from typing import Any

from core.exceptions import SafetyError
from tools.base import ToolHandler

_CWD = Path.cwd()

# Set by the Go daemon (ide/shell) when this process was launched for a
# container-mode IDE session — see internal/session/pyengine.go. Absent for
# a standalone `swarm run` from a terminal, which must keep working exactly
# as before: that's the fallback branch below, unchanged from the original
# local-exec implementation.
_DAEMON_URL = os.environ.get("TANGENT_DAEMON_URL")
_DAEMON_TOKEN = os.environ.get("TANGENT_DAEMON_TOKEN")
_SESSION_ID = os.environ.get("TANGENT_SESSION_ID")

_DENYLIST = [
    "rm -rf /",
    "sudo",
    "mkfs",
    "dd if=",
    ":(){:|:&};:",  # fork bomb
    "chmod 777 /",
    "wget http",
    "curl http",
    "taskkill /im ",   # kills ALL processes by image name — use /pid instead
    "taskkill /f /im ", # same with force flag
    "killall ",        # kills all processes matching a name — use kill <pid> instead
    "pkill ",          # kills all processes matching a pattern — use kill <pid> instead
]


def _check_command(cmd: str) -> None:
    lower = cmd.lower()
    for blocked in _DENYLIST:
        if blocked in lower:
            raise SafetyError(f"Command blocked by denylist: contains '{blocked}'")


class ShellExecHandler(ToolHandler):
    async def _run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        command = inputs["command"]
        timeout = float(inputs.get("timeout", 30))
        working_dir = inputs.get("working_dir", ".")

        _check_command(command)

        # Denylist stays active on both branches — defense in depth, not
        # either/or with the container sandbox the daemon branch runs
        # inside (see hardening.go: cap-drop, read-only rootfs, non-root,
        # no network, no docker.sock).
        if _DAEMON_URL:
            return await self._run_via_daemon(command, working_dir, timeout)

        # Jail working directory
        exec_dir = (_CWD / working_dir).resolve()
        if not str(exec_dir).startswith(str(_CWD)):
            raise SafetyError("working_dir escapes project root")

        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(exec_dir),
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            return {
                "stdout": stdout.decode(errors="replace"),
                "stderr": stderr.decode(errors="replace"),
                "returncode": proc.returncode,
            }
        except asyncio.TimeoutError:
            proc.kill()
            return {"stdout": "", "stderr": "Command timed out", "returncode": -1}
        except Exception as exc:
            return {"stdout": "", "stderr": str(exc), "returncode": -1}

    async def _run_via_daemon(self, command: str, working_dir: str, timeout: float) -> dict[str, Any]:
        """Runs the command inside the session's sandboxed container via the
        Go daemon's execapi, instead of on the host. The working_dir jail
        above is skipped here on purpose — that check computes an absolute
        HOST path, but working_dir means something relative to /workspace
        *inside the container* in this branch; comparing it against _CWD
        would be checking the wrong root entirely. The daemon independently
        resolves and jails working_dir against /workspace on its side
        (ide/shell/internal/execapi/server.go's resolveContainerPath).
        """
        import httpx

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{_DAEMON_URL}/sessions/{_SESSION_ID}/exec",
                    json={"command": command, "working_dir": working_dir, "timeout_seconds": timeout},
                    headers={"Authorization": f"Bearer {_DAEMON_TOKEN}"},
                    timeout=timeout + 10,
                )
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPError as exc:
            return {"stdout": "", "stderr": f"daemon exec failed: {exc}", "returncode": -1}

    async def self_test(self) -> bool:
        r = await self._run({"command": "echo hello"})
        return r["returncode"] == 0 and "hello" in r["stdout"]


handler = ShellExecHandler()
