package codeintel

import "testing"

func TestGraphUpsertAndQuery(t *testing.T) {
	g := NewGraph()

	g.UpsertNode(Node{ID: "ts:a.ts#foo", Kind: KindFunction, FilePath: "a.ts", State: StateResolved})
	if n, ok := g.GetNode("ts:a.ts#foo"); !ok || n.Kind != KindFunction {
		t.Fatalf("expected node to round-trip, got %+v ok=%v", n, ok)
	}

	edge := Edge{ID: "e1", From: "ts:a.ts#foo", ToName: "bar", Kind: EdgeCalls, FilePath: "a.ts", State: StateUnresolved}
	g.UpsertEdge(edge)
	got, ok := g.GetEdge("e1")
	if !ok || got.ToName != "bar" {
		t.Fatalf("expected edge to round-trip, got %+v ok=%v", got, ok)
	}

	edges := g.EdgesInFile("a.ts")
	if len(edges) != 1 || edges[0].ID != "e1" {
		t.Fatalf("expected exactly edge e1 in a.ts, got %+v", edges)
	}
}

func TestGraphSetEdgeStatePreservesToWhenEmpty(t *testing.T) {
	g := NewGraph()
	g.UpsertEdge(Edge{ID: "e1", ToName: "bar", To: "ts:b.ts#bar", FilePath: "a.ts", State: StatePending})

	updated, ok := g.SetEdgeState("e1", StateResolved, "", "")
	if !ok {
		t.Fatal("expected edge to exist")
	}
	if updated.State != StateResolved {
		t.Errorf("expected state Resolved, got %s", updated.State)
	}
	if updated.To != "ts:b.ts#bar" {
		t.Errorf("expected To to be preserved when passed empty, got %q", updated.To)
	}
}

func TestGraphReplaceFileEdgesReportsRemoved(t *testing.T) {
	g := NewGraph()
	g.UpsertEdge(Edge{ID: "e1", FilePath: "a.ts", ToName: "old"})
	g.UpsertEdge(Edge{ID: "e2", FilePath: "a.ts", ToName: "keep"})

	removed := g.ReplaceFileEdges("a.ts", []Edge{{ID: "e2", FilePath: "a.ts", ToName: "keep"}, {ID: "e3", FilePath: "a.ts", ToName: "new"}})

	if len(removed) != 1 || removed[0] != "e1" {
		t.Fatalf("expected e1 reported removed, got %v", removed)
	}
	if _, ok := g.GetEdge("e1"); ok {
		t.Error("expected e1 to be gone from the graph")
	}
	if _, ok := g.GetEdge("e3"); !ok {
		t.Error("expected e3 to be present after replace")
	}
	edges := g.EdgesInFile("a.ts")
	if len(edges) != 2 {
		t.Fatalf("expected exactly 2 edges in a.ts after replace, got %d: %+v", len(edges), edges)
	}
}

func TestSpansOverlap(t *testing.T) {
	cases := []struct {
		name     string
		a, b     Span
		expected bool
	}{
		{"identical", Span{0, 0, 0, 5}, Span{0, 0, 0, 5}, true},
		{"disjoint same line", Span{0, 0, 0, 5}, Span{0, 10, 0, 15}, false},
		{"overlapping", Span{0, 0, 0, 10}, Span{0, 5, 0, 15}, true},
		{"adjacent lines no overlap", Span{0, 0, 0, 5}, Span{1, 0, 1, 5}, false},
		{"multiline containment", Span{0, 0, 5, 0}, Span{2, 3, 2, 8}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := spansOverlap(tc.a, tc.b); got != tc.expected {
				t.Errorf("spansOverlap(%+v, %+v) = %v, want %v", tc.a, tc.b, got, tc.expected)
			}
		})
	}
}
