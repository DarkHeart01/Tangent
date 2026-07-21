import { useSettings, setSettings, resetSettings, type Settings } from "../lib/settings";

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

export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const settings = useSettings();
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings({ [key]: value } as Partial<Settings>);

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
        <button className="settings-page__reset" onClick={() => resetSettings()}>Reset all settings to defaults</button>
      </section>
    </div>
  </div>;
}
