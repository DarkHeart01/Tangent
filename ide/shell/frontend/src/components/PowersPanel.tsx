type Power = { name: string; publisher: string; description: string; tone: string; letter: string };

// Presentational only, per Figma's "Powers" screen — a marketplace of
// installable swarm capabilities. No install/runtime backend exists yet.
const AVAILABLE: Power[] = [
  { name: "API Testing with Postman", publisher: "Postman", description: "Automate API testing and collections", tone: "postman", letter: "Pm" },
  { name: "AWS Transform", publisher: "AWS", description: "Migrate, modernize, and upgrade cloud infra", tone: "aws", letter: "Aw" },
  { name: "Design to Code with Figma", publisher: "Figma", description: "Comprehensive Figma integration for handoff", tone: "figma", letter: "Fg" },
  { name: "Miro Board Context", publisher: "Miro", description: "Uses Miro boards as a source of truth", tone: "miro", letter: "Mi" },
];

export default function PowersPanel() {
  return (
    <>
      <div className="explorer-sidebar__header"><span>POWERS</span></div>
      <div className="powers-panel">
        <section className="agents-panel__section">
          <div className="agents-panel__heading"><span>INSTALLED</span></div>
          <div className="power-row">
            <span className="extension-row__icon extension-row__icon--accent"><span className="codicon codicon-add" /></span>
            <div className="extension-row__body">
              <div className="extension-row__title">Add Custom Power</div>
              <div className="extension-row__desc">Import from url, folder, or build your own</div>
            </div>
          </div>
        </section>
        <section className="agents-panel__section">
          <div className="agents-panel__heading"><span>AVAILABLE</span></div>
          {AVAILABLE.map((power) => (
            <div className="power-row" key={power.name}>
              <span className={`extension-row__icon extension-row__icon--${power.tone}`}>{power.letter}</span>
              <div className="extension-row__body">
                <div className="extension-row__title">{power.name}</div>
                <div className="extension-row__desc">{power.description}</div>
                <div className="extension-row__meta"><span>by {power.publisher}</span></div>
              </div>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
