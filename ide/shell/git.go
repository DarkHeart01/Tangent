package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"shell/internal/session"
	"shell/internal/workspace"
)

type WorkspaceInfo struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type GitFileStatus struct {
	Path         string `json:"path"`
	OriginalPath string `json:"original_path,omitempty"`
	Status       string `json:"status"`
}

type GitStatus struct {
	Root      string          `json:"root"`
	Branch    string          `json:"branch"`
	Ahead     int             `json:"ahead"`
	Behind    int             `json:"behind"`
	Changes   []GitFileStatus `json:"changes"`
	Staged    []GitFileStatus `json:"staged"`
	Conflicts []GitFileStatus `json:"conflicts"`
	Ignored   []GitFileStatus `json:"ignored"`
}

type GitBranch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
	Remote  bool   `json:"remote"`
}

type GitDiff struct {
	Path     string `json:"path"`
	Original string `json:"original"`
	Modified string `json:"modified"`
	Staged   bool   `json:"staged"`
}

func chooseWorkspace(ctx context.Context) (WorkspaceInfo, error) {
	path, err := runtime.OpenDirectoryDialog(ctx, runtime.OpenDialogOptions{Title: "Open Workspace Folder"})
	if err != nil {
		return WorkspaceInfo{}, err
	}
	if path == "" {
		return WorkspaceInfo{}, nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return WorkspaceInfo{}, err
	}
	if !info.IsDir() {
		return WorkspaceInfo{}, fmt.Errorf("workspace path is not a directory")
	}
	return WorkspaceInfo{Name: filepath.Base(path), Path: path}, nil
}

func workspaceRoot(root string) (string, error) {
	if strings.TrimSpace(root) == "" {
		return "", fmt.Errorf("workspace root is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("workspace root %q is not a directory", root)
	}
	return absolute, nil
}

func workspacePath(root, relPath string) (string, error) {
	absRoot, err := workspaceRoot(root)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(filepath.FromSlash(relPath))
	if clean == "." || clean == "" {
		return "", fmt.Errorf("a file path is required")
	}
	full := filepath.Join(absRoot, clean)
	abs, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	if abs != absRoot && !strings.HasPrefix(abs, absRoot+string(os.PathSeparator)) {
		return "", fmt.Errorf("path %q escapes workspace", relPath)
	}
	return abs, nil
}

func runGit(root string, args ...string) (string, error) {
	absRoot, err := workspaceRoot(root)
	if err != nil {
		return "", err
	}
	cmd := exec.Command("git", args...)
	cmd.Dir = absRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), message)
	}
	return string(output), nil
}

func gitFileStatus(code byte, path string) GitFileStatus {
	status := "M"
	switch code {
	case 'A':
		status = "A"
	case 'D':
		status = "D"
	case '?':
		status = "U"
	case 'R':
		status = "M"
	}
	return GitFileStatus{Path: filepath.ToSlash(path), Status: status}
}

func parseGitStatus(root, output string) GitStatus {
	status := GitStatus{Root: root, Changes: []GitFileStatus{}, Staged: []GitFileStatus{}, Conflicts: []GitFileStatus{}, Ignored: []GitFileStatus{}}
	branch, _ := runGit(root, "branch", "--show-current")
	status.Branch = strings.TrimSpace(branch)
	if status.Branch == "" {
		status.Branch = "HEAD"
	}
	if counts, err := runGit(root, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"); err == nil {
		parts := strings.Fields(counts)
		if len(parts) == 2 {
			status.Behind, _ = strconv.Atoi(parts[0])
			status.Ahead, _ = strconv.Atoi(parts[1])
		}
	}
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) < 3 {
			continue
		}
		x, y := line[0], line[1]
		path := strings.TrimSpace(line[3:])
		entry := gitFileStatus(y, path)
		if x == '!' && y == '!' {
			entry.Status = "I"
			status.Ignored = append(status.Ignored, entry)
			continue
		}
		if strings.Contains(path, " -> ") {
			parts := strings.SplitN(path, " -> ", 2)
			entry.OriginalPath, entry.Path = filepath.ToSlash(parts[0]), filepath.ToSlash(parts[1])
		}
		if x == '?' && y == '?' {
			status.Changes = append(status.Changes, entry)
			continue
		}
		if x == 'U' || y == 'U' {
			entry.Status = "!"
			status.Conflicts = append(status.Conflicts, entry)
			continue
		}
		if x != ' ' {
			stagedEntry := gitFileStatus(x, path)
			if entry.OriginalPath != "" {
				stagedEntry = entry
				stagedEntry.Status = gitFileStatus(x, path).Status
			}
			status.Staged = append(status.Staged, stagedEntry)
		}
		if y != ' ' {
			status.Changes = append(status.Changes, entry)
		}
	}
	return status
}

