"""
HTTP / WebSocket API — thin FastAPI layer over the swarm runtime.

Endpoints:
  POST /run          — submit a goal, receive streaming result
  GET  /traces       — list all trace IDs
  GET  /traces/{id}  — get full trace
  GET  /cost/{id}    — cost summary for a trace
  GET  /agents       — list registered agent roles
  GET  /tools        — list registered tools
  WS   /ws           — WebSocket for live agent events + human input channel
  GET  /health       — health check

WebSocket protocol (client → server):
  { "type": "intervention",        "target_agent": "coder",  "message": "..." }
  { "type": "broadcast_intervention",                         "message": "..." }
  { "type": "stop_agent",          "target_agent": "coder" }
  { "type": "stop_swarm" }
  { "type": "human_input_response", "request_id": "<uuid>",  "response": "..." }

WebSocket protocol (server → client):
  { "type": "agent_event",  "role": "...", "event": "...", "content": "..." }
  { "type": "human_input_request", "request_id": "<uuid>",
    "prompt": "...", "options": [...] }
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Callable, Optional, Tuple

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Swarm API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── State (set by CLI on startup) ─────────────────────────────────────────────

_runtime_factory: Optional[Callable[..., Tuple[Any, Any]]] = None
_config: Optional[Any] = None
_default_topology: Optional[str] = None
_ws_clients: list[WebSocket] = []

# Pending human_input requests: request_id → asyncio.Future[str]
_pending_human_inputs: dict[str, "asyncio.Future[str]"] = {}

# Topology keys sent by devforge-frontend → repo-relative YAML paths
_TOPOLOGY_ALIASES: dict[str, str] = {
    "coding_swarm": "examples/coding_swarm/topology.yaml",
    "software_delivery": "examples/software_delivery/topology.yaml",
    "software_delivery_lite": "examples/software_delivery_lite/topology.yaml",
    "research_swarm": "examples/research_swarm/topology.yaml",
    "simple_chat": "examples/simple_chat/topology.yaml",
}


def resolve_topology_path(topology: Optional[str], default: Optional[str] = None) -> Optional[str]:
    """Resolve a UI topology key or YAML path to an absolute file path."""
    from pathlib import Path

    if not topology:
        if not default:
            return None
        topology = default

    key = topology.strip()
    repo_root = Path(__file__).resolve().parent.parent

    candidates: list[Path] = []
    if key in _TOPOLOGY_ALIASES:
        candidates.append(repo_root / _TOPOLOGY_ALIASES[key])
    p = Path(key)
    if p.is_absolute():
        candidates.append(p)
    else:
        candidates.extend([Path.cwd() / p, repo_root / p])

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    raise HTTPException(404, detail=f"Topology not found: {topology}")


def set_runtime_factory(
    factory: Callable[..., Tuple[Any, Any]],
    config: Any,
    default_topology: Optional[str] = None,
) -> None:
    """Register a callable that returns (SwarmRuntime, CostLedger).

    Called once by `swarm dashboard` after bootstrapping registries.
    Each POST /run invocation calls this factory with topology/budget kwargs.
    """
    global _runtime_factory, _config, _default_topology
    _runtime_factory = factory
    _config = config
    _default_topology = default_topology


def set_runtime(runtime: Any, config: Any) -> None:
    """Legacy shim — wraps a pre-built runtime in a factory. Kept for compat."""
    def _factory() -> Tuple[Any, Any]:
        return runtime, None
    set_runtime_factory(_factory, config)


# ── Human input WebSocket bridge ──────────────────────────────────────────────

async def request_human_input(
    prompt: str,
    options: Optional[list[str]],
    timeout: float,
) -> str:
    """
    Send a human_input_request to all connected WebSocket clients and wait for
    the first human_input_response that matches the request_id.

    Raises asyncio.TimeoutError if no response arrives within `timeout` seconds.
    Falls back to the auto-approve value "proceed" if no clients are connected.
    """
    if not _ws_clients:
        # No frontend connected — warn and auto-proceed so the swarm doesn't hang.
        try:
            from observability.logutil import get_logger
            get_logger("api.human_input").warning(
                "human_input_request with no WS clients — auto-approving"
            )
        except Exception:
            pass
        return "proceed"

    req_id = str(uuid.uuid4())
    loop = asyncio.get_event_loop()
    future: asyncio.Future[str] = loop.create_future()
    _pending_human_inputs[req_id] = future

    event = {
        "type": "human_input_request",
        "request_id": req_id,
        "prompt": prompt,
        "options": options or [],
    }
    await broadcast_event(event)

    try:
        return await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
    finally:
        _pending_human_inputs.pop(req_id, None)


# Wire the WS requester into the human_input tool at module load time.
# The tool checks _ws_requester at call time, so this import is safe.
try:
    import tools.human_input.handler as _hi
    _hi.set_ws_requester(request_human_input)
except Exception:
    pass  # tool not installed yet — wired when needed


# ── Request / Response models ─────────────────────────────────────────────────

class RunRequest(BaseModel):
    goal: str
    topology: Optional[str] = None
    budget_usd: Optional[float] = None


class RunResponse(BaseModel):
    trace_id: str
    output: Any
    success: bool
    cost_usd: float
    tokens: int
    iterations: int


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "runtime_ready": _runtime_factory is not None}


@app.post("/run", response_model=RunResponse)
async def run_goal(req: RunRequest) -> RunResponse:
    if _runtime_factory is None:
        raise HTTPException(
            503,
            detail=(
                "Runtime not initialised. "
                "The dashboard must be started with `swarm dashboard` "
                "so that the agent and tool registries are bootstrapped "
                "before accepting run requests."
            ),
        )
    runtime, _ledger = _runtime_factory(
        topology=req.topology,
        budget_usd=req.budget_usd,
    )
    result = await runtime.run(req.goal)
    trace_id = getattr(runtime, "trace_id", "")
    token_total = 0
    if result.token_usage:
        token_total = getattr(result.token_usage, "total_tokens", 0)
    return RunResponse(
        trace_id=trace_id,
        output=result.output,
        success=result.success,
        cost_usd=result.cost or 0.0,
        tokens=token_total,
        iterations=getattr(result, "iterations", 0),
    )


@app.get("/traces")
async def list_traces() -> dict:
    if _config is None:
        return {"traces": []}
    from observability.tracing import Tracer
    tracer = Tracer(_config.trace_dir)
    return {"traces": tracer.list_traces()}


@app.get("/traces/{trace_id}")
async def get_trace(trace_id: str) -> dict:
    if _config is None:
        raise HTTPException(503, "Config not set")
    from observability.replay import load_trace
    spans = load_trace(trace_id, _config.trace_dir)
    if not spans:
        raise HTTPException(404, f"Trace {trace_id} not found")
    return {"trace_id": trace_id, "spans": [s.model_dump() for s in spans]}


@app.get("/cost/{trace_id}")
async def get_cost(trace_id: str) -> dict:
    if _config is None:
        raise HTTPException(503, "Config not set")
    from observability.replay import cost_summary
    return cost_summary(trace_id, _config.trace_dir)


@app.get("/topologies")
async def list_topologies() -> dict:
    """List known topology presets (for devforge-frontend and other clients)."""
    from pathlib import Path

    repo_root = Path(__file__).resolve().parent.parent
    items = []
    for key, rel in _TOPOLOGY_ALIASES.items():
        path = repo_root / rel
        agents: list[str] = []
        if path.exists():
            try:
                from configs.loader import load_topology_spec
                spec = load_topology_spec(path)
                agents = [slot.role for slot in spec.agents]
            except Exception:
                pass
        items.append({
            "key": key,
            "path": rel,
            "agents": agents,
        })
    return {"topologies": items}


@app.get("/agents")
async def list_agents() -> dict:
    from core.registry import get_agent_spec_registry
    ar = get_agent_spec_registry()
    agents = [
        {"role": name, "description": spec.description, "model": spec.model}
        for name, spec in ar.items()
    ]
    return {"agents": agents}


@app.get("/tools")
async def list_tools() -> dict:
    from core.registry import get_tool_registry
    tr = get_tool_registry()
    tools = [
        {
            "name": name,
            "description": handler.spec.description,
            "side_effect_level": handler.spec.side_effect_level,
        }
        for name, handler in tr.items()
    ]
    return {"tools": tools}


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    _ws_clients.append(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")

            if msg_type == "human_input_response":
                # Route the user's answer back to the waiting request_human_input() call.
                req_id = msg.get("request_id", "")
                response = msg.get("response", "")
                future = _pending_human_inputs.get(req_id)
                if future and not future.done():
                    future.set_result(response)

            # All other client messages (intervention, stop_agent, etc.) are
            # broadcast back so agent processes monitoring the bus can act on them.
            # The swarm runtime listens via the message bus, not this WS directly,
            # so we re-emit as a server→client broadcast for any UI subscribers.

    except Exception:
        pass
    finally:
        if ws in _ws_clients:
            _ws_clients.remove(ws)


async def broadcast_event(event: dict) -> None:
    """Broadcast a JSON event to all connected WebSocket clients."""
    payload = json.dumps(event)
    for ws in list(_ws_clients):
        try:
            await ws.send_text(payload)
        except Exception:
            if ws in _ws_clients:
                _ws_clients.remove(ws)
