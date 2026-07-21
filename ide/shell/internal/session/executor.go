package session

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"sync"

	"shell/internal/docker"
	"shell/internal/execapi"
	"shell/internal/watcher"
	"shell/internal/worktree"
)

// defaultContainerImage doubles as the base for the persistent sandbox
// shell_exec runs inside — python:3.12-slim ships coreutils (tail, sh)
// for the keep-alive process, and python itself for agents that want it.
const (
	defaultContainerImage       = "python:3.12-slim"
	defaultContainerMountTarget = "/workspace"
)

// persistentContainerCmd keeps the container alive indefinitely instead of
// running a one-shot script — Step 4's container lifecycle was
// spawn-and-exit; this step's is spawn-once-per-session, exec into it
// repeatedly for every shell_exec call the real swarm run makes.
var persistentContainerCmd = []string{"tail", "-f", "/dev/null"}

// ContainerExecutor is the real, Docker-backed counterpart to
// simulator.go: same event contract via the emit hook (session.started,
// terminal.output, tool.call/result, file.changed, session.ended), a real
// container, a real git worktree, and — as of this step — a real swarm
// engine subprocess underneath instead of a scripted sequence.
type ContainerExecutor struct {
	docker   *docker.DockerManager
	execAPI  *execapi.Server
	repoPath string
	emit     func(sessionID, eventType string, payload interface{})

	mu      sync.Mutex
	running map[string]*runningContainer
}

type runningContainer struct {
	containerID  string
	worktreePath string
	cancel       context.CancelFunc
	swarmCmd     *exec.Cmd // set once LaunchSwarmProcess succeeds
}

func NewContainerExecutor(dm *docker.DockerManager, execAPI *execapi.Server, repoPath string, emit func(sessionID, eventType string, payload interface{})) *ContainerExecutor {
	return &ContainerExecutor{
		docker:   dm,
		execAPI:  execAPI,
		repoPath: repoPath,
		emit:     emit,
		running:  make(map[string]*runningContainer),
	}
}

