import { useEffect, useMemo, useState } from "react";
import { useSession } from "../lib/SessionContext";
import * as wailsClient from "../lib/wailsClient";
import type { AnyEnvelope } from "../lib/contract";

const PHASES = ["Discovery", "Planning", "Architecture", "Repo Discovery", "Contracting", "Build", "Quality", "Deploy + Monitor"];
const PHASE_MAP: Record<string, string> = { discovery: "Discovery", planning: "Planning", architecture: "Architecture", repo_discovery: "Repo Discovery", contracting: "Contracting", test_planning: "Build", build: "Build", documentation_generation: "Build", live_test: "Quality", quality: "Quality", dependency_audit: "Quality", performance_testing: "Quality", release_preparation: "Deploy + Monitor", deployment: "Deploy + Monitor", post_launch: "Deploy + Monitor", implementation: "Build", verification: "Quality" };
const FEED_TYPES = new Set<AnyEnvelope["type"]>(["phase.transition", "agent.started", "agent.finished", "agent.handoff", "tool.call", "tool.result", "critic.score", "budget.update", "error"]);

function phaseName(value: string | null | undefined) { return PHASE_MAP[value ?? ""] ?? value ?? "Discovery"; }
function describe(env: AnyEnvelope) {
  switch (env.type) {
    case "phase.transition": return { title: `Phase: ${phaseName(env.payload.from_phase)} → ${phaseName(env.payload.to_phase)}`, detail: `${env.payload.budget_remaining.toFixed(2)} / ${env.payload.budget_allocated.toFixed(2)} budget remaining`, tone: "phase" };
    case "agent.started": return { title: `${env.payload.agent_role} started`, detail: env.payload.task_id, tone: "agent" };
    case "agent.finished": return { title: `${env.payload.agent_instance_id} finished (${env.payload.status})`, detail: env.payload.task_id, tone: env.payload.status === "success" ? "agent" : "error" };
    case "agent.handoff": return { title: `Handoff: ${env.payload.from_agent} → ${env.payload.to_agent}`, detail: env.payload.artifact_ref, tone: "agent" };
    case "tool.call": return { title: `tool.call ${env.payload.tool_name}`, detail: `[${env.payload.side_effect_tier}] ${env.payload.args_summary}`, tone: env.payload.side_effect_tier === "mutates-external" ? "warn" : "tool" };
    case "tool.result": return { title: `tool.result ${env.payload.status}`, detail: env.payload.summary, tone: env.payload.status === "ok" ? "tool" : "error" };
    case "critic.score": return { title: `critic score ${env.payload.score.toFixed(2)} (threshold ${env.payload.threshold})`, detail: `round ${env.payload.round}${env.payload.will_retry ? " · will retry" : ""}`, tone: env.payload.score >= env.payload.threshold ? "critic" : "warn" };
    case "budget.update": return { title: `Budget · ${phaseName(env.payload.phase)}`, detail: `spent ${env.payload.spent.toFixed(2)} / ${env.payload.allocated.toFixed(2)}`, tone: "budget" };
    case "error": return { title: "Runtime error", detail: env.payload.message, tone: "error" };
    default: return { title: env.type, detail: "", tone: "default" };
  }
}

type PendingQuestion = { gate_id: string; reason: string };
type ChatLine = { from: "swarm" | "you"; text: string };

export default function Dashboard() {
  const { activeSessionId, activeWsClient } = useSession();
  const [entries, setEntries] = useState<AnyEnvelope[]>([]);
  const [currentPhase, setCurrentPhase] = useState("Discovery");
  const [spent, setSpent] = useState(0);
  const [allocated, setAllocated] = useState(100);
  const [message, setMessage] = useState("");
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setEntries([]); setCurrentPhase("Discovery"); setSpent(0); setAllocated(100); setChat([]); setPendingQuestion(null);
    if (!activeWsClient) return;
    return activeWsClient.subscribe((env) => {
      if (env.type === "phase.transition") setCurrentPhase(phaseName(env.payload.to_phase));
      if (env.type === "budget.update") { setSpent((value) => Math.max(value, env.payload.spent)); setAllocated((value) => Math.max(value, env.payload.allocated)); }
      // A "question" gate is the swarm's real inbound human-input channel
      // (execapi/gate.go). Surface it as a chat line and open the input.
      if (env.type === "human_gate.pending" && env.payload.gate_kind === "question") {
        setPendingQuestion({ gate_id: env.payload.gate_id, reason: env.payload.reason });
        setChat((current) => [...current, { from: "swarm", text: env.payload.reason }]);
      }
      if (env.type === "human_gate.resolved") setPendingQuestion((current) => current && current.gate_id === env.payload.gate_id ? null : current);
      if (FEED_TYPES.has(env.type)) setEntries((current) => [...current, env]);
    });
  }, [activeSessionId, activeWsClient]);

  const progress = useMemo(() => Math.min(100, Math.max(0, allocated ? spent / allocated * 100 : 0)), [spent, allocated]);

  // The swarm only accepts human text as the answer to a pending "question"
  // gate — there is no free-form push-to-a-running-swarm channel in the core.
  // So the chat answers that gate when one is open; otherwise it waits.
  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text || !pendingQuestion || sending) return;
    setSending(true);
    try {
      await wailsClient.resolveGate(pendingQuestion.gate_id, text, "");
      setChat((current) => [...current, { from: "you", text }]);
      setMessage("");
      setPendingQuestion(null);
    } catch (error) {
      setChat((current) => [...current, { from: "swarm", text: `Could not send: ${String(error)}` }]);
    } finally {
      setSending(false);
    }
  };

  if (!activeSessionId) return null;
  return <div className="swarm-live">
    <div className="phase-pills">{PHASES.map((phase, index) => <span key={phase} className={`phase-pill ${phase === currentPhase ? "is-current" : index < PHASES.indexOf(currentPhase) ? "is-complete" : ""}`}>{phase}</span>)}</div>
    <div className="budget-row"><div className="budget-track"><span style={{ width: `${progress}%` }} /></div><strong>{spent.toFixed(2)} / {allocated.toFixed(2)}</strong></div>
    <div className="swarm-live__heading"><span>LIVE SESSION EVENTS</span><span className="live-indicator"><i /> {activeWsClient?.status ?? "offline"}</span></div>
    <div className="event-feed">
      {entries.map((env) => { const item = describe(env); return <article key={env.seq} className={`event-card event-card--${item.tone}`}><span className="event-card__line" /><div><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</div><time>{new Date(env.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></article>; })}
      {!entries.length && <div className="event-feed__empty">Waiting for swarm events…</div>}
    </div>
    {chat.length > 0 && <div className="swarm-chat__log">
      {chat.map((line, index) => <div key={index} className={`chat-line chat-line--${line.from}`}><span className="chat-line__who">{line.from === "swarm" ? "Swarm" : "You"}</span><span className="chat-line__text">{line.text}</span></div>)}
    </div>}
    <form className="swarm-chat" onSubmit={sendMessage}>
      <input value={message} onChange={(event) => setMessage(event.target.value)} disabled={!pendingQuestion || sending} placeholder={pendingQuestion ? "Answer the swarm…" : "Waiting — the swarm will ask here when it needs you"} aria-label="Message the swarm" />
      <button type="submit" disabled={!message.trim() || !pendingQuestion || sending}>{sending ? "Sending…" : "Send"}</button>
    </form>
    <p className="swarm-chat__hint">{pendingQuestion ? "The swarm is waiting for your reply." : "Two-way chat opens when the swarm asks a question (human_input). Approvals appear above."}</p>
  </div>;
}
