import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as runtime from "../../../wailsjs/runtime/runtime";
import * as wailsClient from "../wailsClient";
import { useSettings, recordAdaptiveAcceptance } from "../settings";

// Hand-written types mirroring the JSON shape of the Go event structs in
// ide/shell/codeintel.go (codeintelDiagnosticsEvent/codeintelSuggestionEvent)
// -- event payloads aren't part of Wails' generated bindings (only bound
// method signatures are), so every native-event consumer in this codebase
// declares its own matching type (see Terminal.tsx's LocalOutput).
export interface CIEdgeEvent {
  id: string;
  from: string;
  to?: string;
  to_name: string;
  kind: string;
  cross_language: boolean;
  confidence: number;
  bridge_adapter?: string;
  resolution_state: string;
  file_path: string;
  span: { start_line: number; start_col: number; end_line: number; end_col: number };
  message?: string;
}

interface DiagnosticsEvent {
  file_path: string;
  edges: CIEdgeEvent[];
}

export interface SuggestedFile {
  path: string;
  proposed_content: string;
}

export interface SuggestionCard {
  batch_id: string;
  level: 1 | 2 | 3;
  file_path: string;
  description: string;
  edge?: CIEdgeEvent; // only present for Level 1 fix suggestions
  suggestion_id: string;
  explanation: string;
  files: SuggestedFile[];
}

interface CodeIntelContextValue {
  /** Mirrors settings.codeIntelEnabled -- read here so components don't need both hooks. */
  enabled: boolean;
  setEnabledForWorkspace: (root: string, enabled: boolean) => Promise<void>;
  /** Only ever holds dangling/resolution-failed edges -- resolved ones clear out. */
  diagnosticsByFile: Map<string, CIEdgeEvent[]>;
  diagnosticCount: number;
  suggestions: SuggestionCard[];
  acceptSuggestion: (id: string) => Promise<wailsClient.CodeIntelSuggestion>;
  rejectSuggestion: (id: string) => Promise<void>;
  dismissSuggestion: (id: string) => void;
}

const CodeIntelContext = createContext<CodeIntelContextValue | null>(null);

export function CodeIntelProvider({ children }: { children: ReactNode }) {
  const { codeIntelEnabled } = useSettings();
  const [diagnosticsByFile, setDiagnosticsByFile] = useState<Map<string, CIEdgeEvent[]>>(new Map());
  const [suggestions, setSuggestions] = useState<SuggestionCard[]>([]);
  // Mirrors `suggestions` for acceptSuggestion's adaptive-tracking lookup,
  // so that callback doesn't need to be recreated (and re-handed to every
  // consumer) on every suggestion list change.
  const suggestionsRef = useRef<SuggestionCard[]>([]);
  useEffect(() => { suggestionsRef.current = suggestions; }, [suggestions]);

  useEffect(() => {
    if (typeof (window as any).runtime?.EventsOn !== "function") return;

    const offDiagnostics = runtime.EventsOn("codeintel.diagnostics", (event: DiagnosticsEvent) => {
      setDiagnosticsByFile((prev) => {
        // Go's encoding/json marshals a nil slice as `null`, not `[]` -- a
        // file with zero edges must still round-trip cleanly (it's how a
        // previously-reported problem gets cleared). Go already sends `[]`
        // (see py_adapter.go's ExtractEdges), but defend here too rather
        // than depend on every future edge-producing path remembering that.
        const problems = (event.edges ?? []).filter(
          (e) => e.resolution_state === "dangling" || e.resolution_state === "resolution-failed",
        );
        const next = new Map(prev);
        if (problems.length === 0) {
          next.delete(event.file_path);
        } else {
          next.set(event.file_path, problems);
        }
        return next;
      });
    });

    const offSuggestion = runtime.EventsOn("codeintel.suggestion", (event: SuggestionCard) => {
      setSuggestions((prev) => [...prev, event]);
    });

    return () => {
      offDiagnostics?.();
      offSuggestion?.();
    };
  }, []);

  const setEnabledForWorkspace = useCallback(async (root: string, next: boolean) => {
    await wailsClient.codeIntelSetEnabled(next, root);
    if (!next) {
      setDiagnosticsByFile(new Map());
      setSuggestions([]);
    }
  }, []);

  const dismissSuggestion = useCallback((id: string) => {
    setSuggestions((prev) => prev.filter((s) => s.suggestion_id !== id));
  }, []);

  const acceptSuggestion = useCallback(
    async (id: string) => {
      const applied = await wailsClient.codeIntelAcceptSuggestion(id);
      const card = suggestionsRef.current.find((s) => s.suggestion_id === id);
      if (card) recordAdaptiveAcceptance(card.level);
      dismissSuggestion(id);
      return applied;
    },
    [dismissSuggestion],
  );

  const rejectSuggestion = useCallback(
    async (id: string) => {
      await wailsClient.codeIntelRejectSuggestion(id);
      dismissSuggestion(id);
    },
    [dismissSuggestion],
  );

  const diagnosticCount = useMemo(
    () => Array.from(diagnosticsByFile.values()).reduce((sum, edges) => sum + edges.length, 0),
    [diagnosticsByFile],
  );

  const value = useMemo<CodeIntelContextValue>(
    () => ({
      enabled: codeIntelEnabled,
      setEnabledForWorkspace,
      diagnosticsByFile,
      diagnosticCount,
      suggestions,
      acceptSuggestion,
      rejectSuggestion,
      dismissSuggestion,
    }),
    [codeIntelEnabled, setEnabledForWorkspace, diagnosticsByFile, diagnosticCount, suggestions, acceptSuggestion, rejectSuggestion, dismissSuggestion],
  );

  return <CodeIntelContext.Provider value={value}>{children}</CodeIntelContext.Provider>;
}

export function useCodeIntel(): CodeIntelContextValue {
  const ctx = useContext(CodeIntelContext);
  if (!ctx) throw new Error("useCodeIntel must be used within a CodeIntelProvider");
  return ctx;
}
