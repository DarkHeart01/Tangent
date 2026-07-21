// Package execapi is the HTTP surface the real Python swarm process calls
// back into, to run shell_exec inside the session's sandboxed container and
// to read/write files in the session's worktree — the daemon-routing path
// tools/shell_exec and tools/filesystem fall into when TANGENT_DAEMON_URL
// is set. Bound to 127.0.0.1 only; every request needs a per-session bearer
// token minted at StartSession time.
//
// Deliberately has zero dependency on the session package (which owns
// *Server) or internal/workspace (which imports session for its
// FileNode/FileContent types) — importing either here would create a cycle.
// Event payload shapes and the worktree path-jail check are duplicated
// in miniature rather than shared, on purpose.
package execapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"shell/internal/docker"
)

type SessionInfo struct {
	ContainerID  string
	WorktreePath string
	Token        string
}

// EmitFunc matches session.Manager.emitToSession's signature exactly, so
// Manager can pass emitToSession straight in without execapi needing to
// know the session package's Envelope/EventType types.
type EmitFunc func(sessionID, eventType string, payload interface{})

type Server struct {
	docker *docker.DockerManager
	emit   EmitFunc

	mu       sync.RWMutex
	sessions map[string]SessionInfo

	gateStore   *gateStore
	gateTimeout time.Duration

	port     int
	listener net.Listener
	httpSrv  *http.Server
}

func New(dm *docker.DockerManager, emit EmitFunc) *Server {
	return &Server{
		docker:    dm,
		emit:      emit,
		sessions:  make(map[string]SessionInfo),
		gateStore: newGateStore(),
	}
}

// GenerateToken creates a fresh per-session bearer token. Called by
// ContainerExecutor.Start alongside worktree/container creation.
func GenerateToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func (s *Server) Register(sessionID string, info SessionInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[sessionID] = info
}

func (s *Server) Unregister(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, sessionID)
}

func (s *Server) lookup(sessionID string) (SessionInfo, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	info, ok := s.sessions[sessionID]
	return info, ok
}

func (s *Server) Start() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	s.listener = ln
	s.port = ln.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	mux.HandleFunc("POST /sessions/{session_id}/exec", s.handleExec)
	mux.HandleFunc("GET /sessions/{session_id}/fs", s.handleFSGet)
	mux.HandleFunc("PUT /sessions/{session_id}/fs", s.handleFSPut)
	mux.HandleFunc("POST /sessions/{session_id}/gate", s.handleGate)
	s.httpSrv = &http.Server{Handler: mux}

	go func() {
		_ = s.httpSrv.Serve(ln)
	}()

	return s.port, nil
}

func (s *Server) Stop() error {
	if s.httpSrv == nil {
		return nil
	}
	return s.httpSrv.Close()
}

// BaseURL is what gets handed to the swarm subprocess as TANGENT_DAEMON_URL.
func (s *Server) BaseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", s.port)
}

// authenticate resolves session_id from the URL, checks the bearer token
// against that session's registered token, and writes the error response
// itself on failure.
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (SessionInfo, string, bool) {
	sessionID := r.PathValue("session_id")
	info, ok := s.lookup(sessionID)
	if !ok {
		http.Error(w, "unknown session", http.StatusNotFound)
		return SessionInfo{}, "", false
	}
	token, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !found || token != info.Token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return SessionInfo{}, "", false
	}
	return info, sessionID, true
}

// ── exec ─────────────────────────────────────────────────────────────────

// Field names deliberately match tools/shell_exec/handler.py's actual
// inputs (command: str, working_dir: str) and return dict (stdout, stderr,
// returncode) — not the illustrative cmd:[]string/exit_code shape — so the
// Python side can pass its `inputs` through with minimal translation.
type execRequest struct {
	Command        string  `json:"command"`
	WorkingDir     string  `json:"working_dir"`
	TimeoutSeconds float64 `json:"timeout_seconds"`
}

type execResponse struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ReturnCode int    `json:"returncode"`
}

// Mirrors session.ToolCall/session.ToolResult's JSON shape exactly.
type toolCallPayload struct {
	AgentInstanceID string `json:"agent_instance_id"`
	ToolName        string `json:"tool_name"`
	SideEffectTier  string `json:"side_effect_tier"`
	ArgsSummary     string `json:"args_summary"`
	CallID          string `json:"call_id"`
}

type toolResultPayload struct {
	CallID  string `json:"call_id"`
	Status  string `json:"status"`
	Summary string `json:"summary"`
}

// Mirrors session.TerminalOutput's JSON shape.
type terminalOutputPayload struct {
	ContainerID string `json:"container_id"`
	Stream      string `json:"stream"`
	Data        string `json:"data"`
}

// emitLines splits data on newlines and emits one terminal.output per
// non-empty line, matching how StreamLogs (Step 4) fed the Terminal panel
// for the old one-shot containers — exec output needs the same treatment
// since a persistent container never produces anything through
// ContainerLogs.
func emitLines(emit EmitFunc, sessionID, containerID, stream, data string) {
	for _, line := range strings.Split(data, "\n") {
		if line == "" {
			continue
		}
		emit(sessionID, "terminal.output", terminalOutputPayload{
			ContainerID: containerID, Stream: stream, Data: line + "\n",
		})
	}
}

