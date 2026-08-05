"""Git operations tool — scoped write permission, prod-risk flagged for main pushes."""

from __future__ import annotations
import asyncio
from pathlib import Path
from typing import Any
from core.exceptions import SafetyError
from tools.base import ToolHandler

_CWD = Path.cwd()
_PROD_BRANCHES = {"main", "master", "production", "prod"}

# Agent-created worktrees are nested *inside* the agent's own assigned
# worktree (rather than as siblings, which is how the Go daemon lays out
# per-session worktrees) so the existing _safe_dir confinement check below
# — "must resolve under _CWD" — covers them for free, with no new escape
# hatch. Excluded from the outer worktree's `git status` via
# .git/info/exclude (local-only, untracked) the first time one is created,
# not via a tracked .gitignore entry, so it never shows up in the agent's
# own diff.
_AGENT_WORKTREES_DIRNAME = ".agent-worktrees"
_AGENT_WORKTREES_ROOT = _CWD / _AGENT_WORKTREES_DIRNAME


def _safe_dir(rel: str) -> Path:
    """Confine working_dir to the agent's own assigned worktree — same
    intent as tools/filesystem/handler.py's _safe_path, but using
    is_relative_to() rather than a raw string-prefix check, which would
    wrongly accept a sibling like C:\\Foo\\Barbaz as "inside" C:\\Foo\\Bar.
    working_dir was previously joined onto _CWD with no escape check at
    all."""
    p = (_CWD / rel).resolve()
    if not p.is_relative_to(_CWD.resolve()):
        raise SafetyError(f"working_dir {rel!r} resolves outside the assigned worktree")
    return p


def _agent_worktree_path(name: str) -> Path:
    """Resolve a bare worktree_name to a path confined under
    .agent-worktrees/ inside the agent's own worktree. Rejects anything
    that isn't a single path segment so a name can't be used to escape
    (no slashes, no '..', not empty)."""
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise SafetyError(
            f"Invalid worktree_name {name!r} — must be a single path segment, no slashes or '..'"
        )
    p = (_AGENT_WORKTREES_ROOT / name).resolve()
    if not p.is_relative_to(_AGENT_WORKTREES_ROOT.resolve()):
        raise SafetyError(f"worktree_name {name!r} resolves outside the agent worktrees area")
    return p


def _ensure_worktrees_excluded() -> None:
    """Add .agent-worktrees/ to .git/info/exclude the first time it's
    needed, so nested worktrees never appear as untracked content in the
    outer worktree's own status/diff. Local-only — never touches a tracked
    file, so it can't show up in the agent's own PR diff."""
    exclude_file = _CWD / ".git" / "info" / "exclude"
    try:
        existing = exclude_file.read_text(encoding="utf-8") if exclude_file.exists() else ""
        if _AGENT_WORKTREES_DIRNAME not in existing.split():
            exclude_file.parent.mkdir(parents=True, exist_ok=True)
            with exclude_file.open("a", encoding="utf-8") as f:
                f.write(f"\n{_AGENT_WORKTREES_DIRNAME}/\n")
    except OSError:
        pass  # best-effort; a missing .git/info dir (e.g. bare repo) isn't fatal


class GitOpsHandler(ToolHandler):
    async def _run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        action = inputs["action"]
        wd = _safe_dir(inputs.get("working_dir", "."))

        if action == "init":
            wd.mkdir(parents=True, exist_ok=True)
            return await self._git(["init"], wd)
        elif action == "status":
            return await self._git(["status", "--short"], wd)
        elif action == "log":
            return await self._git(["log", "--oneline", "-10"], wd)
        elif action == "diff":
            return await self._git(["diff", "--stat"], wd)
        elif action == "branch":
            name = inputs.get("branch_name", "")
            cmd = ["branch", name] if name else ["branch", "--list"]
            return await self._git(cmd, wd)
        elif action == "checkout":
            name = inputs["branch_name"]
            return await self._git(["checkout", "-B", name], wd)
        elif action == "pull":
            return await self._git(["pull"], wd)
        elif action == "add":
            files = inputs.get("files", ["."])
            return await self._git(["add"] + files, wd)
        elif action == "commit":
            msg = inputs.get("commit_message", "chore: automated commit")
            return await self._git(["commit", "-m", msg], wd)
        elif action == "push":
            remote = inputs.get("remote", "origin")
            branch = inputs.get("branch_name", "")
            cmd = ["push", remote]
            if branch:
                # Flag prod-risk for main/master
                if branch.lower() in _PROD_BRANCHES:
                    return {
                        "prod_risk": True,
                        "warning": f"Pushing to '{branch}' is a prod-risk operation. Human confirmation required.",
                        "action_required": "Approve via human_input tool before executing push.",
                    }
                cmd += [branch]
            return await self._git(cmd, wd)
        elif action == "pr_create":
            return await self._create_pr(inputs, wd)
        elif action == "worktree_add":
            name = inputs.get("worktree_name", "")
            path = _agent_worktree_path(name)
            branch = inputs.get("branch_name") or f"agent-worktree/{name}"
            _ensure_worktrees_excluded()
            cmd = ["worktree", "add", str(path)]
            # create_branch defaults True (fresh branch); set False to attach
            # a worktree to a branch that already exists.
            if inputs.get("create_branch", True):
                cmd += ["-b", branch]
            else:
                cmd += [branch]
            return await self._git(cmd, _CWD)
        elif action == "worktree_list":
            return await self._git(["worktree", "list", "--porcelain"], _CWD)
        elif action == "worktree_remove":
            path = _agent_worktree_path(inputs.get("worktree_name", ""))
            return await self._git(["worktree", "remove", str(path), "--force"], _CWD)
        return {"error": f"Unknown action: {action}"}

    async def _git(self, args: list, cwd: Path) -> dict:
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(cwd),
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            return {
                "success": proc.returncode == 0,
                "output": stdout.decode(errors="replace")[:5000],
                "stderr": stderr.decode(errors="replace")[:2000],
                "exit_code": proc.returncode,
            }
        except FileNotFoundError:
            return {"error": "git not found on PATH"}

    async def _create_pr(self, inputs: dict, wd: Path) -> dict:
        title = inputs.get("pr_title", "Automated PR")
        body = inputs.get("pr_body", "")
        base = inputs.get("base_branch", "main")
        # Use gh CLI if available
        result = await self._git(
            ["gh", "pr", "create", "--title", title, "--body", body, "--base", base],
            wd
        )
        return result

    async def self_test(self) -> bool:
        result = await self._run({"action": "status"})
        return "output" in result or "error" in result


handler = GitOpsHandler()
