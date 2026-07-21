// Thin, typed wrapper over the generated Wails bindings so components never
// import straight from ../../wailsjs/go/*.
import * as SessionAPI from "../../wailsjs/go/main/SessionAPI";
import { session } from "../../wailsjs/go/models";

export type SessionSummary = session.SessionSummary;
export type FileNode = session.FileNode;
export type FileContent = session.FileContent;
export type TraceEntry = session.TraceEntry;
export type CostReport = session.CostReport;
export type StartSessionResult = session.StartSessionResult;
export type ContractEntry = session.ContractEntry;
export type SessionMode = "simulated" | "container";

export const startSession = (goal: string, topology: string, mode: SessionMode): Promise<StartSessionResult> =>
  SessionAPI.StartSession(goal, topology, mode);

export const stopSession = (sessionId: string): Promise<void> => SessionAPI.StopSession(sessionId);

// decision is "approve" | "reject" for gate_kind "phase"/"tool_call", but the
// Go side treats this same parameter as the raw free-text or selected-option
// answer for gate_kind "question" — so it's a plain string here, not a union.
export const resolveGate = (gateId: string, decision: string, note: string): Promise<void> =>
  SessionAPI.ResolveGate(gateId, decision, note);

export const listSessions = (): Promise<SessionSummary[]> => SessionAPI.ListSessions();

export const getWorkspaceTree = (sessionId: string): Promise<FileNode[]> =>
  SessionAPI.GetWorkspaceTree(sessionId);

export const readFile = (sessionId: string, path: string): Promise<FileContent> =>
  SessionAPI.ReadFile(sessionId, path);

export const writeFile = (sessionId: string, path: string, content: string): Promise<void> =>
  SessionAPI.WriteFile(sessionId, path, content);

export const getTrace = (sessionId: string): Promise<TraceEntry[]> => SessionAPI.GetTrace(sessionId);

export const getCost = (sessionId: string): Promise<CostReport> => SessionAPI.GetCost(sessionId);

export const getContracts = (sessionId: string): Promise<ContractEntry[]> =>
  SessionAPI.GetContracts(sessionId);
