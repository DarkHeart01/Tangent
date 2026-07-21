import { useEffect, useState } from "react";
import { useSession } from "../lib/SessionContext";
import { onEnvelopeType } from "../lib/wsClient";
import type { HumanGatePending } from "../lib/contract";
import * as wailsClient from "../lib/wailsClient";

// A "question" gate carries its choices in proposed_action as "Options: a, b, c"
// (see execapi/gate.go). Pull them back out so we can render real buttons.
function parseOptions(proposedAction: string): string[] {
  const prefix = "Options: ";
  if (!proposedAction.startsWith(prefix)) return [];
  return proposedAction
    .slice(prefix.length)
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean);
}

export default function HumanGateBanner() {
  const { activeSessionId, activeWsClient } = useSession();
  const [pending, setPending] = useState<HumanGatePending | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    setPending(null);
    setAnswer("");
    if (!activeWsClient) return;
    const unsubPending = onEnvelopeType(activeWsClient, "human_gate.pending", (payload) => {
      setPending(payload);
    });
    const unsubResolved = onEnvelopeType(activeWsClient, "human_gate.resolved", () => {
      setPending(null);
    });
    return () => {
      unsubPending();
      unsubResolved();
    };
  }, [activeSessionId, activeWsClient]);

  if (!pending) return null;

  const decide = async (decision: "approve" | "reject") => {
    setResolving(true);
    try {
      await wailsClient.resolveGate(pending.gate_id, decision, "");
      setPending(null);
      setAnswer("");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className={`human-gate-banner human-gate-banner--${pending.gate_kind}`}>
      <div className="human-gate-banner__body">
        <div className="human-gate-banner__title">Human approval required — {pending.phase}</div>
        <div className="human-gate-banner__reason">{pending.reason}</div>
        <div className="human-gate-banner__action">
          Proposed action: <code>{pending.proposed_action}</code>
        </div>
      </div>
      <div className="human-gate-banner__buttons">
        <button className="approve" disabled={resolving} onClick={() => decide("approve")}>
          Approve
        </button>
        <button className="reject" disabled={resolving} onClick={() => decide("reject")}>
          Reject
        </button>
      </div>
    </div>
  );
}
