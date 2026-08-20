// Presentational only — Tangent has no debug-adapter/launch-config system
// today, so this mirrors Figma's "Run and Debug" screen without pretending
// to run or attach a debugger.
export default function RunDebugPanel() {
  return (
    <>
      <div className="explorer-sidebar__header"><span>RUN AND DEBUG</span></div>
      <div className="side-empty-panel">
        <p>Open a file which can be debugged or run.</p>
        <button className="start-session-button" disabled title="No launch configuration in this workspace yet">Run and Debug</button>
        <p className="side-empty-panel__hint">To customize Run and Debug <button className="side-empty-panel__link" disabled>create a launch.json file</button>.</p>
      </div>
    </>
  );
}
