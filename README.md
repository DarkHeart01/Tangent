# Tangent

**The AI Swarm That Ships Software End-to-End**

> From a single goal to a deployed, monitored production system — fully autonomous.
> 37 specialized AI agents collaborate with structured handoffs, shared memory, and clear contracts.

Software development is no longer bottlenecked by code. It's bottlenecked by coordination — between planners, architects, engineers, reviewers, and ops teams. Swarmcality replaces that coordination overhead with a swarm of 37 specialized AI agents that collaborate the way the best engineering teams do: with structured handoffs, shared memory, and clear contracts.

**Single Input: Plain-Language Goal · Single Output: Deployed Service · 37 Agents · Built on Groq**

[View Presentation](https://canva.link/tm6wgu6lh3onq4e)

---

## Architecture

```
                    ┌─────────────────────────────────┐
                    │          User Goal               │
                    │   text · audio · PDF · video     │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │    CLI · REST API · WebSocket    │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │           SwarmRuntime           │
                    │       Bootstraps all layers      │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │        Chief Orchestrator        │
                    │   Decomposes goal → TaskGraph    │
                    │             DAG                  │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │        TaskGraphExecutor         │
                    │  Parallel execution · Dependency │
                    │            ordering              │
                    └────────────────┬────────────────┘
                                     │
          ┌──────────────────────────▼──────────────────────────┐
          │              Specialist Agent Pool — 37 Agents       │
          │                                                       │
          │  Researcher ── Coder ── Critic ── Architect ── QA   │
          │                                                       │
          │  SRE ── Security Eng ── Human Liaison ── +30 more   │
          └──────────────────────────┬──────────────────────────┘
                                     │ ▲
                    ┌────────────────▼─┴──────────────┐
                    │            MessageBus            │
                    │  asyncio in-process · Redis      │
                    │            pub/sub               │
                    └──────────┬─────────────┬────────┘
                               │             │
           ┌───────────────────▼──┐    ┌─────▼──────────────────┐
           │  Memory System — 3   │    │      68+ Tools          │
           │        Tiers         │    │                         │
           │                      │    │  filesystem · shell ·   │
           │  ┌────────────────┐  │    │  git · web · docker ·  │
           │  │   Scratchpad   │  │    │  k8s · DB · Prometheus  │
           │  │  per-agent ·   │  │    └─────────────────────────┘
           │  │   ephemeral    │  │
           │  └───────┬────────┘  │
           │  ┌───────▼────────┐  │
           │  │  Blackboard    │  │
           │  │ per-subswarm · │  │
           │  │  consensus     │  │
           │  └───────┬────────┘  │
           │  ┌───────▼────────┐  │
           │  │  Long-Term     │  │
           │  │  Memory ·      │  │
           │  │  ChromaDB ·    │  │
           │  │  cross-run     │  │
           │  └────────────────┘  │
           └──────────────────────┘
                               │
          ┌────────────────────▼────────────────────────────────┐
          │                Safety Layer — 6 Levels               │
          │                                                       │
          │  Allowlist ── Side-effect  ── Injection ── Circuit  │
          │               Gating          Detect       Breaker  │
          │                                                       │
          │                    Quota Enforce ── Path Jail        │
          └────────────────────┬────────────────────────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │       Observability      │
                    │  JSONL traces · Cost     │
                    │  ledger · Structured     │
                    │    logs · Replay         │
                    └─────────────────────────┘
```

---

## Quick Start

```bash
# Install
pip install -e .

# Configure
cp .env.example .env
# Set GROQ_API_KEY in .env

# Check your environment
swarm doctor

# Run against a goal (single agent, no topology file needed)
swarm run --goal "What are the top 5 Python web frameworks? Compare briefly."

# Run with a multi-agent topology
swarm run examples/research_swarm/topology.yaml \
  --goal "Research the current state of LLM fine-tuning techniques"

# Run the full software delivery lifecycle
swarm run examples/software_delivery/topology.yaml \
  --goal "Build a task management API with user authentication"
```

## Tangent IDE

The Wails desktop IDE shell provides the VS Code-style workspace, Monaco editor, Explorer, local file operations, Git Source Control, conditional authenticated GitHub PR integration, resizable Agent Swarm monitor, bottom panels, recent-project handling, and streamed session output. See the [Tangent IDE shell README](ide/shell/README.md) for the current implementation, development commands, and known boundaries.

---

## 8-Phase Software Delivery Lifecycle

When using the `software_delivery` topology, the swarm runs a complete SDLC with human approval gates at critical phases.

| Phase | What Happens | Key Agents | Human Gate |
|-------|-------------|------------|------------|
| **Discovery** | Goal → structured ProductBrief | Product Manager | No |
| **Planning** | ProductBrief → full PRD with user stories | PM + Critic | Yes |
| **Architecture** | PRD → system design, API spec, DB schema | Architect + Security Eng | Yes |
| **Repo Discovery** | Scout existing codebases & templates | Repo Scout Agent | No |
| **Contracting** | Define CDD Contract — strict build contract | Chief Orchestrator | Yes |
| **Build** | Parallel implementation across all layers | Backend/Frontend/DB/Integration | No |
| **Quality** | Tests, code review, security scan, perf benchmarks | QA, Reviewer, Security, Perf | No |
| **Deploy + Monitor** | Release notes, deploy, SLO watch | Release Mgr, DevOps, SRE | Yes |

- If critic score < 7 after Build, agents loop back automatically (max 3 rounds, then escalate to human)
- Dead-letter queue catches failed tasks for human review
- Budget per phase is pre-allocated (e.g., Build = 18% of total)
- Iteration phase routes user feedback back to Planning or Build

---

## CLI Commands

```
swarm run [topology] --goal "<text>"    Run a swarm against a goal
swarm list agents|tools|providers       Inspect registries
swarm scaffold agent|tool|topology      Generate extension templates
swarm validate <file>                   Lint a spec or topology
swarm trace <trace-id>                  Pretty-print a trace
swarm replay <trace-id>                 Re-execute a historical trace
swarm cost [<trace-id>]                 Token usage and cost report
swarm dashboard                         Start local API + dashboard
swarm doctor                            Validate environment + credentials
```

---

## Coordination Modes

| Mode | How It Works | Use Case |
|------|-------------|----------|
| **Hierarchical** | Orchestrator decomposes and dispatches; no peer-to-peer | Default for most tasks |
| **P2P** | Subswarm agents debate and reach consensus via shared blackboard | Collaborative problem-solving |
| **Hybrid** | Orchestrator at top-level; P2P subswarms within phases | Full lifecycle delivery |
| **Lifecycle** | Chief Orchestrator drives 8-phase SDLC with artifact contracts | Software delivery |

---

## Memory System

Three tiers of memory ensure agents never lose context mid-run and knowledge persists across sessions.

| Tier | Scope | Backend | Lifetime |
|------|-------|---------|----------|
| **Scratchpad** | Per-agent | In-memory KV + conversation history | Destroyed when agent completes |
| **Blackboard** | Per-subswarm | Append-only versioned shared store | Snapshot saved to trace on dissolution |
| **Long-Term Memory** | Cross-run | ChromaDB vector database | Persistent across all swarm runs |

---

## Safety Model (6 Layers)

Safety is structural, not a toggle.

1. **Allowlist** — tools must appear in topology's `tool_allowlist` before use
2. **Side-effect Gating** — read-only / mutates-local / mutates-external with progressive confirmation
3. **Injection Detection** — scans external content and demarcates untrusted sources
4. **Circuit Breaker** — disables tool after 3 consecutive errors; auto-reopens after 60s
5. **Quota Enforcement** — per-tool, per-agent, and global budget hard limits
6. **Path Jail** — filesystem and shell tools restricted to project directory

---

## Built-in Agents (37 total)

| Role | Purpose |
|------|---------|
| `chief_orchestrator` | Drives the 8-phase SDLC; manages artifact contracts |
| `orchestrator` | Decomposes goals, builds task graphs, dispatches agents |
| `product_manager` | Goal → ProductBrief → PRD with user stories |
| `architect` | System design, API spec, DB schema |
| `researcher` | Web search + fetch → structured research briefs |
| `coder` | Write, edit, run code; filesystem + shell access |
| `critic` | Reviews output against criteria; structured critique |
| `planner` | Fuzzy goal → detailed step-by-step plan |
| `backend_engineer` | Backend implementation per CDD contract |
| `frontend_engineer` | Frontend implementation and UI |
| `database_engineer` | Schema design and migrations |
| `integration_engineer` | External service integrations |
| `qa_engineer` | Test planning and execution |
| `code_reviewer` | Code diff inspection and standards enforcement |
| `security_engineer` | Security analysis, CVE scanning, threat modeling |
| `test_generator` | Automated test generation |
| `dependency_manager` | Dependency auditing and updates |
| `performance_agent` | Benchmarking and profiling |
| `documentation_agent` | API docs, README, architecture wiki |
| `release_manager` | Changelog, release notes, versioning |
| `devops_engineer` | CI/CD pipelines, deployment manifests |
| `sre_engineer` | SLO monitoring, incident response |
| `observability` | Metrics, logs, alert rules |
| `debug_agent` | Root cause analysis and debugging |
| `repo_scout` | Discovers and evaluates existing codebases |
| `reality_check` | Pre-build feasibility gate |
| `summarizer` | Condenses long content into structured summaries |
| `router` | Fast classifier that routes requests to specialists |
| `referee` | Weighs debate arguments; declares resolution |
| `memory_steward` | Decides what to persist to long-term memory |
| `human_liaison` | Pauses for human input; relays answers to swarm |
| `user_feedback` | Collects and triages post-launch user feedback |
| `live_test` | Runs live integration and smoke tests |
| `changelog_generator` | Generates structured changelogs from diffs |
| `sentiment_scorer` | Scores user feedback sentiment |
| `text_cluster` | Groups related feedback and issues |
| `slo_evaluator` | Evaluates SLO compliance from metrics |

---

## Built-in Tools (68+)

**Development:** `filesystem` · `shell_exec` · `project_scaffold` · `code_sandbox` · `linter_run` · `test_runner` · `ast_inspect`

**Integration:** `git_ops` · `github_actions_api` · `github_clone` · `linear_issue_create` · `notion_page_create`

**Data & Search:** `web_search` · `web_fetch` · `context7_search` · `data_parse` · `calculator`

**Infrastructure:** `docker_build` · `docker_compose_deploy` · `kubernetes_apply` · `cloud_run_deploy` · `gcloud_cli`

**Database:** `db_migrate`

**Observability:** `prometheus_query` · `loki_query` · `grafana_api` · `uptime_kuma_api` · `pagerduty_trigger`

**Security:** `sast_scan` · `dependency_audit` · `secret_scan`

**Memory & Control:** `memory_store` · `memory_retrieve` · `write_blackboard` · `artifact_read` · `artifact_write`

**Communication:** `send_message` · `spawn_agent` · `human_input` · `self_reflect`

**Specialized:** `contractor` · `changelog_generate` · `sentiment_score` · `text_cluster` · `slo_evaluator`

---

## Scaling

| Mode | Execution | Queue | Use Case |
|------|-----------|-------|----------|
| `local` | In-process asyncio | InProcessTaskQueue | Development |
| `redis-workers` | Distributed multi-process | RedisStreamTaskQueue | Team / staging |
| `kubernetes` | Cloud-native | RedisStreamTaskQueue + KEDA | Production |

KEDA scales agent worker pods based on Redis stream depth — scales to zero when idle, spins up instantly under load.

---

## Adding a Custom Agent

```bash
swarm scaffold agent my-agent
# Edit agents/my-agent/spec.yaml — fill in system_prompt, tools, model
swarm validate agents/my-agent/spec.yaml
```

See [docs/how-to-add-an-agent.md](docs/how-to-add-an-agent.md).

## Adding a Custom Tool

```bash
swarm scaffold tool my-tool
# Edit tools/my-tool/spec.yaml and tools/my-tool/handler.py
swarm validate tools/my-tool/spec.yaml
```

See [docs/how-to-add-a-tool.md](docs/how-to-add-a-tool.md).

---

## Tests

```bash
# Unit + integration (no API key needed)
pytest tests/unit tests/integration -v

# End-to-end (requires GROQ_API_KEY)
pytest tests/e2e -v
```

## Docker

```bash
cp .env.example .env   # set GROQ_API_KEY
docker compose up --build
# API: http://localhost:8765
```

Optional queue workers (set `SWARM_DEPLOYMENT_MODE=redis-workers` in `.env`):

```bash
docker compose --profile queue-workers up --build
```

See [docs/deployment.md](docs/deployment.md) for environment variables and local worker processes.
See [docs/keda-architecture.md](docs/keda-architecture.md) for Redis Streams and KEDA scaling details.

---

> **Software delivery is a team sport. AI should be the team.**
