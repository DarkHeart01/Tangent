import { useState } from "react";
import { useSettings, setSettings, resetSettings, effectiveLevel, ADAPTIVE_ESCALATION_THRESHOLD, type Settings } from "../lib/settings";
import { useWorkspace } from "../lib/WorkspaceContext";
import * as wailsClient from "../lib/wailsClient";

function Row({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="settings-row">
    <div className="settings-row__label"><strong>{title}</strong><span>{description}</span></div>
    <div className="settings-row__control">{children}</div>
  </div>;
}

function NumberField({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return <input type="number" min={min} max={max} value={value} onChange={(event) => {
    const next = Number(event.target.value);
    if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
  }} />;
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" className={`settings-toggle ${value ? "is-on" : ""}`} role="switch" aria-checked={value} onClick={() => onChange(!value)}>
    <span className="settings-toggle__knob" />
  </button>;
}

const LEVEL_LABELS: Record<Settings["codeIntelLevel"], string> = {
  low: "Low — file-level only",
  mid: "Mid — file + folder-level",
  high: "High — file + folder + root-level",
  adaptive: "Adaptive — starts low, unlocks more as you accept suggestions",
};

export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const settings = useSettings();
  const { workspace } = useWorkspace();
  const [scanState, setScanState] = useState<"idle" | "scanning" | "done" | "error">("idle");
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings({ [key]: value } as Partial<Settings>);
  const level = effectiveLevel(settings);

  const runScan = async () => {
    if (!workspace?.rootPath) return;
    setScanState("scanning");
    try {
      await wailsClient.codeIntelScanProject(workspace.rootPath);
      setScanState("done");
    } catch {
      setScanState("error");
    }
  };

  return <div className="settings-page">
    <div className="settings-page__header">
      <div><h1>Settings</h1><p>Preferences are saved on this machine and apply immediately.</p></div>
      <button className="settings-page__close" onClick={onClose} title="Close settings">×</button>
    </div>
    <div className="settings-page__body">
      <section>
        <h2>Appearance</h2>
        <Row title="Color Theme" description="Overall color theme for the workbench and editor.">
          <select value={settings.theme} onChange={(event) => set("theme", event.target.value as Settings["theme"])}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </Row>
      </section>

      <section>
        <h2>Editor</h2>
        <Row title="Font Size" description="Controls the editor font size in pixels.">
          <NumberField value={settings.editorFontSize} min={8} max={40} onChange={(n) => set("editorFontSize", n)} />
        </Row>
        <Row title="Tab Size" description="The number of spaces a tab is equal to.">
          <NumberField value={settings.editorTabSize} min={1} max={8} onChange={(n) => set("editorTabSize", n)} />
        </Row>
        <Row title="Word Wrap" description="Wrap long lines to the editor width.">
          <Toggle value={settings.editorWordWrap === "on"} onChange={(v) => set("editorWordWrap", v ? "on" : "off")} />
        </Row>
        <Row title="Minimap" description="Show the code overview minimap on the right.">
          <Toggle value={settings.editorMinimap} onChange={(v) => set("editorMinimap", v)} />
        </Row>
        <Row title="Line Numbers" description="Show line numbers in the gutter.">
          <Toggle value={settings.editorLineNumbers} onChange={(v) => set("editorLineNumbers", v)} />
        </Row>
      </section>

      <section>
        <h2>Terminal</h2>
        <Row title="Font Size" description="Controls the integrated terminal font size in pixels.">
          <NumberField value={settings.terminalFontSize} min={8} max={40} onChange={(n) => set("terminalFontSize", n)} />
        </Row>
      </section>

      <section>
        <h2>Code Intelligence</h2>
        <Row title="Live Code Intelligence" description="Detect broken imports and calls as you type and suggest fixes to review. Off by default; spawns a language server for the open workspace when enabled. Requires a folder opened via Open Folder (not a browser-only workspace).">
          <Toggle value={settings.codeIntelEnabled} onChange={(v) => set("codeIntelEnabled", v)} />
        </Row>
        <Row title="Python support (best-effort)" description="Tier B: detects unresolved local imports via filesystem checks, not a real Python language server -- no type checking. Only takes effect while Live Code Intelligence is on.">
          <Toggle value={settings.codeIntelPythonEnabled} onChange={(v) => set("codeIntelPythonEnabled", v)} />
        </Row>
        <Row title="Intervention level" description="Cumulative: each level adds scope on top of the last. File-level always includes inline ghost-text completion and fixes for broken references.">
          <select value={settings.codeIntelLevel} onChange={(event) => set("codeIntelLevel", event.target.value as Settings["codeIntelLevel"])}>
            {(Object.keys(LEVEL_LABELS) as Settings["codeIntelLevel"][]).map((key) => (
              <option key={key} value={key}>{LEVEL_LABELS[key]}</option>
            ))}
          </select>
        </Row>
        {settings.codeIntelLevel === "adaptive" && (
          <Row title="Adaptive progress" description="Escalates automatically as you accept suggestions -- no action needed here.">
            <span className="settings-adaptive-progress">
              {level === 1 && `${settings.codeIntelAdaptiveProgress.low}/${ADAPTIVE_ESCALATION_THRESHOLD} accepted to unlock folder-level`}
              {level === 2 && `${settings.codeIntelAdaptiveProgress.mid}/${ADAPTIVE_ESCALATION_THRESHOLD} accepted to unlock root-level`}
              {level === 3 && "All levels unlocked"}
            </span>
          </Row>
        )}
        <Row title="Scan Project" description="Root-level (Level 3): detects environment variables used in the codebase and proposes a .env.example covering them. Requires Level 3 (High or escalated Adaptive) and a folder opened via Open Folder.">
          <button
            className="text-button"
            disabled={level < 3 || !workspace?.backendRoot || scanState === "scanning"}
            onClick={() => void runScan()}
          >
            {scanState === "scanning" ? "Scanning…" : scanState === "done" ? "Scanned ✓" : scanState === "error" ? "Scan failed — retry" : "Scan Project"}
          </button>
        </Row>
      </section>

      <section>
        <button className="settings-page__reset" onClick={() => resetSettings()}>Reset all settings to defaults</button>
      </section>
    </div>
  </div>;
}
