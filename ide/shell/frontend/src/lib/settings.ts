import { useEffect, useState } from "react";

// Lightweight, localStorage-backed settings store (VS Code-style). No provider
// needed: a module-level value + subscription so any component can read/react,
// and the values apply directly to Monaco, xterm, and the theme.
export type WordWrap = "off" | "on";

export type Settings = {
  theme: "dark" | "light";
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: WordWrap;
  editorMinimap: boolean;
  editorLineNumbers: boolean;
  terminalFontSize: number;
  // Live Code Intelligence Engine (ide/shell/internal/codeintel): off by
  // default until proven low-noise (spec §8's opt-in requirement) -- enabling
  // spawns a real typescript-language-server process per workspace.
  codeIntelEnabled: boolean;
  // Per-adapter toggle (spec §7) for the Tier B Python adapter specifically
  // -- only takes effect while codeIntelEnabled is also on. No subprocess
  // involved (regex + filesystem checks), so it defaults on.
  codeIntelPythonEnabled: boolean;
  // Cumulative intervention level: low = file-level only, mid = +folder,
  // high = +root, adaptive = starts at low and auto-escalates as
  // suggestions get accepted (see codeIntelAdaptiveProgress/effectiveLevel).
  codeIntelLevel: "low" | "mid" | "high" | "adaptive";
  // Adaptive-mode-only: accepted-suggestion counters per level, driving
  // escalation at 3 (see effectiveLevel). Not used in manual (non-adaptive) modes.
  codeIntelAdaptiveProgress: { low: number; mid: number };
  // File > Auto Save. Debounce-saves the active dirty tab (Editor.tsx) --
  // pure frontend, reuses the same save path Ctrl+S already calls.
  autoSaveEnabled: boolean;
  // Selection menu toggles -- real Monaco editor options (multiCursorModifier
  // / columnSelection), passed straight through to <MonacoEditor options>.
  editorMultiCursorModifier: "alt" | "ctrlCmd";
  editorColumnSelection: boolean;
  // View > Appearance > Zoom In/Out/Reset -- applied as a CSS zoom on #App
  // (App.css). WebView2 is Chromium-based, which supports the `zoom`
  // property directly, so this is real UI scaling, not a fake control.
  uiZoomLevel: number;
  // Customize Layout panel (AccessBar.tsx CustomizeLayout.tsx) -- real
  // visibility/position toggles, all applied directly in App.tsx/App.css.
  menuBarVisible: boolean;
  activityBarVisible: boolean;
  statusBarVisible: boolean;
  primarySideBarPosition: "left" | "right";
  quickInputPosition: "top" | "center";
  zenMode: boolean;
  centeredLayout: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  editorFontSize: 13,
  editorTabSize: 2,
  editorWordWrap: "off",
  editorMinimap: true,
  editorLineNumbers: true,
  terminalFontSize: 13,
  codeIntelEnabled: false,
  codeIntelPythonEnabled: true,
  codeIntelLevel: "low",
  codeIntelAdaptiveProgress: { low: 0, mid: 0 },
  autoSaveEnabled: false,
  editorMultiCursorModifier: "alt",
  editorColumnSelection: false,
  uiZoomLevel: 1,
  menuBarVisible: true,
  activityBarVisible: true,
  statusBarVisible: true,
  primarySideBarPosition: "left",
  quickInputPosition: "top",
  zenMode: false,
  centeredLayout: false,
};

export const ZOOM_STEP = 0.1;
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 2;

export const ADAPTIVE_ESCALATION_THRESHOLD = 3;

/** Maps the level setting to the numeric level (1/2/3) Go's Engine.SetLevel expects. */
export function effectiveLevel(settings: Settings): 1 | 2 | 3 {
  if (settings.codeIntelLevel === "low") return 1;
  if (settings.codeIntelLevel === "mid") return 2;
  if (settings.codeIntelLevel === "high") return 3;
  // adaptive
  const { low, mid } = settings.codeIntelAdaptiveProgress;
  if (low < ADAPTIVE_ESCALATION_THRESHOLD) return 1;
  if (mid < ADAPTIVE_ESCALATION_THRESHOLD) return 2;
  return 3;
}

const KEY = "tangent.ide.settings";

function load(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let current = load();
const listeners = new Set<(s: Settings) => void>();

export function applyTheme(theme: Settings["theme"]) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("theme-light", theme === "light");
}

export function getSettings(): Settings {
  return current;
}

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage may be unavailable; keep in-memory */
  }
  applyTheme(current.theme);
  for (const listener of listeners) listener(current);
}

export function resetSettings() {
  setSettings(DEFAULT_SETTINGS);
}

/**
 * Adaptive-mode bookkeeping: call whenever a suggestion is accepted. A no-op
 * outside adaptive mode. Counters are per-level and independent of the
 * *current* effective level -- accepting a Level 1 suggestion always grows
 * the "low" counter, which is what ungates Level 2 once it hits the
 * threshold (see effectiveLevel).
 */
export function recordAdaptiveAcceptance(acceptedLevel: 1 | 2 | 3) {
  if (current.codeIntelLevel !== "adaptive") return;
  const progress = { ...current.codeIntelAdaptiveProgress };
  if (acceptedLevel === 1 && progress.low < ADAPTIVE_ESCALATION_THRESHOLD) {
    progress.low += 1;
  } else if (acceptedLevel === 2 && progress.mid < ADAPTIVE_ESCALATION_THRESHOLD) {
    progress.mid += 1;
  }
  setSettings({ codeIntelAdaptiveProgress: progress });
}

export function subscribeSettings(listener: (s: Settings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Apply persisted theme immediately at module load, before first paint.
applyTheme(current.theme);

export function useSettings(): Settings {
  const [snapshot, setSnapshot] = useState(current);
  useEffect(() => subscribeSettings(setSnapshot), []);
  return snapshot;
}
