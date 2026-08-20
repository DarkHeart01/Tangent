import { useEffect, useMemo, useState } from "react";
import { useSession } from "./SessionContext";
import * as wailsClient from "./wailsClient";
import type { AnyEnvelope } from "./contract";

export const PHASES = ["Discovery", "Planning", "Architecture", "Repo Discovery", "Contracting", "Build", "Quality", "Deploy + Monitor"];
const PHASE_MAP: Record<string, string> = { discovery: "Discovery", planning: "Planning", architecture: "Architecture", repo_discovery: "Repo Discovery", contracting: "Contracting", test_planning: "Build", build: "Build", documentation_generation: "Build", live_test: "Quality", quality: "Quality", dependency_audit: "Quality", performance_testing: "Quality", release_preparation: "Deploy + Monitor", deployment: "Deploy + Monitor", post_launch: "Deploy + Monitor", implementation: "Build", verification: "Quality" };
const FEED_TYPES = new Set<AnyEnvelope["type"]>(["phase.transition", "agent.started", "agent.finished", "agent.handoff", "tool.call", "tool.result", "critic.score", "budget.update", "error"]);

export function phaseName(value: string | null | undefined) { return PHASE_MAP[value ?? ""] ?? value ?? "Discovery"; }

export function describeEnvelope(env: AnyEnvelope) {
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

export type PendingQuestion = { gate_id: string; reason: string };
export type ChatLine = { from: "swarm" | "you"; text: string; ts: number };

// Shared by Dashboard.tsx (IDE sidebar's compact log view) and
// AgentsChatTranscript.tsx (the Agents page's chat-bubble view) -- same
// underlying data and the same real constraint either way: the swarm's only
// inbound human-text channel is answering a pending "question" gate
// (execapi/gate.go); there is no free-form push-to-a-running-swarm channel
// in the core, so sendMessage only ever resolves that gate.
export function useSwarmSession() {
  const { activeSessionId, activeWsClient } = useSession();
  const [entries, setEntries] = useState<AnyEnvelope[]>([]);
  const [currentPhase, setCurrentPhase] = useState("Discovery");
  const [spent, setSpent] = useState(0);
  const [allocated, setAllocated] = useState(100);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setEntries([]); setCurrentPhase("Discovery"); setSpent(0); setAllocated(100); setChat([]); setPendingQuestion(null);
    if (!activeWsClient) return;
    return activeWsClient.subscribe((env) => {
      if (env.type === "phase.transition") setCurrentPhase(phaseName(env.payload.to_phase));
      if (env.type === "budget.update") { setSpent((value) => Math.max(value, env.payload.spent)); setAllocated((value) => Math.max(value, env.payload.allocated)); }
      if (env.type === "human_gate.pending" && env.payload.gate_kind === "question") {
        setPendingQuestion({ gate_id: env.payload.gate_id, reason: env.payload.reason });
        setChat((current) => [...current, { from: "swarm", text: env.payload.reason, ts: Date.now() }]);
      }
      if (env.type === "human_gate.resolved") setPendingQuestion((current) => current && current.gate_id === env.payload.gate_id ? null : current);
      if (FEED_TYPES.has(env.type)) setEntries((current) => [...current, env]);
    });
  }, [activeSessionId, activeWsClient]);

  const progress = useMemo(() => Math.min(100, Math.max(0, allocated ? spent / allocated * 100 : 0)), [spent, allocated]);

  // Lets the status bar show a compact context/budget meter regardless of
  // which page/component is currently mounted — same window-event pattern
  // SourceControl already uses to publish git status to outside listeners.
  useEffect(() => {
    if (!activeSessionId) { window.dispatchEvent(new CustomEvent("tangent:session-budget", { detail: null })); return; }
    window.dispatchEvent(new CustomEvent("tangent:session-budget", { detail: { spent, allocated, progress } }));
  }, [activeSessionId, spent, allocated, progress]);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !pendingQuestion || sending) return;
    setSending(true);
    try {
      await wailsClient.resolveGate(pendingQuestion.gate_id, trimmed, "");
      setChat((current) => [...current, { from: "you", text: trimmed, ts: Date.now() }]);
      setPendingQuestion(null);
    } catch (error) {
      setChat((current) => [...current, { from: "swarm", text: `Could not send: ${String(error)}`, ts: Date.now() }]);
    } finally {
      setSending(false);
    }
  };

  return { activeSessionId, activeWsClient, entries, currentPhase, spent, allocated, progress, chat, pendingQuestion, sending, sendMessage };
}
