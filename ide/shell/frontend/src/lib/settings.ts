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
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  editorFontSize: 13,
  editorTabSize: 2,
  editorWordWrap: "off",
  editorMinimap: true,
  editorLineNumbers: true,
  terminalFontSize: 13,
};

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
