package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"shell/internal/session"
	"shell/internal/workspace"
	"shell/internal/wsserver"
)

// SessionAPI is the Wails-bound control plane. The WS event server and the
// Wails Go backend run in the same process — SessionAPI owns both the
// in-memory session manager and the WS server that streams each session's
// scripted event sequence.
type SessionAPI struct {
	ctx     context.Context
	manager *session.Manager
	ws      *wsserver.Server
}

func NewSessionAPI() *SessionAPI {
	return &SessionAPI{}
}

// startup is called by Wails once the frontend is ready. It boots the
// in-memory session manager and the localhost-only WS event server.
func (s *SessionAPI) startup(ctx context.Context) {
	s.ctx = ctx

	root, err := sessionsRoot()
	if err != nil {
		runtime.LogErrorf(ctx, "sessionsRoot: %v", err)
		root = "sessions"
	}
	repo, err := repoRoot()
	if err != nil {
		runtime.LogErrorf(ctx, "repoRoot: %v", err)
		repo = "."
	}
	s.manager = session.NewManager(root, repo)

	ws, err := wsserver.New(s.manager)
	if err != nil {
		runtime.LogErrorf(ctx, "wsserver.New: %v", err)
		return
	}
	port, err := ws.Start()
	if err != nil {
		runtime.LogErrorf(ctx, "wsserver.Start: %v", err)
		return
	}
	runtime.LogInfof(ctx, "wsserver listening on 127.0.0.1:%d", port)
	s.ws = ws
}

func (s *SessionAPI) shutdown(ctx context.Context) {
	if s.ws != nil {
		s.ws.Stop()
	}
}

func sessionsRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(wd, "sessions"), nil
}

// repoRoot is the git repo "container" mode checks worktrees out of.
// TANGENT_REPO_PATH overrides it (e.g. to point at a scratch test repo
// instead of the real Tangent monorepo); by default it resolves to the
// Tangent repo root, two levels up from ide/shell (this binary's cwd).
func repoRoot() (string, error) {
	if p := os.Getenv("TANGENT_REPO_PATH"); p != "" {
		return p, nil
	}
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(wd, "..", ".."), nil
}

// StartSession creates a new agent session — "simulated" (default) plays
// back simulator.go's scripted sequence, "container" spawns a real,
// hardened Docker container against a real git worktree — and begins
// streaming its event sequence over the returned WS URL.
func (s *SessionAPI) StartSession(goal, topology, mode string) (session.StartSessionResult, error) {
	sess, err := s.manager.StartSession(session.SessionStartOpts{
		Goal:     goal,
		Topology: topology,
		Mode:     mode,
	})
	if err != nil {
		return session.StartSessionResult{}, err
	}
	return session.StartSessionResult{
		SessionID: sess.ID,
		WSURL:     s.ws.SessionURL(sess.ID),
	}, nil
}

// StopSession cancels a running session; the simulator emits a final
// session.ended{status:"cancelled"} before its goroutine exits.
func (s *SessionAPI) StopSession(sessionID string) error {
	return s.manager.StopSession(sessionID)
}

// ResolveGate unblocks the simulator goroutine that is waiting on gateID.
func (s *SessionAPI) ResolveGate(gateID, decision, note string) error {
	return s.manager.ResolveGate(gateID, decision, note)
}

func (s *SessionAPI) ListSessions() ([]session.SessionSummary, error) {
	return s.manager.ListSessions(), nil
}

func (s *SessionAPI) GetWorkspaceTree(sessionID string) ([]session.FileNode, error) {
	sess, ok := s.manager.Get(sessionID)
	if !ok {
		return nil, fmt.Errorf("session %q not found", sessionID)
	}
	return workspace.Tree(sess.GetWorktreePath())
}

func (s *SessionAPI) ReadFile(sessionID, path string) (session.FileContent, error) {
	sess, ok := s.manager.Get(sessionID)
	if !ok {
		return session.FileContent{}, fmt.Errorf("session %q not found", sessionID)
	}
	return workspace.Read(sess.GetWorktreePath(), path)
}

func (s *SessionAPI) WriteFile(sessionID, path, content string) error {
	sess, ok := s.manager.Get(sessionID)
	if !ok {
		return fmt.Errorf("session %q not found", sessionID)
	}
	return workspace.Write(sess.GetWorktreePath(), path, content)
}

func (s *SessionAPI) GetTrace(sessionID string) ([]session.TraceEntry, error) {
	return s.manager.GetTrace(sessionID)
}

// GetContracts backs WalkthroughPanel: it reads every
// .tangent/contracts/<phase>.json for the session directly off disk.
func (s *SessionAPI) GetContracts(sessionID string) ([]session.ContractEntry, error) {
	return s.manager.GetContracts(sessionID)
}

func (s *SessionAPI) GetCost(sessionID string) (session.CostReport, error) {
	return s.manager.GetCost(sessionID)
}
