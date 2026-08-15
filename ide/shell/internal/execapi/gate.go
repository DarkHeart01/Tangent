package execapi

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// defaultGateTimeout is intentionally long — a human approval isn't a
// 30-second operation, and this must not spuriously time out while someone
// is reading a phase diff or thinking about whether to approve a deploy.
const defaultGateTimeout = 10 * time.Minute

// gateRequest is the internal shape every gate kind maps onto: a lifecycle
// phase-transition gate (coordination/orchestrator.py's on_gate_request), a
// mutates-external tool-call confirmation (coordination/safety.py's
// confirm_tool_call), and a human_input question
// (coordination/orchestrator.py's _daemon_ws_requester, registered as
// tools/human_input/handler.py's _ws_requester) — all three arrive as one
// Gate.Request RPC (grpc.go), which builds this struct from the incoming
// pb.GateRequest before calling requestGate below. Only the fields
// relevant to the given Kind need be set.
type gateRequest struct {
	Kind           string // "phase" | "tool_call" | "question"
	PhaseID        string
	PhaseName      string
	ToolName       string
	SideEffectTier string
	ArgsSummary    string
	Prompt         string
	Options        []string
}

// Mirrors session.HumanGatePending's JSON shape. side_effect_tier is
// meaningless for a "question" gate (nothing is being mutated), so it's
// omitted rather than sent as an empty/placeholder value for that kind.
type humanGatePendingPayload struct {
	GateID         string   `json:"gate_id"`
	GateKind       string   `json:"gate_kind"` // "phase" | "tool_call" | "question"
	Phase          string   `json:"phase"`
	SideEffectTier string   `json:"side_effect_tier,omitempty"`
	Reason         string   `json:"reason"`
	ProposedAction string   `json:"proposed_action"`
	Options        []string `json:"options,omitempty"` // "question" kind only
}

// Decision carries whatever ResolveGate's decision parameter was passed:
// "approve"/"reject" for phase/tool_call kinds, or the raw free-text/
// selected-option answer for a "question" kind. What it means is decided
// by handleGate's per-kind response construction below, not by gateStore
// itself — the store is just a transport.
type gateResult struct {
	Decision string
	Note     string
}

// gateStore is the pending-gates map: one Go channel per outstanding gate,
// resolved by ResolveGate (called from the existing Wails-bound
// SessionAPI.ResolveGate method — no new control-plane method needed).
type gateStore struct {
	mu    sync.Mutex
	gates map[string]chan gateResult
}

func newGateStore() *gateStore {
	return &gateStore{gates: make(map[string]chan gateResult)}
}

func (g *gateStore) register(gateID string) chan gateResult {
	g.mu.Lock()
	defer g.mu.Unlock()
	ch := make(chan gateResult, 1)
	g.gates[gateID] = ch
	return ch
}

func (g *gateStore) remove(gateID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.gates, gateID)
}

// Resolve delivers a decision to a pending gate. Returns false if gateID
// isn't one of this store's — Manager.ResolveGate falls back to trying
// session-native gates (simulator.go's scripted human_gate.pending) in
// that case, so a single gate_id namespace works regardless of which
// mechanism created it.
func (g *gateStore) resolve(gateID, decision, note string) bool {
	g.mu.Lock()
	ch, ok := g.gates[gateID]
	if ok {
		delete(g.gates, gateID)
	}
	g.mu.Unlock()
	if !ok {
		return false
	}
	ch <- gateResult{Decision: decision, Note: note}
	return true
}

// ResolveGate is called by session.Manager.ResolveGate as a fallback when
// gateID doesn't belong to any session's own registerGate map.
func (s *Server) ResolveGate(gateID, decision, note string) bool {
	return s.gateStore.resolve(gateID, decision, note)
}

