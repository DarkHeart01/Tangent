package codeintel

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type lspPosition struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}

type lspRange struct {
	Start lspPosition `json:"start"`
	End   lspPosition `json:"end"`
}

type lspDiagnostic struct {
	Range    lspRange `json:"range"`
	Severity int      `json:"severity"` // 1=Error, 2=Warning, 3=Info, 4=Hint
	Message  string   `json:"message"`
}

type publishDiagnosticsParams struct {
	URI         string          `json:"uri"`
	Diagnostics []lspDiagnostic `json:"diagnostics"`
}

// TSAdapter is the Tier-A adapter for TypeScript/JavaScript: it wraps
// typescript-language-server rather than reimplementing type checking (spec
// ??4). Existence detection comes straight from the server's own
// publishDiagnostics -- an Error-severity diagnostic overlapping a reference
// span means that reference is dangling; no diagnostic there means it
// resolved. This is deliberately broader than enumerating specific TS error
// codes (unresolved import, undefined name, wrong arg count, ...) since v1
// is an existence check, not a type checker (spec's stated non-goal).
type TSAdapter struct {
	client *LSPClient
	graph  *Graph

	mu       sync.Mutex
	versions map[string]int // file URI -> document version, for didChange

	onDiagnostics func(filePath string, edges []Edge)
}

// FindTypescriptLanguageServer locates the language server bundled in
// ide/shell/codeintel-tools -- pinned there independent of whatever the
// user's *opened* project has installed, so Go always has a known binary to
// spawn regardless of workspace contents. execDir is the ide/shell directory
// (repo-relative in dev, next to the binary in a built app).
func FindTypescriptLanguageServer(execDir string) (string, error) {
	name := "typescript-language-server"
	if runtime.GOOS == "windows" {
		name += ".cmd"
	}
	candidate := filepath.Join(execDir, "codeintel-tools", "node_modules", ".bin", name)
	// Must be absolute: exec.Command resolves a relative Path inconsistently
	// on Windows once cmd.Dir differs from the calling process's own cwd
	// (which it always will here -- cmd.Dir is the user's workspace root,
	// not execDir), causing "the system cannot find the path specified"
	// even though the file exists (verified via TestTSAdapterDetectsDanglingImport).
	abs, err := filepath.Abs(candidate)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(abs); err != nil {
		return "", fmt.Errorf("typescript-language-server not found at %q -- run `npm install` in ide/shell/codeintel-tools: %w", abs, err)
	}
	return abs, nil
}

func NewTSAdapter(workspaceRoot, binPath string, graph *Graph, onDiagnostics func(filePath string, edges []Edge)) (*TSAdapter, error) {
	a := &TSAdapter{graph: graph, versions: make(map[string]int), onDiagnostics: onDiagnostics}

	client, err := StartLSPClient(workspaceRoot, binPath, []string{"--stdio"}, a.handleNotification)
	if err != nil {
		return nil, err
	}
	a.client = client

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := client.Initialize(ctx, pathToFileURI(workspaceRoot)); err != nil {
		client.Close()
		return nil, fmt.Errorf("initialize typescript-language-server: %w", err)
	}
	return a, nil
}

func (a *TSAdapter) handleNotification(method string, params json.RawMessage) {
	if method != "textDocument/publishDiagnostics" {
		return
	}
	var p publishDiagnosticsParams
	if err := json.Unmarshal(params, &p); err != nil {
		return
	}
	a.applyDiagnostics(fileURIToPath(p.URI), p.Diagnostics)
}

func (a *TSAdapter) applyDiagnostics(filePath string, diags []lspDiagnostic) {
	edges := a.graph.EdgesInFile(filePath)
	updated := make([]Edge, 0, len(edges))
	for _, e := range edges {
		state := StateResolved
		message := ""
		for _, d := range diags {
			if d.Severity != 1 {
				continue
			}
			if spansOverlap(e.Span, lspRangeToSpan(d.Range)) {
				state = StateDangling
				message = d.Message
				break
			}
		}
		if updatedEdge, ok := a.graph.SetEdgeState(e.ID, state, "", message); ok {
			updated = append(updated, updatedEdge)
		}
	}
	if a.onDiagnostics != nil && len(updated) > 0 {
		a.onDiagnostics(filePath, updated)
	}
}

