import { useState } from "react";
import { useSession } from "../lib/SessionContext";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

const STATUS_COLOR: Record<string, string> = { running: "#d29922", success: "#3fb950", failed: "#f85149", cancelled: "#8b949e" };

// Figma's Chat window shows a tab strip for multiple concurrent sessions.
// SessionContext already tracks every session + a per-session WS client
// (see clientsRef in SessionContext.tsx) — this just finally exposes that
// as UI instead of only ever showing the single active session.
export default function SessionTabs() {
  const { sessions, activeSessionId, selectSession, newSession, stopSession } = useSession();
  const [listAt, setListAt] = useState<{ x: number; y: number } | null>(null);

  const close = (event: React.MouseEvent, id: string, status: string | undefined) => {
    event.stopPropagation();
    if (status && status !== "running") { if (activeSessionId === id) newSession(); return; }
    void stopSession(id);
  };

  const listItems: ContextMenuItem[] = sessions.length
    ? sessions.map((session) => ({ label: session.goal || session.session_id, onClick: () => selectSession(session.session_id) }))
    : [{ label: "No sessions yet", disabled: true }];

  return (
    <div className="session-tabs">
      <div className="session-tabs__strip">
        {sessions.map((session) => (
          <button
            key={session.session_id}
            className={`session-tab ${session.session_id === activeSessionId ? "is-active" : ""}`}
            onClick={() => selectSession(session.session_id)}
            title={session.goal}
          >
            <span className="session-tab__dot" style={{ background: STATUS_COLOR[session.status ?? "running"] }} />
            <span className="session-tab__label">{session.goal || "Session"}</span>
            <span className="session-tab__close" onClick={(event) => close(event, session.session_id, session.status)} title={session.status && session.status !== "running" ? "Dismiss" : "Stop session"}>
              <span className="codicon codicon-close" />
            </span>
          </button>
        ))}
        <button className={`session-tab session-tab--new ${!activeSessionId ? "is-active" : ""}`} onClick={newSession} title="New Session">
          <span className="session-tab__label">New Session</span>
        </button>
      </div>
      <div className="session-tabs__actions">
        <button className="icon-button" title="New Chat" onClick={newSession}><span className="codicon codicon-add" /></button>
        <button className="icon-button" title="Sessions list" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setListAt({ x: rect.right - 200, y: rect.bottom + 4 }); }}><span className="codicon codicon-ellipsis" /></button>
      </div>
      {listAt && <ContextMenu x={listAt.x} y={listAt.y} items={listItems} onClose={() => setListAt(null)} />}
    </div>
  );
}
