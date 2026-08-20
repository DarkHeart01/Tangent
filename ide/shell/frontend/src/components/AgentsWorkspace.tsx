import { useCallback, useMemo, useState } from "react";
import { useSession } from "../lib/SessionContext";
import { useWorkspace } from "../lib/WorkspaceContext";
import AgentsChatTranscript from "./AgentsChatTranscript";
import HumanGateBanner from "./HumanGateBanner";
import mascot from "../assets/meow_mascot.png";

const TOPOLOGIES = ["coding_swarm", "software_delivery", "software_delivery_lite", "research_swarm"];
const STATUS_COLOR: Record<string, string> = { running: "#d29922", success: "#3fb950", failed: "#f85149", cancelled: "#8b949e" };

function relativeTime(iso: string | undefined) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Figma's "Agents" page is a second top-level surface (switched via the
// Access Bar's Agents/IDE pills) built around the same swarm session data
// the IDE page's right sidebar already uses (SessionContext, and
// useSwarmSession.ts for the transcript -- shared with Dashboard.tsx so the
// IDE sidebar's compact log view and this page's chat-bubble view never
// drift). Two things Figma shows that have no backing data are
// deliberately left out rather than faked: per-session message/token counts
// and model name (SessionSummary carries neither), and a "Lines Modified"
// stat under the transcript. The example chat-history rows in the source
// design also contained placeholder text with a slur baked in by whoever
// authored the mock -- not reproduced here; this renders real session goals.
export default function AgentsWorkspace() {
  const { sessions, activeSessionId, starting, error, startSession, selectSession, newSession } = useSession();
  const { workspace, openFolder } = useWorkspace();
  const [view, setView] = useState<"new-task" | "swarm" | "artifacts">("new-task");
  const [goal, setGoal] = useState("");
  const [topology, setTopology] = useState(TOPOLOGIES[0]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFilter, setHistoryFilter] = useState<"workspace" | "project" | "all">("all");
  const [navWidth, setNavWidth] = useState(280);

  // Same drag-to-resize pattern as the IDE page's explorer/swarm sidebars
  // (App.tsx's beginResize) -- kept local here since this panel isn't part
  // of that page's layout state.
  const beginResizeNav = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = navWidth;
    const move = (next: PointerEvent) => setNavWidth(Math.min(420, Math.max(220, startWidth + next.clientX - startX)));
    const stop = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", stop); document.body.style.cursor = ""; };
    document.body.style.cursor = "col-resize";
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop, { once: true });
  }, [navWidth]);

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!goal.trim() || starting) return;
    await startSession(goal.trim(), topology, "simulated");
    setGoal("");
  };

  const recentSessions = useMemo(() => [...sessions].reverse(), [sessions]);
  const recentForProject = recentSessions.slice(0, 6);
  // No per-workspace field on SessionSummary to group by yet, so Workspace/
  // Project/All (historyFilter) are visually separate tabs but currently
  // equivalent -- only the search box actually narrows the list below.
  const filteredHistory = useMemo(
    () => recentSessions.filter((session) => session.goal.toLowerCase().includes(historyQuery.trim().toLowerCase())),
    [recentSessions, historyQuery],
  );

  const openTask = (id: string) => selectSession(id);
  const startNewTask = () => { newSession(); setView("new-task"); };

  return (
    <div className="agents-workspace">
      <aside className="agents-nav" style={{ width: navWidth }}>
        <button className={`agents-nav__item ${view === "new-task" && !activeSessionId ? "is-active" : ""}`} onClick={startNewTask}>
          <span className="codicon codicon-add" /> New Task
        </button>
        <button className={`agents-nav__item ${view === "artifacts" && !activeSessionId ? "is-active" : ""}`} onClick={() => { newSession(); setView("artifacts"); }}>
          <span className="codicon codicon-package" /> Artifacts
        </button>
        <button className={`agents-nav__item ${view === "swarm" && !activeSessionId ? "is-active" : ""}`} onClick={() => { newSession(); setView("swarm"); }}>
          <span className="codicon codicon-pulse" /> Swarm
        </button>
        <div className="agents-nav__divider" />
        <div className="agents-nav__projects-header">
          <span>Projects</span>
          <div>
            <button className="icon-button" title="Open a project" onClick={() => void openFolder()}><span className="codicon codicon-add" /></button>
            <button className="icon-button" title="Connect to GitHub" disabled><span className="codicon codicon-github" /></button>
          </div>
        </div>
        {workspace ? (
          <div className="agents-nav__project">
            <strong>{workspace.name}</strong>
            {recentForProject.length ? recentForProject.map((session) => (
              <button key={session.session_id} className={`agents-nav__task ${session.session_id === activeSessionId ? "is-active" : ""}`} onClick={() => openTask(session.session_id)} title={session.goal}>
                {session.goal || "Untitled task"}
              </button>
            )) : <p className="agents-nav__empty">No tasks yet</p>}
          </div>
        ) : <p className="agents-nav__empty">Open a folder to start a project</p>}
        <div className="panel-resizer panel-resizer--right" onPointerDown={beginResizeNav} role="separator" aria-label="Resize sidebar" />
      </aside>

      <main className="agents-main">
        {activeSessionId ? (
          <>
            <div className="agents-chat">
              <HumanGateBanner />
              <AgentsChatTranscript />
            </div>
            <aside className="agents-history">
              <div className="agents-history__header">
                <div>
                  <h2>Agent Session History</h2>
                  <span>{filteredHistory.length} shown · {sessions.length} recent</span>
                </div>
              </div>
              <div className="agents-history__tabs">
                {(["workspace", "project", "all"] as const).map((tab) => (
                  <button key={tab} className={historyFilter === tab ? "is-active" : ""} onClick={() => setHistoryFilter(tab)}>{tab === "all" ? "All" : tab[0].toUpperCase() + tab.slice(1)}</button>
                ))}
              </div>
              <div className="agents-history__search">
                <span className="codicon codicon-search" />
                <input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="Search…" />
              </div>
              <div className="agents-history__list">
                {filteredHistory.length ? filteredHistory.map((session) => (
                  <button key={session.session_id} className={`agents-history__row ${session.session_id === activeSessionId ? "is-active" : ""}`} onClick={() => openTask(session.session_id)}>
                    <span className="agents-history__dot" style={{ background: STATUS_COLOR[session.status ?? "running"] }} />
                    <span className="agents-history__body">
                      <strong>{session.goal || "Untitled task"}</strong>
                      <small>{session.topology} · {session.mode} · {relativeTime(session.started_at)}</small>
                    </span>
                  </button>
                )) : <div className="agents-history__empty">No sessions yet</div>}
              </div>
            </aside>
          </>
        ) : view === "swarm" ? (
          <div className="agents-swarm-list">
            <h2>Swarm sessions</h2>
            {recentSessions.length ? recentSessions.map((session) => (
              <button key={session.session_id} className="agents-swarm-row" onClick={() => openTask(session.session_id)}>
                <span className="agents-history__dot" style={{ background: STATUS_COLOR[session.status ?? "running"] }} />
                <span className="agents-history__body"><strong>{session.goal || "Untitled task"}</strong><small>{session.topology} · {session.mode} · {relativeTime(session.started_at)}</small></span>
              </button>
            )) : <p className="muted-copy">No swarm sessions yet — start one from New Task.</p>}
          </div>
        ) : view === "artifacts" ? (
          <div className="agents-empty-state">
            <span className="codicon codicon-package" />
            <p>Artifacts will appear here once a session writes build output.</p>
          </div>
        ) : (
          <div className="agents-hero">
            <div className="agents-hero__wordmark">TANGENT</div>
            <p className="agents-hero__tagline">An agentic IDE that helps you do your best work.</p>
            <form className="agents-hero__composer" onSubmit={start}>
              <textarea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="Tell Swarm to do a task for you……"
                rows={2}
                onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void start(event); }}
              />
              <div className="agents-hero__composer-row">
                <select value={topology} onChange={(event) => setTopology(event.target.value)} title="Topology">
                  {TOPOLOGIES.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <button type="submit" className="agents-hero__send" disabled={!goal.trim() || starting} title="Start Session"><span className="codicon codicon-send" /></button>
              </div>
              {error && <div className="session-error">{error}</div>}
              <img src={mascot} alt="Tangent" className="agents-hero__mascot" />
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