func (a *TSAdapter) NotifyFileOpen(path, text string) error {
	uri := pathToFileURI(path)
	a.mu.Lock()
	a.versions[uri] = 1
	a.mu.Unlock()
	return a.client.DidOpen(uri, languageIDForPath(path), text)
}

func (a *TSAdapter) NotifyFileChange(path, text string) error {
	uri := pathToFileURI(path)
	a.mu.Lock()
	a.versions[uri]++
	v := a.versions[uri]
	a.mu.Unlock()
	return a.client.DidChange(uri, v, text)
}

func (a *TSAdapter) NotifyFileClose(path string) error {
	uri := pathToFileURI(path)
	a.mu.Lock()
	delete(a.versions, uri)
	a.mu.Unlock()
	return a.client.DidClose(uri)
}

// ResolveSignature hovers at the reference site itself rather than following
// a separate go-to-definition hop -- the language server already resolves a
// reference's type/signature at that position, which satisfies Tier A's
// "wrap the LSP, don't reimplement type checking" without needing separate
// definition-based node construction (deferred; see plan's known gaps).
func (a *TSAdapter) ResolveSignature(ctx context.Context, e Edge) (Signature, error) {
	detail, err := a.client.Hover(ctx, pathToFileURI(e.FilePath), e.Span.StartLine, e.Span.StartCol)
	if err != nil {
		return Signature{}, err
	}
	return Signature{Name: e.ToName, Detail: strings.TrimSpace(detail)}, nil
}

func (a *TSAdapter) Close() {
	if a.client != nil {
		a.client.Close()
	}
}

// spansOverlap treats each Span as a half-open (line,col) range and compares
// the pairs lexicographically -- avoids pulling in a range-math dependency
// for what's fundamentally two interval comparisons.
func spansOverlap(a, b Span) bool {
	aStart, aEnd := [2]int{a.StartLine, a.StartCol}, [2]int{a.EndLine, a.EndCol}
	bStart, bEnd := [2]int{b.StartLine, b.StartCol}, [2]int{b.EndLine, b.EndCol}
	return lessOrEqual(aStart, bEnd) && lessOrEqual(bStart, aEnd)
}

func lessOrEqual(p, q [2]int) bool {
	if p[0] != q[0] {
		return p[0] < q[0]
	}
	return p[1] <= q[1]
}

func lspRangeToSpan(r lspRange) Span {
	return Span{StartLine: r.Start.Line, StartCol: r.Start.Character, EndLine: r.End.Line, EndCol: r.End.Character}
}

func languageIDForPath(path string) string {
	switch filepath.Ext(path) {
	case ".ts":
		return "typescript"
	case ".tsx":
		return "typescriptreact"
	case ".js", ".mjs", ".cjs":
		return "javascript"
	case ".jsx":
		return "javascriptreact"
	default:
		return "typescript"
	}
}

// NormalizePath canonicalizes a file path for use as both a graph key and an
// LSP URI round-trip: on Windows it lowercases the drive letter, matching
// the vscode-uri normalization every vscode-languageserver-based server
// (including typescript-language-server) applies to any URI it echoes back.
// Without this, a path that entered with an uppercase drive letter would
// never match the lowercase one the server reports in publishDiagnostics,
// silently dropping every diagnostic for that file (caught by
// TestTSAdapterDetectsDanglingImport, which failed with a timeout -- not an
// error -- until this normalization was added).
func NormalizePath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	if runtime.GOOS == "windows" && len(abs) > 1 && abs[1] == ':' {
		abs = strings.ToLower(abs[:1]) + abs[1:]
	}
	return abs
}

func pathToFileURI(p string) string {
	slashed := filepath.ToSlash(NormalizePath(p))
	if runtime.GOOS == "windows" && len(slashed) > 1 && slashed[1] == ':' {
		slashed = "/" + slashed
	}
	u := url.URL{Scheme: "file", Path: slashed}
	return u.String()
}

func fileURIToPath(uri string) string {
	u, err := url.Parse(uri)
	if err != nil {
		return uri
	}
	p := u.Path
	if runtime.GOOS == "windows" && len(p) > 2 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}
	return NormalizePath(filepath.FromSlash(p))
}