func (s *SessionAPI) SelectWorkspace() (workspace WorkspaceInfo, err error) {
	if s.ctx == nil {
		return WorkspaceInfo{}, fmt.Errorf("workspace picker is not ready")
	}
	// Native dialog implementations are platform-backed calls. Keep an
	// unexpected runtime panic from terminating the Wails process; surface it
	// as a normal rejected binding call so the frontend can remain open.
	defer func() {
		if recovered := recover(); recovered != nil {
			workspace = WorkspaceInfo{}
			err = fmt.Errorf("workspace picker failed: %v", recovered)
		}
	}()
	return chooseWorkspace(s.ctx)
}

// GetUserHomePath gives the terminal a useful native fallback before a
// workspace has been opened. It is read-only and does not affect sessions.
func (s *SessionAPI) GetUserHomePath() (string, error) {
	return os.UserHomeDir()
}

// ValidateWorkspacePath backs Open Folder's path-entry flow. Both the native
// OS folder dialog (runtime.OpenDirectoryDialog) and the browser's own File
// System Access picker (showDirectoryPicker, which also calls into the same
// native Windows folder-browse machinery inside WebView2) crash the whole
// app unrecoverably on some machines - neither goes through any Go code, so
// there is nothing here to fix for that path. This is deliberately just
// os.Stat with no dialog involved at all.
func (s *SessionAPI) ValidateWorkspacePath(path string) (WorkspaceInfo, error) {
	absRoot, err := workspaceRoot(path)
	if err != nil {
		return WorkspaceInfo{}, err
	}
	return WorkspaceInfo{Name: filepath.Base(absRoot), Path: absRoot}, nil
}

func (s *SessionAPI) GetWorkspaceTreeAt(root string) ([]session.FileNode, error) {
	absRoot, err := workspaceRoot(root)
	if err != nil {
		return nil, err
	}
	return workspace.Tree(absRoot)
}

// GetWorkspaceDir lists one directory's immediate children on demand - see
// workspace.ListDir for why the explorer no longer walks the whole tree via
// GetWorkspaceTreeAt up front.
func (s *SessionAPI) GetWorkspaceDir(root, relPath string) ([]session.FileNode, error) {
	absRoot, err := workspaceRoot(root)
	if err != nil {
		return nil, err
	}
	return workspace.ListDir(absRoot, relPath)
}

func (s *SessionAPI) ReadWorkspaceFile(root, path string) (session.FileContent, error) {
	absRoot, err := workspaceRoot(root)
	if err != nil {
		return session.FileContent{}, err
	}
	return workspace.Read(absRoot, path)
}

func (s *SessionAPI) WriteWorkspaceFile(root, path, content string) error {
	absRoot, err := workspaceRoot(root)
	if err != nil {
		return err
	}
	return workspace.Write(absRoot, path, content)
}

func (s *SessionAPI) RenameWorkspacePath(root, oldPath, newPath string) error {
	oldFull, err := workspacePath(root, oldPath)
	if err != nil {
		return err
	}
	newFull, err := workspacePath(root, newPath)
	if err != nil {
		return err
	}
	if _, err := os.Stat(oldFull); err != nil {
		return err
	}
	if _, err := os.Stat(newFull); err == nil {
		return fmt.Errorf("destination %q already exists", newPath)
	}
	if err := os.MkdirAll(filepath.Dir(newFull), 0o755); err != nil {
		return err
	}
	return os.Rename(oldFull, newFull)
}

func (s *SessionAPI) CreateWorkspaceFolder(root, relPath string) error {
	full, err := workspacePath(root, relPath)
	if err != nil {
		return err
	}
	return os.MkdirAll(full, 0o755)
}

func (s *SessionAPI) DeleteWorkspacePath(root, path string) error {
	full, err := workspacePath(root, path)
	if err != nil {
		return err
	}
	return os.RemoveAll(full)
}

func (s *SessionAPI) GitStatus(root string) (GitStatus, error) {
	// Do not enumerate ignored files here. With -uall, --ignored expands every
	// ignored file under directories such as node_modules and build output;
	// that can produce a multi-million-line response and exhaust the Wails
	// renderer/backend immediately after a workspace is opened. Git's normal
	// status still reports staged, modified, deleted, and untracked files while
	// respecting .gitignore, which is what the Source Control panel needs.
	output, err := runGit(root, "status", "--porcelain=v1")
	if err != nil {
		return GitStatus{}, err
	}
	status := parseGitStatus(root, output)
	return status, nil
}

