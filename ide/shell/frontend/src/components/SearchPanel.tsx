import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as wailsClient from "../lib/wailsClient";
import { useWorkspace } from "../lib/WorkspaceContext";

type Grouped = { path: string; matches: wailsClient.SearchMatch[] };

// Groups a flat match list by file, preserving first-seen order.
function groupByFile(matches: wailsClient.SearchMatch[]): Grouped[] {
  const order: string[] = [];
  const map = new Map<string, wailsClient.SearchMatch[]>();
  for (const match of matches) {
    if (!map.has(match.path)) { map.set(match.path, []); order.push(match.path); }
    map.get(match.path)!.push(match);
  }
  return order.map((path) => ({ path, matches: map.get(path)! }));
}

export default function SearchPanel() {
  const { workspace } = useWorkspace();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<wailsClient.SearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const seq = useRef(0);
  const root = workspace?.backendRoot ? workspace.rootPath : null;

  const run = useCallback(async (q: string) => {
    if (!root || !q.trim()) { setMatches([]); setSearched(false); setError(null); return; }
    const mine = ++seq.current;
    setLoading(true); setError(null);
    try {
      const results = await wailsClient.searchWorkspace(root, q.trim());
      if (mine !== seq.current) return; // a newer search superseded this one
      setMatches(results); setSearched(true);
    } catch (cause) {
      if (mine === seq.current) { setError(String(cause)); setMatches([]); }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [root]);

  // Debounce typing so each keystroke doesn't kick off a full-repo scan.
  useEffect(() => {
    const handle = window.setTimeout(() => void run(query), 250);
    return () => window.clearTimeout(handle);
  }, [query, run]);

  const grouped = useMemo(() => groupByFile(matches), [matches]);
  const open = (match: wailsClient.SearchMatch) => {
    window.dispatchEvent(new CustomEvent("tangent:open-file", { detail: { path: match.path, preview: false, line: match.line } }));
  };

  return <div className="search-panel">
    <div className="search-panel__box">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search"
        aria-label="Search across the workspace"
        autoFocus
      />
    </div>
    {!root && <div className="search-panel__hint">Open a folder to search across the codebase.</div>}
    {root && loading && <div className="search-panel__hint">Searching…</div>}
    {root && error && <div className="search-panel__error">{error}</div>}
    {root && !loading && !error && searched && matches.length === 0 && <div className="search-panel__hint">No results for “{query.trim()}”.</div>}
    {root && matches.length > 0 && (
      <div className="search-panel__summary">{matches.length}{matches.length >= 500 ? "+" : ""} results in {grouped.length} files</div>
    )}
    <div className="search-panel__results">
      {grouped.map((group) => (
        <div key={group.path} className="search-group">
          <div className="search-group__file" title={group.path}>
            <span className="search-group__name">{group.path.split("/").pop()}</span>
            <span className="search-group__dir">{group.path.split("/").slice(0, -1).join("/")}</span>
            <span className="search-group__count">{group.matches.length}</span>
          </div>
          {group.matches.map((match, index) => (
            <button key={`${match.line}-${index}`} className="search-match" onClick={() => open(match)} title={`${group.path}:${match.line}`}>
              <span className="search-match__line">{match.line}</span>
              <span className="search-match__preview">{match.preview}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  </div>;
}
