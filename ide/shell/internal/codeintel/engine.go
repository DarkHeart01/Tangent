package codeintel

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"shell/internal/session"
	"shell/internal/workspace"
)

// Engine is the facade SessionAPI talks to: it owns the graph, the Tier-A
// TypeScript adapter, the trigger-gate state machine, the signature
// resolution queue, and suggestion generation, and wires them together.
// Everything here operates on absolute file paths -- the one boundary that
// deals in the rest of the IDE's (root, relPath) convention is the bound
// method wrapper in ide/shell/codeintel.go, which joins them once before
// calling in.
//
// Disabled by default and cheap to construct: nothing (no LSP process) spawns
// until SetEnabled(true, workspaceRoot) is called.
type Engine struct {
	execDir  string // ide/shell dir, for locating bundled codeintel-tools
	repoRoot string // Tangent monorepo root, for spawning codeintel-suggest

	graph     *Graph
	generator *SuggestionGenerator

	mu             sync.Mutex
	enabled        bool
	pythonEnabled  bool // per-adapter toggle (spec §7) -- Tier B specifically, on top of the master enabled switch
	level          int  // 1 (file), 2 (+folder), 3 (+root) -- cumulative intervention level, frontend computes adaptive escalation and pushes the resulting number here
	workspaceRoot  string
	adapter        *TSAdapter   // Tier A: TypeScript/JavaScript, via typescript-language-server
	pyAdapter      *PyAdapter   // Tier B: Python, regex + filesystem best-effort (see py_adapter.go)
	bridge         *BridgeGraph // schema-backed cross-language bridge (spec §7) -- nil if no OpenAPI spec was found
	gate           *TriggerGate
	queue          *ResolutionQueue
	openFiles      map[string]bool
	signatureCache map[string]Signature

	pendingSuggestions map[string]pendingSuggestion
	nextSuggestionID   uint64

	onDiagnostics func(filePath string, edges []Edge)
	onSuggestion  func(batchID string, origin SuggestionOrigin, suggestionID string, suggestion Suggestion)
}

type pendingSuggestion struct {
	Suggestion
	origin SuggestionOrigin
}

func NewEngine(execDir, repoRoot string) *Engine {
	return &Engine{
		execDir:            execDir,
		repoRoot:           repoRoot,
		pythonEnabled:      true,
		level:              1,
		graph:              NewGraph(),
		generator:          NewSuggestionGenerator(repoRoot),
		openFiles:          make(map[string]bool),
		signatureCache:     make(map[string]Signature),
		pendingSuggestions: make(map[string]pendingSuggestion),
	}
}

// SetPythonEnabled is the per-adapter toggle (spec §7) for Tier B
// specifically -- independent of the master SetEnabled switch, since Python
// support has a different cost/risk profile (no subprocess, just regex) than
// spawning a real language server.
func (e *Engine) SetPythonEnabled(enabled bool) {
	e.mu.Lock()
	e.pythonEnabled = enabled
	e.mu.Unlock()
}

// SetLevel is the cumulative intervention level (1/2/3) the frontend
// computes from the user's low/mid/high/adaptive setting and pushes down
// whenever it changes. Level itself never gates Level 1 (fix suggestions and
// inline completion are always active once the engine is enabled -- Level 1
// is the baseline every cumulative level includes); it only gates whether
// OnFileSaved (Level 2) and ScanProject (Level 3) are allowed to actually do
// anything.
// Newly unlocking root-level triggers one scan immediately, same as
// clicking "Scan Project" -- consistent with the "once on enable" trigger
// SetEnabled uses when level is already 3 at that point.
func (e *Engine) SetLevel(level int) {
	if level < 1 {
		level = 1
	} else if level > 3 {
		level = 3
	}
	e.mu.Lock()
	prev := e.level
	e.level = level
	e.mu.Unlock()
	if level >= 3 && prev < 3 {
		_ = e.ScanProject()
	}
}

