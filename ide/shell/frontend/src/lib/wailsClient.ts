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

export const startSession = (goal: string, topology: string): Promise<StartSessionResult> =>
  SessionAPI.StartSession(goal, topology);

export const stopSession = (sessionId: string): Promise<void> => SessionAPI.StopSession(sessionId);

export const resolveGate = (gateId: string, decision: "approve" | "reject", note: string): Promise<void> =>
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
