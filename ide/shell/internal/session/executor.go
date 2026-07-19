package session

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"

	"shell/internal/docker"
	"shell/internal/watcher"
	"shell/internal/worktree"
)

// Test payload for this step: not a real agent yet. Exercises both a
// terminal-output path and a file-write path so the WS event contract can
// be proven end to end against a real container. Swapping Image/Cmd here
// for a different script (or eventually the real swarm invocation) needs
// no changes anywhere else in the stack — that's the point of this layer.
const (
	defaultContainerImage       = "python:3.12-slim"
	defaultContainerMountTarget = "/workspace"
)

var defaultContainerCmd = []string{"sh", "-c",
	`echo "agent starting"; sleep 1; echo "reading workspace"; sleep 1; echo "hello from container" > /workspace/output.txt; sleep 1; echo "writing complete"; sleep 1; echo "agent finished"`,
}

// ContainerExecutor is the real, Docker-backed counterpart to
// simulator.go: same event contract via the emit hook (session.started,
// terminal.output, file.changed, session.ended), a real container and a
// real git worktree underneath instead of a scripted sequence.
type ContainerExecutor struct {
	docker   *docker.DockerManager
	repoPath string
	emit     func(sessionID, eventType string, payload interface{})

	mu      sync.Mutex
	running map[string]*runningContainer
}

type runningContainer struct {
	containerID  string
	worktreePath string
	cancel       context.CancelFunc
	finished     bool // set once the container's own process has exited naturally
}

func NewContainerExecutor(dm *docker.DockerManager, repoPath string, emit func(sessionID, eventType string, payload interface{})) *ContainerExecutor {
	return &ContainerExecutor{
		docker:   dm,
		repoPath: repoPath,
		emit:     emit,
		running:  make(map[string]*runningContainer),
	}
}

// Start creates the worktree, spawns the hardened container (bind-mounting
// the worktree), starts the log-stream and filesystem-watcher goroutines,
// and emits session.started with the real worktree_path. Everything
// downstream — terminal.output from the log stream, file.changed from the
// watcher — flows through the same emit hook simulator.go already uses, so
// wsserver and the frontend need zero changes.
func (e *ContainerExecutor) Start(sessionID string, opts SessionStartOpts) error {
	worktreePath, _, err := worktree.CreateWorktree(e.repoPath, sessionID)
	if err != nil {
		return fmt.Errorf("create worktree: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())

	containerID, err := e.docker.SpawnContainer(ctx, docker.ContainerSpawnOpts{
		Image:        defaultContainerImage,
		Cmd:          defaultContainerCmd,
		WorktreePath: worktreePath,
		MountTarget:  defaultContainerMountTarget,
	})
	if err != nil {
		cancel()
		return fmt.Errorf("spawn container: %w", err)
	}

	rc := &runningContainer{containerID: containerID, worktreePath: worktreePath, cancel: cancel}
	e.mu.Lock()
	e.running[sessionID] = rc
	e.mu.Unlock()

	// session.started carries the real worktree_path — this is what
	// Manager.emitToSession uses to populate Session.worktreePath, which
	// GetWorkspaceTree/ReadFile/WriteFile then read.
	e.emit(sessionID, string(EventSessionStarted), SessionStarted{
		Goal:         opts.Goal,
		Topology:     opts.Topology,
		WorktreePath: worktreePath,
	})

	go e.streamLogs(ctx, sessionID, rc)
	go e.watchWorktree(ctx, sessionID, worktreePath)

	return nil
}

func (e *ContainerExecutor) streamLogs(ctx context.Context, sessionID string, rc *runningContainer) {
	streamErr := e.docker.StreamLogs(ctx, rc.containerID, func(stream, line string) {
		e.emit(sessionID, string(EventTerminalOutput), TerminalOutput{
			ContainerID: rc.containerID,
			Stream:      stream,
			Data:        line + "\n",
		})
	})

	if ctx.Err() != nil {
		// Stop() cancelled us; Stop owns the container's final status.
		return
	}

	if streamErr != nil {
		e.emit(sessionID, string(EventError), EngineError{
			Message: fmt.Sprintf("log stream ended: %v", streamErr),
			Fatal:   false,
		})
	}

	// The container's main process exited on its own. Leave it tracked
	// (and leave the container un-removed) so a later, explicit Stop can
	// still remove it — natural completion isn't cleanup.
	e.mu.Lock()
	rc.finished = true
	e.mu.Unlock()

	e.emit(sessionID, string(EventSessionEnded), SessionEnded{
		Status:  "success",
		Summary: "Container run finished.",
	})
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

// Stop stops and removes the container but leaves the worktree on disk — a
// session stop isn't a delete; the human should still be able to inspect
// what the agent produced. Safe to call after the container has already
// exited on its own (e.g. the user clicks Stop after watching "agent
// finished" scroll by): it still performs the actual Docker removal, but
// won't emit a second, contradictory session.ended.
func (e *ContainerExecutor) Stop(sessionID string) error {
	e.mu.Lock()
	rc, ok := e.running[sessionID]
	var alreadyFinished bool
	if ok {
		alreadyFinished = rc.finished
		delete(e.running, sessionID)
	}
	e.mu.Unlock()

	if !ok {
		return fmt.Errorf("no container tracked for session %q", sessionID)
	}

	rc.cancel() // no-op if the process already exited on its own
	err := e.docker.StopAndRemove(context.Background(), rc.containerID)

	if !alreadyFinished {
		e.emit(sessionID, string(EventSessionEnded), SessionEnded{
			Status:  "cancelled",
			Summary: "Session stopped.",
		})
	}
	return err
}
