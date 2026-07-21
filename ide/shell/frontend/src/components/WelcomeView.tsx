import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import { useWorkspace } from "../lib/WorkspaceContext";
import mascot from "../assets/meow_mascot.png";

export default function WelcomeView() {
  const { recentProjects, openFolder, openFile, createFile, openRecent } = useWorkspace();
  const run = async (action: () => Promise<void>) => { try { await action(); } catch (error) { window.alert(String(error)); } };
  return <div className="welcome-view">
    <div className="welcome-view__content">
      <div className="welcome-view__brand">
        <img src={mascot} alt="Tangent mascot" className="welcome-view__logo" />
        <h1>Tangent IDE</h1>
      </div>
      <p className="welcome-view__subtitle">Editing evolved for agent-assisted development</p>
      <div className="welcome-view__columns welcome-view__columns--single">
        <section><h2>Start</h2>
          <button onClick={() => void createFile()}><span className="codicon codicon-new-file" /> <span>New File...</span></button>
          <button onClick={() => run(openFile)}><span className="codicon codicon-go-to-file" /> <span>Open File...</span></button>
          <button onClick={() => run(openFolder)}><span className="codicon codicon-folder-opened" /> <span>Open Folder...</span></button>
          <button onClick={() => run(openFolder)}><span className="codicon codicon-workspace-unknown" /> <span>Open Workspace...</span></button>
          <h2 className="welcome-view__recent-title">Recent</h2>
          {recentProjects.length ? recentProjects.map((project) => <button className="welcome-view__recent" key={`${project.name}-${project.path}`} onClick={() => run(() => openRecent(project))}><span>{project.name}</span><small>{project.path}</small></button>) : <p className="welcome-view__muted">No recent projects yet.</p>}
        </section>
      </div>
    </div>
  </div>;
}
