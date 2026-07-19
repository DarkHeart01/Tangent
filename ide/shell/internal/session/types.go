// Package session implements the in-memory session store, lifecycle, and the
// scripted event simulator that stands in for the real Python swarm engine.
package session

import "time"

// EventType enumerates every WS event type in the contract.
type EventType string

const (
	EventSessionStarted   EventType = "session.started"
	EventSessionEnded     EventType = "session.ended"
	EventPhaseTransition  EventType = "phase.transition"
	EventAgentStarted     EventType = "agent.started"
	EventAgentFinished    EventType = "agent.finished"
	EventAgentHandoff     EventType = "agent.handoff"
	EventToolCall         EventType = "tool.call"
	EventToolResult       EventType = "tool.result"
	EventTerminalOutput   EventType = "terminal.output"
	EventFileChanged      EventType = "file.changed"
	EventHumanGatePending EventType = "human_gate.pending"
	EventHumanGateResolve EventType = "human_gate.resolved"
	EventContractEmitted  EventType = "contract.emitted"
	EventCriticScore      EventType = "critic.score"
	EventBudgetUpdate     EventType = "budget.update"
	EventError            EventType = "error"
)

// Envelope is the wire format for every WS message. Payload carries one of
// the typed structs below, matching the TS discriminated-union contract.
type Envelope struct {
	V         int         `json:"v"`
	SessionID string      `json:"session_id"`
	Seq       int         `json:"seq"`
	Ts        string      `json:"ts"`
	Type      EventType   `json:"type"`
	Payload   interface{} `json:"payload"`
}

func nowISO() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// ── Event payloads ──────────────────────────────────────────────────────────

type SessionStarted struct {
	Goal         string `json:"goal"`
	Topology     string `json:"topology"`
	WorktreePath string `json:"worktree_path"`
}

type SessionEnded struct {
	Status  string `json:"status"` // success | failed | cancelled
	Summary string `json:"summary"`
}

type PhaseTransition struct {
	FromPhase        *string `json:"from_phase"`
	ToPhase          string  `json:"to_phase"`
	BudgetAllocated  float64 `json:"budget_allocated"`
	BudgetRemaining  float64 `json:"budget_remaining"`
}

type AgentStarted struct {
	AgentRole        string `json:"agent_role"`
	AgentInstanceID  string `json:"agent_instance_id"`
	TaskID           string `json:"task_id"`
}

type AgentFinished struct {
	AgentInstanceID string `json:"agent_instance_id"`
	TaskID          string `json:"task_id"`
	Status          string `json:"status"` // success | failed
}

type AgentHandoff struct {
	FromAgent   string `json:"from_agent"`
	ToAgent     string `json:"to_agent"`
	ArtifactRef string `json:"artifact_ref"`
}

type ToolCall struct {
	AgentInstanceID string `json:"agent_instance_id"`
	ToolName        string `json:"tool_name"`
	SideEffectTier  string `json:"side_effect_tier"` // read-only | mutates-local | mutates-external
	ArgsSummary     string `json:"args_summary"`
	CallID          string `json:"call_id"`
}

type ToolResult struct {
	CallID  string `json:"call_id"`
	Status  string `json:"status"` // ok | error | blocked
	Summary string `json:"summary"`
}

type TerminalOutput struct {
	ContainerID string `json:"container_id"`
	Stream      string `json:"stream"` // stdout | stderr
	Data        string `json:"data"`
}

type FileChanged struct {
	Path       string `json:"path"`
	ChangeType string `json:"change_type"` // created | modified | deleted
}

type HumanGatePending struct {
	GateID         string `json:"gate_id"`
	Phase          string `json:"phase"`
	SideEffectTier string `json:"side_effect_tier"` // mutates-external
	Reason         string `json:"reason"`
	ProposedAction string `json:"proposed_action"`
}

type HumanGateResolved struct {
	GateID   string `json:"gate_id"`
	Decision string `json:"decision"` // approve | reject
	Note     string `json:"note,omitempty"`
}

type ContractEmitted struct {
	ContractID string `json:"contract_id"`
	Phase      string `json:"phase"`
	Ref        string `json:"ref"`
}

type CriticScore struct {
	TaskID    string  `json:"task_id"`
	Score     float64 `json:"score"`
	Threshold float64 `json:"threshold"`
	Round     int     `json:"round"`
	WillRetry bool    `json:"will_retry"`
}

type BudgetUpdate struct {
	Phase     string  `json:"phase"`
	Spent     float64 `json:"spent"`
	Allocated float64 `json:"allocated"`
}

type EngineError struct {
	Message         string `json:"message"`
	AgentInstanceID string `json:"agent_instance_id,omitempty"`
	Fatal           bool   `json:"fatal"`
}

// ── Control-plane (Wails request/response) types ────────────────────────────

// SessionStartOpts is the input to Manager.StartSession and
// ContainerExecutor.Start.
type SessionStartOpts struct {
	Goal     string `json:"goal"`
	Topology string `json:"topology"`
	Mode     string `json:"mode"` // "simulated" | "container" — empty defaults to "simulated"
}

type StartSessionResult struct {
	SessionID string `json:"session_id"`
	WSURL     string `json:"ws_url"`
}

type SessionSummary struct {
	SessionID string `json:"session_id"`
	Goal      string `json:"goal"`
	Topology  string `json:"topology"`
	Mode      string `json:"mode"`
	Status    string `json:"status"` // running | success | failed | cancelled
	StartedAt string `json:"started_at"`
	EndedAt   string `json:"ended_at,omitempty"`
}

type FileNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"` // relative to session worktree, forward-slash separated
	IsDir    bool       `json:"is_dir"`
	Children []FileNode `json:"children,omitempty"`
}

type FileContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type TraceEntry struct {
	Seq     int         `json:"seq"`
	Ts      string      `json:"ts"`
	Type    EventType   `json:"type"`
	Payload interface{} `json:"payload"`
}

type CostReport struct {
	TotalSpent     float64            `json:"total_spent"`
	TotalAllocated float64            `json:"total_allocated"`
	ByPhase        []BudgetUpdate     `json:"by_phase"`
}

// TestResult and ContractEntry mirror .tangent/contracts/<phase>.json, read
// directly by WalkthroughPanel — no LLM call involved.
type TestResult struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
}

type ContractEntry struct {
	ContractID     string       `json:"contract_id"`
	Phase          string       `json:"phase"`
	Agent          string       `json:"agent"`
	Intent         string       `json:"intent"`
	DiffRefs       []string     `json:"diff_refs"`
	Reasoning      string       `json:"reasoning"`
	Risks          []string     `json:"risks"`
	TestsRun       []TestResult `json:"tests_run"`
	SideEffectTier string       `json:"side_effect_tier"`
	ApprovedBy     string       `json:"approved_by,omitempty"`
	CreatedAt      string       `json:"created_at"`
}

// manifest.json on disk.
type manifest struct {
	SessionID    string `json:"session_id"`
	Goal         string `json:"goal"`
	Topology     string `json:"topology"`
	WorktreePath string `json:"worktree_path"`
	Status       string `json:"status"`
	StartedAt    string `json:"started_at"`
	EndedAt      string `json:"ended_at,omitempty"`
}
