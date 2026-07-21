import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useSession } from "../lib/SessionContext";
import { onEnvelopeType } from "../lib/wsClient";
import * as runtime from "../../wailsjs/runtime/runtime";
import * as wailsClient from "../lib/wailsClient";
import { useWorkspace } from "../lib/WorkspaceContext";
import { getSettings, subscribeSettings } from "../lib/settings";

type LocalTab = { key: string; id: string; cwd: string; label: string; pending: boolean; shell?: string };
type LocalOutput = { id: string; data?: string; exited?: boolean; exit_code?: number };

// Builds a shell-appropriate change-directory command (with Enter) so opening
// a workspace folder moves the live terminal into it. PowerShell needs
// Set-Location + doubled single quotes; cmd needs /d to cross drives; POSIX
// shells take cd with '\''-escaped single quotes.
function cdCommand(shell: string | undefined, path: string): string {
  const s = (shell ?? "").toLowerCase();
  if (s.includes("pwsh") || s.includes("powershell")) return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'\r`;
  if (s.includes("cmd")) return `cd /d "${path}"\r`;
  return `cd '${path.replace(/'/g, "'\\''")}'\r`;
}

function TerminalSurface({ tab, active, onReady }: { tab: LocalTab; active: boolean; onReady: (pendingID: string, info: wailsClient.LocalTerminalInfo) => void }) {
  const { activeWsClient } = useSession();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef(tab.id);
  const pendingOutput = useRef<LocalOutput[]>([]);
  const sizeRef = useRef({ cols: 80, rows: 24 });
  const fitFnRef = useRef<() => void>(() => {});
  const isSession = tab.id === "swarm-session";
  const sessionClient = isSession ? activeWsClient : null;

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({ convertEol: false, fontSize: getSettings().terminalFontSize, fontFamily: "Consolas, 'Cascadia Mono', monospace", theme: { background: "#0d1117", foreground: "#c9d1d9" }, disableStdin: isSession, cursorBlink: true, scrollback: 10000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    const fitAndResize = () => {
      const el = containerRef.current;
      if (!el || el.clientWidth < 20 || el.clientHeight < 20) return;
      try { fit.fit(); } catch { return; }
      const proposed = fit.proposeDimensions();
      if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
      sizeRef.current = { cols: proposed.cols, rows: proposed.rows };
      if (!isSession && !idRef.current.startsWith("pending-")) void wailsClient.resizeTerminal(idRef.current, proposed.cols, proposed.rows).catch(() => undefined);
    };
    fitFnRef.current = fitAndResize;
    // A single early fit can measure before the monospace font metrics settle
    // (or while the panel is mid-layout), leaving the grid smaller than the
    // panel. Fit now, next frame, and after the font loads.
    fitAndResize();
    const raf = requestAnimationFrame(fitAndResize);
    const fitTimers = [window.setTimeout(fitAndResize, 60), window.setTimeout(fitAndResize, 240)];
    const observer = new ResizeObserver(fitAndResize);
    observer.observe(containerRef.current);
    const onWindowResize = () => fitAndResize();
    window.addEventListener("resize", onWindowResize);
    // Live-apply terminal font-size changes from Settings, then refit.
    const settingsOff = subscribeSettings((s) => { term.options.fontSize = s.terminalFontSize; fitAndResize(); });

    const nativeRuntime = typeof (window as any).runtime?.EventsOn === "function";
    const outputOff = isSession || !nativeRuntime ? undefined : runtime.EventsOn("terminal.local.output", (event: LocalOutput) => {
      if (!event?.id) return;
      if (event.id !== idRef.current) { if (idRef.current.startsWith("pending-")) pendingOutput.current.push(event); return; }
      if (event.data) term.write(event.data);
      if (event.exited) term.write(`\r\n[process exited ${event.exit_code ?? 0}]\r\n`);
    });
    const input = isSession ? undefined : term.onData((data) => {
      if (!idRef.current.startsWith("pending-")) void wailsClient.writeTerminal(idRef.current, data).catch(() => undefined);
    });

    let cancelled = false;
    if (!isSession && typeof (window as any).go?.main?.SessionAPI?.CreateTerminal !== "function") {
      term.write("\x1b[90mNative PTY terminal is available in the Wails desktop app.\x1b[0m\r\n");
      return () => { cancelled = true; outputOff?.(); input?.dispose(); observer.disconnect(); window.removeEventListener("resize", onWindowResize); cancelAnimationFrame(raf); fitTimers.forEach(clearTimeout); settingsOff(); term.dispose(); termRef.current = null; };
    }
    if (isSession) {
      term.write("\x1b[90mSwarm session output\x1b[0m\r\n");
      const unsubscribe = sessionClient ? onEnvelopeType(sessionClient, "terminal.output", (payload) => term.write(payload.data)) : undefined;
      return () => { cancelled = true; unsubscribe?.(); observer.disconnect(); window.removeEventListener("resize", onWindowResize); cancelAnimationFrame(raf); fitTimers.forEach(clearTimeout); settingsOff(); term.dispose(); termRef.current = null; };
    }
    void wailsClient.createTerminal(tab.cwd, sizeRef.current.cols, sizeRef.current.rows).then((info) => {
      if (cancelled) { void wailsClient.closeTerminal(info.id).catch(() => undefined); return; }
      idRef.current = info.id;
      onReady(tab.id, info);
      for (const event of pendingOutput.current.splice(0)) if (event.id === info.id) { if (event.data) term.write(event.data); if (event.exited) term.write(`\r\n[process exited ${event.exit_code ?? 0}]\r\n`); }
      fitAndResize();
      if (active) term.focus();
    }).catch((error) => term.write(`\r\n[terminal failed: ${String(error)}]\r\n`));
    return () => {
      cancelled = true;
      outputOff?.();
      input?.dispose();
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      cancelAnimationFrame(raf);
      fitTimers.forEach(clearTimeout);
      settingsOff();
      const id = idRef.current;
      if (!id.startsWith("pending-")) void wailsClient.closeTerminal(id).catch(() => undefined);
      term.dispose();
      termRef.current = null;
    };
  }, [isSession, onReady, sessionClient, tab.cwd, tab.key]);

  // When this surface becomes visible (tab switch / panel show), the container
  // may have gone from 0-size to real size while hidden — refit so the grid
  // fills instead of staying at its last (possibly tiny) measured size.
  useEffect(() => { if (active) { termRef.current?.focus(); requestAnimationFrame(() => fitFnRef.current()); } }, [active]);
  return <div ref={containerRef} className="terminal-surface" />;
}

