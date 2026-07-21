"""Shared daemon-routing config for any module that needs to call back into
the Go daemon (ide/shell) when running inside a container-mode IDE session.

Previously duplicated independently in tools/shell_exec/handler.py and
tools/filesystem/handler.py (each did its own `os.environ.get(...)`) — this
module is the single source of truth now that coordination/orchestrator.py
and coordination/safety.py need the same three values.

All three are None for a standalone `swarm run` from a terminal — every
consumer must treat that as "use the existing local/stdin fallback", not an
error condition.
"""

from __future__ import annotations

import os

DAEMON_URL: str | None = os.environ.get("TANGENT_DAEMON_URL")
DAEMON_TOKEN: str | None = os.environ.get("TANGENT_DAEMON_TOKEN")
SESSION_ID: str | None = os.environ.get("TANGENT_SESSION_ID")
