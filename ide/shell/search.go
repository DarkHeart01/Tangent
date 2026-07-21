package main

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Global codebase search — the backing for the Explorer's Search view. A
// bounded, dependency-free content grep over the workspace: skips VCS/build/dep
// directories, binary and oversized files, and caps total matches so a huge
// repo can never hang the UI or flood the IPC bridge.

type SearchMatch struct {
	Path    string `json:"path"`    // workspace-relative, forward-slash
	Line    int    `json:"line"`    // 1-based
	Column  int    `json:"column"`  // 1-based, byte offset of the match in the line
	Preview string `json:"preview"` // the matching line, trimmed and truncated
}

const (
	maxSearchMatches  = 500
	maxSearchFileSize = 2 << 20 // 2 MiB — skip anything larger
	maxPreviewLen     = 240
)

// Directories never worth searching. Any dotted dir is skipped too.
var searchSkipDirs = map[string]bool{
	"node_modules": true, "dist": true, "build": true, "out": true,
	"venv": true, "__pycache__": true, "vendor": true, "target": true,
	"bin": true, "obj": true, ".git": true, ".next": true, ".cache": true,
}

func truncatePreview(line string) string {
	trimmed := strings.TrimLeft(line, " \t")
	trimmed = strings.TrimRight(trimmed, "\r\n")
	if len(trimmed) > maxPreviewLen {
		return trimmed[:maxPreviewLen] + "…"
	}
	return trimmed
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
	needle := strings.ToLower(q)

	walkErr := filepath.WalkDir(absRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries rather than aborting the whole search
		}
		if len(matches) >= maxSearchMatches {
			return fs.SkipAll
		}
		name := d.Name()
		if d.IsDir() {
			if path != absRoot && (strings.HasPrefix(name, ".") || searchSkipDirs[name]) {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(name, ".") {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > maxSearchFileSize {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if bytes.IndexByte(data, 0) >= 0 {
			return nil // binary file
		}
		rel, err := filepath.Rel(absRoot, path)
		if err != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		lineNum := 0
		for _, line := range strings.Split(string(data), "\n") {
			lineNum++
			idx := strings.Index(strings.ToLower(line), needle)
			if idx < 0 {
				continue
			}
			matches = append(matches, SearchMatch{Path: relSlash, Line: lineNum, Column: idx + 1, Preview: truncatePreview(line)})
			if len(matches) >= maxSearchMatches {
				return fs.SkipAll
			}
		}
		return nil
	})
	if walkErr != nil && walkErr != fs.SkipAll {
		return nil, walkErr
	}
	return matches, nil
}
