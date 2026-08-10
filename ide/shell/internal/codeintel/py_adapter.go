package codeintel

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// PyAdapter is the Tier B (best-effort) adapter for Python: no compiler or
// language server behind it, per spec §4 ("starts with param-count + name
// matching only in v1... do not reimplement full type inference"). Unlike
// TSAdapter, which pushes text to a real language server and waits
// asynchronously for its diagnostics, PyAdapter resolves synchronously and
// cheaply: a module reference resolves by checking whether the file it
// names exists on disk, and a symbol reference (`from x import y`) resolves
// by regex-scanning that target file for a matching def/class/assignment.
// Third-party/stdlib imports (anything that doesn't resolve to a file inside
// the workspace) are never flagged -- there's no venv/site-packages
// introspection here, and a false "dangling" on `import numpy` would be
// worse than staying silent on it.
//
// This intentionally does not extract call expressions the way the TS
// extraction does: without a real parser, distinguishing a builtin
// (`len(x)`), a method call (`x.append(y)`), and an unresolved local
// function by regex alone has too high a false-positive rate to be useful.
// Import resolution is the highest-value, most reliably-detectable case for
// a regex-based Tier B, so v1 scope stops there.
type PyAdapter struct {
	workspaceRoot string
}

func NewPyAdapter(workspaceRoot string) *PyAdapter {
	return &PyAdapter{workspaceRoot: workspaceRoot}
}

var (
	pyImportRe     = regexp.MustCompile(`(?m)^\s*import\s+([\w.]+)`)
	pyFromImportRe = regexp.MustCompile(`(?m)^\s*from\s+(\.*[\w.]*)\s+import\s+([\w, *()\n]+?)(?:\s*#.*)?$`)
	pyDefRe        = regexp.MustCompile(`(?m)^\s*(?:async\s+)?def\s+(\w+)\s*\(`)
	pyClassRe      = regexp.MustCompile(`(?m)^\s*class\s+(\w+)\s*[:(]`)
	pyAssignRe     = regexp.MustCompile(`(?m)^(\w+)\s*(?::[^=]+)?=`)
)

// ExtractEdges is the whole Tier B pipeline in one synchronous pass: find
// every import in content and resolve it against the filesystem, returning
// fully-resolved Edges ready to go straight into the graph -- there's no
// separate async "wait for diagnostics" step the way TSAdapter has.
func (a *PyAdapter) ExtractEdges(path, content string) []Edge {
	// Non-nil even when empty: this crosses the Wails bridge as JSON, and a
	// nil slice marshals to `null` rather than `[]` -- the frontend calls
	// .filter() on it unconditionally (see CodeIntelContext.tsx), so a
	// Python file with zero imports would otherwise crash the whole React
	// tree with "Cannot read properties of null (reading 'filter')".
	edges := make([]Edge, 0)
	dir := filepath.Dir(path)

	for _, m := range pyImportRe.FindAllStringSubmatchIndex(content, -1) {
		module := content[m[2]:m[3]]
		span := lineSpanFor(content, m[2], m[3])
		edges = append(edges, a.resolveModuleEdge(path, dir, module, "", span))
	}

	for _, m := range pyFromImportRe.FindAllStringSubmatchIndex(content, -1) {
		module := strings.TrimSpace(content[m[2]:m[3]])
		names := strings.TrimSpace(content[m[4]:m[5]])
		nameSpan := lineSpanFor(content, m[4], m[5])
		if names == "*" || module == "" {
			continue // wildcard/relative-only imports aren't a single resolvable symbol
		}
		for _, raw := range strings.Split(names, ",") {
			name := strings.TrimSpace(strings.Split(strings.TrimSpace(raw), " as ")[0])
			name = strings.Trim(name, "()\n ")
			if name == "" {
				continue
			}
			edges = append(edges, a.resolveModuleEdge(path, dir, module, name, nameSpan))
		}
	}

	return edges
}

