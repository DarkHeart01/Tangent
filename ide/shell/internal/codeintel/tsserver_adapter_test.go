package codeintel

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestTSAdapterDetectsDanglingImport is an integration test against the real
// typescript-language-server binary bundled in ide/shell/codeintel-tools --
// it exercises the actual LSP wire protocol (spawn, initialize, didOpen,
// publishDiagnostics), not just Go-side plumbing. Skips itself if the
// bundled binary hasn't been npm-installed yet.
func TestTSAdapterDetectsDanglingImport(t *testing.T) {
	binPath, err := FindTypescriptLanguageServer(filepath.Join("..", ".."))
	if err != nil {
		t.Skip("typescript-language-server not installed:", err)
	}

	dir := t.TempDir()
	filePath := NormalizePath(filepath.Join(dir, "sample.ts"))
	content := "import { doesNotExist } from './nowhere';\n\nfunction use() {\n  return doesNotExist();\n}\n"
	if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	graph := NewGraph()
	diagnostics := make(chan []Edge, 8)
	adapter, err := NewTSAdapter(dir, binPath, graph, func(fp string, edges []Edge) {
		diagnostics <- edges
	})
	if err != nil {
		t.Fatalf("NewTSAdapter: %v", err)
	}
	defer adapter.Close()

	// Span covers the whole import line generously rather than pinpointing
	// tsserver's exact reported column -- this test verifies the protocol
	// roundtrip (diagnostics arrive, get mapped onto our edge), not tsserver's
	// column-reporting precision.
	const edgeID = "test-edge-1"
	graph.UpsertEdge(Edge{
		ID:       edgeID,
		FilePath: filePath,
		ToName:   "doesNotExist",
		Kind:     EdgeImports,
		State:    StateUnresolved,
		Span:     Span{StartLine: 0, StartCol: 0, EndLine: 0, EndCol: 200},
	})

	if err := adapter.NotifyFileOpen(filePath, content); err != nil {
		t.Fatalf("NotifyFileOpen: %v", err)
	}

	deadline := time.After(30 * time.Second)
	for {
		select {
		case edges := <-diagnostics:
			for _, e := range edges {
				if e.ID != edgeID {
					continue
				}
				if e.State != StateDangling {
					t.Fatalf("expected edge to become dangling for an unresolved import, got %s", e.State)
				}
				return // pass
			}
			// This diagnostics push didn't mention our edge yet (tsserver
			// sometimes publishes an empty/partial set first) -- keep waiting.
		case <-deadline:
			t.Fatal("timed out waiting for a dangling diagnostic on the unresolved import")
		}
	}
}