func (s *SessionAPI) GitStage(root string, paths []string) error {
	args := []string{"add", "--"}
	args = append(args, paths...)
	_, err := runGit(root, args...)
	return err
}

func (s *SessionAPI) GitUnstage(root string, paths []string) error {
	args := []string{"restore", "--staged", "--"}
	args = append(args, paths...)
	_, err := runGit(root, args...)
	return err
}

func (s *SessionAPI) GitDiscard(root string, paths []string) error {
	for _, path := range paths {
		full, err := workspacePath(root, path)
		if err != nil {
			return err
		}
		if output, err := runGit(root, "status", "--porcelain", "--", path); err == nil && strings.HasPrefix(output, "??") {
			if _, statErr := os.Stat(full); statErr == nil {
				if err := os.RemoveAll(full); err != nil {
					return err
				}
			}
			continue
		}
		if _, err := runGit(root, "restore", "--worktree", "--staged", "--", path); err != nil {
			return err
		}
	}
	return nil
}

func (s *SessionAPI) GitCommit(root, message string, amend bool) error {
	if strings.TrimSpace(message) == "" {
		return fmt.Errorf("commit message is required")
	}
	args := []string{"commit", "-m", message}
	if amend {
		args = append(args, "--amend")
	}
	_, err := runGit(root, args...)
	return err
}

func (s *SessionAPI) GitFetch(root string) error {
	_, err := runGit(root, "fetch", "--all", "--prune")
	return err
}
func (s *SessionAPI) GitPull(root string) error { _, err := runGit(root, "pull"); return err }
func (s *SessionAPI) GitPush(root string) error { _, err := runGit(root, "push"); return err }
func (s *SessionAPI) GitSync(root string) error {
	if err := s.GitFetch(root); err != nil {
		return err
	}
	if err := s.GitPull(root); err != nil {
		return err
	}
	return s.GitPush(root)
}

func (s *SessionAPI) GitBranches(root string) ([]GitBranch, error) {
	output, err := runGit(root, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes")
	if err != nil {
		return nil, err
	}
	currentOutput, _ := runGit(root, "branch", "--show-current")
	current := strings.TrimSpace(currentOutput)
	branches := []GitBranch{}
	for _, line := range strings.Split(output, "\n") {
		name := strings.TrimSpace(line)
		if name == "" || strings.HasSuffix(name, "/HEAD") {
			continue
		}
		branches = append(branches, GitBranch{Name: name, Current: name == current, Remote: strings.HasPrefix(name, "origin/")})
	}
	return branches, nil
}

func (s *SessionAPI) GitCheckout(root, branch string) error {
	if strings.TrimSpace(branch) == "" || strings.ContainsAny(branch, "\r\n") {
		return fmt.Errorf("invalid branch name")
	}
	_, err := runGit(root, "checkout", branch)
	return err
}

func (s *SessionAPI) GitCreateBranch(root, branch string) error {
	if strings.TrimSpace(branch) == "" || strings.ContainsAny(branch, "\r\n") {
		return fmt.Errorf("invalid branch name")
	}
	_, err := runGit(root, "switch", "-c", branch)
	return err
}

func (s *SessionAPI) GitDiff(root, path string, staged bool) (GitDiff, error) {
	full, err := workspacePath(root, path)
	if err != nil {
		return GitDiff{}, err
	}
	worktree, err := os.ReadFile(full)
	if err != nil && !os.IsNotExist(err) {
		return GitDiff{}, err
	}
	relPath := filepath.ToSlash(path)
	headOutput, _ := runGit(root, "show", "HEAD:"+relPath)
	indexOutput, indexErr := runGit(root, "show", ":"+relPath)
	if staged {
		// A staged diff compares HEAD with the index. Untracked files have no
		// index blob yet, so show the working copy as the proposed addition.
		if indexErr != nil {
			indexOutput = string(worktree)
		}
		return GitDiff{Path: relPath, Original: headOutput, Modified: indexOutput, Staged: true}, nil
	}
	// An unstaged diff compares the index with the working copy. For files
	// that are not staged, HEAD is the best available baseline.
	if indexErr != nil {
		indexOutput = headOutput
	}
	return GitDiff{Path: relPath, Original: indexOutput, Modified: string(worktree), Staged: false}, nil
}
