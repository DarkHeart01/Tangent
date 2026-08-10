package codeintel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// SuggestionRequest is the JSON payload piped to stdin of
// `python -m cli.main codeintel-suggest` -- kept in lockstep with that
// command's expected input shape (cli/main.py).
type SuggestionRequest struct {
	// Type selects which system prompt codeintel-suggest uses: "fix" (default,
	// existing behavior -- repair a confirmed-broken reference), "folder"
	// (Level 2, may propose new files), or "root" (Level 3, project
	// scaffolding). Level 1's forward-completion path (real inline ghost
	// text) is a separate command entirely -- see completion.go.
	Type       string        `json:"suggestion_type,omitempty"`
	Language   string        `json:"language"`
	FilePath   string        `json:"file_path"`
	Symbol     string        `json:"symbol,omitempty"`
	Kind       string        `json:"kind,omitempty"`
	Snippet    string        `json:"snippet"`
	Candidates []string      `json:"candidates,omitempty"`
	Context    []ContextFile `json:"context,omitempty"` // additional files for folder/root-scoped requests
}

// ContextFile is one extra file's content handed to the model alongside the
// primary Snippet -- folder-level requests send siblings, root-level
// requests send whatever's relevant (e.g. an existing .env).
type ContextFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type SuggestedFile struct {
	Path            string `json:"path"`
	ProposedContent string `json:"proposed_content"`
}

// SuggestionOrigin describes what triggered a suggestion, generalized away
// from requiring an Edge -- fix suggestions (Level 1) have one, folder
// (Level 2) and root (Level 3) suggestions don't (there's no single broken
// reference driving them).
type SuggestionOrigin struct {
	Level       int    // 1, 2, or 3
	FilePath    string
	Description string // shown in the UI card
	Edge        *Edge  // non-nil only for edge-triggered (Level 1 fix) suggestions
}

// Suggestion is the JSON payload read back from codeintel-suggest's stdout.
// Never applied automatically -- the UX contract (spec ??8) is
// diff-preview-then-accept, always.
type Suggestion struct {
	Explanation string          `json:"explanation"`
	Files       []SuggestedFile `json:"files"`
}

// SuggestionGenerator shells out to the Python swarm's LLM provider registry
// for a single fix suggestion, deliberately bypassing the swarm/agent/
// task-graph machinery -- a bounded, single completion doesn't need
// orchestration, a budget ledger, or a topology. Mirrors
// internal/session/pyengine.go's LaunchSwarmProcess invocation convention
// (same TANGENT_PYTHON_BIN env var, same `-m cli.main` entry point) and
// github.go's runGH timeout-bounded one-shot subprocess pattern.
type SuggestionGenerator struct {
	repoRoot string
	timeout  time.Duration
}

func NewSuggestionGenerator(repoRoot string) *SuggestionGenerator {
	return &SuggestionGenerator{repoRoot: repoRoot, timeout: 30 * time.Second}
}

func (g *SuggestionGenerator) Generate(ctx context.Context, req SuggestionRequest) (Suggestion, error) {
	pythonBin := os.Getenv("TANGENT_PYTHON_BIN")
	if pythonBin == "" {
		pythonBin = "python"
	}

	reqCtx, cancel := context.WithTimeout(ctx, g.timeout)
	defer cancel()

	payload, err := json.Marshal(req)
	if err != nil {
		return Suggestion{}, err
	}

	cmd := exec.CommandContext(reqCtx, pythonBin, "-m", "cli.main", "codeintel-suggest")
	cmd.Dir = g.repoRoot
	cmd.Stdin = bytes.NewReader(payload)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	if reqCtx.Err() == context.DeadlineExceeded {
		return Suggestion{}, fmt.Errorf("codeintel-suggest timed out after %s", g.timeout)
	}
	if runErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = runErr.Error()
		}
		return Suggestion{}, fmt.Errorf("codeintel-suggest: %s", msg)
	}

	var suggestion Suggestion
	if err := json.Unmarshal(stdout.Bytes(), &suggestion); err != nil {
		return Suggestion{}, fmt.Errorf("codeintel-suggest: decode response: %w", err)
	}
	return suggestion, nil
}
