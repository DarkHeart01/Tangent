import { useEffect, useState } from "react";
import { useSession } from "../lib/SessionContext";
import { onEnvelopeType } from "../lib/wsClient";
import type { HumanGatePending } from "../lib/contract";
import * as wailsClient from "../lib/wailsClient";

export default function HumanGateBanner() {
  const { activeSessionId, activeWsClient } = useSession();
  const [pending, setPending] = useState<HumanGatePending | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    setPending(null);
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
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="human-gate-banner">
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
