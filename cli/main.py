"""
Swarm CLI — primary user surface.

Commands:
  swarm run <topology> --goal "<text>"
  swarm chat [--path <dir>]
  swarm list agents|tools|providers|topologies
  swarm scaffold agent|tool|topology <name>
  swarm validate <file>
  swarm replay <trace-id>
  swarm trace <trace-id>
  swarm cost [<trace-id>|--since <date>]
  swarm dashboard
  swarm doctor
  swarm auth setup|show|clear
  swarm index build [--force]
  swarm index search "<query>" [--k N]
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

import click
from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from cli.auth import auth_cli
from observability.logutil import get_logger

# Load .env before anything reads os.environ (tools, providers, LLM clients)
load_dotenv(override=False)

console = Console()
log = get_logger("cli")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_config(
    api_key: Optional[str],
    model: Optional[str],
    log_level: str,
    trace_dir: str,
    safety_mode: str,
    provider: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
) -> "SwarmConfig":  # type: ignore[name-defined]
    from configs.loader import load_swarm_config
    overrides = {}
    if api_key:
        overrides["groq_api_key"] = api_key
    if openrouter_api_key:
        overrides["openrouter_api_key"] = openrouter_api_key
    if provider:
        overrides["provider"] = provider
    if model:
        overrides["default_model"] = model
    overrides["log_level"] = log_level
    overrides["trace_dir"] = trace_dir
    overrides["safety_mode"] = safety_mode
    return load_swarm_config(overrides)


def _setup_logging(cfg: "SwarmConfig") -> None:  # type: ignore[name-defined]
    from observability.logutil import configure_logging
    configure_logging(cfg.log_level, cfg.log_file)


def _enter_workdir(
    workdir: Optional[str], cfg: "SwarmConfig", topology: Optional[str] = None  # type: ignore[name-defined]
) -> Optional[str]:
    """Chdir into `workdir` (created if missing) and make it the project root.

    agents_dir/tools_dir/topology are swarm internals — resolved to absolute
    paths against the CURRENT (pre-chdir) install location, so they keep
    pointing at the swarm's own definitions no matter which directory
    development happens in. Everything else (traces, memory, code index,
    filesystem/git_ops/repo_inspect tool roots) resolves against the new cwd,
    since those must land inside the target project, self-contained.

    Returns the (possibly re-resolved) topology path.
    """
    if not workdir:
        return topology

    cfg.agents_dir = str(Path(cfg.agents_dir).resolve())
    cfg.tools_dir = str(Path(cfg.tools_dir).resolve())
    if topology:
        topology = str(Path(topology).resolve())

    target = Path(workdir)
    target.mkdir(parents=True, exist_ok=True)
    os.chdir(target)
    console.print(f"[dim]Working directory: {target.resolve()}[/dim]")

    # A freshly created (or previously non-git) project dir needs its own repo
    # so git_ops calls (status/add/commit) work from the first turn. Only done
    # for an explicit --path — never for the ambient cwd, since that may be an
    # existing checkout whose .git state we shouldn't guess at.
    if not (target / ".git").exists():
        import subprocess
        try:
            subprocess.run(["git", "init", "-q"], cwd=str(target), check=True)
            console.print(f"[dim]Initialised a new git repository in {target.resolve()}[/dim]")
        except (OSError, subprocess.CalledProcessError) as e:
            log.warning("git_init_failed", error=str(e))

    return topology


def _bootstrap(cfg: "SwarmConfig") -> tuple:  # type: ignore[name-defined]
    from core.registry import bootstrap_registries
    from observability.tracing import configure_tracer
    configure_tracer(cfg.trace_dir)
    tr, ar, pr = bootstrap_registries(
        tools_dir=cfg.tools_dir,
        agents_dir=cfg.agents_dir,
        groq_api_key=cfg.groq_api_key,
        openrouter_api_key=cfg.openrouter_api_key,
        gemini_api_key=cfg.gemini_api_key,
        openai_api_key=cfg.openai_api_key,
        default_model=cfg.default_model,
    )
    return tr, ar, pr


def _build_runtime(cfg, topology_path: Optional[str], deploy: bool = True):
    from configs.loader import load_topology_spec
    from configs.schema import TopologySpec, AgentSlot
    from coordination.bus import create_bus
    from coordination.orchestrator import SwarmRuntime
    from memory.longterm import LocalChromaMemory
    from observability.cost import reset_ledger
    from core.registry import get_tool_registry, get_agent_spec_registry, get_provider_registry

    tr = get_tool_registry()
    ar = get_agent_spec_registry()
    pr = get_provider_registry()

    if topology_path:
        topology = load_topology_spec(Path(topology_path))
    else:
        # Default single-agent topology using all registered agents
        roles = ar.list()
        topology = TopologySpec(
            name="default",
            agents=[AgentSlot(role=r) for r in roles] if roles else [AgentSlot(role="echo")],
        )

    bus = create_bus(cfg.bus_transport, cfg.redis_url)
    longterm = LocalChromaMemory(persist_dir=cfg.memory_dir)
    ledger = reset_ledger()

    agent_specs = {name: spec for name, spec in ar.items()}
    tool_handlers = {name: handler for name, handler in tr.items()}
    provider = pr.get_or_default(cfg.provider or "openrouter")
    code_searcher, code_index_builder = _build_code_index_components(cfg, pr)

    runtime = SwarmRuntime(
        topology=topology,
        provider=provider,
        tool_handlers=tool_handlers,
        agent_specs=agent_specs,
        bus=bus,
        longterm_memory=longterm,
        ledger=ledger,
        deployment_mode=cfg.deployment_mode,
        redis_url=cfg.redis_url,
        deploy=deploy,
        safety_mode=cfg.safety_mode,
        code_searcher=code_searcher,
        code_index_builder=code_index_builder,
        indexing_top_k=cfg.indexing.top_k,
    )
    return runtime, ledger


def _build_code_index_components(cfg, provider_registry):
    """Resolve an EmbeddingProvider — Gemini if configured, else a local
    offline fallback (see providers/local/adapter.py) — and, if available,
    construct the shared CodeIndexStore/Embedder pair used by both the
    auto-injected retrieval in Agent and the code_search/code_index_build tools.
    Returns (None, None) when indexing is disabled or no embedding-capable
    provider could be resolved at all — every call site treats that as
    "feature off"."""
    if not cfg.indexing.enabled:
        return None, None

    from providers.base import EmbeddingProvider

    embedding_provider = None
    embedding_model = cfg.indexing.embedding_model
    try:
        gemini = provider_registry.lookup("gemini")
        if isinstance(gemini, EmbeddingProvider):
            embedding_provider = gemini
    except Exception:
        pass

    if embedding_provider is None:
        from providers.local.adapter import DEFAULT_MODEL, LocalEmbeddingAdapter

        try:
            embedding_provider = LocalEmbeddingAdapter()
            embedding_model = DEFAULT_MODEL
            log.warning("gemini_unavailable_using_local_embeddings", reason="GEMINI_API_KEY not set")
        except Exception:
            return None, None

    from indexer.build import IndexBuilder
    from indexer.embedder import Embedder
    from indexer.search import CodeIndexSearcher
    from indexer.store import CodeIndexStore

    store = CodeIndexStore(index_dir=cfg.indexing.index_dir)
    embedder = Embedder(embedding_provider, embedding_model)
    searcher = CodeIndexSearcher(store, embedder)
    builder = IndexBuilder(
        store, embedder,
        exclude_dirs=cfg.indexing.exclude_dirs,
        chunk_lines=cfg.indexing.chunk_lines,
        chunk_overlap=cfg.indexing.chunk_overlap,
    )
    return searcher, builder


# ── Main group ────────────────────────────────────────────────────────────────

@click.group()
@click.version_option("0.1.0", prog_name="swarm")
def cli() -> None:
    """Swarm — a general-purpose, extensible LLM agent swarm. Supports Groq and OpenRouter."""


cli.add_command(auth_cli)


# ── run ───────────────────────────────────────────────────────────────────────

@cli.command()
@click.argument("topology", required=False, default=None)
@click.option("--goal", "-g", required=True, help="High-level goal for the swarm")
@click.option("--path", "-C", "workdir", default=None,
              help="Directory to develop in (created if missing). The swarm treats this as "
                   "the project root — all file writes, traces, memory, and the code index "
                   "live under it. Defaults to the current directory.")
@click.option("--provider", "-p", default=None, type=click.Choice(["groq", "openrouter"]), help="LLM provider to use")
@click.option("--api-key", envvar="GROQ_API_KEY", default=None, help="Groq API key")
@click.option("--openrouter-api-key", envvar="OPENROUTER_API_KEY", default=None, help="OpenRouter API key")
@click.option("--model", "-m", default=None, help="Override default LLM model")
@click.option("--log-level", default="INFO", show_default=True)
@click.option("--trace-dir", default="./traces", show_default=True)
@click.option("--safety-mode", default="interactive", type=click.Choice(["interactive", "auto"]))
@click.option("--budget", default=None, type=float, help="Max spend in USD")
@click.option("--resume-from", "resume_from", default=None,
              help="Resume a lifecycle run from this phase, skipping earlier phases and "
                   "reusing artifacts already approved at this --path (e.g. after a phase "
                   "failed). Only valid for lifecycle-strategy topologies; must reuse the "
                   "same --path as the run being resumed.")
@click.option("--json", "output_json", is_flag=True, help="Output result as JSON")
def run(
    topology: Optional[str],
    goal: str,
    workdir: Optional[str],
    provider: Optional[str],
    api_key: Optional[str],
    openrouter_api_key: Optional[str],
    model: Optional[str],
    log_level: str,
    trace_dir: str,
    safety_mode: str,
    budget: Optional[float],
    resume_from: Optional[str],
    output_json: bool,
) -> None:
    """Launch a swarm against a goal.

    TOPOLOGY is an optional path to a topology YAML file.
    If omitted, a default single-agent topology is used.

    \b
    Example:
      swarm run --goal "Research the latest LLM benchmarks"
      swarm run --provider openrouter --model deepseek/deepseek-v4-pro --goal "..."
      swarm run configs/research.yaml --goal "Write a Python web scraper"
      swarm run --path ./my-app --goal "Build a todo app"
    """
    cfg = _load_config(api_key, model, log_level, trace_dir, safety_mode, provider, openrouter_api_key)
    _setup_logging(cfg)
    topology = _enter_workdir(workdir, cfg, topology)

    active_provider = cfg.provider or "openrouter"
    if active_provider == "openrouter" and not cfg.openrouter_api_key:
        console.print("[bold red]Error:[/bold red] OPENROUTER_API_KEY is not set.")
        console.print("  Set it in .env or pass --openrouter-api-key")
        sys.exit(1)
    if active_provider == "groq" and not cfg.groq_api_key:
        console.print("[bold red]Error:[/bold red] GROQ_API_KEY is not set.")
        console.print("  Set it in .env or pass --api-key")
        sys.exit(1)

    _bootstrap(cfg)

    runtime, ledger = _build_runtime(cfg, topology)
    if budget:
        runtime.topology.budget.max_cost_usd = budget

    if resume_from:
        if runtime.topology.coordination.strategy != "lifecycle":
            console.print("[bold red]Error:[/bold red] --resume-from requires a "
                           "lifecycle-strategy topology.")
            sys.exit(1)
        from coordination.orchestrator import _load_lifecycle
        lifecycle_name = runtime.topology.coordination.lifecycle or "software_delivery"
        phase_ids = [p["id"] for p in _load_lifecycle(lifecycle_name).get("phases", [])]
        if resume_from not in phase_ids:
            console.print(f"[bold red]Error:[/bold red] Unknown phase '{resume_from}' "
                           f"for lifecycle '{lifecycle_name}'.\nValid phases: {', '.join(phase_ids)}")
            sys.exit(1)
        runtime._resume_from_phase = resume_from
        console.print(f"[dim]Resuming from phase '{resume_from}' — earlier phases are skipped "
                       "and their already-approved artifacts are reused.[/dim]")

    console.print(Panel(
        f"[bold cyan]Goal:[/bold cyan] {goal}\n"
        f"[dim]Trace ID:[/dim] {runtime.trace_id[:8]}…",
        title="[bold]Swarm Run[/bold]",
        border_style="blue",
    ))

    result = asyncio.run(runtime.run(goal))

    if output_json:
        click.echo(json.dumps({
            "trace_id": runtime.trace_id,
            "output": result.output,
            "success": result.success,
            "cost_usd": result.cost,
            "tokens": result.token_usage.total_tokens,
            "iterations": result.iterations,
            "error": result.error,
        }, indent=2))
        return

    border = "green" if result.success else "red"
    status = "✓ Complete" if result.success else "✗ Failed"
    console.print(Panel(
        str(result.output or result.error or "No output"),
        title=f"[bold]{status}[/bold]",
        border_style=border,
    ))
    console.print(
        f"[dim]Cost: ${result.cost:.4f}  |  "
        f"Tokens: {result.token_usage.total_tokens}  |  "
        f"Iterations: {result.iterations}  |  "
        f"Trace: {runtime.trace_id[:8]}[/dim]"
    )


# ── chat ──────────────────────────────────────────────────────────────────────

# Tools exposed to the interactive chat session: read/write/investigate a project
# directly. Deliberately excludes swarm-internal tools (spawn_agent, send_message,
# artifact_write, memory_store, human_input, etc.) that only make sense inside a
# multi-agent lifecycle run — that's what /swarm is for.
_CHAT_TOOLS = frozenset({
    "filesystem", "code_search", "repo_inspect", "shell_exec", "git_ops",
    "linter_run", "ast_inspect", "code_sandbox", "test_runner", "artifact_read",
})

_CHAT_HELP = """\
[bold]Commands[/bold]
  /help              Show this help
  /swarm <goal>      Launch the full multi-agent build pipeline for <goal> at this path
  /model [name]      Show or switch the model used for chat responses
  /clear             Reset the conversation (same working directory, fresh context)
  /exit, /quit       Leave the session

