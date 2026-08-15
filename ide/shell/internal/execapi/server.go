// Package execapi is the gRPC surface the real Python swarm process calls
// back into, to run shell_exec inside the session's sandboxed container and
// to read/write files in the session's worktree — the daemon-routing path
// tools/shell_exec and tools/filesystem fall into when
// TANGENT_DAEMON_GRPC_TARGET is set. Bound to 127.0.0.1 only; every call
// needs a per-session bearer token (see grpc.go's authInterceptor).
//
// Previously an HTTP surface (POST /sessions/{id}/exec, GET|PUT
// /sessions/{id}/fs, POST /sessions/{id}/gate) — retired once the Python
// side was fully swapped to the gRPC services in grpc.go and real
// verification passed (see the gRPC-execapi-migration task this shipped
// with). The business logic below (runExec/readFile/writeFile/
// requestGate in gate.go) is unchanged from that HTTP version; only the
// transport and auth (grpc.go's metadata-based authInterceptor, replacing
// authenticate's URL-path-segment + header check) are new.
//
// Deliberately has zero dependency on the session package (which owns
// *Server) or internal/workspace (which imports session for its
// FileNode/FileContent types) — importing either here would create a cycle.
// Event payload shapes and the worktree path-jail check are duplicated
// in miniature rather than shared, on purpose.
package execapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"

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

	grpcPort     int
	grpcListener net.Listener
	grpcSrv      *grpc.Server
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

// Stop tears down the gRPC listener — session.Manager.Shutdown and
// containerExecutor's error paths already call Stop() once per Server.
func (s *Server) Stop() error {
	s.StopGRPC()
	return nil
}

// ── exec ─────────────────────────────────────────────────────────────────

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

// execResult is what the gRPC Exec.Run service (grpc.go) projects onto
// pb.ExecResponse.
type execResult struct {
	Stdout     string
	Stderr     string
	ReturnCode int
}

// validationError marks a caller-input problem (bad command, working_dir
// escape) as distinct from an execution failure — grpc.go maps it to
// InvalidArgument vs Internal.
type validationError struct{ msg string }

func (e *validationError) Error() string { return e.msg }

// runExec is the Exec.Run service's actual logic (grpc.go's Run method
// calls this directly) — container-path jail, then the
// tool.call/terminal.output/tool.result event sequence around the real
// docker exec.
//
// explicitTimeout is 0 in every caller today (pb.ExecRequest has no
// timeout_seconds field by design — see execapi.proto); kept as a
// parameter rather than folded into execTimeout's ctx-only lookup so a
// future non-gRPC caller isn't forced through a context deadline to get a
// custom timeout.
func (s *Server) runExec(ctx context.Context, sessionID string, info SessionInfo, command, workingDir string, explicitTimeout time.Duration) (execResult, error) {
	if command == "" {
		return execResult{}, &validationError{"command is required"}
	}
	timeout := s.execTimeout(ctx, explicitTimeout)

	containerCwd, err := resolveContainerPath(workingDir)
	if err != nil {
		return execResult{}, &validationError{err.Error()}
	}

	callID := newID()
	s.emit(sessionID, "tool.call", toolCallPayload{
		ToolName: "shell_exec", SideEffectTier: "mutates-local",
		ArgsSummary: truncate(command, 200), CallID: callID,
	})

	exitCode, stdout, stderr, err := s.docker.ExecInContainer(
		ctx, info.ContainerID, []string{"sh", "-c", command}, containerCwd, timeout,
	)
	if err != nil {
		s.emit(sessionID, "tool.result", toolResultPayload{CallID: callID, Status: "error", Summary: err.Error()})
		return execResult{}, err
	}

	// The Terminal panel's pipeline (Step 4) is driven by terminal.output —
	// tool.call/tool.result alone would only show up in the Dashboard, not
	// the actual command output the DoD wants visible in the Terminal tab.
	emitLines(s.emit, sessionID, info.ContainerID, "stdout", stdout)
	emitLines(s.emit, sessionID, info.ContainerID, "stderr", stderr)

	resultStatus := "ok"
	if exitCode != 0 {
		resultStatus = "error"
	}
	s.emit(sessionID, "tool.result", toolResultPayload{
		CallID: callID, Status: resultStatus, Summary: fmt.Sprintf("exit code %d", exitCode),
	})

	return execResult{Stdout: stdout, Stderr: stderr, ReturnCode: exitCode}, nil
}

// execTimeout: an explicit override wins if given; otherwise derive it
// from the calling context's own deadline — grpc's native per-call
// deadline, propagated from the Python client's RPC timeout rather than
// trusted from a message field; otherwise 30s.
func (s *Server) execTimeout(ctx context.Context, explicit time.Duration) time.Duration {
	if explicit > 0 {
		return explicit
	}
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 {
			return remaining
		}
	}
	return 30 * time.Second
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

// notFoundError distinguishes "file doesn't exist" (grpc.go maps it to
// codes.NotFound) from other read failures (codes.Internal).
type notFoundError struct{ msg string }

func (e *notFoundError) Error() string { return e.msg }

// readFile is the Filesystem.Read service's actual logic (grpc.go's Read
// method calls this directly).
func (s *Server) readFile(sessionID string, info SessionInfo, relPath string) ([]byte, error) {
	full, err := resolveHostPath(info.WorktreePath, relPath)
	if err != nil {
		return nil, &validationError{err.Error()}
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
			return nil, &notFoundError{"not found"}
		}
		s.emit(sessionID, "tool.result", toolResultPayload{CallID: callID, Status: "error", Summary: err.Error()})
		return nil, err
	}
	s.emit(sessionID, "tool.result", toolResultPayload{
		CallID: callID, Status: "ok", Summary: fmt.Sprintf("%d bytes", len(data)),
	})
	return data, nil
}

// writeFile is the Filesystem.Write service's actual logic (grpc.go's
// Write method calls this directly).
func (s *Server) writeFile(sessionID string, info SessionInfo, relPath string, body []byte) (int, error) {
	full, err := resolveHostPath(info.WorktreePath, relPath)
	if err != nil {
		return 0, &validationError{err.Error()}
	}

	callID := newID()
	s.emit(sessionID, "tool.call", toolCallPayload{
		ToolName: "filesystem", SideEffectTier: "mutates-local",
		ArgsSummary: "write " + relPath, CallID: callID,
	})

	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		s.emit(sessionID, "tool.result", toolResultPayload{CallID: callID, Status: "error", Summary: err.Error()})
		return 0, err
	}
	if err := os.WriteFile(full, body, 0o644); err != nil {
		s.emit(sessionID, "tool.result", toolResultPayload{CallID: callID, Status: "error", Summary: err.Error()})
		return 0, err
	}
	// file.changed is left to the existing fsnotify watcher on worktreePath
	// (Step 4) — emitting it here too would double-fire.
	s.emit(sessionID, "tool.result", toolResultPayload{
		CallID: callID, Status: "ok", Summary: fmt.Sprintf("%d bytes", len(body)),
	})
	return len(body), nil
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
