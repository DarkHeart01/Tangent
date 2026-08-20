import { useState } from "react";
import { PHASES, describeEnvelope, useSwarmSession } from "../lib/useSwarmSession";

export default function Dashboard() {
  const { activeSessionId, activeWsClient, entries, currentPhase, spent, allocated, progress, chat, pendingQuestion, sending, sendMessage } = useSwarmSession();
  const [message, setMessage] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    await sendMessage(message);
    setMessage("");
  };

  if (!activeSessionId) return null;
  return <div className="swarm-live">
    <div className="phase-pills">{PHASES.map((phase, index) => <span key={phase} className={`phase-pill ${phase === currentPhase ? "is-current" : index < PHASES.indexOf(currentPhase) ? "is-complete" : ""}`}>{phase}</span>)}</div>
    <div className="budget-row"><div className="budget-track"><span style={{ width: `${progress}%` }} /></div><strong>{spent.toFixed(2)} / {allocated.toFixed(2)}</strong></div>
    <div className="swarm-live__heading"><span>LIVE SESSION EVENTS</span><span className="live-indicator"><i /> {activeWsClient?.status ?? "offline"}</span></div>
    <div className="event-feed">
      {entries.map((env) => { const item = describeEnvelope(env); return <article key={env.seq} className={`event-card event-card--${item.tone}`}><span className="event-card__line" /><div><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</div><time>{new Date(env.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></article>; })}
      {!entries.length && <div className="event-feed__empty">Waiting for swarm events…</div>}
    </div>
    {chat.length > 0 && <div className="swarm-chat__log">
      {chat.map((line, index) => <div key={index} className={`chat-line chat-line--${line.from}`}><span className="chat-line__who">{line.from === "swarm" ? "Swarm" : "You"}</span><span className="chat-line__text">{line.text}</span></div>)}
    </div>}
    <form className="swarm-chat" onSubmit={submit}>
      <input value={message} onChange={(event) => setMessage(event.target.value)} disabled={!pendingQuestion || sending} placeholder={pendingQuestion ? "Answer the swarm…" : "Waiting — the swarm will ask here when it needs you"} aria-label="Message the swarm" />
      <button type="submit" disabled={!message.trim() || !pendingQuestion || sending}>{sending ? "Sending…" : "Send"}</button>
    </form>
    <p className="swarm-chat__hint">{pendingQuestion ? "The swarm is waiting for your reply." : "Two-way chat opens when the swarm asks a question (human_input). Approvals appear above."}</p>
  </div>;
}
