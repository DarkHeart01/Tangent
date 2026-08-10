package codeintel

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestRequestCompletionRealSubprocess exercises RequestCompletion against
// the real codeintel-complete subprocess -- the exact same style as the
// other integration tests in this package (real process, real LLM call,
// skip if python isn't available). Only asserts the pipeline round-trips
// (no error, stdout stayed pure JSON); the exact model output isn't
// asserted since it isn't deterministic.
func TestRequestCompletionRealSubprocess(t *testing.T) {
	if _, err := exec.LookPath("python"); err != nil {
		t.Skip("python not on PATH:", err)
	}

	repoRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}

	insertText, err := RequestCompletion(context.Background(), repoRoot, CompletionRequest{
		Language: "python",
		FilePath: "example.py",
		Prefix:   "def add(a, b):\n    return a ",
		Suffix:   "\n",
	})
	if err != nil {
		t.Fatalf("RequestCompletion: %v", err)
	}
	t.Logf("completion returned: %q", insertText)
}

// TestEngineCompleteInlineNoOpWhenDisabled verifies CompleteInline is
// gated on the master enabled switch and returns immediately (no
// subprocess spawn) when the engine is off.
func TestEngineCompleteInlineNoOpWhenDisabled(t *testing.T) {
	engine := NewEngine(filepath.Join("..", ".."), "")

	insertText, err := engine.CompleteInline(context.Background(), "example.py", "def add(a, b):\n    return a ", "\n")
	if err != nil {
		t.Fatalf("expected no error when disabled, got: %v", err)
	}
	if insertText != "" {
		t.Fatalf("expected empty completion when disabled, got: %q", insertText)
	}
}
