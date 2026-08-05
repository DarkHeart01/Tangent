"""Unit tests for git_ops's worktree_add/worktree_list/worktree_remove
actions and the working_dir/worktree_name path-confinement they depend on.

Uses real git subprocesses against a disposable tmp_path repo — no LLM,
daemon, or docker involved, so these run in plain `pytest`.
"""

from __future__ import annotations

import subprocess

import pytest

import tools.git_ops.handler as git_ops
from core.exceptions import SafetyError
from tools.git_ops.handler import GitOpsHandler


def _init_repo(path):
    env = {
        "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
        "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com",
    }
    subprocess.run(["git", "init", "-b", "main"], cwd=path, check=True, capture_output=True)
    (path / "README.md").write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=path, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "initial"], cwd=path, check=True, capture_output=True,
        env={**__import__("os").environ, **env},
    )


@pytest.fixture
def repo(tmp_path, monkeypatch):
    _init_repo(tmp_path)
    monkeypatch.setattr(git_ops, "_CWD", tmp_path)
    monkeypatch.setattr(git_ops, "_AGENT_WORKTREES_ROOT", tmp_path / ".agent-worktrees")
    return tmp_path


@pytest.mark.asyncio
async def test_worktree_add_creates_confined_worktree(repo):
    h = GitOpsHandler()
    result = await h._run({"action": "worktree_add", "worktree_name": "feature-x"})

    assert result.get("success") is True, result
    wt_path = repo / ".agent-worktrees" / "feature-x"
    assert wt_path.is_dir()
    assert (wt_path / ".git").exists()  # linked worktree marker


@pytest.mark.asyncio
async def test_worktree_add_excludes_dir_from_outer_status(repo):
    h = GitOpsHandler()
    await h._run({"action": "worktree_add", "worktree_name": "feature-x"})

    status = subprocess.run(
        ["git", "status", "--short"], cwd=repo, capture_output=True, text=True, check=True,
    ).stdout
    assert ".agent-worktrees" not in status


@pytest.mark.asyncio
async def test_worktree_list_includes_added_worktree(repo):
    h = GitOpsHandler()
    await h._run({"action": "worktree_add", "worktree_name": "feature-x"})
    result = await h._run({"action": "worktree_list"})

    assert result.get("success") is True, result
    assert "feature-x" in result["output"]


@pytest.mark.asyncio
async def test_worktree_remove_removes_it(repo):
    h = GitOpsHandler()
    await h._run({"action": "worktree_add", "worktree_name": "feature-x"})
    wt_path = repo / ".agent-worktrees" / "feature-x"
    assert wt_path.is_dir()

    result = await h._run({"action": "worktree_remove", "worktree_name": "feature-x"})

    assert result.get("success") is True, result
    assert not wt_path.exists()

    listing = await h._run({"action": "worktree_list"})
    assert "feature-x" not in listing["output"]


@pytest.mark.asyncio
async def test_worktree_add_can_run_further_actions_via_working_dir(repo):
    h = GitOpsHandler()
    await h._run({"action": "worktree_add", "worktree_name": "feature-x"})

    result = await h._run({
        "action": "status", "working_dir": ".agent-worktrees/feature-x",
    })

    assert result.get("success") is True, result


@pytest.mark.parametrize("bad_name", ["../evil", "a/b", "a\\b", "", ".", ".."])
@pytest.mark.asyncio
async def test_worktree_name_escape_rejected(repo, bad_name):
    h = GitOpsHandler()
    with pytest.raises(SafetyError):
        await h._run({"action": "worktree_add", "worktree_name": bad_name})


@pytest.mark.asyncio
async def test_working_dir_escape_rejected(repo):
    h = GitOpsHandler()
    with pytest.raises(SafetyError):
        await h._run({"action": "status", "working_dir": "../../"})


@pytest.mark.asyncio
async def test_working_dir_default_still_works(repo):
    h = GitOpsHandler()
    result = await h._run({"action": "status"})
    assert result.get("success") is True, result
