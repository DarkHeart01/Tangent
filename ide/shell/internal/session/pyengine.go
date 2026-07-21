package session

import (
	"fmt"
	"os"
	"os/exec"
)

// LaunchSwarmProcess runs the real swarm engine as a subprocess:
//
//	python -m cli.main run <topology> --goal "<goal>" --path <worktreePath>
//	  --trace-dir <traceDir> --safety-mode auto --json
//
// invoked with cwd=repoRoot (the Tangent monorepo root, where the
// cli/agents/tools/core packages live) so `-m cli.main` resolves; `swarm`
// as a console-script entry point depends on how it was installed
// (pyproject.toml declares `swarm = "cli.main:cli"`), while `-m cli.main`
// works from any checkout with the dependencies installed, so it's used
// here for robustness.
//
// Deviation from the illustrative signature: the spec only passed
// repoRoot, with no way to tell the engine which worktree to operate in or
// where to write its trace. Phase A found --path controls the project
// root ALL file writes/traces/memory land under (cli/main.py's
// _enter_workdir) — without it the swarm would operate against repoRoot's
// own checkout, not the session's worktree, which defeats the point.
// Extended to take worktreePath and traceDir explicitly.
//
// --safety-mode auto is required, not optional: interactive mode blocks on
// a stdin confirmation prompt (coordination/safety.py's
// confirm_tool_call), and this subprocess has no attached terminal to
// answer it.
func LaunchSwarmProcess(sessionID, goal, topology, repoRoot, worktreePath, traceDir, daemonURL, daemonToken string) (*exec.Cmd, error) {
	if goal == "" {
		return nil, fmt.Errorf("goal must not be empty")
	}
	if topology == "" {
		return nil, fmt.Errorf("topology must not be empty")
	}

	pythonBin := os.Getenv("TANGENT_PYTHON_BIN")
	if pythonBin == "" {
		pythonBin = "python"
	}

	args := []string{
		"-m", "cli.main", "run", topology,
		"--goal", goal,
		"--path", worktreePath,
		"--trace-dir", traceDir,
		"--safety-mode", "auto",
		"--json",
	}

	cmd := exec.Command(pythonBin, args...)
	cmd.Dir = repoRoot
	cmd.Env = append(os.Environ(),
		"TANGENT_SESSION_ID="+sessionID,
		"TANGENT_DAEMON_URL="+daemonURL,
		"TANGENT_DAEMON_TOKEN="+daemonToken,
	)

	// The swarm orchestrator's own Rich-console stdout (goal/trace-id
	// panels, phase logs) is a different stream from actual shell_exec
	// container output — the WS contract's terminal.output is specifically
	// for the latter (Step 4). Inherited straight through to the daemon's
	// own stdout/stderr for debugging visibility, rather than piped into
	// the WS terminal or captured to a per-session file that would need
	// explicit closing once the process exits.
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start swarm process: %w", err)
	}
	return cmd, nil
}
