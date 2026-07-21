package session

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// runSimulator emits the scripted event sequence that stands in for the
// real Python swarm engine. It is the single event-producer goroutine for
// its session (see Session.Emit). Every pause is interruptible via
// StopSession -> Session.cancel.
func runSimulator(sess *Session) {
	sess.Emit(EventSessionStarted, SessionStarted{
		Goal:         sess.Goal,
		Topology:     sess.Topology,
		WorktreePath: sess.worktreePath,
	})

	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	// discovery -> planning
	sess.Emit(EventPhaseTransition, PhaseTransition{
		FromPhase: strPtr("discovery"), ToPhase: "planning",
		BudgetAllocated: 5.00, BudgetRemaining: 5.00,
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	sess.Emit(EventAgentStarted, AgentStarted{
		AgentRole: "product_manager", AgentInstanceID: "pm-1", TaskID: "task-plan-1",
	})
	for _, line := range []string{
		"$ pm-agent analyze goal\n",
		"Parsed requirements: 3 epics, 7 stories\n",
		"Drafting product brief -> docs/brief.md\n",
	} {
		sess.Emit(EventTerminalOutput, TerminalOutput{
			ContainerID: "sim-container", Stream: "stdout", Data: line,
		})
		if !pace(sess.ctx) {
			endCancelled(sess)
			return
		}
	}
	writeFileInWorktree(sess, "docs/brief.md",
		"# Product brief\n\n3 epics, 7 stories parsed from goal:\n\n> "+sess.Goal+"\n")
	sess.Emit(EventFileChanged, FileChanged{Path: "docs/brief.md", ChangeType: "modified"})
	sess.Emit(EventAgentFinished, AgentFinished{
		AgentInstanceID: "pm-1", TaskID: "task-plan-1", Status: "success",
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	// planning -> architecture
	sess.Emit(EventPhaseTransition, PhaseTransition{
		FromPhase: strPtr("planning"), ToPhase: "architecture",
		BudgetAllocated: 8.00, BudgetRemaining: 8.00,
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	sess.Emit(EventAgentStarted, AgentStarted{
		AgentRole: "architect", AgentInstanceID: "arch-1", TaskID: "task-arch-1",
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}
	sess.Emit(EventToolCall, ToolCall{
		AgentInstanceID: "arch-1", ToolName: "write_file", SideEffectTier: "mutates-local",
		ArgsSummary: "write src/schema.ts", CallID: "call-1",
	})
	writeFileInWorktree(sess, "src/schema.ts",
		"export interface Widget {\n  id: string;\n  name: string;\n  ownerId: string;\n}\n\nexport interface Owner {\n  id: string;\n  displayName: string;\n}\n")
	sess.Emit(EventFileChanged, FileChanged{Path: "src/schema.ts", ChangeType: "modified"})
	sess.Emit(EventToolResult, ToolResult{
		CallID: "call-1", Status: "ok", Summary: "wrote 8 lines to src/schema.ts",
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	writeContract(sess, ContractEntry{
		ContractID: "contract-architecture-1",
		Phase:      "architecture",
		Agent:      "architect",
		Intent:     "Define the Widget/Owner schema that later phases build against.",
		DiffRefs:   []string{"src/schema.ts"},
		Reasoning:  "A shared schema module keeps the engineer and QA agents aligned on field names before implementation starts.",
		Risks:      []string{"Schema may need revision once engineer hits real query patterns."},
		TestsRun:   []TestResult{{Name: "schema compiles", Passed: true}},
		SideEffectTier: "mutates-local",
		CreatedAt:      nowISO(),
	})
	sess.Emit(EventContractEmitted, ContractEmitted{
		ContractID: "contract-architecture-1", Phase: "architecture",
		Ref: ".tangent/contracts/architecture.json",
	})
	sess.Emit(EventAgentFinished, AgentFinished{
		AgentInstanceID: "arch-1", TaskID: "task-arch-1", Status: "success",
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	sess.Emit(EventAgentHandoff, AgentHandoff{
		FromAgent: "architect", ToAgent: "release_manager",
		ArtifactRef: ".tangent/contracts/architecture.json",
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	// architecture -> contracting
	sess.Emit(EventPhaseTransition, PhaseTransition{
		FromPhase: strPtr("architecture"), ToPhase: "contracting",
		BudgetAllocated: 3.00, BudgetRemaining: 3.00,
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	sess.Emit(EventAgentStarted, AgentStarted{
		AgentRole: "release_manager", AgentInstanceID: "rel-1", TaskID: "task-contract-1",
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}
	sess.Emit(EventToolCall, ToolCall{
		AgentInstanceID: "rel-1", ToolName: "deploy_staging", SideEffectTier: "mutates-external",
		ArgsSummary: "deploy branch feature/widgets to staging", CallID: "call-2",
	})

	gateID := "gate-1"
	gateCh := sess.registerGate(gateID)
	sess.Emit(EventHumanGatePending, HumanGatePending{
		GateID: gateID, GateKind: "tool_call", Phase: "contracting", SideEffectTier: "mutates-external",
		Reason:         "Deploying to staging is an external side effect and requires human approval.",
		ProposedAction: "Run deploy_staging on branch feature/widgets",
	})

	var decision gateDecision
	select {
	case <-sess.ctx.Done():
		endCancelled(sess)
		return
	case decision = <-gateCh:
	}

	sess.Emit(EventHumanGateResolve, HumanGateResolved{
		GateID: gateID, Decision: decision.Decision, Note: decision.Note,
	})

	if decision.Decision == "approve" {
		sess.Emit(EventToolResult, ToolResult{
			CallID: "call-2", Status: "ok", Summary: "deployed feature/widgets to staging",
		})
	} else {
		sess.Emit(EventToolResult, ToolResult{
			CallID: "call-2", Status: "blocked", Summary: "deploy blocked by human reviewer",
		})
	}
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	sess.Emit(EventCriticScore, CriticScore{
		TaskID: "task-contract-1", Score: 0.86, Threshold: 0.75, Round: 1, WillRetry: false,
	})
	updateCost(sess, "contracting", 2.10, 3.00)
	sess.Emit(EventBudgetUpdate, BudgetUpdate{Phase: "contracting", Spent: 2.10, Allocated: 3.00})
	sess.Emit(EventAgentFinished, AgentFinished{
		AgentInstanceID: "rel-1", TaskID: "task-contract-1", Status: "success",
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	// contracting -> implementation (compressed)
	sess.Emit(EventPhaseTransition, PhaseTransition{
		FromPhase: strPtr("contracting"), ToPhase: "implementation",
		BudgetAllocated: 10.00, BudgetRemaining: 10.00,
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}
	sess.Emit(EventAgentStarted, AgentStarted{
		AgentRole: "engineer", AgentInstanceID: "eng-1", TaskID: "task-impl-1",
	})
	sess.Emit(EventTerminalOutput, TerminalOutput{
		ContainerID: "sim-container", Stream: "stdout", Data: "$ engineer-agent implement stories\n",
	})
	writeFileInWorktree(sess, "src/schema.ts",
		"export interface Widget {\n  id: string;\n  name: string;\n  ownerId: string;\n  createdAt: string;\n}\n\nexport interface Owner {\n  id: string;\n  displayName: string;\n}\n")
	sess.Emit(EventFileChanged, FileChanged{Path: "src/schema.ts", ChangeType: "modified"})
	updateCost(sess, "implementation", 6.40, 10.00)
	sess.Emit(EventBudgetUpdate, BudgetUpdate{Phase: "implementation", Spent: 6.40, Allocated: 10.00})
	sess.Emit(EventAgentFinished, AgentFinished{
		AgentInstanceID: "eng-1", TaskID: "task-impl-1", Status: "success",
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	// implementation -> verification (compressed)
	sess.Emit(EventPhaseTransition, PhaseTransition{
		FromPhase: strPtr("implementation"), ToPhase: "verification",
		BudgetAllocated: 4.00, BudgetRemaining: 4.00,
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}
	sess.Emit(EventAgentStarted, AgentStarted{
		AgentRole: "qa", AgentInstanceID: "qa-1", TaskID: "task-verify-1",
	})
	sess.Emit(EventCriticScore, CriticScore{
		TaskID: "task-verify-1", Score: 0.92, Threshold: 0.75, Round: 1, WillRetry: false,
	})
	updateCost(sess, "verification", 3.50, 4.00)
	sess.Emit(EventBudgetUpdate, BudgetUpdate{Phase: "verification", Spent: 3.50, Allocated: 4.00})
	sess.Emit(EventAgentFinished, AgentFinished{
		AgentInstanceID: "qa-1", TaskID: "task-verify-1", Status: "success",
	})
	if !pace(sess.ctx) {
		endCancelled(sess)
		return
	}

	sess.setStatus("success")
	sess.Emit(EventSessionEnded, SessionEnded{
		Status:  "success",
		Summary: "Delivered " + sess.Goal + " through discovery -> verification with 1 human approval gate.",
	})
}

func endCancelled(sess *Session) {
	sess.setStatus("cancelled")
	sess.Emit(EventSessionEnded, SessionEnded{
		Status:  "cancelled",
		Summary: "Session stopped before completion.",
	})
}

// pace sleeps 500ms-1s (750ms, fixed for deterministic demo timing) or
// returns false immediately if the session was cancelled.
func pace(ctx context.Context) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(750 * time.Millisecond):
		return true
	}
}

func strPtr(s string) *string { return &s }

func writeFileInWorktree(sess *Session, relPath, content string) {
	full := filepath.Join(sess.worktreePath, filepath.FromSlash(relPath))
	os.MkdirAll(filepath.Dir(full), 0o755)
	os.WriteFile(full, []byte(content), 0o644)
}

func updateCost(sess *Session, phase string, spent, allocated float64) {
	report, err := loadCost(sess)
	if err != nil {
		report = CostReport{}
	}
	found := false
	for i := range report.ByPhase {
		if report.ByPhase[i].Phase == phase {
			report.ByPhase[i].Spent = spent
			report.ByPhase[i].Allocated = allocated
			found = true
			break
		}
	}
	if !found {
		report.ByPhase = append(report.ByPhase, BudgetUpdate{Phase: phase, Spent: spent, Allocated: allocated})
	}
	report.TotalSpent = 0
	report.TotalAllocated = 0
	for _, b := range report.ByPhase {
		report.TotalSpent += b.Spent
		report.TotalAllocated += b.Allocated
	}
	writeCost(sess, report)
}

func loadCost(sess *Session) (CostReport, error) {
	path := filepath.Join(sess.TangentDir, "cost.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return CostReport{}, err
	}
	var report CostReport
	if err := json.Unmarshal(data, &report); err != nil {
		return CostReport{}, err
	}
	return report, nil
}