func (e *Engine) OnDiagnostics(cb func(filePath string, edges []Edge)) { e.onDiagnostics = cb }

func (e *Engine) OnSuggestion(cb func(batchID string, origin SuggestionOrigin, suggestionID string, suggestion Suggestion)) {
	e.onSuggestion = cb
}

// SetEnabled turns the engine on or off for workspaceRoot. Off (the
// default) means zero overhead: no LSP process, no goroutines beyond what
// Go's runtime always has. Called again with a different workspaceRoot
// tears down the old adapter/queue and starts fresh against the new one.
func (e *Engine) SetEnabled(enabled bool, workspaceRoot string) error {
	e.mu.Lock()
	noChange := enabled == e.enabled && (!enabled || workspaceRoot == e.workspaceRoot)
	if noChange {
		e.mu.Unlock()
		return nil
	}
	oldAdapter, oldQueue := e.adapter, e.queue
	e.adapter, e.pyAdapter, e.queue, e.gate = nil, nil, nil, nil
	e.enabled = false
	e.workspaceRoot = workspaceRoot
	e.mu.Unlock()

	if oldQueue != nil {
		oldQueue.Close()
	}
	if oldAdapter != nil {
		oldAdapter.Close()
	}
	if !enabled {
		return nil
	}

	binPath, err := FindTypescriptLanguageServer(e.execDir)
	if err != nil {
		return err
	}
	adapter, err := NewTSAdapter(workspaceRoot, binPath, e.graph, e.handleDiagnostics)
	if err != nil {
		return err
	}

	var bridge *BridgeGraph
	if specPath := FindOpenAPISpec(workspaceRoot); specPath != "" {
		bridge, _ = LoadOpenAPISpec(specPath) // best-effort -- a malformed spec just means no bridging, not a failure to enable
	}

	e.mu.Lock()
	e.adapter = adapter
	e.pyAdapter = NewPyAdapter(workspaceRoot) // Tier B: no process to spawn, always available once enabled
	e.bridge = bridge
	e.gate = NewTriggerGate(e.graph, e.handleFire)
	e.queue = NewResolutionQueue(adapter, e.handleSignatureResolved)
	e.enabled = true
	level := e.level
	e.mu.Unlock()

	if level >= 3 {
		_ = e.ScanProject() // best-effort, fire-and-forget: root-level was already unlocked when this workspace was enabled
	}
	return nil
}

func isPythonPath(path string) bool { return strings.HasSuffix(path, ".py") }

func (e *Engine) handleDiagnostics(filePath string, edges []Edge) {
	e.mu.Lock()
	gate, queue := e.gate, e.queue
	e.mu.Unlock()

	for _, edge := range edges {
		if gate != nil {
			gate.OnEdgeStateChanged(edge.ID, edge.State)
		}
		// The queue is bound to the TS adapter's LSP-backed ResolveSignature
		// (see SetEnabled) -- only worth enqueueing TS/JS edges. Python's
		// ExtractEdges path resolves synchronously and never has anything
		// useful for ResolveSignature to add (see py_adapter.go).
		if queue != nil && edge.State == StateDangling && !isPythonPath(edge.FilePath) {
			queue.Enqueue(edge) // proactive background signature fetch, see handleSignatureResolved
		}
	}
	if e.onDiagnostics != nil {
		e.onDiagnostics(filePath, edges)
	}
}

func (e *Engine) handleSignatureResolved(edgeID string, sig Signature) {
	e.mu.Lock()
	e.signatureCache[edgeID] = sig
	e.mu.Unlock()
}

// handleFire is TriggerGate's fire callback -- an edge just passed all four
// gates. resolution-failed edges are surfaced in diagnostics already (via
// handleDiagnostics) but never get a "create this" suggestion (spec ??6).
func (e *Engine) handleFire(batch TriggerBatch, edge Edge) {
	if edge.State == StateResolutionFailed {
		return
	}
	go e.generateFixSuggestion(batch.ID, edge)
}

