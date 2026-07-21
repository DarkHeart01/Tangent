import { useCallback, useEffect, useMemo, useState } from "react";
import * as runtime from "../../wailsjs/runtime/runtime";
import * as wailsClient from "../lib/wailsClient";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

function statusMap(status: wailsClient.GitStatus) {
  return [...status.changes, ...status.staged, ...status.conflicts, ...status.ignored].reduce<Record<string, string>>((result, file) => {
    result[file.path] = file.status;
    return result;
  }, {});
}

type SourceControlProps = {
  root: string | null;
  github?: wailsClient.GitHubStatus | null;
  initialPR?: wailsClient.GitHubPR | null;
};

export default function SourceControl({ root, github, initialPR }: SourceControlProps) {
  const [status, setStatus] = useState<wailsClient.GitStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [branches, setBranches] = useState<wailsClient.GitBranch[]>([]);
  const [githubOpen, setGithubOpen] = useState(true);
  const [pr, setPR] = useState<wailsClient.GitHubPR | null>(initialPR ?? null);
  const [createPROpen, setCreatePROpen] = useState(false);
  const [prTitle, setPRTitle] = useState("");
  const [prBody, setPRBody] = useState("");
  const [prBase, setPRBase] = useState("");
  const [baseBranches, setBaseBranches] = useState<string[]>([]);
  const [prError, setPRError] = useState<string | null>(null);
  const [prBusy, setPRBusy] = useState(false);
  const [allPRs, setAllPRs] = useState<wailsClient.GitHubPRListItem[]>([]);
  const [allPROpen, setAllPROpen] = useState(false);

  const githubEnabled = Boolean(root && github?.available && github.authenticated && github.is_github_remote);
  const publishPR = useCallback((next: wailsClient.GitHubPR | null) => {
    setPR(next?.exists ? next : null);
    window.dispatchEvent(new CustomEvent("tangent:github-pr", { detail: next?.exists ? next : null }));
  }, []);

  const refresh = useCallback(async () => {
    if (!root) {
      setStatus(null);
      window.dispatchEvent(new CustomEvent("tangent:git-status", { detail: {} }));
      window.dispatchEvent(new CustomEvent("tangent:git-status-summary", { detail: null }));
      return;
    }
    try {
      const next = await wailsClient.gitStatus(root);
      setStatus(next);
      setError(null);
      window.dispatchEvent(new CustomEvent("tangent:git-status", { detail: statusMap(next) }));
      window.dispatchEvent(new CustomEvent("tangent:git-status-summary", { detail: next }));
    } catch (err) {
      setError(String(err));
      setStatus(null);
      window.dispatchEvent(new CustomEvent("tangent:git-status", { detail: {} }));
      window.dispatchEvent(new CustomEvent("tangent:git-status-summary", { detail: null }));
    }
  }, [root]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    setPR(initialPR ?? null);
    setPRError(null);
    setCreatePROpen(false);
    if (!githubEnabled) return () => { cancelled = true; };
    void Promise.all([
      wailsClient.githubCurrentPR(root!),
      wailsClient.githubDefaultBranch(root!),
      wailsClient.gitLog(root!, 20),
      wailsClient.gitBranches(root!),
    ]).then(([current, base, commits, branchesForPR]) => {
      if (cancelled) return;
      publishPR(current);
      setPRBase(base);
      setPRTitle(commits[0]?.message ?? "");
      setPRBody(commits.map((commit) => `- ${commit.message}`).join("\n"));
      setBaseBranches([base, ...branchesForPR.filter((branch) => !branch.remote).map((branch) => branch.name).filter((name) => name !== base)]);
    }).catch(() => { /* GitHub is optional; keep the core panel quiet. */ });
    return () => { cancelled = true; };
  }, [githubEnabled, initialPR, publishPR, root]);

  const run = async (operation: () => Promise<void>) => {
    if (!root) return;
    setBusy(true);
    setError(null);
    try { await operation(); await refresh(); if (githubEnabled) { const next = await wailsClient.githubCurrentPR(root); publishPR(next); } }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const stage = (path: string) => void run(() => wailsClient.gitStage(root!, [path]));
  const unstage = (path: string) => void run(() => wailsClient.gitUnstage(root!, [path]));
  const discard = (path: string) => { if (window.confirm(`Discard changes to ${path}?`)) void run(() => wailsClient.gitDiscard(root!, [path])); };
  const openDiff = (path: string, staged = false) => window.dispatchEvent(new CustomEvent("tangent:open-diff", { detail: { path, staged } }));
  const copy = async (path: string) => { try { await navigator.clipboard?.writeText(path); } catch { /* optional permission */ } };

  const fileRows = (files: wailsClient.GitFileStatus[], staged: boolean) => files.map((file) => (
    <button className="source-control__file" key={`${staged ? "staged" : "change"}-${file.path}`} onClick={() => openDiff(file.path, staged)}>
      <span className={`source-control__status source-control__status--${file.status}`}>{file.status}</span>
      <span className="source-control__file-name"><b>{file.path.split("/").pop()}</b><small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</small></span>
      <span className="source-control__actions">{staged ? <span onClick={(event) => { event.stopPropagation(); unstage(file.path); }} title="Unstage">-</span> : <span onClick={(event) => { event.stopPropagation(); stage(file.path); }} title="Stage">+</span>}{!staged && <span onClick={(event) => { event.stopPropagation(); discard(file.path); }} title="Discard changes">x</span>}</span>
    </button>
  ));

  const overflowItems: ContextMenuItem[] = [
    { label: "Refresh", onClick: () => void refresh() },
    { label: "Fetch", onClick: () => void run(() => wailsClient.gitFetch(root!)) },
    { label: "Pull", onClick: () => void run(() => wailsClient.gitPull(root!)) },
    { label: "Push", onClick: () => void run(() => wailsClient.gitPush(root!)) },
    { label: "Sync", onClick: () => void run(() => wailsClient.gitSync(root!)) },
    { label: "Copy Repository Path", onClick: () => void copy(root ?? "") },
  ];
  const commit = async (amend = false, followUp?: "push" | "sync") => {
    if (!root || !message.trim() || (!amend && !status?.staged.length)) return;
    await run(async () => { await wailsClient.gitCommit(root!, message.trim(), amend); setMessage(""); setCommitMenuOpen(false); if (followUp === "push") await wailsClient.gitPush(root!); if (followUp === "sync") await wailsClient.gitSync(root!); });
  };
  const loadBranches = async () => { if (!root) return; try { setBranches(await wailsClient.gitBranches(root)); } catch (err) { setError(String(err)); } };
  useEffect(() => {
    const choose = () => void loadBranches();
    const sync = () => void run(() => wailsClient.gitSync(root!));
    const focusGitHub = () => { setGithubOpen(true); window.setTimeout(() => document.getElementById("github-section")?.scrollIntoView({ block: "nearest" }), 0); };
    window.addEventListener("tangent:open-branch-picker", choose);
    window.addEventListener("tangent:git-sync", sync);
    window.addEventListener("tangent:focus-github", focusGitHub);
    return () => { window.removeEventListener("tangent:open-branch-picker", choose); window.removeEventListener("tangent:git-sync", sync); window.removeEventListener("tangent:focus-github", focusGitHub); };
  }, [root]);
  const branchItems = useMemo(() => branches.map((branch) => <button className="source-control__branch" key={`${branch.remote ? "remote" : "local"}-${branch.name}`} onClick={() => void run(async () => { await wailsClient.gitCheckout(root!, branch.name); setBranches([]); })}>{branch.current ? "* " : ""}{branch.name}</button>), [branches, root]);

  const openURL = (url: string) => {
    if (!url) return;
    if (typeof (window as any).runtime?.BrowserOpenURL === "function") {
      try { runtime.BrowserOpenURL(url); return; } catch { /* fall through to browser navigation */ }
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };
  const createPR = async (pushFirst = false) => {
    if (!root || !prTitle.trim() || !prBase.trim()) return;
    setPRBusy(true); setPRError(null);
    try {
      if (pushFirst) await wailsClient.gitPush(root);
      const next = await wailsClient.githubCreatePR(root, prTitle.trim(), prBody, prBase.trim());
      publishPR(next); setCreatePROpen(false);
    } catch (err) {
      const text = String(err);
      setPRError(text);
      if (!pushFirst && /no upstream|set-upstream|has no upstream|push.*branch/i.test(text)) setPRError(`${text}\nPush the branch, then retry.`);
    } finally { setPRBusy(false); }
  };
  const loadAllPRs = async () => {
    if (!root) return;
    try { setAllPRs(await wailsClient.githubListPRs(root)); setAllPROpen(true); }
    catch (err) { setPRError(String(err)); }
  };

  if (!root) return <div className="source-control__empty"><span className="codicon codicon-source-control" /><strong>Source Control</strong><small>Open a local folder to use Git.</small></div>;
  return <div className="source-control" onContextMenu={(event) => event.preventDefault()}>
    <div className="source-control__header"><span>SOURCE CONTROL</span><div><button className="icon-button" title="Refresh" onClick={() => void refresh()}><span className="codicon codicon-refresh" /></button><button className="icon-button" title="More actions" onClick={() => setMenuOpen(true)}><span className="codicon codicon-ellipsis" /></button></div></div>
    {menuOpen && <ContextMenu x={210} y={42} items={overflowItems} onClose={() => setMenuOpen(false)} />}
    {error && <div className="source-control__error">{error}</div>}
    <div className="source-control__branch-row"><span className="codicon codicon-git-branch" /><strong>{status?.branch ?? "Loading..."}</strong><span className="source-control__sync-count">A{status?.ahead ?? 0} B{status?.behind ?? 0}</span><button className="icon-button" title="Choose branch" onClick={() => void loadBranches()}><span className="codicon codicon-chevron-down" /></button></div>
    {branches.length > 0 && <div className="source-control__branches">{branchItems}<button className="source-control__branch source-control__branch--new" onClick={() => { const name = window.prompt("New branch name"); if (name) void run(async () => { await wailsClient.gitCreateBranch(root!, name); setBranches([]); }); }}>+ Create new branch</button></div>}
    <div className="source-control__commit"><textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Message (press Ctrl+Enter to commit)" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void commit(); }} /><div className="source-control__commit-row"><button className="start-session-button source-control__commit-button" disabled={busy || !message.trim() || !status?.staged.length} onClick={() => void commit()}>Commit</button><button className="icon-button source-control__commit-menu" title="Commit options" onClick={() => setCommitMenuOpen((value) => !value)}><span className="codicon codicon-chevron-down" /></button></div>{commitMenuOpen && <ContextMenu x={185} y={170} items={[{ label: "Commit & Push", onClick: () => void commit(false, "push"), disabled: busy || !message.trim() || !status?.staged.length }, { label: "Commit & Sync", onClick: () => void commit(false, "sync"), disabled: busy || !message.trim() || !status?.staged.length }, { separator: true, label: "" }, { label: "Amend Last Commit", onClick: () => void commit(true), disabled: busy || !message.trim() }]} onClose={() => setCommitMenuOpen(false)} />}</div>
    {status && <div className="source-control__sections"><section><header><strong>Changes</strong><span>{status.changes.length}</span><button onClick={() => void run(() => wailsClient.gitStage(root!, status.changes.map((file) => file.path)))} disabled={!status.changes.length}>Stage All</button><button onClick={() => { if (window.confirm("Discard all changes?")) void run(() => wailsClient.gitDiscard(root!, status.changes.map((file) => file.path))); }} disabled={!status.changes.length}>Discard All</button></header>{fileRows(status.changes, false)}</section><section><header><strong>Staged Changes</strong><span>{status.staged.length}</span><button onClick={() => void run(() => wailsClient.gitUnstage(root!, status.staged.map((file) => file.path)))} disabled={!status.staged.length}>Unstage All</button></header>{fileRows(status.staged, true)}</section>{status.conflicts.length > 0 && <section><header><strong>Merge Changes</strong><span>!</span></header>{fileRows(status.conflicts, false)}</section>}
    {githubEnabled && <section id="github-section" className="github-section"><header><button className="github-section__toggle" onClick={() => setGithubOpen((value) => !value)}><span className={`codicon ${githubOpen ? "codicon-chevron-down" : "codicon-chevron-right"}`} /> <strong>GitHub</strong></button><span className="github-section__account">{github?.login}</span></header>{githubOpen && <div className="github-section__body">
      {pr ? <button className="github-pr-card" onClick={() => openURL(pr.url)}><span className={`github-pr-dot github-pr-dot--${pr.check_status}`} /><span><b>#{pr.number} {pr.title}</b><small>{pr.author || "Unknown author"} · checks {pr.check_status}</small></span><span className="codicon codicon-link-external" /></button> : <button className="github-create-link" onClick={() => setCreatePROpen(true)}><span className="codicon codicon-git-pull-request" /> Create Pull Request</button>}
      {createPROpen && !pr && <div className="github-pr-form"><label>Title<input value={prTitle} onChange={(event) => setPRTitle(event.target.value)} /></label><label>Description<textarea value={prBody} onChange={(event) => setPRBody(event.target.value)} /></label><label>Base branch<select value={prBase} onChange={(event) => setPRBase(event.target.value)}>{baseBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select></label>{prError && <div className="source-control__error">{prError}</div>}<div className="github-pr-form__actions"><button onClick={() => setCreatePROpen(false)}>Cancel</button><button onClick={() => void createPR()} disabled={prBusy || !prTitle.trim() || !prBase.trim()}>Create</button>{prError && /upstream|push.*branch/i.test(prError) && <button onClick={() => void createPR(true)} disabled={prBusy}>Push and create</button>}</div></div>}
      {pr && <button className="github-create-link" onClick={() => openURL(pr.url)}>Open Pull Request</button>}<button className="github-view-all" onClick={() => allPROpen ? setAllPROpen(false) : void loadAllPRs()}>{allPROpen ? "Hide all PRs" : "View all PRs"}</button>{allPROpen && <div className="github-pr-list">{allPRs.map((item) => <button key={item.number} onClick={() => openURL(item.url)}><b>#{item.number} {item.title}</b><small>{item.author} · {item.head_branch}</small></button>)}</div>}
    </div>}</section>}
    </div>}
  </div>;
}
