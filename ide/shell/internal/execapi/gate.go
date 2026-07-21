package execapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// defaultGateTimeout is intentionally long — a human approval isn't a
// 30-second operation, and this must not spuriously time out while someone
// is reading a phase diff or thinking about whether to approve a deploy.
const defaultGateTimeout = 10 * time.Minute

// gateRequest is the wire shape for both kinds this endpoint serves:
// a lifecycle phase-transition gate (coordination/orchestrator.py's
// on_gate_request) and a mutates-external tool-call confirmation
// (coordination/safety.py's confirm_tool_call). Only the fields relevant to
// the given Kind need be set.
type gateRequest struct {
	Kind           string `json:"kind"` // "phase" | "tool_call"
	PhaseID        string `json:"phase_id,omitempty"`
	PhaseName      string `json:"phase_name,omitempty"`
	ToolName       string `json:"tool_name,omitempty"`
	SideEffectTier string `json:"side_effect_tier,omitempty"`
	ArgsSummary    string `json:"args_summary,omitempty"`
}

type gateResponse struct {
	Approved bool `json:"approved"`
}

// Mirrors session.HumanGatePending's JSON shape.
type humanGatePendingPayload struct {
	GateID         string `json:"gate_id"`
	Phase          string `json:"phase"`
	SideEffectTier string `json:"side_effect_tier"`
	Reason         string `json:"reason"`
	ProposedAction string `json:"proposed_action"`
}

type gateResult struct {
	Approved bool
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
	ch <- gateResult{Approved: decision == "approve", Note: note}
	return true
}

// ResolveGate is called by session.Manager.ResolveGate as a fallback when
// gateID doesn't belong to any session's own registerGate map.
func (s *Server) ResolveGate(gateID, decision, note string) bool {
	return s.gateStore.resolve(gateID, decision, note)
}

func (s *Server) handleGate(w http.ResponseWriter, r *http.Request) {
	_, sessionID, ok := s.authenticate(w, r)
	if !ok {
		return
	}

	var req gateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	var phase, reason, proposedAction, tier string
	switch req.Kind {
	case "phase":
		phase = req.PhaseID
		tier = "mutates-external"
		reason = fmt.Sprintf("Phase %q is ready for review.", req.PhaseName)
		proposedAction = fmt.Sprintf("Continue past phase %q", req.PhaseName)
	case "tool_call":
		tier = req.SideEffectTier
		if tier == "" {
			tier = "mutates-external"
		}
		reason = fmt.Sprintf("Tool %q (%s) requires confirmation before running.", req.ToolName, tier)
		proposedAction = req.ArgsSummary
	default:
		http.Error(w, "unknown gate kind (want \"phase\" or \"tool_call\")", http.StatusBadRequest)
		return
	}

	gateID := newID()
	resultCh := s.gateStore.register(gateID)

	s.emit(sessionID, "human_gate.pending", humanGatePendingPayload{
		GateID: gateID, Phase: phase, SideEffectTier: tier,
		Reason: reason, ProposedAction: proposedAction,
	})

	timeout := s.gateTimeout
	if timeout <= 0 {
		timeout = defaultGateTimeout
	}

	select {
	case result := <-resultCh:
		s.emit(sessionID, "human_gate.resolved", humanGateResolvedPayload{
			GateID: gateID, Decision: decisionString(result.Approved), Note: result.Note,
		})
		writeJSON(w, http.StatusOK, gateResponse{Approved: result.Approved})

	case <-time.After(timeout):
		s.gateStore.remove(gateID)
		// Fail closed: an un-actioned mutates-external gate is treated as
		// rejected, not silently approved, after a very long wait.
		s.emit(sessionID, "human_gate.resolved", humanGateResolvedPayload{
			GateID: gateID, Decision: "reject", Note: "timed out waiting for a human decision",
		})
		writeJSON(w, http.StatusOK, gateResponse{Approved: false})

	case <-r.Context().Done():
		s.gateStore.remove(gateID)
	}
}

// Mirrors session.HumanGateResolved's JSON shape.
type humanGateResolvedPayload struct {
	GateID   string `json:"gate_id"`
	Decision string `json:"decision"`
	Note     string `json:"note,omitempty"`
}

func decisionString(approved bool) string {
	if approved {
		return "approve"
	}
	return "reject"
}