// generateFixSuggestion is Level 1's edge-triggered behavior: repair a
// confirmed-broken reference. Level 1 also covers live inline completion
// (see completion.go), which is a separate, directly-awaited path that does
// not go through runSuggestion below.
func (e *Engine) generateFixSuggestion(batchID string, edge Edge) {
	snippet, err := readSnippet(edge)
	if err != nil {
		return
	}

	sig := e.resolveSignatureForSuggestion(edge)
	var candidates []string
	if sig.Detail != "" {
		candidates = append(candidates, sig.Detail)
	}

	req := SuggestionRequest{
		Type:       "fix",
		Language:   languageForPath(edge.FilePath),
		FilePath:   edge.FilePath,
		Symbol:     edge.ToName,
		Kind:       string(edge.Kind),
		Snippet:    snippet,
		Candidates: candidates,
	}
	origin := SuggestionOrigin{
		Level:       1,
		FilePath:    edge.FilePath,
		Description: "Unresolved reference: " + edge.ToName,
		Edge:        &edge,
	}
	e.runSuggestion(batchID, origin, req)
}

// resolveSignatureForSuggestion checks the background-resolved cache first
// (populated in handleDiagnostics as soon as the edge went dangling, well
// before Gate 2's 500ms settle window elapses -- usually already done by
// the time a suggestion fires) and falls back to a direct, short-timeout
// lookup if it hasn't. Python edges never populate the cache (PyAdapter's
// ResolveSignature is a no-op stub) so the fallback is skipped for them too.
func (e *Engine) resolveSignatureForSuggestion(edge Edge) Signature {
	e.mu.Lock()
	sig, cached := e.signatureCache[edge.ID]
	adapter := e.adapter
	e.mu.Unlock()
	if cached || adapter == nil || isPythonPath(edge.FilePath) {
		return sig
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if resolved, err := adapter.ResolveSignature(ctx, edge); err == nil {
		return resolved
	}
	return sig
}

func languageForPath(path string) string {
	if isPythonPath(path) {
		return "python"
	}
	return "typescript"
}

// runSuggestion is the shared tail of every suggestion path -- Level 1 fix,
// Level 2 folder, Level 3 root: call codeintel-suggest, track the pending
// result, and emit the UI event. A suggestion offering no file changes is
// dropped silently -- "nothing to fix" shouldn't produce an empty card.
func (e *Engine) runSuggestion(batchID string, origin SuggestionOrigin, req SuggestionRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	suggestion, err := e.generator.Generate(ctx, req)
	if err != nil || len(suggestion.Files) == 0 {
		return // no card appears; for Level 1 fixes the diagnostic itself is still visible in Problems
	}

	e.mu.Lock()
	e.nextSuggestionID++
	id := fmt.Sprintf("sugg-%d", e.nextSuggestionID)
	e.pendingSuggestions[id] = pendingSuggestion{Suggestion: suggestion, origin: origin}
	e.mu.Unlock()

	if e.onSuggestion != nil {
		e.onSuggestion(batchID, origin, id, suggestion)
	}
}

func readSnippet(edge Edge) (string, error) {
	data, err := os.ReadFile(edge.FilePath)
	if err != nil {
		return "", err
	}
	const contextLines = 10
	lines := strings.Split(string(data), "\n")
	start := edge.Span.StartLine - contextLines
	if start < 0 {
		start = 0
	}
	end := edge.Span.EndLine + contextLines
	if end > len(lines) {
		end = len(lines)
	}
	return strings.Join(lines[start:end], "\n"), nil
}

// UpdateFile merges freshly extracted nodes/edges for path into the graph
// (replacing whatever that file previously contributed) and records Gate 1's
// syntax-validity signal and the resolution queue's cursor-proximity anchor.
// A no-op if the engine is disabled.
//
// TypeScript/JavaScript: nodes/edges come from the frontend's tree-sitter
// extraction (unresolved until the language server's next diagnostics push
// -- see handleDiagnostics). Python: the frontend sends only raw content
// (it has no Python parser); PyAdapter extracts and resolves synchronously
// right here, so incoming nodes/edges for a .py path are ignored.
func (e *Engine) UpdateFile(path, content string, nodes []Node, edges []Edge, syntaxValid bool, cursorLine int) error {
	e.mu.Lock()
	adapter, pyAdapter, gate, queue := e.adapter, e.pyAdapter, e.gate, e.queue
	pythonEnabled := e.pythonEnabled
	e.mu.Unlock()
	if adapter == nil {
		return nil
	}

	path = NormalizePath(path)

	if isPythonPath(path) {
		if !pythonEnabled {
			return nil
		}
		resolved := pyAdapter.ExtractEdges(path, content)
		e.graph.ReplaceFileEdges(path, resolved)
		e.handleDiagnostics(path, resolved) // same gate/onDiagnostics pipeline TS diagnostics use
		return nil
	}

	// Stamp every node/edge with the same normalized path this call uses as
	// its graph key, rather than trusting whatever the frontend put in
	// Node.FilePath/Edge.FilePath -- NormalizePath's Windows drive-letter
	// canonicalization has to be applied consistently everywhere a path
	// becomes a graph key or the diagnostics round trip silently drops
	// (see NormalizePath's doc comment).
	for i := range nodes {
		nodes[i].FilePath = path
	}
	for i := range edges {
		edges[i].FilePath = path
	}

	for _, n := range nodes {
		e.graph.UpsertNode(n)
	}
	removed := e.graph.ReplaceFileEdges(path, edges)
	for _, id := range removed {
		gate.OnEdgeStateChanged(id, StateResolved) // vanished edge -- treat as settled-away, cancel any pending timer
	}
	var bridgeEdges []Edge
	for _, edge := range edges {
		if edge.Kind == EdgeRoutesTo {
			// Bridge edges (spec §7) resolve synchronously against the
			// loaded OpenAPI spec, not the LSP -- tsserver has no opinion on
			// whether a URL string matches a backend route. Directionality
			// rule: this only ever runs when the *caller* (this fetch/axios
			// call site) is edited, never pushed from a backend route change.
			bridgeEdges = append(bridgeEdges, edge)
			continue
		}
		// New/still-current edges start life unresolved until the next
		// diagnostics push -- Gate 4 must hold them until then (never show
		// "dangling" before resolution completes, spec ??6).
		gate.OnEdgeStateChanged(edge.ID, StateUnresolved)
	}
	if len(bridgeEdges) > 0 {
		e.resolveBridgeEdges(path, bridgeEdges)
	}

	gate.SetSyntaxValid(path, syntaxValid)
	queue.SetCursor(path, cursorLine)

	return e.notifyBuffer(adapter, path, content)
}

// resolveBridgeEdges matches each routes-to edge's URL (carried in ToName as
// "METHOD path", or just "path" when the extraction couldn't tell the verb)
// against the loaded OpenAPI spec. With no spec loaded, bridge edges are
// left resolved (nothing to flag) rather than dangling -- most workspaces
// have no OpenAPI spec at all, and that's not itself a problem.
func (e *Engine) resolveBridgeEdges(path string, bridgeEdges []Edge) {
	e.mu.Lock()
	bridge := e.bridge
	e.mu.Unlock()

	resolved := make([]Edge, 0, len(bridgeEdges))
	for _, edge := range bridgeEdges {
		method, url := splitMethodAndURL(edge.ToName)
		if bridge == nil {
			edge.State = StateResolved
		} else if route, ok := bridge.Match(method, url); ok {
			edge.State = StateResolved
			edge.Confidence = 1.0
			edge.BridgeAdapter = "openapi-schema"
			edge.To = route.OperationID
		} else {
			edge.State = StateDangling
			edge.Confidence = 1.0
			edge.BridgeAdapter = "openapi-schema"
			edge.Message = "No route in " + filepath.Base(bridge.SourcePath) + " matches " + edge.ToName
		}
		e.graph.UpsertEdge(edge)
		resolved = append(resolved, edge)
	}
	e.handleDiagnostics(path, resolved)
}

func splitMethodAndURL(toName string) (method, url string) {
	if i := strings.IndexByte(toName, ' '); i > 0 {
		return toName[:i], toName[i+1:]
	}
	return "", toName
}

func (e *Engine) notifyBuffer(adapter *TSAdapter, path, content string) error {
	e.mu.Lock()
	alreadyOpen := e.openFiles[path]
	e.openFiles[path] = true
	e.mu.Unlock()

	if alreadyOpen {
		return adapter.NotifyFileChange(path, content)
	}
	return adapter.NotifyFileOpen(path, content)
}

// SetFocus is spec §3's promotion/demotion mechanism: hot when path is the
// focused tab, warm when it loses focus. Cold-tier eviction is deliberately
// not implemented -- the spec itself defers it pending real usage data;
// this only ever moves a file between hot and warm.
func (e *Engine) SetFocus(path string, focused bool) {
	if focused {
		e.graph.SetFileTier(NormalizePath(path), TierHot)
	} else {
		e.graph.SetFileTier(NormalizePath(path), TierWarm)
	}
}

// ForgetFile drops path's nodes/edges from the graph and lets the relevant
// adapter release any per-file state it held (the LSP's own document state
// for TS, nothing for Python) -- call when a tab closes.
func (e *Engine) ForgetFile(path string) {
	path = NormalizePath(path)
	e.mu.Lock()
	adapter, gate := e.adapter, e.gate
	delete(e.openFiles, path)
	e.mu.Unlock()

	if gate != nil {
		for _, edge := range e.graph.EdgesInFile(path) {
			gate.OnEdgeStateChanged(edge.ID, StateResolved) // cancel any pending settle/awaiting timers
		}
	}
	e.graph.RemoveFile(path)
	if adapter != nil && !isPythonPath(path) {
		_ = adapter.NotifyFileClose(path)
	}
}

const (
	folderScanMaxFiles     = 12
	folderScanMaxFileBytes = 64 * 1024
)

// OnFileSaved is Level 2's trigger (on-demand, not live -- fires once per
// save, not per keystroke). Gathers the saved file's folder siblings fresh
// from disk, since most were never opened in an editor tab and so were
// never parsed into the in-memory graph. No-op below level 2 or with no
// workspace open.
func (e *Engine) OnFileSaved(path string) {
	path = NormalizePath(path)
	e.mu.Lock()
	root, level := e.workspaceRoot, e.level
	e.mu.Unlock()
	if level < 2 || root == "" {
		return
	}

	relDir, err := filepath.Rel(root, filepath.Dir(path))
	if err != nil {
		return
	}
	if relDir == "." {
		relDir = ""
	}

	go e.runFolderSuggestion(root, relDir, path)
}

func (e *Engine) runFolderSuggestion(root, relDir, savedPath string) {
	entries, err := workspace.ListDir(root, relDir)
	if err != nil {
		return
	}

	var context []ContextFile
	for _, entry := range entries {
		if entry.IsDir || len(context) >= folderScanMaxFiles {
			continue
		}
		if !rootScanExtensions[filepath.Ext(entry.Name)] {
			continue
		}
		content, err := workspace.Read(root, entry.Path)
		if err != nil || len(content.Content) > folderScanMaxFileBytes {
			continue
		}
		context = append(context, ContextFile{Path: entry.Path, Content: content.Content})
	}
	if len(context) == 0 {
		return
	}

	folderLabel := relDir
	if folderLabel == "" {
		folderLabel = "(workspace root)"
	}
	req := SuggestionRequest{
		Type:     "folder",
		Language: languageForPath(savedPath),
		FilePath: savedPath,
		Snippet:  fmt.Sprintf("Folder: %s (%d file(s) shown below)", folderLabel, len(context)),
		Context:  context,
	}
	origin := SuggestionOrigin{
		Level:       2,
		FilePath:    savedPath,
		Description: fmt.Sprintf("Folder suggestion for %s", folderLabel),
	}
	e.runSuggestion(fmt.Sprintf("folder-%s-%d", relDir, time.Now().UnixNano()), origin, req)
}

// SignalScopeExit is Gate 3's primary signal, forwarded from the frontend's
// tree-sitter cursor tracking, for the edge-based dangling-reference fix
// flow (TriggerGate.OnScopeExit). Level 1's "general improvement" review
// pass that used to also live here was removed in favor of real inline
// ghost-text completion (see completion.go) -- a live, per-keystroke,
// predict-what-comes-next experience the user actually wanted, not a
// post-hoc review of finished code.
func (e *Engine) SignalScopeExit(path string, scopeSpan Span) {
	path = NormalizePath(path)
	e.mu.Lock()
	gate := e.gate
	e.mu.Unlock()
	if gate == nil {
		return
	}
	gate.OnScopeExit(path, scopeSpan)
}

// CompleteInline is Level 1's real ghost-text path: given the code
// immediately before and after the cursor, ask the model what comes next
// and return it directly for Monaco's InlineCompletionsProvider to show as
// grey text. Unlike the suggestion system (fire-and-forget, then an event
// once a batch settles), the frontend awaits this call directly per
// keystroke, so it's gated only on the master enabled switch -- Level 1 is
// always on once the engine is on, no level check needed.
func (e *Engine) CompleteInline(ctx context.Context, path, prefix, suffix string) (string, error) {
	e.mu.Lock()
	enabled := e.enabled
	repoRoot := e.repoRoot
	e.mu.Unlock()
	if !enabled {
		return "", nil
	}

	return RequestCompletion(ctx, repoRoot, CompletionRequest{
		Language: languageForPath(NormalizePath(path)),
		FilePath: path,
		Prefix:   prefix,
		Suffix:   suffix,
	})
}

// ArmIdleFallback (re)starts Gate 3's idle-fallback timer -- call on every
// keystroke inside scopeSpan.
func (e *Engine) ArmIdleFallback(path string, scopeSpan Span) {
	e.mu.Lock()
	gate := e.gate
	e.mu.Unlock()
	if gate != nil {
		gate.ArmIdleFallback(NormalizePath(path), scopeSpan)
	}
}

// AcceptSuggestion writes every file in the suggestion through
// internal/workspace's path-jailed Write (the same function every other
// workspace file edit in this app goes through), then forgets it. Returns
// an error if id is unknown -- already applied, rejected, or the engine was
// restarted since it was generated.
func (e *Engine) AcceptSuggestion(id string) (Suggestion, error) {
	e.mu.Lock()
	pending, ok := e.pendingSuggestions[id]
	if ok {
		delete(e.pendingSuggestions, id)
	}
	root := e.workspaceRoot
	e.mu.Unlock()
	if !ok {
		return Suggestion{}, fmt.Errorf("suggestion %q not found (already applied, rejected, or expired)", id)
	}

	for _, f := range pending.Files {
		if err := workspace.Write(root, f.Path, f.ProposedContent); err != nil {
			return Suggestion{}, fmt.Errorf("write %s: %w", f.Path, err)
		}
	}
	return pending.Suggestion, nil
}

func (e *Engine) RejectSuggestion(id string) {
	e.mu.Lock()
	delete(e.pendingSuggestions, id)
	e.mu.Unlock()
}

// Close tears down the LSP process and resolution queue. Call from
// SessionAPI.shutdown, mirroring TerminalManager.CloseAll.
func (e *Engine) Close() {
	e.mu.Lock()
	adapter, queue := e.adapter, e.queue
	e.adapter, e.queue, e.gate = nil, nil, nil
	e.enabled = false
	e.mu.Unlock()

	if queue != nil {
		queue.Close()
	}
	if adapter != nil {
		adapter.Close()
	}
}

// rootScanSkipDirs and rootScanExtensions bound ScanProject's filesystem
// walk -- workspace.Tree/readDir only skips dotfiles, not build output or
// dependency directories, and node_modules alone can be tens of thousands
// of files. rootScanMaxFiles is a second, absolute backstop.
var rootScanSkipDirs = map[string]bool{
	"node_modules": true, "dist": true, "build": true, "out": true,
	"__pycache__": true, "venv": true, ".venv": true, "vendor": true,
	"target": true, ".next": true, ".cache": true,
}

var rootScanExtensions = map[string]bool{
	".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true, ".py": true,
}

const (
	rootScanMaxFiles     = 500
	rootScanMaxFileBytes = 256 * 1024
)

func flattenSourceFiles(nodes []session.FileNode, limit int) []string {
	var out []string
	var walk func(nodes []session.FileNode)
	walk = func(nodes []session.FileNode) {
		for _, n := range nodes {
			if len(out) >= limit {
				return
			}
			if n.IsDir {
				if rootScanSkipDirs[n.Name] {
					continue
				}
				walk(n.Children)
				continue
			}
			if rootScanExtensions[filepath.Ext(n.Name)] {
				out = append(out, n.Path)
			}
		}
	}
	walk(nodes)
	return out
}

// ScanProject is Level 3's explicit trigger (also called once,
// fire-and-forget, whenever root-level is newly unlocked -- see SetLevel
// and SetEnabled). Runs in the background; the result (if any) arrives as a
// normal suggestion event once codeintel-suggest returns.
func (e *Engine) ScanProject() error {
	e.mu.Lock()
	root, level := e.workspaceRoot, e.level
	e.mu.Unlock()
	if level < 3 {
		return fmt.Errorf("root-level scanning is off at the current intervention level")
	}
	if root == "" {
		return fmt.Errorf("no workspace open")
	}
	go e.runRootScan(root)
	return nil
}

func (e *Engine) runRootScan(root string) {
	tree, err := workspace.Tree(root)
	if err != nil {
		return
	}
	paths := flattenSourceFiles(tree, rootScanMaxFiles)

	files := make(map[string]string, len(paths))
	for _, relPath := range paths {
		content, err := workspace.Read(root, relPath)
		if err != nil || len(content.Content) > rootScanMaxFileBytes {
			continue
		}
		files[relPath] = content.Content
	}

	detected := ExtractEnvVarUsage(files)
	if len(detected) == 0 {
		return
	}

	existingPath := ".env.example"
	existing, err := workspace.Read(root, existingPath)
	if err != nil {
		existing, err = workspace.Read(root, ".env")
	}
	existingContent := ""
	if err == nil {
		existingContent = existing.Content
	}

	missing := DiffEnvFile(existingContent, detected)
	if len(missing) == 0 {
		return
	}

	req := SuggestionRequest{
		Type:     "root",
		Language: "project",
		FilePath: ".env.example",
		Snippet: fmt.Sprintf(
			"Detected environment variables used in the codebase: %s\n\nExisting .env.example contents (may be empty):\n%s",
			strings.Join(detected, ", "), existingContent,
		),
	}
	origin := SuggestionOrigin{
		Level:       3,
		FilePath:    ".env.example",
		Description: fmt.Sprintf("%d environment variable(s) missing from .env.example", len(missing)),
	}
	e.runSuggestion(fmt.Sprintf("root-scan-%d", time.Now().UnixNano()), origin, req)
}
