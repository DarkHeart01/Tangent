import { useEffect, useMemo, useRef, useState } from "react";
import { describeEnvelope, useSwarmSession } from "../lib/useSwarmSession";
import { onEnvelopeType } from "../lib/wsClient";
import type { AnyEnvelope } from "../lib/contract";
import type { ChatLine } from "../lib/useSwarmSession";

type TimelineItem = { key: string; ts: number } & (
  | { kind: "event"; env: AnyEnvelope }
  | { kind: "chat"; line: ChatLine }
);

// The Agents page's chat panel, restyled as real chat bubbles (per the
// user's request for a Claude/ChatGPT-style feel) over the *same* data and
// the *same* real constraint Dashboard.tsx's compact log view has always had:
// the swarm's only inbound human-text channel is answering a pending
// "question" gate (execapi/gate.go) -- there's no free-form
// push-to-a-running-swarm channel in the core, so the composer only ever
// resolves that gate. Technical events (tool calls, phase transitions, agent
// handoffs) render as compact inline system rows in the same timeline rather
// than being hidden, so nothing real is lost in the reskin -- see
// useSwarmSession.ts, shared with Dashboard.tsx so both views stay in sync.
export default function AgentsChatTranscript() {
  const { entries, currentPhase, spent, allocated, progress, chat, pendingQuestion, sending, sendMessage, activeWsClient } = useSwarmSession();
  const [message, setMessage] = useState("");
  const [currentAgent, setCurrentAgent] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrentAgent(null);
    if (!activeWsClient) return;
    const offStart = onEnvelopeType(activeWsClient, "agent.started", (payload) => setCurrentAgent(payload.agent_role));
    const offFinish = onEnvelopeType(activeWsClient, "agent.finished", () => setCurrentAgent(null));
    return () => { offStart(); offFinish(); };
  }, [activeWsClient]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const events: TimelineItem[] = entries.map((env) => ({ kind: "event", env, key: `e${env.seq}`, ts: new Date(env.ts).getTime() }));
    const lines: TimelineItem[] = chat.map((line, index) => ({ kind: "chat", line, key: `c${index}`, ts: line.ts }));
    return [...events, ...lines].sort((a, b) => a.ts - b.ts);
  }, [entries, chat]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [timeline.length]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    await sendMessage(message);
    setMessage("");
  };

  return (
    <div className="agent-chat">
      <div className="agent-chat__header">
        <div className="agent-chat__phase">Phase: <strong>{currentPhase}</strong></div>
        <div className="budget-track agent-chat__budget"><span style={{ width: `${progress}%` }} /></div>
        <span className="agent-chat__budget-label">{spent.toFixed(2)} / {allocated.toFixed(2)}</span>
        <span className="live-indicator"><i /> {activeWsClient?.status ?? "offline"}</span>
      </div>
      <div className="agent-chat__scroll" ref={scrollRef}>
        {timeline.length === 0 && <div className="agent-chat__empty">Waiting for the swarm to start working…</div>}
        {timeline.map((item) => {
          if (item.kind === "chat") {
            const mine = item.line.from === "you";
            return (
              <div key={item.key} className={`chat-bubble-row ${mine ? "is-mine" : ""}`}>
                <div className={`chat-bubble ${mine ? "chat-bubble--you" : "chat-bubble--swarm"}`}>
                  {!mine && <span className="chat-bubble__who"><span className="codicon codicon-hubot" /> Swarm asks</span>}
                  <p>{item.line.text}</p>
                </div>
              </div>
            );
          }
          const info = describeEnvelope(item.env);
          return (
            <div key={item.key} className={`agent-chat__system agent-chat__system--${info.tone}`} title={info.detail}>
              <span className="agent-chat__system-dot" />
              <span className="agent-chat__system-title">{info.title}</span>
              {info.detail && <span className="agent-chat__system-detail">{info.detail}</span>}
              <time>{new Date(item.env.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </div>
          );
        })}
      </div>
      {currentAgent && <div className="agent-chat__current"><span className="codicon codicon-pulse" /> Current Agent: {currentAgent}</div>}
      <form className="agent-chat__composer" onSubmit={submit}>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={!pendingQuestion || sending}
          placeholder={pendingQuestion ? "Answer the swarm……" : "Waiting — the swarm will ask here when it needs you"}
          aria-label="Message the swarm"
          rows={1}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(event); } }}
        />
        <button type="submit" disabled={!message.trim() || !pendingQuestion || sending} title="Send"><span className="codicon codicon-send" /></button>
      </form>
      <p className="agent-chat__hint">{pendingQuestion ? "The swarm is waiting for your reply." : "The input opens when the swarm asks a question. Approvals appear as gate cards above."}</p>
    </div>
  );
}
