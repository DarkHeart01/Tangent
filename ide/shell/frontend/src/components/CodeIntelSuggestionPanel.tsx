import { useState } from "react";
import { DiffEditor as MonacoDiffEditor } from "@monaco-editor/react";
import { useCodeIntel, type SuggestionCard } from "../lib/codeintel/CodeIntelContext";
import * as wailsClient from "../lib/wailsClient";
import { useWorkspace } from "../lib/WorkspaceContext";
import { useSettings } from "../lib/settings";

const LEVEL_LABELS: Record<1 | 2 | 3, string> = { 1: "File", 2: "Folder", 3: "Project" };

function languageForDiff(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "tsx") return "typescript";
  if (ext === "ts") return "typescript";
  if (ext === "jsx" || ext === "js") return "javascript";
  return "plaintext";
}

// Floating suggestion queue (spec §8: always diff-preview -> accept/reject,
// never a silent write) + the multi-file diff-preview modal it opens into.
// Mounted once at the Shell level so a suggestion surfaces regardless of
// which bottom-panel tab or file is currently focused -- these are meant to
// read as occasional, dismissable notifications, not a panel you go looking
// for, matching the spec's "non-interrupting popup" framing for individual
// resolutions within a batch.
export default function CodeIntelSuggestionPanel() {
  const { suggestions, acceptSuggestion, rejectSuggestion, dismissSuggestion } = useCodeIntel();
  const { workspace } = useWorkspace();
  const settings = useSettings();
  const [previewing, setPreviewing] = useState<SuggestionCard | null>(null);
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  if (suggestions.length === 0) return null;

  const openPreview = async (card: SuggestionCard) => {
    setPreviewError(null);
    if (!workspace?.rootPath) {
      setPreviewError("No workspace open.");
      return;
    }
    try {
      const loaded: Record<string, string> = {};
      for (const file of card.files) {
        try {
          const existing = await wailsClient.readWorkspaceFile(workspace.rootPath, file.path);
          loaded[file.path] = existing.content;
        } catch {
          loaded[file.path] = ""; // new file -- diff against empty
        }
      }
      setOriginals(loaded);
      setPreviewing(card);
    } catch (err) {
      setPreviewError(String(err));
    }
  };

  const accept = async (id: string) => {
    setBusy(true);
    try {
      await acceptSuggestion(id);
      setPreviewing(null);
    } catch (err) {
      setPreviewError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id: string) => {
    setBusy(true);
    try {
      await rejectSuggestion(id);
      setPreviewing(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="codeintel-suggestions">
        {suggestions.map((card) => (
          <article key={card.suggestion_id} className="event-card codeintel-suggestion-card">
            <div className="event-card__line" />
            <div className="codeintel-suggestion-card__body">
              <strong>
                <span className={`codeintel-level-badge codeintel-level-badge--${card.level}`}>{LEVEL_LABELS[card.level]}</span>
                {card.edge ? `Unresolved reference: ${card.edge.to_name}` : card.description}
              </strong>
              <small>{card.explanation || "No explanation returned."}</small>
              <span className="codeintel-suggestion-card__meta">
                {card.files.length} file{card.files.length === 1 ? "" : "s"} · {card.file_path}
                {card.edge?.cross_language && (
                  <span className="problems-list__confidence" title={`Cross-language match via ${card.edge.bridge_adapter ?? "unknown adapter"}`}>
                    {card.edge.bridge_adapter === "openapi-schema" ? "schema" : card.edge.bridge_adapter ?? "bridge"} · {Math.round(card.edge.confidence * 100)}%
                  </span>
                )}
              </span>
            </div>
            <div className="codeintel-suggestion-card__actions">
              <button className="text-button" onClick={() => void openPreview(card)}>Preview</button>
              <button className="icon-button" title="Dismiss" aria-label="Dismiss" onClick={() => dismissSuggestion(card.suggestion_id)}>×</button>
            </div>
          </article>
        ))}
      </div>

      {previewing && (
        <div className="codeintel-diff-modal__backdrop" onClick={() => setPreviewing(null)}>
          <div className="codeintel-diff-modal" onClick={(e) => e.stopPropagation()}>
            <div className="codeintel-diff-modal__header">
              <strong>{previewing.explanation || "Suggested fix"}</strong>
              <button className="icon-button" onClick={() => setPreviewing(null)} title="Close">×</button>
            </div>
            <div className="codeintel-diff-modal__body">
              {previewing.files.map((file) => (
                <div key={file.path} className="codeintel-diff-modal__file">
                  <div className="diff-toolbar"><strong>{file.path}</strong></div>
                  <MonacoDiffEditor
                    height="280px"
                    language={languageForDiff(file.path)}
                    theme={settings.theme === "light" ? "vs" : "vs-dark"}
                    original={originals[file.path] ?? ""}
                    modified={file.proposed_content}
                    options={{ renderSideBySide: true, readOnly: true, minimap: { enabled: false }, fontSize: settings.editorFontSize, scrollBeyondLastLine: false }}
                  />
                </div>
              ))}
              {previewError && <div className="editor-inline-error">{previewError}</div>}
            </div>
            <div className="codeintel-diff-modal__footer">
              <button className="codeintel-diff-modal__reject" disabled={busy} onClick={() => void reject(previewing.suggestion_id)}>Reject</button>
              <button className="codeintel-diff-modal__accept" disabled={busy} onClick={() => void accept(previewing.suggestion_id)}>
                {busy ? "Applying…" : "Accept"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
