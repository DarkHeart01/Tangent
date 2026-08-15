"""Shared daemon-routing config for any module that needs to call back into
the Go daemon (ide/shell) when running inside a container-mode IDE session.

Previously duplicated independently in tools/shell_exec/handler.py and
tools/filesystem/handler.py (each did its own `os.environ.get(...)`) — this
module is the single source of truth now that coordination/orchestrator.py
and coordination/safety.py need the same values.

All of these are None for a standalone `swarm run` from a terminal — every
consumer must treat that as "use the existing local/stdin fallback", not an
error condition.

DAEMON_GRPC_TARGET (host:port, no scheme) is the channel — every call site
in this module's consumers gates on it. There used to be a DAEMON_URL
(HTTP) alongside it; removed once the Go side's HTTP execapi endpoints
were retired in favor of the gRPC services below.
"""

from __future__ import annotations

import os

DAEMON_GRPC_TARGET: str | None = os.environ.get("TANGENT_DAEMON_GRPC_TARGET")
DAEMON_TOKEN: str | None = os.environ.get("TANGENT_DAEMON_TOKEN")
SESSION_ID: str | None = os.environ.get("TANGENT_SESSION_ID")


def grpc_metadata() -> list[tuple[str, str]]:
    """The (authorization, x-session-id) metadata pair every daemon-routed
    gRPC call needs — mirrors the old `Authorization: Bearer <token>`
    header + `/sessions/{id}/...` URL segment, as gRPC metadata instead
    (see ide/shell/internal/execapi/grpc.go's authInterceptor)."""
    return [
        ("authorization", f"Bearer {DAEMON_TOKEN}"),
        ("x-session-id", SESSION_ID or ""),
    ]


def grpc_channel():
    """A fresh insecure grpc.aio channel to the daemon's execapi gRPC
    server — mirrors how every daemon-routed call site here already
    created a fresh httpx.AsyncClient per call rather than sharing one
    (same lifecycle discipline, new transport). 127.0.0.1-only, per-launch
    bearer token in metadata — no TLS needed, matching the HTTP path this
    replaces."""
    import grpc

    return grpc.aio.insecure_channel(DAEMON_GRPC_TARGET)
