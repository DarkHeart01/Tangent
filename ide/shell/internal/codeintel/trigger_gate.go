package codeintel

import (
	"fmt"
	"sync"
	"time"
)

const (
	// Gate 2: how long a dangling edge must persist before it's treated as
	// real rather than rename/refactor churn. A reasoned default, not a
	// validated one -- tune once there's real usage data (the spec makes
	// the same caveat about its own numbers).
	settleWindow = 500 * time.Millisecond

	// Gate 3 fallback: fire anyway after this much idle time in one scope,
	// if the cursor hasn't structurally left it. Spec's suggested range is
	// 800-1500ms; using the upper bound errs toward fewer interruptions.
	idleFallback = 1500 * time.Millisecond
)

// TriggerBatch groups every edge that becomes fireable as a result of one
// scope-exit (or idle-fallback) event -- spec ??5's batching rule: one
// trigger event per scope-exit, not one per reference.
type TriggerBatch struct {
	ID        string
	FilePath  string
	ScopeSpan Span
	FiredAt   time.Time
}

// FireHandler is called once per edge as it becomes fireable, tagged with
// the batch it belongs to. A batch can call this multiple times as members
// individually finish settling/resolving -- the caller (suggestion.go) uses
// BatchID to group them back together in the UI without waiting for the
// slowest member before showing anything.
type FireHandler func(batch TriggerBatch, edge Edge)

// TriggerGate implements the spec's four sequential gates:
//  1. Syntax validity      -- frontend signal (tree-sitter has the live AST)
//  2. Reference persistence -- settle-window timer, owned here
//  3. Scope-exit / idle    -- frontend signal for scope-exit; idle fallback owned here
//  4. Resolution settled   -- never fire while an edge is still `pending`, owned here
//
// Gate 1 is checked at whole-file granularity in v1 (the spec's "current
// statement" precision would need the frontend to report which specific
// statement has the error; whole-file is a reasonable simplification for a
// first pass -- it only ever makes the gate *more* conservative, never less).
type TriggerGate struct {
	graph *Graph
	fire  FireHandler

	mu sync.Mutex

	syntaxValid map[string]bool        // filePath -> Gate 1 state
	settling    map[string]*time.Timer // edgeID -> Gate 2 timer, while dangling but not yet settled
	awaiting    map[string]string      // edgeID -> batchID, for edges a scope-exit found not-yet-fireable
	idleTimers  map[string]*time.Timer // filePath -> Gate 3 idle-fallback timer
	nextBatchID uint64
}

func NewTriggerGate(graph *Graph, fire FireHandler) *TriggerGate {
	return &TriggerGate{
		graph:       graph,
		fire:        fire,
		syntaxValid: make(map[string]bool),
		settling:    make(map[string]*time.Timer),
		awaiting:    make(map[string]string),
		idleTimers:  make(map[string]*time.Timer),
	}
}

// SetSyntaxValid is Gate 1, driven by the frontend's tree-sitter parse.
func (t *TriggerGate) SetSyntaxValid(filePath string, valid bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.syntaxValid[filePath] = valid
}

// OnScopeExit is Gate 3's primary signal: the cursor structurally left
// scopeSpan in filePath. Snapshots every edge currently inside that scope
// into one new batch. Edges already settled and non-pending fire
// immediately; edges still settling or still resolving are registered so
// they fire into this same batch later, once ready, instead of blocking it
// or being dropped.
func (t *TriggerGate) OnScopeExit(filePath string, scopeSpan Span) {
	batch := TriggerBatch{FilePath: filePath, ScopeSpan: scopeSpan, FiredAt: time.Now()}

	t.mu.Lock()
	t.nextBatchID++
	batch.ID = fmt.Sprintf("batch-%d", t.nextBatchID)
	syntaxOK := t.syntaxValid[filePath]
	var toFire []Edge
	for _, edge := range t.graph.EdgesInFile(filePath) {
		if !spansContain(scopeSpan, edge.Span) {
			continue
		}
		switch edge.State {
		case StateDangling, StateResolutionFailed:
			if _, stillSettling := t.settling[edge.ID]; stillSettling {
				t.awaiting[edge.ID] = batch.ID
				continue
			}
			toFire = append(toFire, edge)
		case StateUnresolved, StatePending:
			t.awaiting[edge.ID] = batch.ID
		}
		// StateResolved: nothing to surface.
	}
	t.mu.Unlock()

	if !syntaxOK { // Gate 1: current file has a syntax error, hold off
		return
	}
	for _, edge := range toFire {
		if t.fire != nil {
			t.fire(batch, edge)
		}
	}
}

