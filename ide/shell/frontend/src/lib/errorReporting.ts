// Central crash/error sink. A WebView2 renderer fault (or any uncaught JS
// throw) was previously invisible - the app just white-screened or the window
// vanished with nothing written down. Everything here routes an error to two
// places: a visible on-screen overlay (so a crash is never silent) and, when
// running inside the Wails desktop app, an append-only log file on the Go side
// (so the exact stack survives the crash and can be read afterwards).

type AnyError = unknown;

function stringifyError(error: AnyError): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Best-effort append to the Go-side log file. Calls the binding directly and
// defensively so a missing/older generated binding can never itself throw.
function logToBackend(context: string, message: string) {
  try {
    const api = (window as unknown as { go?: { main?: { SessionAPI?: { LogFrontendError?: (msg: string) => Promise<void> } } } }).go;
    const fn = api?.main?.SessionAPI?.LogFrontendError;
    if (typeof fn === "function") void fn(`[${context}] ${message}`).catch(() => undefined);
  } catch {
    /* logging must never cascade into another failure */
  }
}

let overlayEl: HTMLDivElement | null = null;

function showOverlay(context: string, message: string) {
  if (typeof document === "undefined") return;
  if (!overlayEl) {
    overlayEl = document.createElement("div");
    overlayEl.setAttribute("data-tangent-crash-overlay", "");
    overlayEl.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#1b1b1f;color:#e6e6e6;" +
      "font:13px/1.5 Consolas,'Cascadia Mono',monospace;padding:24px;overflow:auto;white-space:pre-wrap";
    document.body.appendChild(overlayEl);
  }
  overlayEl.textContent =
    `Tangent IDE hit an error (${context}).\n\n` +
    `${message}\n\n` +
    `This was written to tangent-ide.log next to the app. ` +
    `Press Ctrl+R to reload, or copy the text above.`;
}

// Breadcrumb into the same on-disk log. Used to record how far a session got
// before a hard renderer crash (which no error handler can catch): the last
// breadcrumb before the log goes silent pinpoints the failing step.
export function logInfo(context: string, message: string) {
  // eslint-disable-next-line no-console
  console.info(`[tangent:${context}]`, message);
  logToBackend(context, message);
}

export function reportError(context: string, error: AnyError) {
  const message = stringifyError(error);
  // eslint-disable-next-line no-console
  console.error(`[tangent:${context}]`, error);
  logToBackend(context, message);
  showOverlay(context, message);
}

// Installs process-wide handlers. Call once, as early as possible, before the
// React tree mounts.
export function installGlobalErrorHandlers() {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (event) => {
    reportError("window.onerror", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportError("unhandledrejection", event.reason);
  });
}