// Start creates the worktree, spawns the hardened persistent container
// (bind-mounting the worktree), mints a per-session execapi bearer token,
// launches the real swarm engine subprocess against that worktree, and
// starts the filesystem-watcher and trace-tailer goroutines. Everything
// downstream — terminal.output and tool.call/tool.result from execapi,
// file.changed from the watcher, agent/tool events from the trace tailer —
// flows through the same emit hook simulator.go already uses, so wsserver
// and the frontend need zero changes.
//
// tangentDir is sess.TangentDir (sessions/<id>/.tangent/) — SessionStartOpts
// only carries user-facing intent (goal/topology/mode), so this is passed
// separately by Manager.StartSession, which already computes it.
func (e *ContainerExecutor) Start(sessionID, tangentDir string, opts SessionStartOpts) error {
	worktreePath, _, err := worktree.CreateWorktree(e.repoPath, sessionID)
	if err != nil {
		return fmt.Errorf("create worktree: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())

	containerID, err := e.docker.SpawnContainer(ctx, docker.ContainerSpawnOpts{
		Image:        defaultContainerImage,
		Cmd:          persistentContainerCmd,
		WorktreePath: worktreePath,
		MountTarget:  defaultContainerMountTarget,
		Labels:       map[string]string{"tangent.session_id": sessionID},
	})
	if err != nil {
		cancel()
		return fmt.Errorf("spawn container: %w", err)
	}

	token, err := execapi.GenerateToken()
	if err != nil {
		cancel()
		_ = e.docker.StopAndRemove(context.Background(), containerID)
		return fmt.Errorf("generate daemon token: %w", err)
	}

	rc := &runningContainer{containerID: containerID, worktreePath: worktreePath, cancel: cancel}
	e.mu.Lock()
	e.running[sessionID] = rc
	e.mu.Unlock()

	e.execAPI.Register(sessionID, execapi.SessionInfo{
		ContainerID:  containerID,
		WorktreePath: worktreePath,
		Token:        token,
	})

	// session.started carries the real worktree_path — this is what
	// Manager.emitToSession uses to populate Session.worktreePath, which
	// GetWorkspaceTree/ReadFile/WriteFile then read.
	e.emit(sessionID, string(EventSessionStarted), SessionStarted{
		Goal:         opts.Goal,
		Topology:     opts.Topology,
		WorktreePath: worktreePath,
	})

	// The frontend's topology dropdown sends a bare key ("coding_swarm")
	// matching the examples/ directory name, not a file path — every
	// example topology follows this same layout.
	topologyPath := filepath.ToSlash(filepath.Join("examples", opts.Topology, "topology.yaml"))
	// A dedicated subdirectory, not the existing .tangent/trace.jsonl (that
	// one is the Go daemon's own WS-envelope log, a completely different
	// file from the swarm engine's internal span trace tailed here).
	traceDir := filepath.Join(tangentDir, "traces")

	swarmCmd, err := LaunchSwarmProcess(sessionID, opts.Goal, topologyPath, e.repoPath, worktreePath, traceDir, e.execAPI.BaseURL(), token)
	if err != nil {
		e.mu.Lock()
		delete(e.running, sessionID)
		e.mu.Unlock()
		e.execAPI.Unregister(sessionID)
		cancel()
		_ = e.docker.StopAndRemove(context.Background(), containerID)
		return fmt.Errorf("launch swarm process: %w", err)
	}
	rc.swarmCmd = swarmCmd

	go e.watchWorktree(ctx, sessionID, worktreePath)
	go e.tailTrace(ctx, sessionID, traceDir)
	go e.waitSwarmProcess(sessionID, rc)

	return nil
}

func (e *ContainerExecutor) watchWorktree(ctx context.Context, sessionID, worktreePath string) {
	err := watcher.WatchDirectory(ctx, worktreePath, func(path, changeType string) {
		rel, relErr := filepath.Rel(worktreePath, path)
		if relErr != nil {
			rel = path
		}
		e.emit(sessionID, string(EventFileChanged), FileChanged{
			Path:       filepath.ToSlash(rel),
			ChangeType: changeType,
		})
	})
	if err != nil && ctx.Err() == nil {
		e.emit(sessionID, string(EventError), EngineError{
			Message: fmt.Sprintf("worktree watcher ended: %v", err),
			Fatal:   false,
		})
	}
}

// tailTrace watches the swarm engine's own trace output and translates
// each finished span into the closest matching contract event(s) — see
// tracemap.go for the mapping and its documented limitations.
func (e *ContainerExecutor) tailTrace(ctx context.Context, sessionID, traceDir string) {
	err := watcher.TailTraceFile(ctx, traceDir, func(line string) {
		mapTraceLine(func(eventType string, payload interface{}) {
			e.emit(sessionID, eventType, payload)
		}, line)
	})
	if err != nil && ctx.Err() == nil {
		e.emit(sessionID, string(EventError), EngineError{
			Message: fmt.Sprintf("trace tailer ended: %v", err),
			Fatal:   false,
		})
	}
}

// waitSwarmProcess is the "swarm subprocess crashes or finishes on its
// own" cleanup path — mirrors Stop's, arbitrated by claim() so whichever
// of the two happens first (a manual Stop, or the process just ending) is
// the only one that actually tears things down.
func (e *ContainerExecutor) waitSwarmProcess(sessionID string, rc *runningContainer) {
	waitErr := rc.swarmCmd.Wait()

	claimed, ok := e.claim(sessionID)
	if !ok {
		return // Stop() already claimed cleanup
	}

	status, summary := "success", "Swarm run finished."
	if waitErr != nil {
		status, summary = "failed", fmt.Sprintf("Swarm process exited with error: %v", waitErr)
	}
	e.finish(sessionID, claimed, status, summary)
}

// claim atomically removes sessionID from the running set and returns
// whether this caller was the one to do so — the single arbitration point
// between an explicit Stop() and the swarm process ending on its own, so
// exactly one of them performs cleanup and emits exactly one
// session.ended.
func (e *ContainerExecutor) claim(sessionID string) (*runningContainer, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	rc, ok := e.running[sessionID]
	if ok {
		delete(e.running, sessionID)
	}
	return rc, ok
}

// finish is the actual teardown: cancel the watcher/tracer goroutines, kill
// the swarm subprocess if it's still alive, unregister from execapi, and
// stop+remove the container. Unlike Step 4's one-shot containers (whose
// exited-but-not-removed state was a deliberate "let the human inspect it"
// choice), a persistent container's own process (tail -f /dev/null) never
// exits on its own — leaving it running after the swarm process is done
// would be a genuine orphan, not a useful inspectable artifact, so cleanup
// always removes it. The worktree is untouched either way.
func (e *ContainerExecutor) finish(sessionID string, rc *runningContainer, status, summary string) error {
	rc.cancel()
	if rc.swarmCmd != nil && rc.swarmCmd.Process != nil {
		_ = rc.swarmCmd.Process.Kill() // no-op if it already exited
	}
	e.execAPI.Unregister(sessionID)
	err := e.docker.StopAndRemove(context.Background(), rc.containerID)
	e.emit(sessionID, string(EventSessionEnded), SessionEnded{Status: status, Summary: summary})
	return err
}

// Stop ends a running session on demand: kills the swarm subprocess (if
// still running) and removes the container, but leaves the worktree on
// disk — a session stop isn't a delete; the human should still be able to
// inspect what the agent produced.
func (e *ContainerExecutor) Stop(sessionID string) error {
	rc, ok := e.claim(sessionID)
	if !ok {
		return fmt.Errorf("no container tracked for session %q", sessionID)
	}
	return e.finish(sessionID, rc, "cancelled", "Session stopped.")
}
