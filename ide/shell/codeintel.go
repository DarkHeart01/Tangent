package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"shell/internal/codeintel"
)

type codeintelDiagnosticsEvent struct {
	FilePath string           `json:"file_path"`
	Edges    []codeintel.Edge `json:"edges"`
}

type codeintelSuggestionEvent struct {
	BatchID      string                    `json:"batch_id"`
	Level        int                       `json:"level"`
	FilePath     string                    `json:"file_path"`
	Description  string                    `json:"description"`
	Edge         *codeintel.Edge           `json:"edge,omitempty"` // only present for Level 1 fix suggestions
	SuggestionID string                    `json:"suggestion_id"`
	Explanation  string                    `json:"explanation"`
	Files        []codeintel.SuggestedFile `json:"files"`
}

// codeintelEngine lazily constructs the engine on first use (matching the
// "off by default, zero overhead" contract -- nothing is built, let alone
// spawned, until the frontend actually calls a CodeIntel* method) and wires
// its two output callbacks to native Wails events, the same mechanism
// TerminalManager uses for terminal.local.output (ide/shell/terminal.go) --
// this feature is workspace-scoped and in-process like the local terminal,
// not swarm-session-scoped, so it doesn't go through the WS envelope system.
func (s *SessionAPI) codeintelEngine() *codeintel.Engine {
	if s.codeintel != nil {
		return s.codeintel
	}
	execDir, err := os.Getwd()
	if err != nil {
		execDir = "."
	}
	repo, err := repoRoot()
	if err != nil {
		repo = execDir
	}

	engine := codeintel.NewEngine(execDir, repo)
	engine.OnDiagnostics(func(filePath string, edges []codeintel.Edge) {
		wailsRuntime.EventsEmit(s.ctx, "codeintel.diagnostics", codeintelDiagnosticsEvent{FilePath: filePath, Edges: edges})
	})
	engine.OnSuggestion(func(batchID string, origin codeintel.SuggestionOrigin, suggestionID string, suggestion codeintel.Suggestion) {
		wailsRuntime.EventsEmit(s.ctx, "codeintel.suggestion", codeintelSuggestionEvent{
			BatchID:      batchID,
			Level:        origin.Level,
			FilePath:     origin.FilePath,
			Description:  origin.Description,
			Edge:         origin.Edge,
			SuggestionID: suggestionID,
			Explanation:  suggestion.Explanation,
			Files:        suggestion.Files,
		})
	})
	s.codeintel = engine
	return s.codeintel
}

// resolveWorkspacePath joins root and relPath and guarantees the result
// stays inside root, mirroring internal/workspace's unexported resolve() --
// duplicated in miniature here rather than exporting that function, since
// this package boundary otherwise has no reason to depend on workspace's
// internals.
func resolveWorkspacePath(root, relPath string) (string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	full := filepath.Join(absRoot, filepath.FromSlash(relPath))
	if full != absRoot && !strings.HasPrefix(full, absRoot+string(os.PathSeparator)) {
		return "", fmt.Errorf("path %q escapes workspace", relPath)
	}
	return full, nil
}

// CodeIntelSetEnabled turns the live code-intelligence engine on or off for
// the given workspace. Off (the default) means zero overhead: no language
// server process, no goroutines beyond Go's own runtime. Enabling spawns
// typescript-language-server, bundled independently of the opened project
// in ide/shell/codeintel-tools (see FindTypescriptLanguageServer).
func (s *SessionAPI) CodeIntelSetEnabled(enabled bool, root string) error {
	absRoot, err := workspaceRoot(root)
	if err != nil {
		return err
	}
	return s.codeintelEngine().SetEnabled(enabled, absRoot)
}

// CodeIntelSetPythonEnabled is the per-adapter toggle (spec §7) for Tier B
// specifically, independent of the master CodeIntelSetEnabled switch.
func (s *SessionAPI) CodeIntelSetPythonEnabled(enabled bool) error {
	s.codeintelEngine().SetPythonEnabled(enabled)
	return nil
}

// CodeIntelSetLevel is the cumulative intervention level (1/2/3) the
// frontend computes from the low/mid/high/adaptive setting. Level 1 (file)
// is always active once the engine is enabled; this only gates whether
// Level 2 (folder, on save) and Level 3 (root, on scan) may fire.
func (s *SessionAPI) CodeIntelSetLevel(level int) error {
	s.codeintelEngine().SetLevel(level)
	return nil
}

