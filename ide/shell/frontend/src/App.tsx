import { useState } from "react";
import "./App.css";
import { SessionProvider, useSession } from "./lib/SessionContext";
import SessionList from "./components/SessionList";
import Terminal from "./components/Terminal";
import Dashboard from "./components/Dashboard";
import Editor from "./components/Editor";
import WalkthroughPanel from "./components/WalkthroughPanel";
import HumanGateBanner from "./components/HumanGateBanner";

type Tab = "terminal" | "dashboard" | "files" | "walkthrough";

const TABS: { id: Tab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "dashboard", label: "Dashboard" },
  { id: "files", label: "Files" },
  { id: "walkthrough", label: "Walkthrough" },
];

function Shell() {
  const { activeSessionId, activeWsClient, reconnectActiveWs } = useSession();
  const [tab, setTab] = useState<Tab>("terminal");
  const wsStatus = activeWsClient?.status ?? "closed";

  return (
    <div id="App">
      <aside className="app-sidebar">
        <div className="app-sidebar__title">Tangent IDE</div>
        <SessionList />
      </aside>
      <main className="app-main">
        <HumanGateBanner />
        <div className="app-tabbar">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "is-active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
          <div className="app-tabbar__spacer" />
          {activeSessionId && (
            <div className="app-tabbar__ws">
              <span className={`ws-dot ws-dot--${wsStatus}`} />
              {wsStatus}
              <button className="app-tabbar__reconnect" onClick={reconnectActiveWs} title="Close and reopen the WS connection">
                Reconnect
              </button>
            </div>
          )}
        </div>
        <div className="app-content">
          <div style={{ display: tab === "terminal" ? "block" : "none", height: "100%" }}>
            <Terminal />
          </div>
          <div style={{ display: tab === "dashboard" ? "block" : "none", height: "100%" }}>
            <Dashboard />
          </div>
          <div style={{ display: tab === "files" ? "block" : "none", height: "100%" }}>
            <Editor />
          </div>
          <div style={{ display: tab === "walkthrough" ? "block" : "none", height: "100%" }}>
            <WalkthroughPanel />
          </div>
        </div>
      </main>
    </div>
  );
}

function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

export default App;