Anything else goes straight to the assistant — paste an error, describe a bug, ask
for a change. It has filesystem/shell/git/lint/test/code-search access right here.\
"""


@cli.command()
@click.option("--path", "-C", "workdir", default=None,
              help="Directory to work in (created if missing). Defaults to the current directory.")
@click.option("--provider", "-p", default=None, type=click.Choice(["groq", "openrouter"]), help="LLM provider to use")
@click.option("--api-key", envvar="GROQ_API_KEY", default=None, help="Groq API key")
@click.option("--openrouter-api-key", envvar="OPENROUTER_API_KEY", default=None, help="OpenRouter API key")
@click.option("--model", "-m", default=None, help="Starting model for chat responses (switch anytime with /model)")
@click.option("--log-level", default="WARNING", show_default=True)
@click.option("--trace-dir", default="./traces", show_default=True)
@click.option("--safety-mode", default="interactive", type=click.Choice(["interactive", "auto"]),
              help="Safety mode applied to any /swarm builds launched from this session")
@click.option("--budget", default=8.0, type=float, show_default=True,
              help="Max spend in USD for any /swarm build launched from this session")
def chat(
    workdir: Optional[str],
    provider: Optional[str],
    api_key: Optional[str],
    openrouter_api_key: Optional[str],
    model: Optional[str],
    log_level: str,
    trace_dir: str,
    safety_mode: str,
    budget: float,
) -> None:
    """Interactive back-and-forth session — chat, paste bugs, ask for fixes.

    A single stateful model with direct tool access (filesystem, shell, git, lint,
    test, code search) handles ordinary back-and-forth. Type /swarm <goal> from
    inside the session to switch into the full multi-agent build pipeline for a
    new app/feature; everything else stays in fast, stateful single-model chat.

    \b
    Example:
      swarm chat --path ./my-app
    """
    cfg = _load_config(api_key, model, log_level, trace_dir, safety_mode, provider, openrouter_api_key)
    _setup_logging(cfg)
    _enter_workdir(workdir, cfg)

    active_provider = cfg.provider or "openrouter"
    if active_provider == "openrouter" and not cfg.openrouter_api_key:
        console.print("[bold red]Error:[/bold red] OPENROUTER_API_KEY is not set.")
        sys.exit(1)
    if active_provider == "groq" and not cfg.groq_api_key:
        console.print("[bold red]Error:[/bold red] GROQ_API_KEY is not set.")
        sys.exit(1)

    tr, ar, pr = _bootstrap(cfg)
    llm_provider = pr.get_or_default(active_provider)

    code_searcher, code_index_builder = _build_code_index_components(cfg, pr)
    if code_searcher:
        import tools.code_search.handler as cs_h
        cs_h.set_searcher(code_searcher)

    chat_tools = {name: handler for name, handler in tr.items() if name in _CHAT_TOOLS}

    from observability.cost import reset_ledger
    ledger = reset_ledger()

    asyncio.run(_chat_main(cfg, llm_provider, chat_tools, code_index_builder,
                            ledger, cfg.default_model, safety_mode, budget))


async def _chat_main(cfg, llm_provider, chat_tools, code_index_builder, ledger,
                      session_model, safety_mode, budget) -> None:
    from core.chat_session import ChatSession

    if code_index_builder:
        try:
            await code_index_builder.build()
        except Exception as exc:
            log.warning("chat_index_build_failed", error=str(exc))

    session = ChatSession(llm_provider, session_model, chat_tools, ledger=ledger)

    console.print(Panel(
        f"[bold cyan]DevForge Chat[/bold cyan]\n"
        f"[dim]Path:[/dim]  {Path.cwd()}\n"
        f"[dim]Model:[/dim] {session_model}\n"
        f"[dim]Tools:[/dim] {', '.join(sorted(chat_tools))}\n\n"
        "Type your message, or /help for commands.",
        border_style="cyan",
    ))

    await session.seed_repo_overview()

    def _on_tool_call(name: str, args: dict) -> None:
        preview = json.dumps(args, default=str)
        if len(preview) > 120:
            preview = preview[:120] + "…"
        console.print(f"  [dim]→ {name}({preview})[/dim]")

    def _on_tool_result(name: str, result: dict) -> None:
        if isinstance(result, dict) and result.get("error"):
            console.print(f"  [red]✗ {name}: {str(result['error'])[:200]}[/red]")
        else:
            console.print(f"  [dim]✓ {name}[/dim]")

    while True:
        try:
            user_text = (await asyncio.to_thread(console.input, "\n[bold cyan]you>[/bold cyan] ")).strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[dim]Goodbye.[/dim]")
            return

        if not user_text:
            continue

        if user_text.startswith("/"):
            parts = user_text.split(maxsplit=1)
            cmd, arg = parts[0].lower(), (parts[1].strip() if len(parts) > 1 else "")

            if cmd in ("/exit", "/quit"):
                console.print("[dim]Goodbye.[/dim]")
                return
            elif cmd == "/help":
                console.print(_CHAT_HELP)
            elif cmd == "/clear":
                session.clear()
                console.print("[dim]Conversation cleared.[/dim]")
            elif cmd == "/model":
                if arg:
                    session.switch_model(arg)
                    console.print(f"[dim]Model switched to '{arg}'.[/dim]")
                else:
                    console.print(f"[dim]Current model: {session.model}[/dim]")
            elif cmd == "/swarm":
                if not arg:
                    console.print("[yellow]Usage: /swarm <goal>[/yellow]")
                else:
                    await _run_swarm_from_chat(cfg, arg, safety_mode, budget)
            else:
                console.print(f"[yellow]Unknown command '{cmd}'. Try /help.[/yellow]")
            continue

        try:
            reply = await session.send(user_text, on_tool_call=_on_tool_call, on_tool_result=_on_tool_result)
        except Exception as exc:
            console.print(f"[bold red]Error:[/bold red] {exc}")
            continue

        console.print(f"\n[bold green]assistant>[/bold green] {reply}")
        console.print(f"[dim]Session cost: ${session.total_cost:.4f}[/dim]")


async def _run_swarm_from_chat(cfg, goal: str, safety_mode: str, budget: float) -> None:
    """Launch the full lifecycle build pipeline for one goal, then return to chat."""
    swarm_topology = str(Path(__file__).parent.parent / "examples" / "software_delivery_lite" / "topology.yaml")
    swarm_cfg = cfg.model_copy(update={"safety_mode": safety_mode})

    runtime, _ = _build_runtime(swarm_cfg, swarm_topology)
    runtime.topology.budget.max_cost_usd = budget

    console.print(Panel(
        f"[bold magenta]Swarm build[/bold magenta]\n"
        f"[dim]Goal:[/dim]  {goal}\n"
        f"[dim]Trace:[/dim] {runtime.trace_id[:8]}…\n"
        f"[dim]Budget:[/dim] ${budget:.2f}",
        border_style="magenta",
    ))

    result = await runtime.run(goal)

    border = "green" if result.success else "red"
    status = "✓ Complete" if result.success else "✗ Failed"
    console.print(Panel(
        str(result.output or result.error or "No output"),
        title=f"[bold]Swarm build {status}[/bold]",
        border_style=border,
    ))
    console.print(
        f"[dim]Cost: ${result.cost:.4f}  |  Tokens: {result.token_usage.total_tokens}  |  "
        f"Trace: {runtime.trace_id[:8]}[/dim]\n"
        "[dim]Back to chat — ask about what was built, or keep going.[/dim]"
    )


# ── list ──────────────────────────────────────────────────────────────────────

@cli.command("list")
@click.argument("kind", type=click.Choice(["agents", "tools", "providers", "topologies"]))
@click.option("--agents-dir", default="./agents")
@click.option("--tools-dir", default="./tools")
@click.option("--configs-dir", default="./configs")
@click.option("--json", "output_json", is_flag=True)
def list_cmd(
    kind: str, agents_dir: str, tools_dir: str, configs_dir: str, output_json: bool
) -> None:
    """List registered agents, tools, providers, or topologies."""
    from configs.loader import load_swarm_config
    cfg = load_swarm_config()
    _setup_logging(cfg)

    if kind == "agents":
        from configs.loader import load_agent_spec
        rows = []
        for spec_path in sorted(Path(agents_dir).rglob("spec.yaml")):
            try:
                s = load_agent_spec(spec_path)
                rows.append((s.role, s.description[:60], s.model, ", ".join(s.tools[:3])))
            except Exception as e:
                rows.append((str(spec_path), f"ERROR: {e}", "", ""))
        if output_json:
            click.echo(json.dumps([{"role": r[0], "description": r[1]} for r in rows], indent=2))
            return
        t = Table(title="Registered Agents")
        for col in ("Role", "Description", "Model", "Tools"):
            t.add_column(col)
        for row in rows:
            t.add_row(*row)
        console.print(t)

    elif kind == "tools":
        from configs.loader import load_tool_spec
        rows = []
        for spec_path in sorted(Path(tools_dir).rglob("spec.yaml")):
            try:
                s = load_tool_spec(spec_path)
                rows.append((s.name, s.description[:60], s.side_effect_level))
            except Exception as e:
                rows.append((str(spec_path), f"ERROR: {e}", ""))
        if output_json:
            click.echo(json.dumps([{"name": r[0], "description": r[1]} for r in rows], indent=2))
            return
        t = Table(title="Registered Tools")
        for col in ("Name", "Description", "Side Effects"):
            t.add_column(col)
        for row in rows:
            t.add_row(*row)
        console.print(t)

    elif kind == "providers":
        rows = [
            ("groq", "Groq LLaMA API", "https://groq.com"),
            ("openrouter", "OpenRouter (OpenAI-compatible multi-model)", "https://openrouter.ai"),
        ]
        if output_json:
            click.echo(json.dumps([{"name": r[0]} for r in rows], indent=2))
            return
        t = Table(title="Providers")
        for col in ("Name", "Description", "URL"):
            t.add_column(col)
        for row in rows:
            t.add_row(*row)
        console.print(t)

    elif kind == "topologies":
        rows = []
        for p in sorted(Path(configs_dir).glob("*.yaml")):
            rows.append((p.stem, str(p)))
        if output_json:
            click.echo(json.dumps([{"name": r[0], "path": r[1]} for r in rows], indent=2))
            return
        t = Table(title="Topology Files")
        for col in ("Name", "Path"):
            t.add_column(col)
        for row in rows:
            t.add_row(*row)
        console.print(t)


# ── scaffold ──────────────────────────────────────────────────────────────────

@cli.command()
@click.argument("kind", type=click.Choice(["agent", "tool", "topology"]))
@click.argument("name")
@click.option("--agents-dir", default="./agents")
@click.option("--tools-dir", default="./tools")
@click.option("--configs-dir", default="./configs")
def scaffold(
    kind: str, name: str, agents_dir: str, tools_dir: str, configs_dir: str
) -> None:
    """Generate a new agent, tool, or topology template.

    \b
    Examples:
      swarm scaffold agent my-analyst
      swarm scaffold tool sql-query
      swarm scaffold topology data-pipeline
    """
    from cli.scaffold import scaffold_agent, scaffold_tool, scaffold_topology
    if kind == "agent":
        scaffold_agent(name, agents_dir)
    elif kind == "tool":
        scaffold_tool(name, tools_dir)
    elif kind == "topology":
        scaffold_topology(name, configs_dir)


# ── validate ──────────────────────────────────────────────────────────────────

@cli.command()
@click.argument("path")
def validate(path: str) -> None:
    """Validate a spec or topology YAML file."""
    p = Path(path)
    if not p.exists():
        console.print(f"[red]File not found: {path}[/red]")
        sys.exit(1)
    try:
        if "agents" in str(p):
            from configs.loader import load_agent_spec
            s = load_agent_spec(p)
            console.print(f"[green]✓ Agent spec valid:[/green] role={s.role}, model={s.model}")
        elif "tools" in str(p):
            from configs.loader import load_tool_spec
            s = load_tool_spec(p)
            console.print(f"[green]✓ Tool spec valid:[/green] name={s.name}")
        else:
            from configs.loader import load_topology_spec
            s = load_topology_spec(p)
            console.print(f"[green]✓ Topology valid:[/green] name={s.name}")
    except Exception as exc:
        console.print(f"[bold red]✗ Validation failed:[/bold red] {exc}")
        sys.exit(1)


# ── trace ─────────────────────────────────────────────────────────────────────

@cli.command()
@click.argument("trace_id")
@click.option("--trace-dir", default="./traces")
@click.option("--json", "output_json", is_flag=True)
def trace(trace_id: str, trace_dir: str, output_json: bool) -> None:
    """Pretty-print or dump a trace."""
    from observability.replay import load_trace, pretty_print_trace
    spans = load_trace(trace_id, trace_dir)
    if not spans:
        console.print(f"[red]Trace '{trace_id}' not found in {trace_dir}[/red]")
        sys.exit(1)
    if output_json:
        click.echo(json.dumps([s.model_dump(mode="json") for s in spans], indent=2, default=str))
    else:
        pretty_print_trace(spans)


# ── replay ────────────────────────────────────────────────────────────────────

@cli.command()
@click.argument("trace_id")
@click.option("--trace-dir", default="./traces")
@click.option("--fresh", is_flag=True, help="Re-run with live LLM calls instead of cached outputs")
def replay(trace_id: str, trace_dir: str, fresh: bool) -> None:
    """Re-execute a historical trace for debugging or regression testing."""
    from observability.replay import load_trace, pretty_print_trace
    spans = load_trace(trace_id, trace_dir)
    if not spans:
        console.print(f"[red]Trace {trace_id!r} not found[/red]")
        sys.exit(1)

    if not fresh:
        console.print(f"[yellow]Replaying trace {trace_id[:8]} (deterministic — cached outputs)[/yellow]")
        pretty_print_trace(spans)
        console.print("[dim]Use --fresh to re-run with live LLM calls[/dim]")
    else:
        console.print(f"[yellow]Fresh replay not yet implemented — use 'swarm run' instead[/yellow]")


# ── cost ──────────────────────────────────────────────────────────────────────

@cli.command()
@click.argument("trace_id", required=False)
@click.option("--trace-dir", default="./traces")
@click.option("--json", "output_json", is_flag=True)
def cost(trace_id: Optional[str], trace_dir: str, output_json: bool) -> None:
    """Show token usage and cost for a trace (or all traces)."""
    from observability.replay import cost_summary, load_trace
    from observability.tracing import Tracer

    tracer = Tracer(trace_dir)

    if trace_id:
        summary = cost_summary(trace_id, trace_dir)
        if output_json:
            click.echo(json.dumps(summary, indent=2))
        else:
            t = Table(title=f"Cost: {trace_id[:8]}")
            t.add_column("Metric")
            t.add_column("Value")
            t.add_row("Total cost (USD)", f"${summary['total_cost_usd']:.6f}")
            t.add_row("Total tokens", str(summary["total_tokens"]))
            t.add_row("Spans", str(summary["span_count"]))
            console.print(t)
    else:
        trace_ids = tracer.list_traces()
        rows = []
        for tid in trace_ids[-20:]:
            s = cost_summary(tid, trace_dir)
            rows.append((tid[:8], f"${s['total_cost_usd']:.6f}", str(s["total_tokens"])))
        if output_json:
            click.echo(json.dumps(rows, indent=2))
        else:
            t = Table(title="Cost Summary (last 20 traces)")
            for col in ("Trace ID", "Cost (USD)", "Tokens"):
                t.add_column(col)
            for row in rows:
                t.add_row(*row)
            console.print(t)


# ── dashboard ─────────────────────────────────────────────────────────────────

@cli.command()
@click.option("--host", default="0.0.0.0", show_default=True)
@click.option("--port", default=8765, type=int, show_default=True)
@click.option("--api-key", envvar="GROQ_API_KEY", default=None, help="Groq API key")
@click.option("--openrouter-api-key", envvar="OPENROUTER_API_KEY", default=None, help="OpenRouter API key")
@click.option("--provider", "-p", default=None, type=click.Choice(["groq", "openrouter"]))
@click.option("--topology", default=None, help="Optional topology YAML path")
@click.option("--log-level", default="INFO", show_default=True)
def dashboard(
    host: str,
    port: int,
    api_key: Optional[str],
    openrouter_api_key: Optional[str],
    provider: Optional[str],
    topology: Optional[str],
    log_level: str,
) -> None:
    """Start the local API server and open the dashboard."""
    import uvicorn

    cfg = _load_config(
        api_key=api_key,
        model=None,
        log_level=log_level,
        trace_dir="./traces",
        safety_mode="auto",   # API mode: no interactive prompts
        provider=provider,
        openrouter_api_key=openrouter_api_key,
    )
    _setup_logging(cfg)

    # Bootstrap registries once so all tools/agents/providers are available
    # to the per-request factory below.
    _bootstrap(cfg)

    console.print(Panel(
        f"[bold cyan]Swarm Dashboard[/bold cyan]\n"
        f"API:  http://{host}:{port}\n"
        f"Docs: http://{host}:{port}/docs\n"
        f"Provider: {cfg.provider or 'openrouter'}",
        border_style="cyan",
    ))

    # Wire a factory so each POST /run gets a fresh, isolated SwarmRuntime.
    # Using a factory (rather than a single shared runtime) prevents state
    # leakage between consecutive API calls.
    cli_topology = topology

    def _make_runtime(
        topology: Optional[str] = None,
        budget_usd: Optional[float] = None,
    ):
        from api.server import resolve_topology_path

        topo_path = resolve_topology_path(topology, default=cli_topology)
        runtime, ledger = _build_runtime(cfg, topology_path=topo_path, deploy=False)
        if budget_usd is not None:
            runtime.topology.budget.max_cost_usd = budget_usd
        return runtime, ledger

    from api.server import app, set_runtime_factory
    set_runtime_factory(_make_runtime, cfg, default_topology=cli_topology)

    uvicorn.run(app, host=host, port=port, log_level="warning")


# ── doctor ────────────────────────────────────────────────────────────────────

@cli.command()
@click.option("--api-key", envvar="GROQ_API_KEY", default=None)
@click.option("--openrouter-api-key", envvar="OPENROUTER_API_KEY", default=None)
@click.option("--agents-dir", default="./agents")
@click.option("--tools-dir", default="./tools")
def doctor(api_key: Optional[str], openrouter_api_key: Optional[str], agents_dir: str, tools_dir: str) -> None:
    """Validate the environment, credentials, and registry integrity."""
    ok = True

    def check(label: str, condition: bool, fix: str = "") -> None:
        nonlocal ok
        icon = "[green]✓[/green]" if condition else "[red]✗[/red]"
        console.print(f"  {icon}  {label}")
        if not condition:
            ok = False
            if fix:
                console.print(f"      [dim]Fix: {fix}[/dim]")

    console.print("[bold]Swarm Doctor[/bold]\n")

    # Credentials
    from dotenv import load_dotenv
    load_dotenv()
    import os
    key = api_key or os.environ.get("GROQ_API_KEY", "")
    or_key = openrouter_api_key or os.environ.get("OPENROUTER_API_KEY", "")
    provider = os.environ.get("SWARM_PROVIDER", "openrouter").lower()

    if provider == "openrouter":
        check("OPENROUTER_API_KEY is set", bool(or_key), "Set OPENROUTER_API_KEY in .env or environment")
    elif provider == "groq":
        check("GROQ_API_KEY is set", bool(key), "Set GROQ_API_KEY in .env or environment")
    else:
        check(
            "LLM API key configured (GROQ or OpenRouter)",
            bool(key) or bool(or_key),
            "Set OPENROUTER_API_KEY or GROQ_API_KEY in .env or environment",
        )

    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    check("GEMINI_API_KEY is set (higher-quality code_search embeddings)", bool(gemini_key),
          "Optional — without it the code indexer falls back to a local offline embedding model")
    try:
        idx_dir = Path(".devforge/index")
        idx_dir.mkdir(parents=True, exist_ok=True)
        test_file = idx_dir / ".write_test"
        test_file.write_text("ok")
        test_file.unlink()
        check("Code index directory is writable (.devforge/index)", True)
    except OSError as e:
        check("Code index directory is writable (.devforge/index)", False, str(e))

    # Directories
    check("agents/ directory exists", Path(agents_dir).exists(), f"mkdir {agents_dir}")
    check("tools/ directory exists", Path(tools_dir).exists(), f"mkdir {tools_dir}")

    # Spec files
    agent_specs = list(Path(agents_dir).rglob("spec.yaml"))
    tool_specs = list(Path(tools_dir).rglob("spec.yaml"))
    check(f"Found {len(agent_specs)} agent spec(s)", len(agent_specs) > 0)
    check(f"Found {len(tool_specs)} tool spec(s)", len(tool_specs) > 0)

    # Validate all specs
    from configs.loader import load_agent_spec, load_tool_spec
    for p in agent_specs:
        try:
            load_agent_spec(p)
            check(f"  Agent spec valid: {p.parent.name}", True)
        except Exception as e:
            check(f"  Agent spec valid: {p.parent.name}", False, str(e))

    for p in tool_specs:
        try:
            load_tool_spec(p)
            check(f"  Tool spec valid: {p.parent.name}", True)
        except Exception as e:
            check(f"  Tool spec valid: {p.parent.name}", False, str(e))

    # Python packages
    packages = [
        ("groq", "pip install groq"),
        ("pydantic", "pip install pydantic"),
        ("structlog", "pip install structlog"),
        ("rich", "pip install rich"),
        ("duckduckgo_search", "pip install duckduckgo-search"),
        ("httpx", "pip install httpx"),
        ("bs4", "pip install beautifulsoup4"),
        ("networkx", "pip install networkx"),
        ("fastapi", "pip install fastapi"),
    ]
    for pkg, fix in packages:
        try:
            __import__(pkg)
            check(f"Package '{pkg}'", True)
        except ImportError:
            check(f"Package '{pkg}'", False, fix)

    console.print()
    if ok:
        console.print("[bold green]All checks passed — ready to run![/bold green]")
    else:
        console.print("[bold red]Some checks failed. Fix the issues above and re-run.[/bold red]")
        sys.exit(1)


# ── Index commands ────────────────────────────────────────────────────────────

@cli.group("index")
def index_group() -> None:
    """Manage the local semantic code index used by the code_search tool."""


@index_group.command("build")
@click.option("--force", is_flag=True, help="Re-embed every file even if unchanged")
@click.option("--agents-dir", default="./agents")
@click.option("--tools-dir", default="./tools")
def index_build(force: bool, agents_dir: str, tools_dir: str) -> None:
    """Build (or incrementally refresh) the code index for the current repo."""
    from configs.loader import load_swarm_config

    cfg = load_swarm_config({"agents_dir": agents_dir, "tools_dir": tools_dir})
    _setup_logging(cfg)
    _, _, pr = _bootstrap(cfg)

    _, builder = _build_code_index_components(cfg, pr)
    if builder is None:
        console.print("[red]Code indexing is not configured.[/red] It is disabled in config, or the "
                      "local fallback embedding model failed to load (see logs) — check that chromadb "
                      "is installed, or set GEMINI_API_KEY in .env and retry.")
        sys.exit(1)

    stats = asyncio.run(builder.build(force=force))
    t = Table(title="Index build complete")
    for col in ("Files indexed", "Files skipped", "Files removed", "Chunks", "Duration (s)"):
        t.add_column(col)
    t.add_row(str(stats.files_indexed), str(stats.files_skipped), str(stats.files_removed),
              str(stats.chunks_total), str(stats.duration_s))
    console.print(t)


@index_group.command("search")
@click.argument("query")
@click.option("--k", default=6, help="Number of results")
@click.option("--path-filter", default=None, help="Restrict results to file paths containing this substring")
@click.option("--agents-dir", default="./agents")
@click.option("--tools-dir", default="./tools")
def index_search(query: str, k: int, path_filter: Optional[str], agents_dir: str, tools_dir: str) -> None:
    """Search the local code index and print ranked results."""
    from configs.loader import load_swarm_config

    cfg = load_swarm_config({"agents_dir": agents_dir, "tools_dir": tools_dir})
    _setup_logging(cfg)
    _, _, pr = _bootstrap(cfg)

    searcher, _ = _build_code_index_components(cfg, pr)
    if searcher is None:
        console.print("[red]Code indexing is not configured.[/red] It is disabled in config, or the "
                      "local fallback embedding model failed to load (see logs) — check that chromadb "
                      "is installed, or set GEMINI_API_KEY in .env and retry.")
        sys.exit(1)

    results = asyncio.run(searcher.search(query, k=k, path_filter=path_filter))
    if not results:
        console.print("[dim]No results.[/dim]")
        return

    t = Table(title=f"Code search: {query!r}")
    for col in ("Score", "File", "Lines", "Symbol", "Kind"):
        t.add_column(col)
    for r in results:
        t.add_row(f"{r.score:.3f}", r.file, f"{r.start_line}-{r.end_line}", r.symbol, r.kind)
    console.print(t)


# ── Artifact commands ─────────────────────────────────────────────────────────

@cli.group("artifact")
def artifact_group() -> None:
    """Inspect and manage workforce artifacts."""


@artifact_group.command("list")
@click.option("--project", default="", help="Filter by project id")
@click.option("--type", "artifact_type", default="", help="Filter by artifact type")
@click.option("--stage", default="", help="Filter by stage id")
@click.option("--status", default="any", type=click.Choice(["draft", "approved", "superseded", "any"]))
@click.option("--memory-dir", default="./memory_store")
@click.option("--json", "output_json", is_flag=True)
def artifact_list(
    project: str, artifact_type: str, stage: str, status: str,
    memory_dir: str, output_json: bool
) -> None:
    """List artifacts in the registry.

    \b
    Examples:
      swarm artifact list
      swarm artifact list --type PRD --status approved
      swarm artifact list --stage planning --project my-project
    """
    from memory.artifacts import ArtifactRegistry

    reg = ArtifactRegistry(persist_dir=memory_dir)

    async def _fetch():
        if artifact_type:
            items = await reg.list_by_type(artifact_type, project_id=project, stage_id=stage)
        elif stage:
            items = await reg.list_by_stage(stage, project_id=project)
        else:
            items = await reg.list_all(project_id=project)
        if status != "any":
            items = [
                a for a in items
                if (a.status if isinstance(a.status, str) else a.status.value) == status
            ]
        return items

    items = asyncio.run(_fetch())

    if output_json:
        click.echo(json.dumps([a.model_dump(mode="json") for a in items], indent=2, default=str))
        return

    t = Table(title=f"Artifacts ({len(items)})")
    for col in ("ID", "Type", "Stage", "Status", "Created"):
        t.add_column(col)
    for a in items:
        console.print(t.add_row(
            a.id[:8],
            a.artifact_type if isinstance(a.artifact_type, str) else a.artifact_type.value,
            a.stage_id or "—",
            a.status if isinstance(a.status, str) else a.status.value,
            a.created_at.strftime("%Y-%m-%d %H:%M"),
        ) or "")
    console.print(t)


@artifact_group.command("show")
@click.argument("artifact_id")
@click.option("--memory-dir", default="./memory_store")
@click.option("--json", "output_json", is_flag=True)
def artifact_show(artifact_id: str, memory_dir: str, output_json: bool) -> None:
    """Pretty-print a single artifact including lineage.

    \b
    Example:
      swarm artifact show abc12345
    """
    from memory.artifacts import ArtifactRegistry

    reg = ArtifactRegistry(persist_dir=memory_dir)

    async def _fetch():
        artifact = await reg.get_by_id(artifact_id)
        if artifact is None:
            # Try prefix search — find first matching id
            all_items = await reg.list_all()
            for a in all_items:
                if a.id.startswith(artifact_id):
                    artifact = a
                    break
        lineage = await reg.get_lineage(artifact.id) if artifact else []
        return artifact, lineage

    artifact, lineage = asyncio.run(_fetch())

    if artifact is None:
        console.print(f"[red]Artifact '{artifact_id}' not found.[/red]")
        sys.exit(1)

    if output_json:
        out = {
            "artifact": artifact.model_dump(mode="json"),
            "lineage": [a.model_dump(mode="json") for a in lineage],
        }
        click.echo(json.dumps(out, indent=2, default=str))
        return

    a_type = artifact.artifact_type if isinstance(artifact.artifact_type, str) else artifact.artifact_type.value
    a_status = artifact.status if isinstance(artifact.status, str) else artifact.status.value
    console.print(Panel(
        f"[bold]Type:[/bold]    {a_type}\n"
        f"[bold]ID:[/bold]      {artifact.id}\n"
        f"[bold]Stage:[/bold]   {artifact.stage_id or '—'}\n"
        f"[bold]Status:[/bold]  {a_status}\n"
        f"[bold]Version:[/bold] {artifact.version}\n"
        f"[bold]Author:[/bold]  {artifact.author_agent_id or '—'}\n"
        f"[bold]Created:[/bold] {artifact.created_at}\n"
        f"[bold]Lineage:[/bold] {', '.join(artifact.lineage) or 'root'}",
        title=f"[bold]Artifact: {artifact.id[:8]}[/bold]",
        border_style="cyan",
    ))
    if lineage:
        console.print("\n[bold]Parent chain:[/bold]")
        for parent in lineage:
            p_type = parent.artifact_type if isinstance(parent.artifact_type, str) else parent.artifact_type.value
            p_status = parent.status if isinstance(parent.status, str) else parent.status.value
            console.print(f"  ↑ {parent.id[:8]}  [{p_type}]  {p_status}")


# ── Phase gate commands ────────────────────────────────────────────────────────

@cli.group("phase")
def phase_group() -> None:
    """Manage lifecycle phase approval gates."""


@phase_group.command("approve")
@click.argument("trace_id")
@click.argument("phase_id")
@click.option("--trace-dir", default="./traces")
def phase_approve(trace_id: str, phase_id: str, trace_dir: str) -> None:
    """Manually approve a pending lifecycle phase gate.

    \b
    Example:
      swarm phase approve abc12345 planning
    """
    _write_phase_gate_decision(trace_dir, trace_id, phase_id, approved=True, reason="")
    console.print(f"[green]✓ Phase '{phase_id}' approved for trace {trace_id[:8]}[/green]")


@phase_group.command("reject")
@click.argument("trace_id")
@click.argument("phase_id")
@click.option("--reason", default="", help="Reason for rejection")
@click.option("--trace-dir", default="./traces")
def phase_reject(trace_id: str, phase_id: str, reason: str, trace_dir: str) -> None:
    """Reject a pending lifecycle phase gate.

    \b
    Example:
      swarm phase reject abc12345 quality --reason "Test coverage too low"
    """
    _write_phase_gate_decision(trace_dir, trace_id, phase_id, approved=False, reason=reason)
    console.print(f"[red]✗ Phase '{phase_id}' rejected for trace {trace_id[:8]}[/red]")
    if reason:
        console.print(f"  Reason: {reason}")


def _write_phase_gate_decision(
    trace_dir: str, trace_id: str, phase_id: str, approved: bool, reason: str
) -> None:
    """Write a phase gate decision file that the orchestrator polls."""
    import datetime
    gate_dir = Path(trace_dir) / "phase_gates"
    gate_dir.mkdir(parents=True, exist_ok=True)
    gate_file = gate_dir / f"{trace_id}_{phase_id}.json"
    gate_file.write_text(json.dumps({
        "trace_id": trace_id,
        "phase_id": phase_id,
        "approved": approved,
        "reason": reason,
        "decided_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }, indent=2))


# ── Workforce run ─────────────────────────────────────────────────────────────

def _run_feedback_loop(runtime: Any, cons: Console) -> None:
    """Prompt the user for bug reports / change requests and apply fixes via debug_agent."""
    cons.print(Panel(
        "[bold]Review the output in the [cyan]built/[/cyan] directory.[/bold]\n"
        "Describe any bugs or requested changes below, one round at a time.\n"
        "Type [bold cyan]done[/bold cyan] (or press Enter with no text) when satisfied.",
        title="[bold cyan]Feedback Loop[/bold cyan]",
        border_style="cyan",
    ))
    while True:
        try:
            feedback = click.prompt(
                "\nFeedback",
                default="done",
                show_default=False,
                prompt_suffix=" (or 'done' to finish) > ",
            )
        except (click.exceptions.Abort, EOFError):
            break
        if not feedback or feedback.strip().lower() in ("done", "exit", "quit"):
            cons.print("[dim]Exiting feedback loop.[/dim]")
            break
        fix_goal = (
            "USER FEEDBACK — apply these fixes to the project in the built/ directory:\n\n"
            f"{feedback}\n\n"
            "Steps:\n"
            "1. List built/ to identify the frontend and backend directories.\n"
            "2. Read the relevant source files to understand the current implementation.\n"
            "3. Fix every reported issue in a single pass — do not stop after the first fix.\n"
            "4. Verify each changed Python file: shell_exec 'python -m py_compile <file>'\n"
            "5. Verify TypeScript: shell_exec 'cd built/<frontend_dir> && npx tsc --noEmit'\n"
            "6. Fix any compile errors that appear.\n"
            "7. Output one line per changed file as your final summary."
        )
        cons.print("[dim]Applying fixes…[/dim]")
        fix_result = asyncio.run(runtime._spawn_agent_for_goal(
            "debug_agent", fix_goal, timeout=86400.0, max_iterations=100
        ))
        border = "green" if fix_result.success else "red"
        title = (
            "[bold green]✓ Fixes Applied[/bold green]"
            if fix_result.success
            else "[bold red]✗ Fix Failed[/bold red]"
        )
        cons.print(Panel(
            str(fix_result.output or fix_result.error or "No output."),
            title=title,
            border_style=border,
        ))


def _print_workforce_result(result: Any, cons: Console) -> None:
    """Render the phase summary panel for a workforce result."""
    border = "green" if result.success else "red"
    status = "✓ Workforce Complete" if result.success else "✗ Workforce Failed"
    paused = (result.metadata or {}).get("paused_after")
    if paused:
        status = f"⏸  Paused after '{paused}' phase"
        border = "yellow"
    cons.print(Panel(
        str(result.output or result.error or "No output"),
        title=f"[bold]{status}[/bold]",
        border_style=border,
    ))
    phases = (result.metadata or {}).get("phases", [])
    if phases:
        t = Table(title="Phase Summary")
        for col in ("Phase", "Success", "Outputs Missing"):
            t.add_column(col)
        for ph in phases:
            t.add_row(
                ph["phase_id"],
                "[green]✓[/green]" if ph["success"] else "[red]✗[/red]",
                ", ".join(ph.get("output_missing", [])) or "—",
            )
        cons.print(t)


@cli.command("workforce")
@click.argument("topology")
@click.option("--goal", "-g", required=True, help="Product goal for the workforce")
@click.option("--provider", "-p", default=None, type=click.Choice(["groq", "openrouter", "gemini"]), help="LLM provider to use")
@click.option("--api-key", envvar="GROQ_API_KEY", default=None)
@click.option("--openrouter-api-key", envvar="OPENROUTER_API_KEY", default=None, help="OpenRouter API key")
@click.option("--gemini-api-key", envvar="GEMINI_API_KEY", default=None, help="Google Gemini API key")
@click.option("--model", "-m", default=None)
@click.option("--log-level", default="INFO", show_default=True)
@click.option("--trace-dir", default="./traces", show_default=True)
@click.option("--memory-dir", default="./memory_store", show_default=True)
@click.option("--approve-all", is_flag=True, help="Auto-approve all phase gates (CI mode)")
@click.option("--deploy/--no-deploy", default=False, show_default=True,
              help="Include deployment phases (deployment + post_launch). Omit to stop at quality and go straight to feedback/iteration.")
@click.option("--budget", default=None, type=float, help="Max spend in USD")
@click.option("--json", "output_json", is_flag=True)
def workforce(
    topology: str,
    goal: str,
    provider: Optional[str],
    api_key: Optional[str],
    openrouter_api_key: Optional[str],
    gemini_api_key: Optional[str],
    model: Optional[str],
    log_level: str,
    trace_dir: str,
    memory_dir: str,
    approve_all: bool,
    deploy: bool,
    budget: Optional[float],
    output_json: bool,
) -> None:
    """Run a product goal through the full AI workforce lifecycle.

    TOPOLOGY must point to a topology YAML with coordination.strategy=lifecycle.

    \b
    Example:
      swarm workforce examples/software_delivery/topology.yaml \\
        --goal "Build a URL-shortener SaaS with email/password auth and a dashboard"
    """
    safety_mode = "auto" if approve_all else "interactive"
    cfg = _load_config(api_key, model, log_level, trace_dir, safety_mode, provider, openrouter_api_key)
    if gemini_api_key:
        cfg.gemini_api_key = gemini_api_key
    cfg.memory_dir = memory_dir
    _setup_logging(cfg)

    active_provider = cfg.provider or "openrouter"
    if active_provider == "openrouter" and not cfg.openrouter_api_key:
        console.print("[bold red]Error:[/bold red] OPENROUTER_API_KEY is not set.")
        sys.exit(1)
    if active_provider == "groq" and not cfg.groq_api_key:
        console.print("[bold red]Error:[/bold red] GROQ_API_KEY is not set.")
        sys.exit(1)
    if active_provider == "gemini" and not cfg.gemini_api_key:
        console.print("[bold red]Error:[/bold red] GEMINI_API_KEY is not set.")
        sys.exit(1)

    _bootstrap(cfg)

    from configs.loader import load_topology_spec
    topo = load_topology_spec(Path(topology))
    if topo.coordination.strategy != "lifecycle":
        console.print(
            f"[yellow]Warning:[/yellow] topology strategy is '{topo.coordination.strategy}', "
            "not 'lifecycle'. Overriding to 'lifecycle'."
        )
        topo.coordination.strategy = "lifecycle"

    if approve_all:
        topo.coordination.approval_gates = False

    if budget:
        topo.budget.max_cost_usd = budget

    # Reset artifact registry for this run
    from memory.artifacts import reset_artifact_registry
    reset_artifact_registry(persist_dir=memory_dir)

    runtime, ledger = _build_runtime(cfg, topology, deploy=deploy)
    runtime.topology = topo

    console.print(Panel(
        f"[bold cyan]Workforce Run[/bold cyan]\n"
        f"[bold]Goal:[/bold] {goal}\n"
        f"[dim]Lifecycle:[/dim] {topo.coordination.lifecycle or 'software_delivery'}\n"
        f"[dim]Trace:[/dim]    {runtime.trace_id[:8]}…\n"
        f"[dim]Gates:[/dim]    {'auto-approved' if approve_all else 'interactive'}\n"
        f"[dim]Deploy:[/dim]   {'enabled' if deploy else 'skipped (use --deploy to include)'}",
        title="[bold]AI Digital Workforce[/bold]",
        border_style="magenta",
    ))

    # With --deploy, pause after build so the user can review before deployment
    if deploy:
        runtime._stop_after_phase = "build"

    result = asyncio.run(runtime.run(goal))
    paused_after = (result.metadata or {}).get("paused_after")

    if output_json:
        click.echo(json.dumps({
            "trace_id": runtime.trace_id,
            "output": result.output,
            "success": result.success,
            "cost_usd": result.cost,
            "tokens": result.token_usage.total_tokens,
            "phases": (result.metadata or {}).get("phases", []),
            "paused_after": paused_after,
            "error": result.error,
        }, indent=2, default=str))
        return

    _print_workforce_result(result, console)
    console.print(
        f"[dim]Cost: ${result.cost:.4f}  |  "
        f"Tokens: {result.token_usage.total_tokens}  |  "
        f"Trace: {runtime.trace_id[:8]}[/dim]"
    )

    # ── Feedback loop ─────────────────────────────────────────────────────────
    if result.success:
        _run_feedback_loop(runtime, console)

        # With --deploy: continue the remaining lifecycle phases after feedback
        if paused_after == "build":
            runtime._stop_after_phase = None
            runtime._resume_from_phase = "live_test"
            console.print(Panel(
                "[dim]Continuing lifecycle (live_test → quality → deployment → post_launch → iteration)…[/dim]",
                border_style="magenta",
            ))
            result = asyncio.run(runtime.run(goal))
            _print_workforce_result(result, console)
            console.print(
                f"[dim]Cost: ${result.cost:.4f}  |  "
                f"Tokens: {result.token_usage.total_tokens}  |  "
                f"Trace: {runtime.trace_id[:8]}[/dim]"
            )

    console.print(
        "\n[dim]Inspect artifacts:[/dim]  swarm artifact list\n"
        "[dim]Show artifact:[/dim]     swarm artifact show <id>"
    )


# ── obs ───────────────────────────────────────────────────────────────────────

@cli.command("obs")
@click.option("--port", default=8501, type=int, show_default=True, help="Streamlit server port")
@click.option("--topology", default=None, envvar="SWARM_OBS_TOPOLOGY",
              help="Optional topology YAML path")
@click.option("--provider", "-p", default=None, envvar="SWARM_OBS_PROVIDER",
              type=click.Choice(["groq", "openrouter", "gemini"]),
              help="LLM provider override")
@click.option("--api-key", envvar="GROQ_API_KEY", default=None)
@click.option("--openrouter-api-key", envvar="OPENROUTER_API_KEY", default=None)
@click.option("--gemini-api-key", envvar="GEMINI_API_KEY", default=None)
@click.option("--model", "-m", default=None, envvar="SWARM_OBS_MODEL",
              help="Model override")
@click.option("--trace-dir", default="./traces", show_default=True, envvar="SWARM_OBS_TRACE_DIR")
@click.option("--browser/--no-browser", default=True, show_default=True,
              help="Auto-open the browser tab")
def obs(
    port: int,
    topology: Optional[str],
    provider: Optional[str],
    api_key: Optional[str],
    openrouter_api_key: Optional[str],
    gemini_api_key: Optional[str],
    model: Optional[str],
    trace_dir: str,
    browser: bool,
) -> None:
    """Start the live Streamlit observer UI.

    Lets you provide a goal, watch every tool call and LLM span in real time,
    and inspect the full hierarchical trace — all in a browser tab.

    \b
    Example:
      swarm obs
      swarm obs --port 8502 --provider gemini --no-browser
    """
    try:
        import streamlit  # noqa: F401
    except ImportError:
        console.print(
            "[bold red]streamlit is not installed.[/bold red]\n"
            "  Install it with:  [cyan]pip install streamlit pandas[/cyan]"
        )
        sys.exit(1)

    import subprocess
    import os as _os

    app_path = Path(__file__).resolve().parent.parent / "obs" / "app.py"
    if not app_path.exists():
        console.print(f"[red]Observer app not found at {app_path}[/red]")
        sys.exit(1)

    env = _os.environ.copy()
    if topology:
        env["SWARM_OBS_TOPOLOGY"] = topology
    if provider:
        env["SWARM_OBS_PROVIDER"] = provider
    if api_key:
        env["GROQ_API_KEY"] = api_key
    if openrouter_api_key:
        env["OPENROUTER_API_KEY"] = openrouter_api_key
    if gemini_api_key:
        env["GEMINI_API_KEY"] = gemini_api_key
    if model:
        env["SWARM_OBS_MODEL"] = model
    env["SWARM_OBS_TRACE_DIR"] = trace_dir

    console.print(Panel(
        f"[bold cyan]Swarm Observer[/bold cyan]\n"
        f"URL:       http://localhost:{port}\n"
        f"Trace dir: {trace_dir}\n"
        f"Provider:  {provider or '(from .env)'}",
        title="[bold]Observer[/bold]",
        border_style="cyan",
    ))

    cmd = [
        sys.executable, "-m", "streamlit", "run", str(app_path),
        "--server.port", str(port),
        "--server.headless", "false" if browser else "true",
        "--browser.gatherUsageStats", "false",
        "--theme.base", "dark",
    ]
    subprocess.run(cmd, env=env, cwd=str(app_path.parent.parent))


if __name__ == "__main__":
    cli()
