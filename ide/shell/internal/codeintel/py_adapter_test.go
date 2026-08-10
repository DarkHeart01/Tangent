package codeintel

import (
	"os"
	"path/filepath"
	"testing"
)

// TestPyAdapterExtractEdgesNeverReturnsNil guards against a real bug found
// in production: a nil Go slice marshals to JSON `null`, and the frontend
// calls .filter() on the edges array unconditionally, so a Python file with
// zero imports used to crash the whole React tree with "Cannot read
// properties of null (reading 'filter')".
func TestPyAdapterExtractEdgesNeverReturnsNil(t *testing.T) {
	adapter := NewPyAdapter(t.TempDir())
	edges := adapter.ExtractEdges("empty.py", "x = 1\n")
	if edges == nil {
		t.Fatal("ExtractEdges must return a non-nil (even if empty) slice -- nil marshals to JSON null, not []")
	}
	if len(edges) != 0 {
		t.Fatalf("expected no edges for a file with no imports, got %v", edges)
	}
}

func TestPyAdapterResolvesImports(t *testing.T) {
	root := t.TempDir()

	// root/sibling.py defines `thing` but not `missing_thing`.
	if err := os.WriteFile(filepath.Join(root, "sibling.py"), []byte("def thing():\n    pass\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// root/localmod.py exists (for the plain `import localmod` case).
	if err := os.WriteFile(filepath.Join(root, "localmod.py"), []byte("VALUE = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	mainPath := filepath.Join(root, "main.py")
	content := `import os
import localmod
import nonexistent_module
from .sibling import thing
from .sibling import missing_thing
from .missing_file import whatever
`
	if err := os.WriteFile(mainPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := NewPyAdapter(root)
	edges := adapter.ExtractEdges(mainPath, content)

	byName := map[string]Edge{}
	for _, e := range edges {
		byName[e.ToName] = e
	}

	cases := []struct {
		name  string
		state ResolutionState
	}{
		{"os", StateResolved},              // stdlib -- can't verify, don't flag
		{"localmod", StateResolved},        // local file exists
		{"nonexistent_module", StateResolved}, // plain top-level import with no local file is
		// indistinguishable from a real third-party package without venv
		// introspection -- the adapter deliberately never flags these
		// (see resolvePyModulePath's doc comment); only relative imports
		// (below) are confidently "local, so a miss really is dangling".
		{".sibling.thing", StateResolved},         // exists in sibling.py
		{".sibling.missing_thing", StateDangling}, // sibling.py exists but doesn't define this
		{".missing_file.whatever", StateDangling}, // module itself doesn't resolve
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			edge, ok := byName[tc.name]
			if !ok {
				t.Fatalf("no edge extracted for %q -- extracted: %v", tc.name, keys(byName))
			}
			if edge.State != tc.state {
				t.Errorf("edge %q: got state %s, want %s (message: %q)", tc.name, edge.State, tc.state, edge.Message)
			}
		})
	}
}

func keys(m map[string]Edge) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
