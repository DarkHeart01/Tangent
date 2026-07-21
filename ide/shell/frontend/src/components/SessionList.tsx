import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../lib/SessionContext";
import * as wailsClient from "../lib/wailsClient";
import type { SessionMode } from "../lib/wailsClient";

const TOPOLOGIES = ["coding_swarm", "software_delivery", "software_delivery_lite", "research_swarm"];
const MODES: { value: SessionMode; label: string; detail: string }[] = [
  { value: "simulated", label: "Simulated", detail: "scripted, no Docker / key" },
  { value: "container", label: "Container", detail: "real Docker + swarm" },
];
const STATUS_COLOR: Record<string, string> = { running: "#d29922", success: "#3fb950", failed: "#f85149", cancelled: "#8b949e" };

function ProviderKeyPanel() {
  const [status, setStatus] = useState<wailsClient.ProviderKeyStatus | null>(null);
  const [provider, setProvider] = useState("openrouter");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const nativeDesktop = wailsClient.isWailsDesktop();

  const refresh = useCallback(async () => {
    if (!nativeDesktop) return;
    try {
      const next = await wailsClient.getProviderKeyStatus();
      setStatus(next);
      setProvider((current) => next.active_provider || current);
      setModel((current) => current || next.default_model || "");
    } catch (error) { setNote(String(error)); }
  }, [nativeDesktop]);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async () => {
    if (!key.trim()) { setNote("Enter a key first."); return; }
    setSaving(true); setNote(null);
    try {
      await wailsClient.setProviderKey(provider, key.trim(), model.trim());
      setKey("");
      setNote(`Saved to ${status?.env_path ?? ".env"}`);
      await refresh();
    } catch (error) { setNote(String(error)); }
    finally { setSaving(false); }
  };

  const configured = status?.configured?.[provider];
  return <details className="provider-panel">
    <summary>Provider API key {configured ? <span className="provider-panel__ok">● {provider} set</span> : <span className="provider-panel__missing">not set</span>}</summary>
    {!nativeDesktop ? <p className="muted-copy">Run the desktop app to set the key.</p> : <>
      <label className="select-field"><span>PROVIDER</span>
        <select value={provider} onChange={(event) => setProvider(event.target.value)}>
          {(status?.known_providers ?? ["openrouter", "groq", "gemini", "openai"]).map((id) => <option key={id} value={id}>{id}{status?.configured?.[id] ? " ✓" : ""}</option>)}
        </select>
      </label>
      <input className="provider-panel__input" type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={provider === "openrouter" ? "sk-or-v1-…" : "API key"} aria-label="Provider API key" />
      <input className="provider-panel__input" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Default model (optional, e.g. deepseek/deepseek-v4-pro)" aria-label="Default model" />
      <button className="provider-panel__save" onClick={() => void save()} disabled={saving || !key.trim()}>{saving ? "Saving…" : "Save key"}</button>
      {note && <p className="provider-panel__note">{note}</p>}
      <p className="muted-copy">Written to the repo-root <code>.env</code>; the swarm loads it on start (container mode).</p>
    </>}
  </details>;
}

export default function SessionList() {
  const { sessions, activeSessionId, starting, error, startSession, stopSession } = useSession();
  const [goal, setGoal] = useState("Add a Widget/Owner schema and ship it to staging");
  const [topology, setTopology] = useState(TOPOLOGIES[0]);
  const [mode, setMode] = useState<SessionMode>("simulated");
  const [stopping, setStopping] = useState(false);
  const recentGoals = useMemo(() => Array.from(new Set(sessions.map((session) => session.goal))).slice(-6).reverse(), [sessions]);
  const active = sessions.find((session) => session.session_id === activeSessionId);
  const nativeDesktop = wailsClient.isWailsDesktop();

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!goal.trim() || starting) return;
    await startSession(goal.trim(), topology, mode);
  };

  const stop = async () => {
    if (!activeSessionId || stopping) return;
    setStopping(true);
    try { await stopSession(activeSessionId); } finally { setStopping(false); }
  };

  if (activeSessionId) return <div className="swarm-session-strip">
    <span className="status-dot" style={{ background: STATUS_COLOR[active?.status ?? "running"] }} />
    <span className="swarm-session-strip__goal" title={active?.goal}>{active?.goal ?? "Active session"}</span>
    <span className="swarm-session-strip__mode">{active?.mode ?? "simulated"}</span>
    <button className="swarm-session-strip__stop" onClick={() => void stop()} disabled={stopping || (active?.status !== undefined && active.status !== "running")} title="Stop this session">{stopping ? "Stopping…" : "Stop"}</button>
  </div>;

  return <div className="session-setup">
    <div className="goal-field"><label htmlFor="goal">GOAL</label><textarea id="goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} placeholder="Describe what the swarm should deliver…" /></div>
    <label className="select-field" htmlFor="topology"><span>TOPOLOGY</span><select id="topology" value={topology} onChange={(event) => setTopology(event.target.value)}>{TOPOLOGIES.map((item) => <option key={item}>{item}</option>)}</select></label>
    <fieldset className="mode-field"><legend>MODE</legend><div className="mode-cards">{MODES.map((item) => <button type="button" key={item.value} className={`mode-card ${mode === item.value ? "is-active" : ""}`} onClick={() => setMode(item.value)}><strong>{item.label}</strong><small>{item.detail}</small></button>)}</div></fieldset>
    {mode === "container" && <ProviderKeyPanel />}
    <button className="start-session-button" onClick={start} disabled={starting || !goal.trim() || !nativeDesktop} title={nativeDesktop ? "Start Session" : "Run wails dev to start a native session"}>{starting ? "Starting session…" : "Start Session"}</button>
    {!nativeDesktop && <div className="session-runtime-note">Browser preview is read-only. Run <code>wails dev</code> to start Swarm sessions and use the native terminal.</div>}
    {error && <div className="session-error">{error}</div>}
    <section className="recent-goals"><h3>RECENT GOALS</h3>{recentGoals.length ? recentGoals.map((item) => <button key={item} className="recent-goal" onClick={() => setGoal(item)} title={item}>{item}</button>) : <p className="muted-copy">Your previous goals will appear here.</p>}</section>
  </div>;
}