// requestGate is the Gate.Request service's actual logic (grpc.go's
// Request method calls this directly) — the pending/resolved event
// sequence and fail-closed timeout behavior around gateStore, shared by
// all three gate kinds.
//
// explicitTimeout is always 0 from grpc.go today (pb.GateRequest has no
// timeout_seconds field by design — see execapi.proto); kept as a
// parameter, not folded into gateWaitTimeout's ctx-only lookup, for the
// same reason runExec keeps one.
func (s *Server) requestGate(ctx context.Context, sessionID string, req gateRequest, explicitTimeout time.Duration) (gateResult, error) {
	var phase, reason, proposedAction, tier, gateKind string
	var options []string
	switch req.Kind {
	case "phase":
		gateKind = "phase"
		phase = req.PhaseID
		tier = "mutates-external"
		reason = fmt.Sprintf("Phase %q is ready for review.", req.PhaseName)
		proposedAction = fmt.Sprintf("Continue past phase %q", req.PhaseName)
	case "tool_call":
		gateKind = "tool_call"
		tier = req.SideEffectTier
		if tier == "" {
			tier = "mutates-external"
		}
		reason = fmt.Sprintf("Tool %q (%s) requires confirmation before running.", req.ToolName, tier)
		proposedAction = req.ArgsSummary
	case "question":
		// No side_effect_tier — nothing is being mutated, a question is
		// just waiting on a real answer (or a real frontend to relay one).
		// options is passed through structured (not flattened into a
		// display string) so the frontend can render a real picker rather
		// than parsing free text back out of proposed_action.
		gateKind = "question"
		reason = req.Prompt
		options = req.Options
	default:
		return gateResult{}, fmt.Errorf("unknown gate kind %q (want \"phase\", \"tool_call\", or \"question\")", req.Kind)
	}

	gateID := newID()
	resultCh := s.gateStore.register(gateID)

	s.emit(sessionID, "human_gate.pending", humanGatePendingPayload{
		GateID: gateID, GateKind: gateKind, Phase: phase, SideEffectTier: tier,
		Reason: reason, ProposedAction: proposedAction, Options: options,
	})

	timeout := s.gateWaitTimeout(ctx, explicitTimeout)

	select {
	case result := <-resultCh:
		s.emit(sessionID, "human_gate.resolved", humanGateResolvedPayload{
			GateID: gateID, Decision: result.Decision, Note: result.Note,
		})
		return result, nil

	case <-time.After(timeout):
		s.gateStore.remove(gateID)
		if req.Kind == "question" {
			// Matches the existing non-daemon fallback in
			// tools/human_input/handler.py (WS timeout -> "proceed") rather
			// than reusing "reject", which has no meaning for a question.
			result := gateResult{Decision: "proceed", Note: "timed out waiting for a human answer"}
			s.emit(sessionID, "human_gate.resolved", humanGateResolvedPayload{
				GateID: gateID, Decision: result.Decision, Note: result.Note,
			})
			return result, nil
		}
		// Fail closed: an un-actioned mutates-external gate is treated as
		// rejected, not silently approved, after a very long wait.
		result := gateResult{Decision: "reject", Note: "timed out waiting for a human decision"}
		s.emit(sessionID, "human_gate.resolved", humanGateResolvedPayload{
			GateID: gateID, Decision: result.Decision, Note: result.Note,
		})
		return result, nil

	case <-ctx.Done():
		s.gateStore.remove(gateID)
		return gateResult{}, ctx.Err()
	}
}

// gateWaitTimeout: an explicit override wins if given; otherwise derive it
// from ctx's own deadline — grpc's native per-call deadline, propagated
// from the Python client's RPC timeout — minus a small safety margin so
// this handler can still respond with a clean "reject"/"proceed" a moment
// before the caller's own deadline would fire and turn it into a raw
// DeadlineExceeded instead; otherwise defaultGateTimeout.
func (s *Server) gateWaitTimeout(ctx context.Context, explicit time.Duration) time.Duration {
	if explicit > 0 {
		return explicit
	}
	if deadline, ok := ctx.Deadline(); ok {
		const margin = 2 * time.Second
		if remaining := time.Until(deadline); remaining > margin {
			return remaining - margin
		} else if remaining > 0 {
			return remaining
		}
	}
	if s.gateTimeout > 0 {
		return s.gateTimeout
	}
	return defaultGateTimeout
}

// Mirrors session.HumanGateResolved's JSON shape.
type humanGateResolvedPayload struct {
	GateID   string `json:"gate_id"`
	Decision string `json:"decision"`
	Note     string `json:"note,omitempty"`
}
