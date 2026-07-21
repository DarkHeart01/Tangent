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
  const [answer, setAnswer] = useState("");

  useEffect(() => {
    setPending(null);
    setAnswer("");
    if (!activeWsClient) return;
    const unsubPending = onEnvelopeType(activeWsClient, "human_gate.pending", (payload) => {
      setPending(payload);
      setAnswer("");
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

  // decision is "approve"/"reject" for phase & tool_call gates, or the raw
  // free-text/selected-option answer for a "question" gate.
  const resolve = async (decision: string) => {
    if (!decision.trim()) return;
    setResolving(true);
    try {
      await wailsClient.resolveGate(pending.gate_id, decision, "");
      setPending(null);
      setAnswer("");
    } finally {
      setResolving(false);
    }
  };

  const isQuestion = pending.gate_kind === "question";
  const options = isQuestion ? parseOptions(pending.proposed_action) : [];

  return (
    <div className={`human-gate-banner human-gate-banner--${pending.gate_kind}`}>
      <div className="human-gate-banner__body">
        <div className="human-gate-banner__title">
          {isQuestion ? "The swarm is asking you" : `Human approval required — ${pending.phase}`}
        </div>
        <div className="human-gate-banner__reason">{pending.reason}</div>
        {!isQuestion && (
          <div className="human-gate-banner__action">
            Proposed action: <code>{pending.proposed_action}</code>
          </div>
        )}
      </div>

      {isQuestion ? (
        <div className="human-gate-banner__question">
          {options.length > 0 && (
            <div className="human-gate-banner__options">
              {options.map((option) => (
                <button key={option} disabled={resolving} onClick={() => void resolve(option)}>
                  {option}
                </button>
              ))}
            </div>
          )}
          <form
            className="human-gate-banner__answer"
            onSubmit={(event) => {
              event.preventDefault();
              void resolve(answer);
            }}
          >
            <input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Type your answer to the swarm…"
              aria-label="Answer to the swarm"
              autoFocus
            />
            <button type="submit" disabled={resolving || !answer.trim()}>
              Send
            </button>
          </form>
        </div>
      ) : (
        <div className="human-gate-banner__buttons">
          <button className="approve" disabled={resolving} onClick={() => void resolve("approve")}>
            Approve
          </button>
          <button className="reject" disabled={resolving} onClick={() => void resolve("reject")}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
