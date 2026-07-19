import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useSession } from "../lib/SessionContext";
import { onEnvelopeType } from "../lib/wsClient";

export default function Terminal() {
  const { activeSessionId, activeWsClient } = useSession();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Mount xterm once.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      convertEol: true,
      fontSize: 13,
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
      theme: { background: "#0d1117", foreground: "#c9d1d9" },
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Reset screen and resubscribe whenever the active session changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.writeln(activeSessionId ? `\x1b[90m— session ${activeSessionId} —\x1b[0m` : "\x1b[90mNo session selected\x1b[0m");

    if (!activeWsClient) return;
    const unsubscribe = onEnvelopeType(activeWsClient, "terminal.output", (payload) => {
      const color = payload.stream === "stderr" ? "\x1b[31m" : "\x1b[0m";
      term.write(color + payload.data.replace(/\n$/, "") + "\x1b[0m\r\n");
    });
    return unsubscribe;
  }, [activeSessionId, activeWsClient]);

  return <div className="terminal-panel" ref={containerRef} />;
}
