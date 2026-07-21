import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../lib/errorReporting";

type Props = { children: ReactNode };
type State = { error: Error | null };

// A render-time throw anywhere in the tree used to unmount the whole app to a
// blank screen with nothing recorded. This catches it, logs it (to screen and
// to the Go-side file via reportError), and shows a recoverable panel instead
// so the window stays alive and the cause is visible.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError("react", `${error.message}\n${error.stack ?? ""}\ncomponentStack:${info.componentStack ?? ""}`);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, font: "13px/1.6 Consolas, 'Cascadia Mono', monospace", color: "#e6e6e6", background: "#1b1b1f", height: "100vh", overflow: "auto", whiteSpace: "pre-wrap" }}>
          <h2 style={{ color: "#ff6b6b", marginTop: 0 }}>Tangent IDE crashed while rendering</h2>
          <p>The error below was also written to <code>tangent-ide.log</code> next to the app.</p>
          <pre style={{ color: "#ffb4b4" }}>{this.state.error.message}</pre>
          <pre style={{ color: "#9aa0a6", fontSize: 12 }}>{this.state.error.stack}</pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 12, padding: "6px 14px", background: "#0e639c", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
          >
            Try to recover
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
