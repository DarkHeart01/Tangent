import { useCallback, useEffect, useState } from "react";
import MonacoEditor from "@monaco-editor/react";
import { useSession } from "../lib/SessionContext";
import { onEnvelopeType } from "../lib/wsClient";
import { useSettings } from "../lib/settings";
import * as wailsClient from "../lib/wailsClient";
import type { ArtifactEntry } from "../lib/wailsClient";

type TabKey = "document" | "openapi" | "asyncapi" | "ci";

const TAB_LABELS: Record<TabKey, string> = {
  document: "Document",
  openapi: "OpenAPI",
  asyncapi: "AsyncAPI",
  ci: "CI/CD Pipeline",
};

function tabsFor(artifact: ArtifactEntry): TabKey[] {
  // full_document (the whole CDD markdown) is always the primary view;
  // openapi_yaml/asyncapi_yaml/ci_pipeline_yaml are the only other
  // structured sub-documents that actually exist on a CDDContract — shown
  // only when non-empty. Everything else (examples, error contract,
  // compat rules, Specmatic config) is prose inside full_document itself,
  // not a separate field, so there's no tab for it.
  const tabs: TabKey[] = ["document"];
  if (artifact.openapi_yaml) tabs.push("openapi");
  if (artifact.asyncapi_yaml) tabs.push("asyncapi");
  if (artifact.ci_pipeline_yaml) tabs.push("ci");
  return tabs;
}

function contentFor(artifact: ArtifactEntry, tab: TabKey): { language: string; value: string } {
  switch (tab) {
    case "openapi": return { language: "yaml", value: artifact.openapi_yaml ?? "" };
    case "asyncapi": return { language: "yaml", value: artifact.asyncapi_yaml ?? "" };
    case "ci": return { language: "yaml", value: artifact.ci_pipeline_yaml ?? "" };
    default: return { language: "markdown", value: artifact.full_document ?? "" };
  }
}

export default function WalkthroughPanel() {
  const { activeSessionId, activeWsClient } = useSession();
  const settings = useSettings();
  const [contractId, setContractId] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ArtifactEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("document");

  const load = useCallback(async (sessionId: string, id: string) => {
    setLoading(true);
    setError(null);
    try {
      const entry = await wailsClient.getArtifact(sessionId, id);
      setArtifact(entry);
      setActiveTab("document");
    } catch (err) {
      setError(String(err));
      setArtifact(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setContractId(null);
    setArtifact(null);
    setError(null);
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeWsClient || !activeSessionId) return;
    // Only query after contract.emitted confirms the artifact write has
    // already landed in the ChromaDB registry — never poll or hold a
    // concurrent client into the same persist directory a live swarm
    // process may still be writing to.
    return onEnvelopeType(activeWsClient, "contract.emitted", (payload) => {
      setContractId(payload.contract_id);
      void load(activeSessionId, payload.contract_id);
    });
  }, [activeWsClient, activeSessionId, load]);

  if (!activeSessionId) {
    return <div className="walkthrough-panel walkthrough-panel--empty">Select or start a session to see its contracts.</div>;
  }
  if (!contractId) {
    return <div className="walkthrough-panel walkthrough-panel--empty">No contracts emitted yet.</div>;
  }
  if (loading && !artifact) {
    return <div className="walkthrough-panel walkthrough-panel--empty">Loading contract {contractId.slice(0, 8)}…</div>;
  }
  if (error) {
    return <div className="walkthrough-panel walkthrough-panel--empty">Could not load contract {contractId.slice(0, 8)}: {error}</div>;
  }
  if (!artifact) {
    return <div className="walkthrough-panel walkthrough-panel--empty">No contract data.</div>;
  }

  const tabs = tabsFor(artifact);
  const { language, value } = contentFor(artifact, activeTab);

  return (
    <div className="walkthrough-panel walkthrough-panel--doc">
      <div className="walkthrough-panel__header">
        <div className="walkthrough-panel__title">
          {artifact.artifact_type} <span className="walkthrough-panel__id">{artifact.id.slice(0, 8)}</span>
        </div>
        <div className="walkthrough-panel__meta">
          {artifact.consumer_service && artifact.provider_service && (
            <span>{artifact.consumer_service} → {artifact.provider_service}</span>
          )}
          <span className={`walkthrough-panel__status walkthrough-panel__status--${artifact.status}`}>{artifact.status}</span>
        </div>
      </div>
      <div className="walkthrough-tabs">
        {tabs.map((tab) => (
          <button key={tab} className={activeTab === tab ? "is-active" : ""} onClick={() => setActiveTab(tab)}>
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>
      <div className="walkthrough-panel__body">
        <MonacoEditor
          height="100%"
          language={language}
          value={value || `(empty — this contract has no ${TAB_LABELS[activeTab].toLowerCase()} content)`}
          theme={settings.theme === "light" ? "vs" : "vs-dark"}
          options={{ readOnly: true, minimap: { enabled: false }, fontSize: settings.editorFontSize, wordWrap: "on", scrollBeyondLastLine: false, automaticLayout: true }}
        />
      </div>
    </div>
  );
}
