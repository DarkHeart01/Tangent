package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/google/uuid"
)

// gateDecision is delivered from ResolveGate (an RPC-handler goroutine) to
// the single simulator goroutine that is blocked waiting on a gate.
type gateDecision struct {
	Decision string
	Note     string
}

// Session is the in-memory record for one simulated agent run. Only the
// simulator goroutine ever calls emit()/appendEvent-adjacent mutations that
// assign seq, so seq assignment needs no locking beyond what protects the
// shared events/subs slices for concurrent WS readers.
type Session struct {
	ID           string
	Goal         string
	Topology     string
	WorktreePath string
	TangentDir   string
	StartedAt    string

	mu      sync.Mutex
	status  string // running | success | failed | cancelled
	endedAt string
	nextSeq int
	events  []Envelope
	subs    map[int]chan Envelope
	nextSub int

	broadcast chan Envelope

	gatesMu sync.Mutex
	gates   map[string]chan gateDecision

	ctx    context.Context
	cancel context.CancelFunc

	traceMu   sync.Mutex
	tracePath string
}

func (s *Session) Status() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// Emit assigns the next seq, timestamps the envelope, and hands it to the
// session's fanout goroutine. Must only be called from the session's single
// producer goroutine (the simulator).
func (s *Session) Emit(t EventType, payload interface{}) Envelope {
	s.mu.Lock()
	seq := s.nextSeq
	s.nextSeq++
	s.mu.Unlock()

	env := Envelope{
		V:         1,
		SessionID: s.ID,
		Seq:       seq,
		Ts:        nowISO(),
		Type:      t,
		Payload:   payload,
	}
	s.broadcast <- env
	return env
}

// fanoutLoop is the session's single reader goroutine: it reads newly
// emitted envelopes off the broadcast channel, appends them to the durable
// event log (memory + trace.jsonl) and pushes them to every subscribed WS
// connection's writer channel, all inside one critical section so that
// Subscribe() can never observe a gap or a duplicate.
func (s *Session) fanoutLoop() {
	for env := range s.broadcast {
		s.mu.Lock()
		s.events = append(s.events, env)
		subsSnapshot := make([]chan Envelope, 0, len(s.subs))
		for _, ch := range s.subs {
			subsSnapshot = append(subsSnapshot, ch)
		}
		s.mu.Unlock()

		s.appendTrace(env)

		for _, ch := range subsSnapshot {
			ch <- env
		}
	}
}

// Subscribe registers a new WS connection's channel and returns a snapshot
// of every event emitted so far, atomically with respect to fanoutLoop, so
// the caller can replay history then rely on live delivery with no gap or
// duplicate.
func (s *Session) Subscribe() (id int, history []Envelope, live chan Envelope) {
	s.mu.Lock()
	defer s.mu.Unlock()

	history = make([]Envelope, len(s.events))
	copy(history, s.events)

	ch := make(chan Envelope, 256)
	id = s.nextSub
	s.nextSub++
	if s.subs == nil {
		s.subs = make(map[int]chan Envelope)
	}
	s.subs[id] = ch
	return id, history, ch
}

func (s *Session) Unsubscribe(id int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ch, ok := s.subs[id]; ok {
		delete(s.subs, id)
		close(ch)
	}
}

func (s *Session) appendTrace(env Envelope) {
	s.traceMu.Lock()
	defer s.traceMu.Unlock()

	f, err := os.OpenFile(s.tracePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()

	entry := TraceEntry{Seq: env.Seq, Ts: env.Ts, Type: env.Type, Payload: env.Payload}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	f.Write(line)
	f.Write([]byte("\n"))
}

// registerGate creates a channel that ResolveGate() will deliver a decision
// to, and WaitForGate blocks the calling (simulator) goroutine on it.
func (s *Session) registerGate(gateID string) chan gateDecision {
	s.gatesMu.Lock()
	defer s.gatesMu.Unlock()
	if s.gates == nil {
		s.gates = make(map[string]chan gateDecision)
	}
	ch := make(chan gateDecision, 1)
	s.gates[gateID] = ch
	return ch
}

func (s *Session) resolveGate(gateID, decision, note string) error {
	s.gatesMu.Lock()
	ch, ok := s.gates[gateID]
	if ok {
		delete(s.gates, gateID)
	}
	s.gatesMu.Unlock()

	if !ok {
		return fmt.Errorf("gate %q not pending", gateID)
	}
	ch <- gateDecision{Decision: decision, Note: note}
	return nil
}

func (s *Session) setStatus(status string) {
	s.mu.Lock()
	s.status = status
	if status != "running" {
		s.endedAt = nowISO()
	}
	s.mu.Unlock()
}

func (s *Session) summary() SessionSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionSummary{
		SessionID: s.ID,
		Goal:      s.Goal,
		Topology:  s.Topology,
		Status:    s.status,
		StartedAt: s.StartedAt,
		EndedAt:   s.endedAt,
	}
}

// Manager owns every in-memory Session and the on-disk sessions/ tree.
type Manager struct {
	mu           sync.RWMutex
	sessions     map[string]*Session
	sessionsRoot string
}

func NewManager(sessionsRoot string) *Manager {
	return &Manager{
		sessions:     make(map[string]*Session),
		sessionsRoot: sessionsRoot,
	}
}