func (s *Server) handleExec(w http.ResponseWriter, r *http.Request) {
	info, sessionID, ok := s.authenticate(w, r)
	if !ok {
		return
	}

	var req execRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if req.Command == "" {
		http.Error(w, "command is required", http.StatusBadRequest)
		return
	}
	timeout := time.Duration(req.TimeoutSeconds * float64(time.Second))
	if timeout <= 0 {
		timeout = 30 * time.Second
	}

	containerCwd, err := resolveContainerPath(req.WorkingDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	callID := newID()
	s.emit(sessionID, "tool.call", toolCallPayload{
		ToolName: "shell_exec", SideEffectTier: "mutates-local",
		ArgsSummary: truncate(req.Command, 200), CallID: callID,
	})

	exitCode, stdout, stderr, err := s.docker.ExecInContainer(
		r.Context(), info.ContainerID, []string{"sh", "-c", req.Command}, containerCwd, timeout,
	)
	if err != nil {
		s.emit(sessionID, "tool.result", toolResultPayload{CallID: callID, Status: "error", Summary: err.Error()})
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// The Terminal panel's pipeline (Step 4) is driven by terminal.output —
	// tool.call/tool.result alone would only show up in the Dashboard, not
	// the actual command output the DoD wants visible in the Terminal tab.
	emitLines(s.emit, sessionID, info.ContainerID, "stdout", stdout)
	emitLines(s.emit, sessionID, info.ContainerID, "stderr", stderr)

	status := "ok"
	if exitCode != 0 {
		status = "error"
	}
	s.emit(sessionID, "tool.result", toolResultPayload{
		CallID: callID, Status: status, Summary: fmt.Sprintf("exit code %d", exitCode),
	})

	writeJSON(w, http.StatusOK, execResponse{Stdout: stdout, Stderr: stderr, ReturnCode: exitCode})
}

// resolveContainerPath validates working_dir (as given by the swarm
// process, relative to its own project root == /workspace inside the
// container) and returns the absolute container path, rejecting escape
// from /workspace. POSIX path semantics (path, not filepath) since this
// resolves a path inside the Linux container, not on the Windows/host fs.
func resolveContainerPath(workingDir string) (string, error) {
	if workingDir == "" || workingDir == "." {
		return "/workspace", nil
	}
	joined := path.Join("/workspace", workingDir)
	if joined != "/workspace" && !strings.HasPrefix(joined, "/workspace/") {
		return "", fmt.Errorf("working_dir escapes /workspace")
	}
	return joined, nil
}

// ── filesystem ───────────────────────────────────────────────────────────

func (s *Server) handleFSGet(w http.ResponseWriter, r *http.Request) {
	info, sessionID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	relPath := r.URL.Query().Get("path")
	full, err := resolveHostPath(info.WorktreePath, relPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	callID := newID()
	s.emit(sessionID, "tool.call", toolCallPayload{
		ToolName: "filesystem", SideEffectTier: "read-only",
		ArgsSummary: "read " + relPath, CallID: callID,
	})

	data, err := os.ReadFile(full)
	if err != nil {
		if os.IsNotExist(err) {
			s.emit(sessionID, "tool.result", toolResultPayload{CallID: callID, Status: "error", Summary: "not found"})
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		s.emit(sessionID, "tool.result", toolResultPayload{CallID: callID, Status: "error", Summary: err.Error()})
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.emit(sessionID, "tool.result", toolResultPayload{
		CallID: callID, Status: "ok", Summary: fmt.Sprintf("%d bytes", len(data)),
	})

	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) handleFSPut(w http.ResponseWriter, r *http.Request) {
	info, sessionID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	relPath := r.URL.Query().Get("path")
	full, err := resolveHostPath(info.WorktreePath, relPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	callID := newID()
	s.emit(sessionID, "tool.call", toolCallPayload{
		ToolName: "filesystem", SideEffectTier: "mutates-local",
		ArgsSummary: "write " + relPath, CallID: callID,
	})

	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		s.emit(sessionID, "tool.result", toolResultPayload{CallID: callID, Status: "error", Summary: err.Error()})
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.WriteFile(full, body, 0o644); err != nil {
		s.emit(sessionID, "tool.result", toolResultPayload{CallID: callID, Status: "error", Summary: err.Error()})
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// file.changed is left to the existing fsnotify watcher on worktreePath
	// (Step 4) — emitting it here too would double-fire.
	s.emit(sessionID, "tool.result", toolResultPayload{
		CallID: callID, Status: "ok", Summary: fmt.Sprintf("%d bytes", len(body)),
	})

	writeJSON(w, http.StatusOK, map[string]int{"bytes_written": len(body)})
}

// resolveHostPath is the same defense-in-depth check as
// internal/workspace/fs.go's resolve() — duplicated rather than shared,
// see the package doc comment for why.
func resolveHostPath(worktreePath, relPath string) (string, error) {
	if relPath == "" {
		return "", fmt.Errorf("path is required")
	}
	cleanRel := filepath.Clean(filepath.FromSlash(relPath))
	full := filepath.Join(worktreePath, cleanRel)
	rootAbs, err := filepath.Abs(worktreePath)
	if err != nil {
		return "", err
	}
	fullAbs, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	if fullAbs != rootAbs && !strings.HasPrefix(fullAbs, rootAbs+string(os.PathSeparator)) {
		return "", fmt.Errorf("path %q escapes worktree", relPath)
	}
	return fullAbs, nil
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func newID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
