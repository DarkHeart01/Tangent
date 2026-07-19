// Package worktree creates and removes real git worktrees for
// container-mode sessions by shelling out to the git CLI.
package worktree

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// CreateWorktree runs `git worktree add <path> -b tangent/session-<sessionID>`
// against repoPath (the Tangent repo, or a configurable test repo — see
// TANGENT_REPO_PATH in app.go), returning the new worktree's absolute path
// and branch name. The worktree is checked out as a sibling of repoPath,
// under .tangent-worktrees/, so it never shows up as untracked content
// inside the source repo's own working tree.
func CreateWorktree(repoPath, sessionID string) (worktreePath, branch string, err error) {
	branch = "tangent/session-" + sessionID

	worktreesRoot := filepath.Join(filepath.Dir(repoPath), ".tangent-worktrees")
	if err := os.MkdirAll(worktreesRoot, 0o755); err != nil {
		return "", "", fmt.Errorf("create worktrees root: %w", err)
	}
	worktreePath = filepath.Join(worktreesRoot, sessionID)

	cmd := exec.Command("git", "worktree", "add", worktreePath, "-b", branch)
	cmd.Dir = repoPath
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", "", fmt.Errorf("git worktree add: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return worktreePath, branch, nil
}

// RemoveWorktree removes a previously created worktree and prunes its
// branch's worktree registration. Not called from ContainerExecutor.Stop —
// a session stop isn't a delete, the human should still be able to inspect
// what the agent produced. Wire this up as an explicit separate cleanup
// action later if one is needed.
func RemoveWorktree(repoPath, worktreePath string) error {
	cmd := exec.Command("git", "worktree", "remove", worktreePath, "--force")
	cmd.Dir = repoPath
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git worktree remove: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
