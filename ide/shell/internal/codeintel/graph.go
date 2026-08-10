// Package codeintel is the language-blind core of the Live Code Intelligence
// Engine: a symbol/reference graph, a trigger-gate state machine, and an
// async resolution pipeline that talks to a language server. It never
// imports language-specific parsing logic — per-language structural
// extraction (tree-sitter) runs in the frontend (see
// frontend/src/lib/codeintel/treeSitter.ts) because this app ships with
// CGO disabled, and the standard Go tree-sitter bindings need CGO. The
// frontend calls into this package's Engine with already-extracted
// Nodes/Edges; only signature resolution (which wraps a real language
// server, not a reimplementation) and everything downstream of it lives here.
package codeintel

import "sync"

type Kind string

const (
	KindFunction Kind = "function"
	KindClass    Kind = "class"
	KindRoute    Kind = "route"
	KindImport   Kind = "import"
	KindVariable Kind = "variable"
	KindType     Kind = "type"
)

type Tier string

const (
	TierHot  Tier = "hot"
	TierWarm Tier = "warm"
	TierCold Tier = "cold"
)

type ResolutionState string

const (
	StateUnresolved       ResolutionState = "unresolved"
	StatePending          ResolutionState = "pending"
	StateResolved         ResolutionState = "resolved"
	StateDangling         ResolutionState = "dangling"
	StateResolutionFailed ResolutionState = "resolution-failed"
)

type EdgeKind string

const (
	EdgeCalls    EdgeKind = "calls"
	EdgeImports  EdgeKind = "imports"
	EdgeExtends  EdgeKind = "extends"
	EdgeRoutesTo EdgeKind = "routes-to"
)

// Span is a half-open [Start, End) range in a single file, line/col 0-indexed
// to match both tree-sitter and LSP conventions directly (no off-by-one
// translation needed at either boundary).
type Span struct {
	StartLine int `json:"start_line"`
	StartCol  int `json:"start_col"`
	EndLine   int `json:"end_line"`
	EndCol    int `json:"end_col"`
}

// Signature is only ever populated by a Tier-A adapter's LSP hover/definition
// lookup (or left nil) -- v1 does not reimplement type inference (spec ??4).
type Signature struct {
	Name       string `json:"name"`
	Detail     string `json:"detail"`      // raw LSP hover string, language-adapter-formatted
	ReturnType string `json:"return_type"` // best-effort, may be empty
}

// Node is a symbol: a function/class/route/import/variable/type declaration
// or reference site. IDs are namespaced by the adapter that produced them
// (e.g. "ts:frontend/api.ts#fetchUser") so they're unambiguous once the
// bridge layer starts mixing multiple language graphs together.
type Node struct {
	ID        string          `json:"id"`
	Kind      Kind            `json:"kind"`
	Language  string          `json:"language"`
	FilePath  string          `json:"file_path"`
	Span      Span            `json:"span"`
	Signature *Signature      `json:"signature,omitempty"`
	Tier      Tier            `json:"tier"`
	State     ResolutionState `json:"resolution_state"`
}

// Edge is a reference: node From, at Span in FilePath, refers to something
// named ToName. To is filled in once resolution finds (or fails to find) a
// real Node for that name -- until then it's empty and State is Unresolved
// or Pending.
type Edge struct {
	ID            string          `json:"id"`
	From          string          `json:"from"`
	To            string          `json:"to,omitempty"`
	ToName        string          `json:"to_name"`
	Kind          EdgeKind        `json:"kind"`
	CrossLanguage bool            `json:"cross_language"`
	Confidence    float64         `json:"confidence"`
	BridgeAdapter string          `json:"bridge_adapter,omitempty"`
	State         ResolutionState `json:"resolution_state"`
	FilePath      string          `json:"file_path"`
	Span          Span            `json:"span"`
	// Message is the language server's own diagnostic text (e.g. "Cannot
	// find module './nowhere'"), set by an adapter when it marks an edge
	// dangling/resolution-failed -- carried through so the Problems panel
	// can show something more useful than just the symbol name.
	Message string `json:"message,omitempty"`
}

// Graph is the in-memory node/edge store for one workspace. All access is
// mutex-guarded (mirrors TerminalManager's map+RWMutex shape in
// ide/shell/terminal.go) since frontend updates, LSP resolution callbacks,
// and the trigger-gate timer all touch it from different goroutines.
type Graph struct {
	mu    sync.RWMutex
	nodes map[string]*Node
	edges map[string]*Edge
	// byFile indexes edge IDs sourced from a given file, so a re-parse of
	// that file can diff out the edges that no longer exist.
	byFile map[string]map[string]struct{}
	// nodesByFile mirrors byFile for nodes -- needed for tiering (retagging
	// every node a file owns on focus change) and RemoveFile.
	nodesByFile map[string]map[string]struct{}
	// nodesByName supports Tier B's name-match resolution (spec §4: "starts
	// with param-count + name matching only in v1") -- a language without a
	// real compiler/LSP behind it resolves a reference by checking whether
	// any node anywhere in the graph has a matching name, rather than a
	// project-aware lookup.
	nodesByName map[string]map[string]struct{}
}

func NewGraph() *Graph {
	return &Graph{
		nodes:       make(map[string]*Node),
		edges:       make(map[string]*Edge),
		byFile:      make(map[string]map[string]struct{}),
		nodesByFile: make(map[string]map[string]struct{}),
		nodesByName: make(map[string]map[string]struct{}),
	}
}

