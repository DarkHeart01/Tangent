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

// CompletionRequest is the JSON payload piped to stdin of
// `python -m cli.main codeintel-complete` -- Level 1's real inline
// ghost-text path (like GitHub Copilot/Cursor), deliberately separate from
// SuggestionRequest: "insert this text at the cursor" doesn't fit the
// {explanation, files} suggestion shape, and this is a direct
// call-and-return the frontend awaits per keystroke, not a background
// review that emits an event later.
type CompletionRequest struct {
	Language string `json:"language"`
	FilePath string `json:"file_path"`
	Prefix   string `json:"prefix"`
	Suffix   string `json:"suffix"`
}

type completionResponse struct {
	InsertText string `json:"insert_text"`
}

// completionTimeout is shorter than SuggestionGenerator's 30s -- this is
// interactive, in the way of typing, not a background review -- but a
// fresh Python subprocess plus a real network LLM call observably takes
// anywhere from ~3s to ~9s, so 8s produced spurious timeouts in practice.
// 15s trades a little more worst-case latency for not dropping completions
// that were about to land.
const completionTimeout = 15 * time.Second

// RequestCompletion shells out to codeintel-complete the same way
// SuggestionGenerator.Generate shells out to codeintel-suggest (same
// TANGENT_PYTHON_BIN/-m cli.main convention), but with its own short
// timeout and minimal request/response envelope.
func RequestCompletion(ctx context.Context, repoRoot string, req CompletionRequest) (string, error) {
	pythonBin := os.Getenv("TANGENT_PYTHON_BIN")
	if pythonBin == "" {
		pythonBin = "python"
	}

	reqCtx, cancel := context.WithTimeout(ctx, completionTimeout)
	defer cancel()

	payload, err := json.Marshal(req)
	if err != nil {
		return "", err
	}

	cmd := exec.CommandContext(reqCtx, pythonBin, "-m", "cli.main", "codeintel-complete")
	cmd.Dir = repoRoot
	cmd.Stdin = bytes.NewReader(payload)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	if reqCtx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("codeintel-complete timed out after %s", completionTimeout)
	}
	if runErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = runErr.Error()
		}
		return "", fmt.Errorf("codeintel-complete: %s", msg)
	}

	var resp completionResponse
	if err := json.Unmarshal(stdout.Bytes(), &resp); err != nil {
		return "", fmt.Errorf("codeintel-complete: decode response: %w", err)
	}
	return resp.InsertText, nil
}