func (m *Manager) StartSession(goal, topology string) (*Session, error) {
	if goal == "" {
		return nil, fmt.Errorf("goal must not be empty")
	}
	if topology == "" {
		topology = "coding_swarm"
	}

	id := uuid.NewString()
	sessionDir := filepath.Join(m.sessionsRoot, id)
	worktreeDir := filepath.Join(sessionDir, "worktree")
	tangentDir := filepath.Join(sessionDir, ".tangent")
	contractsDir := filepath.Join(tangentDir, "contracts")

	for _, dir := range []string{worktreeDir, tangentDir, contractsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create session dirs: %w", err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	sess := &Session{
		ID:           id,
		Goal:         goal,
		Topology:     topology,
		WorktreePath: worktreeDir,
		TangentDir:   tangentDir,
		StartedAt:    nowISO(),
		status:       "running",
		subs:         make(map[int]chan Envelope),
		gates:        make(map[string]chan gateDecision),
		broadcast:    make(chan Envelope, 64),
		ctx:          ctx,
		cancel:       cancel,
		tracePath:    filepath.Join(tangentDir, "trace.jsonl"),
	}

	m.mu.Lock()
	m.sessions[id] = sess
	m.mu.Unlock()

	go sess.fanoutLoop()

	if err := seedWorktree(worktreeDir); err != nil {
		return nil, fmt.Errorf("seed worktree: %w", err)
	}
	if err := writeManifest(sess); err != nil {
		return nil, fmt.Errorf("write manifest: %w", err)
	}
	if err := writeCost(sess, CostReport{}); err != nil {
		return nil, fmt.Errorf("write cost: %w", err)
	}

	go runSimulator(sess)

	return sess, nil
}

func (m *Manager) StopSession(sessionID string) error {
	sess, ok := m.Get(sessionID)
	if !ok {
		return fmt.Errorf("session %q not found", sessionID)
	}
	sess.cancel()
	return nil
}

func (m *Manager) ResolveGate(gateID, decision, note string) error {
	if decision != "approve" && decision != "reject" {
		return fmt.Errorf("decision must be 'approve' or 'reject', got %q", decision)
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, sess := range m.sessions {
		if err := sess.resolveGate(gateID, decision, note); err == nil {
			return nil
		}
	}
	return fmt.Errorf("gate %q not found in any active session", gateID)
}

func (m *Manager) Get(sessionID string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	sess, ok := m.sessions[sessionID]
	return sess, ok
}

func (m *Manager) ListSessions() []SessionSummary {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]SessionSummary, 0, len(m.sessions))
	for _, sess := range m.sessions {
		out = append(out, sess.summary())
	}
	return out
}

func (m *Manager) GetTrace(sessionID string) ([]TraceEntry, error) {
	sess, ok := m.Get(sessionID)
	if !ok {
		return nil, fmt.Errorf("session %q not found", sessionID)
	}
	data, err := os.ReadFile(sess.tracePath)
	if err != nil {
		if os.IsNotExist(err) {
			return []TraceEntry{}, nil
		}
		return nil, err
	}
	var entries []TraceEntry
	dec := json.NewDecoder(bytes.NewReader(data))
	for dec.More() {
		var e TraceEntry
		if err := dec.Decode(&e); err != nil {
			break
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// GetContracts reads every .tangent/contracts/<phase>.json for a session.
// Not part of the originally enumerated control-plane list, but required to
// back WalkthroughPanel — contracts live outside worktree/, so
// GetWorkspaceTree/ReadFile (deliberately scoped to the user-facing
// worktree) can't reach them.
func (m *Manager) GetContracts(sessionID string) ([]ContractEntry, error) {
	sess, ok := m.Get(sessionID)
	if !ok {
		return nil, fmt.Errorf("session %q not found", sessionID)
	}
	dir := filepath.Join(sess.TangentDir, "contracts")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []ContractEntry{}, nil
		}
		return nil, err
	}
	out := make([]ContractEntry, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var c ContractEntry
		if err := json.Unmarshal(data, &c); err != nil {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

func (m *Manager) GetCost(sessionID string) (CostReport, error) {
	sess, ok := m.Get(sessionID)
	if !ok {
		return CostReport{}, fmt.Errorf("session %q not found", sessionID)
	}
	path := filepath.Join(sess.TangentDir, "cost.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return CostReport{}, nil
		}
		return CostReport{}, err
	}
	var report CostReport
	if err := json.Unmarshal(data, &report); err != nil {
		return CostReport{}, err
	}
	return report, nil
}

func writeManifest(sess *Session) error {
	man := manifest{
		SessionID:    sess.ID,
		Goal:         sess.Goal,
		Topology:     sess.Topology,
		WorktreePath: sess.WorktreePath,
		Status:       sess.Status(),
		StartedAt:    sess.StartedAt,
	}
	data, err := json.MarshalIndent(man, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(sess.TangentDir, "manifest.json"), data, 0o644)
}

func writeCost(sess *Session, report CostReport) error {
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(sess.TangentDir, "cost.json"), data, 0o644)
}

func writeContract(sess *Session, entry ContractEntry) error {
	data, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(sess.TangentDir, "contracts", entry.Phase+".json")
	return os.WriteFile(path, data, 0o644)
}

func seedWorktree(worktreeDir string) error {
	files := map[string]string{
		"README.md": "# Simulated workspace\n\nThis worktree is populated by the Tangent IDE shell simulator.\n",
		"src/schema.ts": "export interface Widget {\n  id: string;\n  name: string;\n}\n",
		"docs/brief.md": "# Product brief\n\n(pending — will be drafted by product_manager)\n",
	}
	for rel, content := range files {
		full := filepath.Join(worktreeDir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			return err
		}
	}
	return nil
}
