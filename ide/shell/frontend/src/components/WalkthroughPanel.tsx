import { useCallback, useEffect, useState } from "react";
import { useSession } from "../lib/SessionContext";
import { onEnvelopeType } from "../lib/wsClient";
import * as wailsClient from "../lib/wailsClient";
import type { ContractEntry } from "../lib/wailsClient";

const TIER_LABEL: Record<string, string> = {
  "read-only": "read-only",
  "mutates-local": "mutates local",
  "mutates-external": "mutates external",
};

export default function WalkthroughPanel() {
  const { activeSessionId, activeWsClient } = useSession();
  const [contracts, setContracts] = useState<ContractEntry[]>([]);

  const refresh = useCallback(async (sessionId: string) => {
    try {
      const entries = await wailsClient.getContracts(sessionId);
      setContracts(entries);
    } catch {
      setContracts([]);
    }
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setContracts([]);
      return;
    }
    refresh(activeSessionId);
  }, [activeSessionId, refresh]);

  useEffect(() => {
    if (!activeWsClient || !activeSessionId) return;
    return onEnvelopeType(activeWsClient, "contract.emitted", () => {
      refresh(activeSessionId);
    });
  }, [activeWsClient, activeSessionId, refresh]);

  if (!activeSessionId) {
    return <div className="walkthrough-panel walkthrough-panel--empty">Select or start a session to see its contracts.</div>;
  }

  if (contracts.length === 0) {
    return <div className="walkthrough-panel walkthrough-panel--empty">No contracts emitted yet.</div>;
  }

  return (
    <div className="walkthrough-panel">
      {contracts.map((c) => (
        <article key={c.contract_id} className="contract-card">
          <header className="contract-card__header">
            <span className="contract-card__phase">{c.phase}</span>
            <span className="contract-card__agent">{c.agent}</span>
            <span className={`contract-card__tier tier-${c.side_effect_tier}`}>{TIER_LABEL[c.side_effect_tier]}</span>
          </header>
          <p className="contract-card__intent">{c.intent}</p>
          <p className="contract-card__reasoning">{c.reasoning}</p>

          {c.diff_refs.length > 0 && (
            <div className="contract-card__section">
              <h4>Diffs</h4>
              <ul>
                {c.diff_refs.map((ref) => (
                  <li key={ref}>{ref}</li>
                ))}
              </ul>
            </div>
          )}

          {c.risks.length > 0 && (
            <div className="contract-card__section">
              <h4>Risks</h4>
              <ul>
                {c.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </div>
          )}

          {c.tests_run.length > 0 && (
            <div className="contract-card__section">
              <h4>Tests</h4>
              <ul>
                {c.tests_run.map((t) => (
                  <li key={t.name} className={t.passed ? "test-pass" : "test-fail"}>
                    {t.passed ? "✓" : "✗"} {t.name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <footer className="contract-card__footer">
            <span>{c.contract_id}</span>
            <span>{new Date(c.created_at).toLocaleString()}</span>
            {c.approved_by && <span>approved by {c.approved_by}</span>}
          </footer>
        </article>
      ))}
    </div>
  );
}
