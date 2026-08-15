package session

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// MinSwarmVersion is the minimum `swarm` CLI version pyengine.go will
// trust as a standalone binary (see resolveSwarmCommand). Bump this when a
// change here depends on a newer swarm CLI feature — anything older found
// on PATH is treated the same as "not found" and falls back to the
// -m cli.main checkout path rather than being invoked incompatibly.
// 0.1.0 matches pyproject.toml's current [project] version as of the
// standalone-install work this constant shipped with.
const MinSwarmVersion = "0.1.0"

// resolveSwarmCommand decides how to invoke the swarm engine: the
// standalone `swarm` console-script (scripts/install.sh / install.ps1,
// `uv tool install`) if one is on PATH and its version satisfies
// MinSwarmVersion, otherwise `python -m cli.main` against repoRoot's own
// checkout — the original, still-supported dev/build path. Returns an
// error only when neither is viable, naming exactly what's missing rather
// than silently falling through to something incompatible.
func resolveSwarmCommand(repoRoot string) (bin string, leadingArgs []string, err error) {
	if swarmPath, lookErr := exec.LookPath("swarm"); lookErr == nil {
		installed, verErr := swarmVersion(swarmPath)
		switch {
		case verErr == nil && versionAtLeast(installed, MinSwarmVersion):
			return swarmPath, nil, nil
		case verErr != nil:
			log.Printf("pyengine: found swarm on PATH but couldn't read its version (%v) — falling back to -m cli.main", verErr)
		default:
			log.Printf("pyengine: swarm on PATH is v%s, need >= v%s — falling back to -m cli.main", installed, MinSwarmVersion)
		}
	}

	pythonBin := os.Getenv("TANGENT_PYTHON_BIN")
	if pythonBin == "" {
		pythonBin = "python"
	}
	if _, statErr := os.Stat(filepath.Join(repoRoot, "cli", "main.py")); statErr != nil {
		return "", nil, fmt.Errorf(
			"no usable swarm engine: standalone `swarm` binary not found on PATH (or older than the required v%s), "+
				"and no monorepo checkout found at %q either (missing cli/main.py) — "+
				"install the standalone CLI (scripts/install.sh or scripts/install.ps1) or run this daemon from within the Tangent checkout",
			MinSwarmVersion, repoRoot,
		)
	}
	return pythonBin, []string{"-m", "cli.main"}, nil
}

// swarmVersion runs `swarm --version` and parses click's fixed
// "<prog_name>, version <version>" output format (see
// cli/main.py's @click.version_option).
func swarmVersion(swarmPath string) (string, error) {
	out, err := exec.Command(swarmPath, "--version").Output()
	if err != nil {
		return "", err
	}
	text := strings.TrimSpace(string(out))
	idx := strings.LastIndex(text, "version ")
	if idx < 0 {
		return "", fmt.Errorf("unexpected `swarm --version` output: %q", text)
	}
	return strings.TrimSpace(text[idx+len("version "):]), nil
}

// versionAtLeast compares dotted-numeric versions component-wise (so 1.9.0
// correctly compares below 1.10.0, unlike a plain string compare). Any
// component that isn't a plain integer after stripping a trailing
// "+build"/"-prerelease" tag makes that version unparseable and therefore
// NOT satisfying — fails closed into the -m cli.main fallback rather than
// trusting an ambiguous binary.
func versionAtLeast(installed, min string) bool {
	iParts, iErr := parseVersionParts(installed)
	mParts, mErr := parseVersionParts(min)
	if iErr != nil || mErr != nil {
		return false
	}
	for i := 0; i < len(iParts) || i < len(mParts); i++ {
		var a, b int
		if i < len(iParts) {
			a = iParts[i]
		}
		if i < len(mParts) {
			b = mParts[i]
		}
		if a != b {
			return a > b
		}
	}
	return true
}

func parseVersionParts(v string) ([]int, error) {
	if idx := strings.IndexAny(v, "+-"); idx >= 0 {
		v = v[:idx]
	}
	segments := strings.Split(v, ".")
	out := make([]int, len(segments))
	for i, seg := range segments {
		n, err := strconv.Atoi(seg)
		if err != nil {
			return nil, fmt.Errorf("bad version component %q in %q", seg, v)
		}
		out[i] = n
	}
	return out, nil
}

// LaunchSwarmProcess runs the real swarm engine as a subprocess — either
// the standalone `swarm` binary or `python -m cli.main`, decided by
// resolveSwarmCommand:
//
//	<bin> [-m cli.main] run <topology> --goal "<goal>" --path <worktreePath>
//	  --trace-dir <traceDir> --safety-mode auto --json
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
func LaunchSwarmProcess(sessionID, goal, topology, repoRoot, worktreePath, traceDir, daemonGRPCTarget, daemonToken string) (*exec.Cmd, error) {
	if goal == "" {
		return nil, fmt.Errorf("goal must not be empty")
	}
	if topology == "" {
		return nil, fmt.Errorf("topology must not be empty")
	}

	bin, leadingArgs, err := resolveSwarmCommand(repoRoot)
	if err != nil {
		return nil, err
	}

	args := append(append([]string{}, leadingArgs...),
		"run", topology,
		"--goal", goal,
		"--path", worktreePath,
		"--trace-dir", traceDir,
		"--safety-mode", "auto",
		"--json",
	)

	cmd := exec.Command(bin, args...)
	cmd.Dir = repoRoot
	cmd.Env = append(os.Environ(),
		"TANGENT_SESSION_ID="+sessionID,
		"TANGENT_DAEMON_GRPC_TARGET="+daemonGRPCTarget,
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