// CodeIntelFileSaved is Level 2's trigger -- call after a successful save.
func (s *SessionAPI) CodeIntelFileSaved(root, path string) error {
	absPath, err := resolveWorkspacePath(root, path)
	if err != nil {
		return err
	}
	s.codeintelEngine().OnFileSaved(absPath)
	return nil
}

// CodeIntelScanProject is Level 3's explicit trigger ("Scan Project"). root
// is validated for a clear error if the workspace itself is invalid, but
// the scan otherwise runs against whatever root SetEnabled already
// configured the engine with.
func (s *SessionAPI) CodeIntelScanProject(root string) error {
	if _, err := workspaceRoot(root); err != nil {
		return err
	}
	return s.codeintelEngine().ScanProject()
}

// CodeIntelUpdateFile receives the frontend's freshly tree-sitter-extracted
// nodes/edges for one file (already debounced on that side) plus Gate 1's
// syntax-validity signal and the cursor's current line.
func (s *SessionAPI) CodeIntelUpdateFile(
	root, path, content string,
	nodes []codeintel.Node,
	edges []codeintel.Edge,
	syntaxValid bool,
	cursorLine int,
) error {
	absPath, err := resolveWorkspacePath(root, path)
	if err != nil {
		return err
	}
	return s.codeintelEngine().UpdateFile(absPath, content, nodes, edges, syntaxValid, cursorLine)
}

// CodeIntelSetFocus is spec §3's tiering signal: focused=true when path
// becomes the active tab (promotes to hot), focused=false when it loses
// focus (demotes to warm).
func (s *SessionAPI) CodeIntelSetFocus(root, path string, focused bool) error {
	absPath, err := resolveWorkspacePath(root, path)
	if err != nil {
		return err
	}
	s.codeintelEngine().SetFocus(absPath, focused)
	return nil
}

// CodeIntelForgetFile drops path's nodes/edges and releases any per-file
// adapter state -- call when a tab closes.
func (s *SessionAPI) CodeIntelForgetFile(root, path string) error {
	absPath, err := resolveWorkspacePath(root, path)
	if err != nil {
		return err
	}
	s.codeintelEngine().ForgetFile(absPath)
	return nil
}

// CodeIntelSignalScopeExit is Gate 3's primary signal: the cursor
// structurally left scopeSpan (a function/class body) in path.
func (s *SessionAPI) CodeIntelSignalScopeExit(root, path string, scopeSpan codeintel.Span) error {
	absPath, err := resolveWorkspacePath(root, path)
	if err != nil {
		return err
	}
	s.codeintelEngine().SignalScopeExit(absPath, scopeSpan)
	return nil
}

// CodeIntelArmIdleFallback (re)starts Gate 3's idle-fallback timer for the
// scope the cursor is currently in -- call on every keystroke.
func (s *SessionAPI) CodeIntelArmIdleFallback(root, path string, scopeSpan codeintel.Span) error {
	absPath, err := resolveWorkspacePath(root, path)
	if err != nil {
		return err
	}
	s.codeintelEngine().ArmIdleFallback(absPath, scopeSpan)
	return nil
}

// CodeIntelCompleteInline is Level 1's real ghost-text path: the frontend's
// Monaco InlineCompletionsProvider awaits this directly per keystroke
// (after its own debounce), passing bounded prefix/suffix windows around
// the cursor, and shows whatever text comes back as grey inline text.
func (s *SessionAPI) CodeIntelCompleteInline(root, path, prefix, suffix string) (string, error) {
	absPath, err := resolveWorkspacePath(root, path)
	if err != nil {
		return "", err
	}
	return s.codeintelEngine().CompleteInline(s.ctx, absPath, prefix, suffix)
}

// CodeIntelAcceptSuggestion writes every file in the named suggestion
// through the same path-jailed workspace.Write every other file edit in
// this app uses, then returns what was applied so the frontend can close
// the diff-preview modal and clear the suggestion card.
func (s *SessionAPI) CodeIntelAcceptSuggestion(id string) (codeintel.Suggestion, error) {
	return s.codeintelEngine().AcceptSuggestion(id)
}

func (s *SessionAPI) CodeIntelRejectSuggestion(id string) error {
	s.codeintelEngine().RejectSuggestion(id)
	return nil
}
