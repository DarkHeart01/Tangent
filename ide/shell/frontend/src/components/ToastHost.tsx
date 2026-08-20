import { useEffect, useState } from "react";
import type { ToastPayload } from "../lib/toast";

const AUTO_DISMISS_MS = 3600;

export default function ToastHost() {
  const [toasts, setToasts] = useState<ToastPayload[]>([]);

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<ToastPayload>).detail;
      if (!detail) return;
      setToasts((current) => [...current, detail]);
      window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== detail.id)), AUTO_DISMISS_MS);
    };
    window.addEventListener("tangent:toast", onToast);
    return () => window.removeEventListener("tangent:toast", onToast);
  }, []);

  if (!toasts.length) return null;
  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span>{toast.message}</span>
          <button onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))} aria-label="Dismiss"><span className="codicon codicon-close" /></button>
        </div>
      ))}
    </div>
  );
}
