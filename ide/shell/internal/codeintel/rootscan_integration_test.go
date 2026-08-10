package codeintel

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestEngineScanProjectProposesEnvFile exercises the full Level 3 path
// (not just ExtractEnvVarUsage/DiffEnvFile in isolation, per rootscan_test.go)
// against the real `python -m cli.main codeintel-suggest` subprocess,
// verifying a workspace with detected env-var usage and no .env.example
// gets a root-level suggestion proposing one.
func TestEngineScanProjectProposesEnvFile(t *testing.T) {
	if _, err := exec.LookPath("python"); err != nil {
		t.Skip("python not on PATH:", err)
	}

	root := t.TempDir()
	src := "export function connect() {\n  return process.env.DATABASE_URL;\n}\n"
	if err := os.WriteFile(filepath.Join(root, "db.ts"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	repoRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	engine := NewEngine(filepath.Join("..", ".."), repoRoot) // repoRoot: Tangent monorepo root, for `-m cli.main` to resolve
	engine.workspaceRoot = root
	engine.level = 3

	suggestions := make(chan SuggestionOrigin, 4)
	engine.OnSuggestion(func(batchID string, origin SuggestionOrigin, suggestionID string, suggestion Suggestion) {
		suggestions <- origin
	})

	engine.runRootScan(root) // synchronous call (ScanProject's own goroutine wrapper isn't needed for the test)

	select {
	case origin := <-suggestions:
		if origin.Level != 3 {
			t.Errorf("expected Level 3, got %d", origin.Level)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("timed out waiting for a root-level suggestion")
	}
}
