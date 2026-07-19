import { useEffect, useState } from "react";
import { useSession } from "../lib/SessionContext";
import type { AnyEnvelope } from "../lib/contract";

const TIMELINE_TYPES = new Set<AnyEnvelope["type"]>([
  "phase.transition",
  "agent.started",
  "agent.finished",
  "agent.handoff",
  "tool.call",
  "tool.result",
  "critic.score",
  "budget.update",
]);

function describe(env: AnyEnvelope): { title: string; detail: string; tone: string } {
  switch (env.type) {
    case "phase.transition":
      return {
        title: `Phase: ${env.payload.from_phase ?? "∅"} → ${env.payload.to_phase}`,
        detail: `budget ${env.payload.budget_remaining.toFixed(2)} / ${env.payload.budget_allocated.toFixed(2)}`,
        tone: "phase",
      };
    case "agent.started":
      return { title: `${env.payload.agent_role} started`, detail: env.payload.task_id, tone: "agent" };
    case "agent.finished":
      return {
        title: `${env.payload.agent_instance_id} finished (${env.payload.status})`,
        detail: env.payload.task_id,
        tone: env.payload.status === "success" ? "agent" : "error",
      };
    case "agent.handoff":
      return {
        title: `Handoff: ${env.payload.from_agent} → ${env.payload.to_agent}`,
        detail: env.payload.artifact_ref,
        tone: "agent",
      };
    case "tool.call":
      return {
        title: `tool.call ${env.payload.tool_name} [${env.payload.side_effect_tier}]`,
        detail: env.payload.args_summary,
        tone: env.payload.side_effect_tier === "mutates-external" ? "warn" : "tool",
      };
    case "tool.result":
      return {
        title: `tool.result ${env.payload.status}`,
        detail: env.payload.summary,
        tone: env.payload.status === "ok" ? "tool" : "error",
      };
    case "critic.score":
      return {
        title: `critic score ${env.payload.score.toFixed(2)} (threshold ${env.payload.threshold})`,
        detail: `round ${env.payload.round}${env.payload.will_retry ? " · will retry" : ""}`,
        tone: env.payload.score >= env.payload.threshold ? "critic" : "warn",
      };
    case "budget.update":
      return {
        title: `Budget · ${env.payload.phase}`,
        detail: `spent ${env.payload.spent.toFixed(2)} / ${env.payload.allocated.toFixed(2)}`,
        tone: "budget",
      };
    default:
      return { title: env.type, detail: "", tone: "default" };
  }
}

export default function Dashboard() {
  const { activeSessionId, activeWsClient } = useSession();
  const [entries, setEntries] = useState<AnyEnvelope[]>([]);

  useEffect(() => {
    setEntries([]);
    if (!activeWsClient) return;
    const unsubscribe = activeWsClient.subscribe((env) => {
      if (TIMELINE_TYPES.has(env.type)) {
        setEntries((prev) => [...prev, env]);
      }
    });
    return unsubscribe;
  }, [activeSessionId, activeWsClient]);

  if (!activeSessionId) {
    return <div className="dashboard-panel dashboard-panel--empty">Select or start a session to see its timeline.</div>;
  }

  return (
    <div className="dashboard-panel">
      <ol className="dashboard-timeline">
        {entries.map((env) => {
          const { title, detail, tone } = describe(env);
          return (
            <li key={env.seq} className={`dashboard-timeline__item tone-${tone}`}>
              <span className="dashboard-timeline__seq">#{env.seq}</span>
              <span className="dashboard-timeline__title">{title}</span>
              {detail && <span className="dashboard-timeline__detail">{detail}</span>}
            </li>
          );
        })}
        {entries.length === 0 && <li className="dashboard-timeline__empty">Waiting for events…</li>}
      </ol>
    </div>
  );
}
