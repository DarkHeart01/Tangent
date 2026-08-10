package codeintel

import (
	"os"
	"path/filepath"
	"testing"
)

const sampleOpenAPIJSON = `{
  "openapi": "3.0.0",
  "paths": {
    "/users/{id}": {
      "get": {"operationId": "getUser"},
      "delete": {"operationId": "deleteUser"}
    },
    "/users": {
      "post": {"operationId": "createUser"}
    }
  }
}`

const sampleOpenAPIYAML = `
openapi: 3.0.0
paths:
  /users/{id}:
    get:
      operationId: getUser
`

func TestLoadOpenAPISpecJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "openapi.json")
	if err := os.WriteFile(path, []byte(sampleOpenAPIJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	bridge, err := LoadOpenAPISpec(path)
	if err != nil {
		t.Fatalf("LoadOpenAPISpec: %v", err)
	}
	if len(bridge.Routes) != 3 {
		t.Fatalf("expected 3 routes, got %d: %+v", len(bridge.Routes), bridge.Routes)
	}

	cases := []struct {
		method, url string
		wantMatch   bool
		wantOpID    string
	}{
		{"GET", "/users/42", true, "getUser"},
		{"DELETE", "/users/42", true, "deleteUser"},
		{"GET", "/users/42/", true, "getUser"}, // trailing slash tolerated
		{"POST", "/users", true, "createUser"},
		{"GET", "/users", false, ""},        // no GET /users (only POST)
		{"GET", "/nonexistent", false, ""},
		{"GET", "/users/42?verbose=1", true, "getUser"}, // query string ignored
	}
	for _, tc := range cases {
		route, ok := bridge.Match(tc.method, tc.url)
		if ok != tc.wantMatch {
			t.Errorf("%s %s: match=%v, want %v", tc.method, tc.url, ok, tc.wantMatch)
			continue
		}
		if ok && route.OperationID != tc.wantOpID {
			t.Errorf("%s %s: operationId=%q, want %q", tc.method, tc.url, route.OperationID, tc.wantOpID)
		}
	}
}

func TestLoadOpenAPISpecYAML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "openapi.yaml")
	if err := os.WriteFile(path, []byte(sampleOpenAPIYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	bridge, err := LoadOpenAPISpec(path)
	if err != nil {
		t.Fatalf("LoadOpenAPISpec: %v", err)
	}
	if len(bridge.Routes) != 1 || bridge.Routes[0].OperationID != "getUser" {
		t.Fatalf("unexpected routes: %+v", bridge.Routes)
	}
}

func TestFindOpenAPISpecPrefersFirstMatch(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "openapi.yaml"), []byte(sampleOpenAPIYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := FindOpenAPISpec(dir); got == "" {
		t.Fatal("expected to find openapi.yaml")
	}
	if got := FindOpenAPISpec(t.TempDir()); got != "" {
		t.Errorf("expected no spec found in empty dir, got %q", got)
	}
}