export default function Terminal() {
  const { workspace } = useWorkspace();
  const cwd = workspace?.rootPath ?? "";
  const [tabs, setTabs] = useState<LocalTab[]>(() => [{ key: "pending-1", id: "pending-1", cwd, label: "Terminal", pending: true }]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const counter = useRef(1);
  const { activeSessionId, activeWsClient } = useSession();

  const addTerminal = () => {
    counter.current += 1;
    const id = `pending-${counter.current}`;
    setTabs((current) => [...current, { key: id, id, cwd, label: "Terminal", pending: true }]);
    setActiveTab(id);
  };
  useEffect(() => { if (!activeTab && tabs[0]) setActiveTab(tabs[0].id); }, [activeTab, tabs]);
  useEffect(() => { if (activeSessionId) setActiveTab("swarm-session"); else if (activeTab === "swarm-session") setActiveTab(tabs[0]?.id ?? null); }, [activeSessionId, activeTab, tabs]);
  const onReady = useCallback((pendingID: string, info: wailsClient.LocalTerminalInfo) => {
    setTabs((current) => current.map((tab) => tab.id === pendingID ? { ...tab, id: info.id, label: info.shell.toLowerCase().includes("pwsh") ? "PowerShell" : info.shell.split(/[\\/]/).pop() ?? "Terminal", pending: false, shell: info.shell } : tab));
    setActiveTab((current) => current === pendingID ? info.id : current);
  }, []);

  // When the workspace folder changes, move the live terminal into it (the
  // native PTY persists across folder switches — see App.tsx — so it must be
  // told to cd rather than being respawned). New terminals already inherit the
  // current cwd, so only the visible, ready native terminal needs the nudge.
  const lastCwd = useRef(cwd);
  useEffect(() => {
    if (!cwd || cwd === lastCwd.current) return;
    lastCwd.current = cwd;
    const active = tabs.find((tab) => tab.id === activeTab);
    if (active && !active.pending && active.id.startsWith("local-")) {
      void wailsClient.writeTerminal(active.id, cdCommand(active.shell, cwd)).catch(() => undefined);
    }
  }, [cwd, activeTab, tabs]);
  const closeTab = (id: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== id));
    if (activeTab === id) setActiveTab(tabs.find((tab) => tab.id !== id)?.id ?? null);
  };
  const sessionTab: LocalTab = { key: "swarm-session", id: "swarm-session", cwd: "", label: "Swarm session", pending: false };
  const allTabs = activeSessionId && activeWsClient ? [...tabs, sessionTab] : tabs;
  return <div className="terminal-container">
    <div className="terminal-tabs">
      <button className="terminal-tabs__add" title="New terminal" onClick={addTerminal}>+</button>
      {allTabs.map((tab) => <button key={tab.id} className={`terminal-tab ${activeTab === tab.id ? "is-active" : ""} ${tab.id === "swarm-session" ? "is-session" : ""}`} onClick={() => setActiveTab(tab.id)}><span>{tab.label}{tab.pending ? "..." : ""}</span>{tab.id !== "swarm-session" && <span className="terminal-tab__close" onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}>x</span>}</button>)}
      <span className="terminal-tabs__spacer" /><span className="terminal-tabs__cwd">{workspace?.rootPath ?? "user home"}</span>
    </div>
    <div className="terminal-surfaces">
      {tabs.map((tab) => <div key={tab.key} className="terminal-surface-wrap" hidden={activeTab !== tab.id}><TerminalSurface tab={tab} active={activeTab === tab.id} onReady={onReady} /></div>)}
      {activeSessionId && activeWsClient && <div className="terminal-surface-wrap" hidden={activeTab !== "swarm-session"}><TerminalSurface tab={sessionTab} active={activeTab === "swarm-session"} onReady={() => undefined} /></div>}
    </div>
  </div>;
}
