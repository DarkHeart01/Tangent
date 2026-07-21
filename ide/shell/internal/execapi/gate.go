package execapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// defaultGateTimeout is intentionally long — a human approval isn't a
// 30-second operation, and this must not spuriously time out while someone
// is reading a phase diff or thinking about whether to approve a deploy.
const defaultGateTimeout = 10 * time.Minute

// gateRequest is the wire shape for every kind this endpoint serves: a
// lifecycle phase-transition gate (coordination/orchestrator.py's
// on_gate_request), a mutates-external tool-call confirmation
// (coordination/safety.py's confirm_tool_call), and a human_input question
// (coordination/orchestrator.py's _daemon_ws_requester, registered as
// tools/human_input/handler.py's _ws_requester). Only the fields relevant
// to the given Kind need be set.
type gateRequest struct {
	Kind           string   `json:"kind"` // "phase" | "tool_call" | "question"
	PhaseID        string   `json:"phase_id,omitempty"`
	PhaseName      string   `json:"phase_name,omitempty"`
	ToolName       string   `json:"tool_name,omitempty"`
	SideEffectTier string   `json:"side_effect_tier,omitempty"`
	ArgsSummary    string   `json:"args_summary,omitempty"`
	Prompt         string   `json:"prompt,omitempty"`
	Options        []string `json:"options,omitempty"`
	TimeoutSeconds float64  `json:"timeout_seconds,omitempty"`
}

// Used for "phase"/"tool_call" kinds. "question" kind writes
// {"response": "..."} directly instead — see handleGate.
type gateResponse struct {
	Approved bool `json:"approved"`
}

// Mirrors session.HumanGatePending's JSON shape. side_effect_tier is
// meaningless for a "question" gate (nothing is being mutated), so it's
// omitted rather than sent as an empty/placeholder value for that kind.
type humanGatePendingPayload struct {
	GateID         string `json:"gate_id"`
	GateKind       string `json:"gate_kind"` // "phase" | "tool_call" | "question"
	Phase          string `json:"phase"`
	SideEffectTier string `json:"side_effect_tier,omitempty"`
	Reason         string `json:"reason"`
	ProposedAction string `json:"proposed_action"`
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

	var phase, reason, proposedAction, tier, gateKind string
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
		gateKind = "question"
		reason = req.Prompt
		if len(req.Options) > 0 {
			proposedAction = "Options: " + strings.Join(req.Options, ", ")
		}
	default:
		http.Error(w, "unknown gate kind (want \"phase\", \"tool_call\", or \"question\")", http.StatusBadRequest)
		return
	}

	gateID := newID()
	resultCh := s.gateStore.register(gateID)

	s.emit(sessionID, "human_gate.pending", humanGatePendingPayload{
		GateID: gateID, GateKind: gateKind, Phase: phase, SideEffectTier: tier,
		Reason: reason, ProposedAction: proposedAction,
	})

	timeout := s.gateTimeout
	if timeout <= 0 {
		timeout = defaultGateTimeout
	}
	// A "question" carries its own caller-supplied timeout (the human_input
	// tool's own spec.timeout, typically much shorter than the 10-minute
	// default used for phase/tool_call gates) — the Go side must honor it
	// rather than block far longer than the Python side's httpx client will
	// actually wait.
	if req.Kind == "question" && req.TimeoutSeconds > 0 {
		timeout = time.Duration(req.TimeoutSeconds * float64(time.Second))
	}

	select {
	case result := <-resultCh:
		s.emit(sessionID, "human_gate.resolved", humanGateResolvedPayload{
			GateID: gateID, Decision: result.Decision, Note: result.Note,
		})
		if req.Kind == "question" {
			writeJSON(w, http.StatusOK, map[string]string{"response": result.Decision})
		} else {
			writeJSON(w, http.StatusOK, gateResponse{Approved: result.Decision == "approve"})
		}

	case <-time.After(timeout):
		s.gateStore.remove(gateID)
		if req.Kind == "question" {
			// Matches the existing non-daemon fallback in
			// tools/human_input/handler.py (WS timeout -> "proceed") rather
			// than reusing "reject", which has no meaning for a question.
			s.emit(sessionID, "human_gate.resolved", humanGateResolvedPayload{
				GateID: gateID, Decision: "proceed", Note: "timed out waiting for a human answer",
			})
			writeJSON(w, http.StatusOK, map[string]string{"response": "proceed"})
			return
		}
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
