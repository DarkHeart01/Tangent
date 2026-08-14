# Installs the `swarm` CLI as a standalone tool, independent of this
# checkout — bootstraps uv if needed, then `uv tool install`s this package
# from local source. No public registry involved yet: source is always
# this checkout's own pyproject.toml, resolved relative to this script,
# not a package name.
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "uv not found -- installing via astral.sh's standalone installer..."
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    # The installer writes to $HOME\.local\bin but doesn't update the
    # *current* session's PATH -- needed so `uv tool install` below can
    # find the binary it just installed.
    $env:Path = "$HOME\.local\bin;$env:Path"
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Error "uv was installed but is still not on PATH. Add `$HOME\.local\bin to PATH and re-run this script."
    exit 1
}

Write-Host "Installing swarm CLI from $RepoRoot ..."
uv tool install --force $RepoRoot

Write-Host ""
Write-Host "Done. If 'swarm --version' doesn't work in this shell yet, run:"
Write-Host "  uv tool update-shell"
Write-Host "and open a new shell."
