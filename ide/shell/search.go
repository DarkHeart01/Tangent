package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// Global codebase search — the backing for the Explorer's Search view. Shells
// out to the vendored ripgrep (see ripgrep.go) instead of hand-walking the
// tree: gitignore-aware, skips binary files automatically, and is orders of
// magnitude faster than a naive per-file substring scan on large repos.

type SearchMatch struct {
	Path    string `json:"path"`    // workspace-relative, forward-slash
	Line    int    `json:"line"`    // 1-based
	Column  int    `json:"column"`  // 1-based, byte offset of the match in the line
	Preview string `json:"preview"` // the matching line, trimmed and truncated
}

const (
	maxSearchMatches     = 500
	maxSearchFileSizeArg = "2M" // ripgrep --max-filesize value
	maxPreviewLen        = 240
)

// Directories skipped regardless of .gitignore - belt-and-suspenders on top
// of ripgrep's own gitignore-awareness, for repos with a thin or missing
// .gitignore.
var searchSkipDirs = []string{
	"node_modules", "dist", "build", "out",
	"venv", "__pycache__", "vendor", "target",
	"bin", "obj", ".git", ".next", ".cache",
}

func truncatePreview(line string) string {
	trimmed := strings.TrimLeft(line, " \t")
	trimmed = strings.TrimRight(trimmed, "\r\n")
	if len(trimmed) > maxPreviewLen {
		return trimmed[:maxPreviewLen] + "…"
	}
	return trimmed
}

// Minimal subset of ripgrep's --json event schema - see
// https://docs.rs/grep-printer/latest/grep_printer/struct.JSON.html
type rgEvent struct {
	Type string `json:"type"`
	Data struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber int `json:"line_number"`
		Submatches []struct {
			Start int `json:"start"`
		} `json:"submatches"`
	} `json:"data"`
}

// SearchWorkspace scans root for a case-insensitive substring match of query
// and returns up to maxSearchMatches hits. An empty query returns no matches.
func (s *SessionAPI) SearchWorkspace(root, query string) ([]SearchMatch, error) {
	absRoot, err := workspaceRoot(root)
	if err != nil {
		return nil, err
	}
	q := strings.TrimSpace(query)
	matches := []SearchMatch{}
	if q == "" {
		return matches, nil
	}

	rgPath, err := ripgrepPath()
	if err != nil {
		return nil, err
	}

	args := []string{"--json", "--fixed-strings", "--ignore-case", "--max-filesize", maxSearchFileSizeArg}
	for _, dir := range searchSkipDirs {
		args = append(args, "--glob", "!"+dir)
	}
	args = append(args, "--", q, ".")

	cmd := exec.Command(rgPath, args...)
	cmd.Dir = absRoot
	var stderr strings.Builder
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ripgrep: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("ripgrep: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		var event rgEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			continue // skip a malformed/unexpected line rather than aborting the whole search
		}
		if event.Type != "match" {
			continue
		}
		column := 1
		if len(event.Data.Submatches) > 0 {
			column = event.Data.Submatches[0].Start + 1
		}
		rel := strings.TrimPrefix(filepath.ToSlash(event.Data.Path.Text), "./")
		matches = append(matches, SearchMatch{
			Path:    rel,
			Line:    event.Data.LineNumber,
			Column:  column,
			Preview: truncatePreview(event.Data.Lines.Text),
		})
		if len(matches) >= maxSearchMatches {
			break
		}
	}
	_ = cmd.Process.Kill() // enforce the cap by stopping rg early; no-op if it already exited on its own
	waitErr := cmd.Wait()

	if waitErr != nil {
		// Exit code 1 with no output means "no matches" - a normal empty
		// result, not a failure. If we already have matches (including via
		// the early-kill above), the wait error is irrelevant either way.
		var exitErr *exec.ExitError
		if len(matches) == 0 && errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 1 {
			return matches, nil
		}
		if len(matches) > 0 {
			return matches, nil
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = waitErr.Error()
		}
		return nil, fmt.Errorf("ripgrep: %s", message)
	}
	return matches, nil
}
