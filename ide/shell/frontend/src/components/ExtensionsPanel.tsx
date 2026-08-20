type Extension = { name: string; publisher: string; description: string; rating: number; downloads: string; tone: string; letter: string };

// Presentational only — no real extension host/marketplace exists yet. The
// list is representative content sized to Tangent's own stack (Python swarm,
// Go shell, TS/React frontend) rather than a literal transcription of
// Figma's example screenshot, which listed unrelated Java/PHP tooling.
const EXTENSIONS: Extension[] = [
  { name: "Python", publisher: "ms-python", description: "IntelliSense, linting, debugging for Python", rating: 4.5, downloads: "148M", tone: "python", letter: "Py" },
  { name: "Python Debugger", publisher: "ms-python", description: "Debugger extension using debugpy", rating: 4.4, downloads: "55.3M", tone: "python", letter: "Py" },
  { name: "Go", publisher: "golang", description: "Rich language support for Go", rating: 4.6, downloads: "33.9M", tone: "go", letter: "Go" },
  { name: "Docker", publisher: "ms-azuretools", description: "Build, manage, and deploy containerized apps", rating: 4.3, downloads: "41.2M", tone: "docker", letter: "Do" },
  { name: "YAML", publisher: "redhat", description: "YAML language support with schema validation", rating: 4.4, downloads: "38.5M", tone: "yaml", letter: "Ym" },
  { name: "GitLens", publisher: "eamodio", description: "Supercharge Git within the editor", rating: 4.7, downloads: "29.8M", tone: "git", letter: "Gl" },
  { name: "Claude Code", publisher: "anthropic", description: "Anthropic's agentic coding assistant", rating: 4.8, downloads: "12.1M", tone: "claude", letter: "Cc" },
  { name: "Markdown All in One", publisher: "yzhang", description: "Markdown keyboard shortcuts, TOC, preview", rating: 4.6, downloads: "18.7M", tone: "markdown", letter: "Md" },
];

export default function ExtensionsPanel() {
  return (
    <>
      <div className="explorer-sidebar__header"><span>EXTENSIONS</span><button className="icon-button" title="Refresh"><span className="codicon codicon-refresh" /></button></div>
      <div className="extensions-panel">
        <div className="extensions-panel__search"><span className="codicon codicon-search" /><input placeholder="Search Extensions in Marketplace" disabled /><span className="codicon codicon-filter" /></div>
        <div className="extensions-panel__group">POPULAR</div>
        {EXTENSIONS.map((ext) => (
          <div className="extension-row" key={ext.name}>
            <span className={`extension-row__icon extension-row__icon--${ext.tone}`}>{ext.letter}</span>
            <div className="extension-row__body">
              <div className="extension-row__title">{ext.name}</div>
              <div className="extension-row__desc">{ext.description}</div>
              <div className="extension-row__meta">
                <span>{ext.publisher}</span>
                <span><span className="codicon codicon-star-full" /> {ext.rating}</span>
                <span><span className="codicon codicon-cloud-download" /> {ext.downloads}</span>
              </div>
            </div>
            <button className="extension-row__install" disabled title="Extension marketplace is not wired up yet">Install</button>
          </div>
        ))}
      </div>
    </>
  );
}
