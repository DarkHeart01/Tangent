import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SessionWsClient, onEnvelopeType } from "./wsClient";
import * as wailsClient from "./wailsClient";
import type { SessionSummary, SessionMode } from "./wailsClient";

interface SessionContextValue {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  activeWsClient: SessionWsClient | null;
  starting: boolean;
  error: string | null;
  selectSession: (id: string) => void;
  newSession: () => void;
  startSession: (goal: string, topology: string, mode: SessionMode) => Promise<void>;
  stopSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  reconnectActiveWs: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-render on ws client swap without duplicating client state elsewhere.
  const [, forceRender] = useState(0);

  const clientsRef = useRef<Map<string, SessionWsClient>>(new Map());

  const refreshSessions = useCallback(async () => {
    if (!wailsClient.isWailsDesktop()) {
      // Browser/Vite preview has no bound Go session API. Keep the setup view
      // usable without surfacing a misleading "window.go.main" exception.
      setSessions([]);
      return;
    }
    try {
      const list = await wailsClient.listSessions();
      setSessions(list);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const startSession = useCallback(
    async (goal: string, topology: string, mode: SessionMode) => {
      setStarting(true);
      setError(null);
      if (!wailsClient.isWailsDesktop()) {
        setError("Start Session is available in the Wails desktop application.");
        setStarting(false);
        return;
      }
      try {
        const result = await wailsClient.startSession(goal, topology, mode);
        const client = new SessionWsClient(result.ws_url);
        clientsRef.current.set(result.session_id, client);
        setActiveSessionId(result.session_id);
        await refreshSessions();
      } catch (err) {
        setError(String(err));
      } finally {
        setStarting(false);
      }
    },
    [refreshSessions],
  );

  const stopSession = useCallback(
    async (id: string) => {
      if (!wailsClient.isWailsDesktop()) {
        setError("Stop Session is available in the Wails desktop application.");
        return;
      }
      try {
        await wailsClient.stopSession(id);
        await refreshSessions();
      } catch (err) {
        setError(String(err));
      }
    },
    [refreshSessions],
  );

  const selectSession = useCallback((id: string) => {
    setActiveSessionId(id);
  }, []);

  const newSession = useCallback(() => {
    setActiveSessionId(null);
    setError(null);
  }, []);

  const reconnectActiveWs = useCallback(() => {
    if (!activeSessionId) return;
    clientsRef.current.get(activeSessionId)?.reconnect();
    forceRender((n) => n + 1);
  }, [activeSessionId]);

  const activeWsClient = activeSessionId ? clientsRef.current.get(activeSessionId) ?? null : null;

  // Populate the sidebar with sessions that already existed on the Go side
  // (started from a prior page instance, e.g. before a WS reconnect or
  // window reload) — otherwise it stays empty until this page starts one
  // itself.
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Session status (running -> success/failed/cancelled) changes on the Go
  // side without a dedicated "sessions list changed" push; refetch the
  // authoritative summary whenever the active session ends.
  useEffect(() => {
    if (!activeWsClient) return;
    return onEnvelopeType(activeWsClient, "session.ended", () => {
      refreshSessions();
    });
  }, [activeWsClient, refreshSessions]);

  const value = useMemo<SessionContextValue>(
    () => ({
      sessions,
      activeSessionId,
      activeWsClient,
      starting,
      error,
      selectSession,
      newSession,
      startSession,
      stopSession,
      refreshSessions,
      reconnectActiveWs,
    }),
    [sessions, activeSessionId, activeWsClient, starting, error, selectSession, newSession, startSession, stopSession, refreshSessions, reconnectActiveWs],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