// resolveModuleEdge resolves `module` (optionally `.symbol`) relative to a
// Python file at dir. Module resolution is a real filesystem existence
// check (reliable); symbol-within-module resolution is a best-effort regex
// scan of the target file (Tier B's "name matching", scoped to the one file
// the import already names rather than a whole-graph lookup).
func (a *PyAdapter) resolveModuleEdge(path, dir, module, symbol string, span Span) Edge {
	toName := module
	if symbol != "" {
		toName = module + "." + symbol
	}
	edge := Edge{
		ID:       "imports:" + path + ":" + toName + ":" + strconv.Itoa(span.StartLine) + ":" + strconv.Itoa(span.StartCol),
		From:     "py:" + path + "#module",
		ToName:   toName,
		Kind:     EdgeImports,
		FilePath: path,
		Span:     span,
	}

	modulePath, isLocal := resolvePyModulePath(dir, a.workspaceRoot, module)
	if !isLocal {
		edge.State = StateResolved // third-party/stdlib -- can't verify, don't flag
		return edge
	}
	if modulePath == "" {
		edge.State = StateDangling
		edge.Message = "No local module named '" + module + "'"
		return edge
	}
	if symbol == "" {
		edge.State = StateResolved
		return edge
	}

	data, err := os.ReadFile(modulePath)
	if err != nil {
		edge.State = StateResolutionFailed
		edge.Message = "Could not read " + modulePath + ": " + err.Error()
		return edge
	}
	if pySymbolExists(string(data), symbol) {
		edge.State = StateResolved
	} else {
		edge.State = StateDangling
		edge.Message = "'" + symbol + "' is not defined in " + filepath.Base(modulePath)
	}
	return edge
}

// resolvePyModulePath resolves a dotted module name to a file, trying the
// relative-to-the-importing-file location first (Python's own resolution
// order for `from . import x` / `from .pkg import y`) and falling back to
// workspace-root-relative (a plain top-level `import mypackage.mymodule`).
// isLocal is false when neither resolves inside the workspace, i.e. the
// import is presumed third-party/stdlib.
func resolvePyModulePath(fileDir, workspaceRoot, module string) (resolvedPath string, isLocal bool) {
	if module == "" {
		return "", true // bare relative import ("from . import x") -- treat as local, symbol-in-package check skipped
	}
	relParts := strings.Split(strings.TrimLeft(module, "."), ".")
	dots := len(module) - len(strings.TrimLeft(module, "."))

	base := fileDir
	for i := 1; i < dots; i++ { // one leading dot means "this package" (fileDir itself)
		base = filepath.Dir(base)
	}

	candidates := [][]string{}
	if dots > 0 {
		candidates = append(candidates, append([]string{base}, relParts...))
	}
	candidates = append(candidates, append([]string{workspaceRoot}, relParts...))

	for _, parts := range candidates {
		joined := filepath.Join(parts...)
		if fi, err := os.Stat(joined + ".py"); err == nil && !fi.IsDir() {
			return joined + ".py", true
		}
		if fi, err := os.Stat(filepath.Join(joined, "__init__.py")); err == nil && !fi.IsDir() {
			return filepath.Join(joined, "__init__.py"), true
		}
	}
	if dots > 0 {
		return "", true // relative import that doesn't resolve -- still local, just dangling
	}
	return "", false
}

func pySymbolExists(source, symbol string) bool {
	for _, re := range []*regexp.Regexp{pyDefRe, pyClassRe} {
		for _, m := range re.FindAllStringSubmatch(source, -1) {
			if m[1] == symbol {
				return true
			}
		}
	}
	for _, m := range pyAssignRe.FindAllStringSubmatch(source, -1) {
		if m[1] == symbol {
			return true
		}
	}
	return false
}

func lineSpanFor(content string, start, end int) Span {
	startLine, startCol := lineColAt(content, start)
	endLine, endCol := lineColAt(content, end)
	return Span{StartLine: startLine, StartCol: startCol, EndLine: endLine, EndCol: endCol}
}

func lineColAt(content string, offset int) (line, col int) {
	line = strings.Count(content[:offset], "\n")
	if idx := strings.LastIndexByte(content[:offset], '\n'); idx >= 0 {
		col = offset - idx - 1
	} else {
		col = offset
	}
	return line, col
}

func (a *PyAdapter) ResolveSignature(ctx context.Context, e Edge) (Signature, error) {
	_ = ctx
	return Signature{Name: e.ToName}, nil // no real signature detail in Tier B v1
}

func (a *PyAdapter) Close() {}
