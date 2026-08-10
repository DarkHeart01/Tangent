package codeintel

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestEngineResolvesBridgeEdge exercises the full Engine.UpdateFile path
// (not just BridgeGraph in isolation, per bridge_test.go) against the real
// typescript-language-server, verifying a routes-to edge is matched against
// a loaded OpenAPI spec rather than left for the LSP (which has no opinion
// on URL strings) to resolve.
func TestEngineResolvesBridgeEdge(t *testing.T) {
	if _, err := FindTypescriptLanguageServer(filepath.Join("..", "..")); err != nil {
		t.Skip("typescript-language-server not installed:", err)
	}

	root := t.TempDir()
	spec := `{"paths": {"/users/{id}": {"get": {"operationId": "getUser"}}}}`
	if err := os.WriteFile(filepath.Join(root, "openapi.json"), []byte(spec), 0o644); err != nil {
		t.Fatal(err)
	}

	filePath := filepath.Join(root, "api.ts")
	content := "export async function loadUser(id: string) {\n  return fetch('/users/' + id);\n}\n"
	if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	engine := NewEngine(filepath.Join("..", ".."), root) // execDir points at ide/shell so SetEnabled finds the bundled codeintel-tools

	diagnostics := make(chan []Edge, 8)
	engine.OnDiagnostics(func(fp string, edges []Edge) { diagnostics <- edges })

	if err := engine.SetEnabled(true, root); err != nil {
		t.Fatalf("SetEnabled: %v", err)
	}
	defer engine.Close()

	edge := Edge{
		ID:       "routes-to:test:1",
		FilePath: filePath,
		ToName:   "GET /users/123",
		Kind:     EdgeRoutesTo,
		State:    "unresolved",
		Span:     Span{StartLine: 1, StartCol: 9, EndLine: 1, EndCol: 40},
	}
	if err := engine.UpdateFile(filePath, content, nil, []Edge{edge}, true, 1); err != nil {
		t.Fatalf("UpdateFile: %v", err)
	}

	deadline := time.After(10 * time.Second)
	for {
		select {
		case edges := <-diagnostics:
			for _, e := range edges {
				if e.Kind != EdgeRoutesTo {
					continue
				}
				if e.State != StateResolved {
					t.Fatalf("expected bridge edge resolved (schema has GET /users/{id}), got %s: %s", e.State, e.Message)
				}
				if e.BridgeAdapter != "openapi-schema" {
					t.Errorf("expected bridge_adapter=openapi-schema, got %q", e.BridgeAdapter)
				}
				return // pass
			}
		case <-deadline:
			t.Fatal("timed out waiting for bridge edge diagnostics")
		}
	}
}
