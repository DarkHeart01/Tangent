import { useEffect, useMemo, useState } from "react";

export type QuickOpenItem = { id: string; label: string; hint?: string; onRun: () => void };

// A real, working Command Palette (Ctrl+Shift+P) over whatever action list
// the caller hands it -- AccessBar.tsx flattens its File/Edit/Selection/
// View/Go/Run menu entries into this. Simple substring filter, not true
// fuzzy matching, but genuinely runs the selected action.
export default function QuickOpen({ items, onClose, centered }: { items: QuickOpenItem[]; onClose: () => void; centered?: boolean }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => { setIndex(0); }, [query]);

  const run = (item?: QuickOpenItem) => {
    const target = item ?? filtered[index];
    if (!target) return;
    onClose();
    target.onRun();
  };

  return (
    <div className={`quick-open__backdrop ${centered ? "is-centered" : ""}`} onMouseDown={onClose}>
      <div className="quick-open" onMouseDown={(event) => event.stopPropagation()}>
        <div className="quick-open__input">
          <span className="codicon codicon-search" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command…"
            aria-label="Command Palette"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setIndex((i) => Math.min(filtered.length - 1, i + 1)); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
              else if (event.key === "Enter") { event.preventDefault(); run(); }
              else if (event.key === "Escape") { event.preventDefault(); onClose(); }
            }}
          />
        </div>
        <div className="quick-open__list">
          {filtered.length === 0 && <div className="quick-open__empty">No matching commands</div>}
          {filtered.map((item, i) => (
            <button key={item.id} className={i === index ? "is-active" : ""} onMouseEnter={() => setIndex(i)} onClick={() => run(item)}>
              <span>{item.label}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
