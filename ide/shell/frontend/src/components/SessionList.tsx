import { useState } from "react";
import { useSession } from "../lib/SessionContext";

const TOPOLOGIES = ["coding_swarm", "software_delivery", "software_delivery_lite", "research_swarm"];

const STATUS_COLOR: Record<string, string> = {
  running: "#e8b339",
  success: "#3fb950",
  failed: "#f85149",
  cancelled: "#8b949e",
};

export default function SessionList() {
  const { sessions, activeSessionId, starting, error, selectSession, startSession, stopSession } = useSession();
  const [goal, setGoal] = useState("Add a Widget/Owner schema and ship it to staging");
  const [topology, setTopology] = useState(TOPOLOGIES[0]);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || starting) return;
    await startSession(goal.trim(), topology);
  };

  return (
    <div className="session-list">
      <form className="session-list__form" onSubmit={handleStart}>
        <label>
          Goal
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} />
        </label>
        <label>
          Topology
          <select value={topology} onChange={(e) => setTopology(e.target.value)}>
            {TOPOLOGIES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={starting}>
          {starting ? "Starting…" : "Start Session"}
        </button>
      </form>

      {error && <div className="session-list__error">{error}</div>}

      <ul className="session-list__items">
        {sessions.length === 0 && <li className="session-list__empty">No sessions yet</li>}
        {sessions.map((s) => (
          <li
            key={s.session_id}
            className={`session-list__item ${s.session_id === activeSessionId ? "is-active" : ""}`}
            onClick={() => selectSession(s.session_id)}
          >
            <div className="session-list__item-header">
              <span className="session-list__dot" style={{ background: STATUS_COLOR[s.status] ?? "#8b949e" }} />
              <span className="session-list__goal" title={s.goal}>
                {s.goal}
              </span>
            </div>
            <div className="session-list__meta">
              <span>{s.topology}</span>
              <span>{s.status}</span>
            </div>
            {s.status === "running" && (
              <button
                className="session-list__stop"
                onClick={(e) => {
                  e.stopPropagation();
                  stopSession(s.session_id);
                }}
              >
                Stop
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
