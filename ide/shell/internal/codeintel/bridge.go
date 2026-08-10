package codeintel

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// OpenAPIRoute is the slice of an OpenAPI operation this bridge cares about:
// enough to match a frontend fetch/axios call's (method, path) against it.
type OpenAPIRoute struct {
	Method       string // upper-case: GET, POST, ...
	PathTemplate string // as written in the spec, e.g. "/users/{id}"
	OperationID  string
}

// BridgeGraph is spec §7's "separate, thin graph" -- it only ever holds
// schema-backed junction data (an OpenAPI spec's routes in v1), not a
// mirror of either language graph. Convention-backed matching (bare REST
// path string guessing, no schema) is deliberately not implemented in this
// pass -- the spec's own priority order says prove the high-confidence,
// schema-backed case first.
type BridgeGraph struct {
	SourcePath string
	Routes     []OpenAPIRoute
}

// openAPIDoc covers just the subset of the OpenAPI 3.x / Swagger 2.x shape
// needed for route matching -- not a full spec model.
type openAPIDoc struct {
	Paths map[string]map[string]struct {
		OperationID string `json:"operationId" yaml:"operationId"`
	} `json:"paths" yaml:"paths"`
}

var httpMethods = map[string]bool{
	"get": true, "post": true, "put": true, "patch": true, "delete": true, "head": true, "options": true,
}

// commonOpenAPIFilenames is checked at the workspace root only (v1 scope --
// a recursive search adds real cost for a feature that's entirely optional
// and additive).
var commonOpenAPIFilenames = []string{
	"openapi.json", "openapi.yaml", "openapi.yml",
	"swagger.json", "swagger.yaml", "swagger.yml",
}

// FindOpenAPISpec looks for a schema file at the workspace root under one of
// the conventional names. Returns "" (not an error) if none exists --
// having no spec is the common case, not a failure.
func FindOpenAPISpec(workspaceRoot string) string {
	for _, name := range commonOpenAPIFilenames {
		candidate := filepath.Join(workspaceRoot, name)
		if fi, err := os.Stat(candidate); err == nil && !fi.IsDir() {
			return candidate
		}
	}
	return ""
}

func LoadOpenAPISpec(path string) (*BridgeGraph, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var doc openAPIDoc
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".json":
		err = json.Unmarshal(data, &doc)
	case ".yaml", ".yml":
		err = yaml.Unmarshal(data, &doc)
	default:
		return nil, fmt.Errorf("unrecognized OpenAPI spec extension %q", ext)
	}
	if err != nil {
		return nil, fmt.Errorf("parse OpenAPI spec %s: %w", path, err)
	}

	bridge := &BridgeGraph{SourcePath: path}
	for pathTemplate, methods := range doc.Paths {
		for method, op := range methods {
			method = strings.ToLower(method)
			if !httpMethods[method] {
				continue
			}
			bridge.Routes = append(bridge.Routes, OpenAPIRoute{
				Method:       strings.ToUpper(method),
				PathTemplate: pathTemplate,
				OperationID:  op.OperationID,
			})
		}
	}
	return bridge, nil
}

// Match checks urlPath (as extracted from a frontend fetch/axios call
// literal, e.g. "/users/42") against every route's template, treating
// "{param}" segments as wildcards. method may be "" (fetch's default GET is
// often implicit in source, and a naive extraction can't always tell) --
// an empty method matches any.
func (b *BridgeGraph) Match(method, urlPath string) (OpenAPIRoute, bool) {
	urlSegments := splitPath(urlPath)
	for _, route := range b.Routes {
		if method != "" && route.Method != strings.ToUpper(method) {
			continue
		}
		if pathMatches(splitPath(route.PathTemplate), urlSegments) {
			return route, true
		}
	}
	return OpenAPIRoute{}, false
}

func splitPath(p string) []string {
	p = strings.SplitN(p, "?", 2)[0] // ignore query string
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) == 1 && parts[0] == "" {
		return nil
	}
	return parts
}

func pathMatches(template, actual []string) bool {
	if len(template) != len(actual) {
		return false
	}
	for i, seg := range template {
		if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
			continue // wildcard path param
		}
		if seg != actual[i] {
			return false
		}
	}
	return true
}
