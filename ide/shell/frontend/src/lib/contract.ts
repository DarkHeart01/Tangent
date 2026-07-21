// Mirrors ide/shell/internal/session/types.go exactly. This is the wire
// contract for the WS event stream — keep the two in lockstep.

export interface Envelope<T = unknown> {
  v: 1;
  session_id: string;
  seq: number; // monotonic per session_id, starts at 0
  ts: string; // ISO 8601
  type: EventType;
  payload: T;
}

export type EventType =
  | "session.started"
  | "session.ended"
  | "phase.transition"
  | "agent.started"
  | "agent.finished"
  | "agent.handoff"
  | "tool.call"
  | "tool.result"
  | "terminal.output"
  | "file.changed"
  | "human_gate.pending"
  | "human_gate.resolved"
  | "contract.emitted"
  | "critic.score"
  | "budget.update"
  | "error";

export interface SessionStarted {
  goal: string;
  topology: string;
  worktree_path: string;
}

export interface SessionEnded {
  status: "success" | "failed" | "cancelled";
  summary: string;
}

export interface PhaseTransition {
  from_phase: string | null;
  to_phase: string;
  budget_allocated: number;
  budget_remaining: number;
}

export interface AgentStarted {
  agent_role: string;
  agent_instance_id: string;
  task_id: string;
}

export interface AgentFinished {
  agent_instance_id: string;
  task_id: string;
  status: "success" | "failed";
}

export interface AgentHandoff {
  from_agent: string;
  to_agent: string;
  artifact_ref: string;
}

export interface ToolCall {
  agent_instance_id: string;
  tool_name: string;
  side_effect_tier: "read-only" | "mutates-local" | "mutates-external";
  args_summary: string;
  call_id: string;
}

export interface ToolResult {
  call_id: string;
  status: "ok" | "error" | "blocked";
  summary: string;
}

export interface TerminalOutput {
  container_id: string;
  stream: "stdout" | "stderr";
  data: string;
}

export interface FileChanged {
  path: string;
  change_type: "created" | "modified" | "deleted";
}

export interface HumanGatePending {
  gate_id: string;
  gate_kind: "phase" | "tool_call" | "question";
  phase: string;
  // Absent for gate_kind "question" — nothing is being mutated by a plain
  // question, so there's no side-effect tier to show.
  side_effect_tier?: "mutates-external";
  reason: string;
  proposed_action: string;
  // "question" kind only — a picker should be shown when this is
  // present and non-empty, a free-text input otherwise.
  options?: string[] | null;
}

export interface HumanGateResolved {
  gate_id: string;
  decision: "approve" | "reject";
  note?: string;
}

export interface ContractEmitted {
  contract_id: string;
  phase: string;
  ref: string;
}

export interface CriticScore {
  task_id: string;
  score: number;
  threshold: number;
  round: number;
  will_retry: boolean;
}

export interface BudgetUpdate {
  phase: string;
  spent: number;
  allocated: number;
}

export interface EngineError {
  message: string;
  agent_instance_id?: string;
  fatal: boolean;
}

// Maps an EventType to its payload shape, so a switch on `envelope.type` can
// narrow `envelope.payload` without a cast.
export interface EventPayloadMap {
  "session.started": SessionStarted;
  "session.ended": SessionEnded;
  "phase.transition": PhaseTransition;
  "agent.started": AgentStarted;
  "agent.finished": AgentFinished;
  "agent.handoff": AgentHandoff;
  "tool.call": ToolCall;
  "tool.result": ToolResult;
  "terminal.output": TerminalOutput;
  "file.changed": FileChanged;
  "human_gate.pending": HumanGatePending;
  "human_gate.resolved": HumanGateResolved;
  "contract.emitted": ContractEmitted;
  "critic.score": CriticScore;
  "budget.update": BudgetUpdate;
  error: EngineError;
}

export type AnyEnvelope = {
  [K in EventType]: Envelope<EventPayloadMap[K]> & { type: K };
}[EventType];

// Rendered straight from .tangent/contracts/<phase>.json — no LLM call.
export interface ContractEntry {
  contract_id: string;
  phase: string;
  agent: string;
  intent: string;
  diff_refs: string[];
  reasoning: string;
  risks: string[];
  tests_run: { name: string; passed: boolean }[];
  side_effect_tier: "read-only" | "mutates-local" | "mutates-external";
  approved_by?: string;
  created_at: string;
}
