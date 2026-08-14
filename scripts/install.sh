#!/usr/bin/env bash
# Installs the `swarm` CLI as a standalone tool, independent of this
# checkout — bootstraps uv if needed, then `uv tool install`s this package
# from local source. No public registry involved yet (see Phase A/B notes
# in the task this shipped with): source is always this checkout's own
# pyproject.toml, resolved relative to this script, not a package name.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found — installing via astral.sh's standalone installer..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # The installer writes to ~/.local/bin (or ~/.cargo/bin on older uv
  # releases) but doesn't update the *current* shell's PATH — needed so the
  # `uv tool install` a few lines down can find the binary it just installed.
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv was installed but is still not on PATH." >&2
  echo "Add \$HOME/.local/bin to PATH and re-run this script." >&2
  exit 1
fi

echo "Installing swarm CLI from $REPO_ROOT ..."
uv tool install --force "$REPO_ROOT"

echo
echo "Done. If 'swarm --version' doesn't work in this shell yet, run:"
echo "  uv tool update-shell"
echo "and open a new shell."