func nodeDisplayName(id string) string {
	// Namespaced IDs are "<lang>:<file>#<name>[:extra]" (spec §7's
	// addressing scheme) -- the name is what a Tier B name-match needs.
	if i := lastIndexByte(id, '#'); i >= 0 {
		name := id[i+1:]
		if j := indexByte(name, ':'); j >= 0 {
			name = name[:j]
		}
		return name
	}
	return id
}

func lastIndexByte(s string, b byte) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func (g *Graph) UpsertNode(n Node) {
	g.mu.Lock()
	defer g.mu.Unlock()
	cp := n
	g.nodes[n.ID] = &cp

	if g.nodesByFile[n.FilePath] == nil {
		g.nodesByFile[n.FilePath] = make(map[string]struct{})
	}
	g.nodesByFile[n.FilePath][n.ID] = struct{}{}

	name := nodeDisplayName(n.ID)
	if g.nodesByName[name] == nil {
		g.nodesByName[name] = make(map[string]struct{})
	}
	g.nodesByName[name][n.ID] = struct{}{}
}

// FindByName backs Tier B name-match resolution: every node anywhere in the
// graph (any file, any language) whose display name matches exactly.
func (g *Graph) FindByName(name string) []Node {
	g.mu.RLock()
	defer g.mu.RUnlock()
	ids := g.nodesByName[name]
	out := make([]Node, 0, len(ids))
	for id := range ids {
		if n, ok := g.nodes[id]; ok {
			out = append(out, *n)
		}
	}
	return out
}

// SetFileTier retags every node and edge sourced from filePath -- the
// promotion/demotion mechanism from spec §3 (hot on focus, warm on losing
// focus). Cold-tier eviction is deliberately not implemented (the spec
// itself defers it pending real usage data); this only ever moves between
// hot and warm.
func (g *Graph) SetFileTier(filePath string, tier Tier) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for id := range g.nodesByFile[filePath] {
		if n, ok := g.nodes[id]; ok {
			n.Tier = tier
		}
	}
}

// RemoveFile drops every node and edge a closed file owns (and its index
// entries) -- called when a tab closes so the graph doesn't grow unbounded
// across a long session, and so a stale LSP diagnostic for a since-closed
// file has nothing left to match against.
func (g *Graph) RemoveFile(filePath string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for id := range g.nodesByFile[filePath] {
		if n, ok := g.nodes[id]; ok {
			name := nodeDisplayName(n.ID)
			delete(g.nodesByName[name], id)
			if len(g.nodesByName[name]) == 0 {
				delete(g.nodesByName, name)
			}
		}
		delete(g.nodes, id)
	}
	delete(g.nodesByFile, filePath)
	for id := range g.byFile[filePath] {
		delete(g.edges, id)
	}
	delete(g.byFile, filePath)
}

func (g *Graph) GetNode(id string) (Node, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	n, ok := g.nodes[id]
	if !ok {
		return Node{}, false
	}
	return *n, true
}

func (g *Graph) UpsertEdge(e Edge) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.upsertEdgeLocked(e)
}

func (g *Graph) upsertEdgeLocked(e Edge) {
	cp := e
	g.edges[e.ID] = &cp
	if g.byFile[e.FilePath] == nil {
		g.byFile[e.FilePath] = make(map[string]struct{})
	}
	g.byFile[e.FilePath][e.ID] = struct{}{}
}

func (g *Graph) GetEdge(id string) (Edge, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	e, ok := g.edges[id]
	if !ok {
		return Edge{}, false
	}
	return *e, true
}

// SetEdgeState updates an edge's resolution_state (and, optionally, its
// resolved target or the language server's diagnostic message -- pass ""
// for either to leave it unchanged) and returns the updated edge so callers
// can emit it without a second lookup.
func (g *Graph) SetEdgeState(id string, state ResolutionState, to string, message string) (Edge, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	e, ok := g.edges[id]
	if !ok {
		return Edge{}, false
	}
	e.State = state
	if to != "" {
		e.To = to
	}
	if message != "" {
		e.Message = message
	}
	return *e, true
}

func (g *Graph) EdgesInFile(filePath string) []Edge {
	g.mu.RLock()
	defer g.mu.RUnlock()
	ids := g.byFile[filePath]
	out := make([]Edge, 0, len(ids))
	for id := range ids {
		if e, ok := g.edges[id]; ok {
			out = append(out, *e)
		}
	}
	return out
}

// ReplaceFileEdges swaps every edge sourced from filePath for a fresh set
// (the result of re-parsing that file) and reports which previously-known
// edge IDs disappeared, so the resolution queue and any pending timers for
// them can be cancelled instead of resolving a reference that no longer
// exists in the buffer.
func (g *Graph) ReplaceFileEdges(filePath string, edges []Edge) (removedIDs []string) {
	g.mu.Lock()
	defer g.mu.Unlock()

	previous := g.byFile[filePath]
	next := make(map[string]struct{}, len(edges))
	for _, e := range edges {
		next[e.ID] = struct{}{}
	}
	for id := range previous {
		if _, keep := next[id]; !keep {
			delete(g.edges, id)
			removedIDs = append(removedIDs, id)
		}
	}
	g.byFile[filePath] = make(map[string]struct{})
	for _, e := range edges {
		g.upsertEdgeLocked(e)
	}
	return removedIDs
}
