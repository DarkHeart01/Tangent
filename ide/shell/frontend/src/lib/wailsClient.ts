// Thin, typed wrapper over the generated Wails bindings so components never
// import straight from ../../wailsjs/go/*.
import * as SessionAPI from "../../wailsjs/go/main/SessionAPI";
import { main, session } from "../../wailsjs/go/models";

/** True when the page is hosted inside the Wails desktop WebView. */
export const isWailsDesktop = (): boolean =>
  typeof window !== "undefined" &&
  // Wails injects runtime.js before the generated Go bindings. Detecting
  // the runtime alone prevents a startup race from falling through to the
  // browser/native directory picker (or an old prompt) while bindings are
  // still being initialised.
  typeof (window as any).runtime?.Environment === "function";

export type SessionSummary = session.SessionSummary;
export type FileNode = session.FileNode;
export type FileContent = session.FileContent;
export type TraceEntry = session.TraceEntry;
export type CostReport = session.CostReport;
export type StartSessionResult = session.StartSessionResult;
export type ContractEntry = session.ContractEntry;
export type SessionMode = "simulated" | "container";
export type WorkspaceInfo = main.WorkspaceInfo;
export type GitFileStatus = main.GitFileStatus;
export type GitStatus = main.GitStatus;
export type GitBranch = main.GitBranch;
export type GitDiff = main.GitDiff;
export type GitHubStatus = main.GitHubStatus;
export type GitHubPR = main.GitHubPR;
export type GitHubPRListItem = main.GitHubPRListItem;
export type GitHubCommit = main.GitHubCommit;
export type LocalTerminalInfo = main.LocalTerminalInfo;
export type ProviderKeyStatus = main.ProviderKeyStatus;
export type SearchMatch = main.SearchMatch;

export const startSession = (goal: string, topology: string, mode: SessionMode): Promise<StartSessionResult> =>
  SessionAPI.StartSession(goal, topology, mode);

export const stopSession = (sessionId: string): Promise<void> => SessionAPI.StopSession(sessionId);

// decision is "approve"/"reject" for phase & tool_call gates, or the raw
// free-text answer for a "question" gate (the swarm's human_input channel).
export const resolveGate = (gateId: string, decision: string, note: string): Promise<void> =>
  SessionAPI.ResolveGate(gateId, decision, note);

export const searchWorkspace = (root: string, query: string): Promise<SearchMatch[]> => SessionAPI.SearchWorkspace(root, query);
export const getProviderKeyStatus = (): Promise<ProviderKeyStatus> => SessionAPI.GetProviderKeyStatus();
export const setProviderKey = (provider: string, key: string, model: string): Promise<void> =>
  SessionAPI.SetProviderKey(provider, key, model);

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

export const selectWorkspace = (): Promise<WorkspaceInfo> => SessionAPI.SelectWorkspace();
export const validateWorkspacePath = (path: string): Promise<WorkspaceInfo> => SessionAPI.ValidateWorkspacePath(path);
export const getUserHomePath = (): Promise<string> => SessionAPI.GetUserHomePath();
export const getWorkspaceTreeAt = (root: string): Promise<FileNode[]> => SessionAPI.GetWorkspaceTreeAt(root);
export const getWorkspaceDir = (root: string, relPath: string): Promise<FileNode[]> => SessionAPI.GetWorkspaceDir(root, relPath);
export const readWorkspaceFile = (root: string, path: string): Promise<FileContent> => SessionAPI.ReadWorkspaceFile(root, path);
export const writeWorkspaceFile = (root: string, path: string, content: string): Promise<void> => SessionAPI.WriteWorkspaceFile(root, path, content);
export const renameWorkspacePath = (root: string, oldPath: string, newPath: string): Promise<void> => SessionAPI.RenameWorkspacePath(root, oldPath, newPath);
export const createWorkspaceFolder = (root: string, path: string): Promise<void> => SessionAPI.CreateWorkspaceFolder(root, path);
export const deleteWorkspacePath = (root: string, path: string): Promise<void> => SessionAPI.DeleteWorkspacePath(root, path);
export const gitStatus = (root: string): Promise<GitStatus> => SessionAPI.GitStatus(root);
export const gitStage = (root: string, paths: string[]): Promise<void> => SessionAPI.GitStage(root, paths);
export const gitUnstage = (root: string, paths: string[]): Promise<void> => SessionAPI.GitUnstage(root, paths);
export const gitDiscard = (root: string, paths: string[]): Promise<void> => SessionAPI.GitDiscard(root, paths);
export const gitCommit = (root: string, message: string, amend = false): Promise<void> => SessionAPI.GitCommit(root, message, amend);
export const gitFetch = (root: string): Promise<void> => SessionAPI.GitFetch(root);
export const gitPull = (root: string): Promise<void> => SessionAPI.GitPull(root);
export const gitPush = (root: string): Promise<void> => SessionAPI.GitPush(root);
export const gitSync = (root: string): Promise<void> => SessionAPI.GitSync(root);
export const gitBranches = (root: string): Promise<GitBranch[]> => SessionAPI.GitBranches(root);
export const gitCheckout = (root: string, branch: string): Promise<void> => SessionAPI.GitCheckout(root, branch);
export const gitCreateBranch = (root: string, branch: string): Promise<void> => SessionAPI.GitCreateBranch(root, branch);
export const gitDiff = (root: string, path: string, staged = false): Promise<GitDiff> => SessionAPI.GitDiff(root, path, staged);
export const githubStatus = (root: string): Promise<GitHubStatus> => SessionAPI.GitHubStatus(root);
export const githubCurrentPR = (root: string): Promise<GitHubPR> => SessionAPI.GitHubCurrentPR(root);
export const githubDefaultBranch = (root: string): Promise<string> => SessionAPI.GitHubDefaultBranch(root);
export const githubCreatePR = (root: string, title: string, body: string, base: string): Promise<GitHubPR> => SessionAPI.GitHubCreatePR(root, title, body, base);
export const githubListPRs = (root: string): Promise<GitHubPRListItem[]> => SessionAPI.GitHubListPRs(root);
export const gitLog = (root: string, limit = 20): Promise<GitHubCommit[]> => SessionAPI.GitLog(root, limit);
export const createTerminal = (root: string, cols: number, rows: number): Promise<LocalTerminalInfo> => SessionAPI.CreateTerminal(root, cols, rows);
export const writeTerminal = (id: string, data: string): Promise<void> => SessionAPI.WriteTerminal(id, data);
export const resizeTerminal = (id: string, cols: number, rows: number): Promise<void> => SessionAPI.ResizeTerminal(id, cols, rows);
export const closeTerminal = (id: string): Promise<void> => SessionAPI.CloseTerminal(id);
