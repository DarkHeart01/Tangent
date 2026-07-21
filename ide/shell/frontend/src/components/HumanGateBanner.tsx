import { useEffect, useState } from "react";
import { useSession } from "../lib/SessionContext";
import { onEnvelopeType } from "../lib/wsClient";
import type { HumanGatePending } from "../lib/contract";
import * as wailsClient from "../lib/wailsClient";

export default function HumanGateBanner() {
  const { activeSessionId, activeWsClient } = useSession();
  const [pending, setPending] = useState<HumanGatePending | null>(null);
  const [resolving, setResolving] = useState(false);
  const [textAnswer, setTextAnswer] = useState("");
  const [selectedOption, setSelectedOption] = useState<string | null>(null);

  useEffect(() => {
    setPending(null);
    if (!activeWsClient) return;
    const unsubPending = onEnvelopeType(activeWsClient, "human_gate.pending", (payload) => {
      setPending(payload);
      setTextAnswer("");
      setSelectedOption(null);
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

  const resolve = async (decision: string) => {
    setResolving(true);
    try {
      await wailsClient.resolveGate(pending.gate_id, decision, "");
    } finally {
      setResolving(false);
    }
  };

  const isQuestion = pending.gate_kind === "question";
  const hasOptions = isQuestion && Array.isArray(pending.options) && pending.options.length > 0;

  return (
    <div className="human-gate-banner">
      <div className="human-gate-banner__body">
        <div className="human-gate-banner__title">
          {isQuestion ? "Question from the swarm" : `Human approval required — ${pending.phase}`}
        </div>
        {/* whiteSpace: pre-wrap — a question's reason is the real prompt
            text and may be several sentences across multiple lines; the
            existing approve/reject reason line is short enough that this
            has no visible effect there. */}
        <div className="human-gate-banner__reason" style={{ whiteSpace: "pre-wrap" }}>
          {pending.reason}
        </div>
        {!isQuestion && (
          <div className="human-gate-banner__action">
            Proposed action: <code>{pending.proposed_action}</code>
          </div>
        )}
        {isQuestion && hasOptions && (
          <div className="human-gate-banner__options">
            {pending.options!.map((opt) => (
              <label key={opt} className="human-gate-banner__option">
                <input
                  type="radio"
                  name={`gate-option-${pending.gate_id}`}
                  value={opt}
                  checked={selectedOption === opt}
                  onChange={() => setSelectedOption(opt)}
                  disabled={resolving}
                />
                {opt}
              </label>
            ))}
          </div>
        )}
        {isQuestion && !hasOptions && (
          <input
            className="human-gate-banner__text-input"
            type="text"
            value={textAnswer}
            onChange={(e) => setTextAnswer(e.target.value)}
            placeholder="Type your answer…"
            disabled={resolving}
          />
        )}
      </div>
      <div className="human-gate-banner__buttons">
        {isQuestion ? (
          <button
            className="approve"
            disabled={resolving || (hasOptions ? selectedOption === null : textAnswer.trim() === "")}
            onClick={() => resolve(hasOptions ? selectedOption! : textAnswer.trim())}
          >
            Submit
          </button>
        ) : (
          <>
            <button className="approve" disabled={resolving} onClick={() => resolve("approve")}>
              Approve
            </button>
            <button className="reject" disabled={resolving} onClick={() => resolve("reject")}>
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}