// ArmIdleFallback (re)starts Gate 3's idle-fallback timer for filePath: call
// this on every keystroke inside scopeSpan. If no structural scope-exit
// happens before the timer fires, it sweeps the scope anyway so a long
// single-scope edit doesn't hold suggestions open indefinitely.
func (t *TriggerGate) ArmIdleFallback(filePath string, scopeSpan Span) {
	t.mu.Lock()
	if existing := t.idleTimers[filePath]; existing != nil {
		existing.Stop()
	}
	t.idleTimers[filePath] = time.AfterFunc(idleFallback, func() { t.OnScopeExit(filePath, scopeSpan) })
	t.mu.Unlock()
}

// OnEdgeStateChanged is the single hook the resolution pipeline (LSP
// diagnostics, the async queue) calls whenever an edge's resolution_state
// changes. It owns Gate 2 (starts/stops the settle timer) and Gate 4
// (releases a batch-awaited edge once it's no longer pending).
func (t *TriggerGate) OnEdgeStateChanged(edgeID string, newState ResolutionState) {
	switch newState {
	case StateResolved:
		t.cancelSettle(edgeID)
		t.mu.Lock()
		delete(t.awaiting, edgeID)
		t.mu.Unlock()

	case StatePending, StateUnresolved:
		// Still not fireable -- nothing to do but make sure it isn't
		// mid-settle from a stale prior state.
		t.cancelSettle(edgeID)

	case StateDangling:
		t.mu.Lock()
		if _, already := t.settling[edgeID]; !already {
			t.settling[edgeID] = time.AfterFunc(settleWindow, func() { t.onSettled(edgeID) })
		}
		t.mu.Unlock()

	case StateResolutionFailed:
		// Distinct from dangling and doesn't need a settle window -- it's
		// not something that resolves itself as the user keeps typing.
		t.cancelSettle(edgeID)
		t.releaseIfAwaited(edgeID)
	}
}

func (t *TriggerGate) cancelSettle(edgeID string) {
	t.mu.Lock()
	if timer, ok := t.settling[edgeID]; ok {
		timer.Stop()
		delete(t.settling, edgeID)
	}
	t.mu.Unlock()
}

func (t *TriggerGate) onSettled(edgeID string) {
	t.mu.Lock()
	delete(t.settling, edgeID)
	t.mu.Unlock()

	edge, ok := t.graph.GetEdge(edgeID)
	if !ok || (edge.State != StateDangling && edge.State != StateResolutionFailed) {
		return // resolved or removed while settling
	}
	t.releaseIfAwaited(edgeID)
}

// releaseIfAwaited fires edgeID into whatever batch a prior scope-exit
// registered it under, if any. An edge that becomes fireable with no
// open batch waiting on it (e.g. it settled before any scope-exit ever
// happened) simply waits for the next scope-exit or idle-fallback sweep --
// it's already sitting in the graph, so that sweep will find it.
func (t *TriggerGate) releaseIfAwaited(edgeID string) {
	t.mu.Lock()
	batchID, ok := t.awaiting[edgeID]
	if ok {
		delete(t.awaiting, edgeID)
	}
	t.mu.Unlock()
	if !ok {
		return
	}
	edge, ok := t.graph.GetEdge(edgeID)
	if !ok {
		return
	}

	t.mu.Lock()
	syntaxOK := t.syntaxValid[edge.FilePath]
	t.mu.Unlock()
	if !syntaxOK { // Gate 1: current file has a syntax error, hold off
		return
	}
	if t.fire != nil {
		t.fire(TriggerBatch{ID: batchID, FilePath: edge.FilePath, ScopeSpan: edge.Span, FiredAt: time.Now()}, edge)
	}
}

func spansContain(outer, inner Span) bool {
	outerStart, outerEnd := [2]int{outer.StartLine, outer.StartCol}, [2]int{outer.EndLine, outer.EndCol}
	innerStart, innerEnd := [2]int{inner.StartLine, inner.StartCol}, [2]int{inner.EndLine, inner.EndCol}
	return lessOrEqual(outerStart, innerStart) && lessOrEqual(innerEnd, outerEnd)
}
