// Presentational only, per Figma's "Agents" screen — deliberately rebranded
// from the source design's leftover "KIRO" label to Tangent's own name. Does
// not pull the swarm's real agents/*/spec.yaml roster; that's a separate,
// larger piece of backend wiring out of scope for this pass.
export default function AgentsPanel() {
  return (
    <>
      <div className="explorer-sidebar__header"><span>AGENTS</span></div>
      <div className="agents-panel">
        <section className="agents-panel__section">
          <div className="agents-panel__heading"><span>SPECS</span><button className="icon-button" title="New Spec"><span className="codicon codicon-add" /></button></div>
          <div className="agents-panel__card">
            <p>Create a project plan to develop complex features and services</p>
            <button className="start-session-button" disabled title="Spec authoring isn't wired up yet">+ Create New Spec</button>
          </div>
        </section>
        <section className="agents-panel__section">
          <div className="agents-panel__heading"><span>AGENT HOOKS</span><button className="icon-button" title="New Hook"><span className="codicon codicon-add" /></button></div>
          <div className="agents-panel__card">
            <p>Automate tasks like documentation, code cleanup, or language localization</p>
            <button className="start-session-button" disabled title="Agent hooks aren't wired up yet">+ Create New Hook</button>
          </div>
        </section>
        <section className="agents-panel__section">
          <div className="agents-panel__heading"><span>AGENT STEERING &amp; SKILLS</span></div>
          <div className="agents-panel__tree">
            <div className="agents-panel__tree-group"><span className="codicon codicon-chevron-down" /> Global</div>
            <button className="agents-panel__skill"><span className="codicon codicon-plug" /> architecture-selection</button>
            <button className="agents-panel__skill"><span className="codicon codicon-plug" /> quick-spec</button>
            <button className="agents-panel__skill"><span className="codicon codicon-plug" /> bug-fix</button>
          </div>
        </section>
        <section className="agents-panel__section">
          <div className="agents-panel__heading"><span>MCP SERVERS</span></div>
          <p className="muted-copy">Connect external tools and data sources</p>
        </section>
      </div>
    </>
  );
}
