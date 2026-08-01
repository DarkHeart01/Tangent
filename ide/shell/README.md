# Tangent IDE shell

The Tangent IDE is a Wails desktop shell for the Tangent Swarm. It combines a VS Code-style workspace with the existing Go session API and authenticated localhost WebSocket stream. The current upgrade is frontend-focused: the Swarm runtime, session manager, approval gates, workspace RPCs, and event contracts remain the source of truth.

## Current state

The IDE is usable for frontend workspace browsing, editing, and simulated/session monitoring.

Implemented:

- VS Code-style dark shell with a draggable title bar and application menu.
- Explorer, Monaco editor, Agent Swarm panel, and bottom panel in one persistent layout.
- Resizable Explorer, Agent Swarm, and Terminal/Problems/Output/Debug Console regions.
- First-launch Welcome view with New File, Open File, Open Folder, and persisted Recent Projects.
- Local workspace loading through the browser File System Access API, with a `webkitdirectory` fallback for WebViews that do not expose directory handles.
- Workspace-relative file tree, folders, language-aware Monaco editing, tabs, dirty state, Ctrl/Cmd+S, and file updates for clean buffers.
- Explorer/workspace right-click menus with new file/folder, copy path, terminal focus, remove workspace, and delete actions.
- Native file/folder deletion when the selected workspace grants File System Access permissions; fallback workspaces update the in-memory IDE view.
- Agent Swarm setup and monitoring views backed by the existing Wails session methods and WebSocket event stream.
- GitHub CLI integration shown only for authenticated `gh` users in GitHub-backed repositories: current-branch PR/check status, browser links, PR creation, push-and-create recovery, and a collapsed open-PR list.
- Human approval gate actions and reconnect controls.
- Real xterm terminal tabs backed by OS PTYs: PowerShell/cmd with ConPTY on Windows and the user's `$SHELL`/bash with Unix PTYs on macOS/Linux. Input, control characters, raw output, resize events, interactive programs, and process cleanup are handled by the native shell.
- Streaming `terminal.output` rendering from an active Swarm session.

The frontend does not modify the Swarm core, Python agents, session event envelopes, or WebSocket sequencing. The shell has additive Go workspace/Git/GitHub surfaces for operations that cannot be performed safely by a browser-only frontend.

## Layout

```text
Title bar / menu
  Activity rail | Explorer | Editor + bottom panel | Agent Swarm
```

The initial screen shows the Welcome view when there is no active session or selected local workspace. Opening a folder immediately establishes the workspace context; its tree is populated as the folder is enumerated. Selecting a file in Explorer opens it in the central Monaco editor.

## Frontend structure

| File | Responsibility |
| --- | --- |
| `frontend/src/App.tsx` | Persistent IDE layout, panel sizing, bottom-panel selection, and shell-level events |
| `frontend/src/lib/WorkspaceContext.tsx` | Local workspace state, recent projects, file/folder operations, and persistence |
| `frontend/src/lib/SessionContext.tsx` | Session lifecycle, active session, WebSocket clients, and reconnect behavior |
| `frontend/src/components/Editor.tsx` | Explorer tree, context menus, Monaco tabs, editing, and saves |
| `frontend/src/components/ContextMenu.tsx` | Shared Explorer/workspace context menu |
| `frontend/src/components/WelcomeView.tsx` | First-launch and recent-project view |
| `frontend/src/components/SessionList.tsx` | Session setup and recent goals |
| `frontend/src/components/Dashboard.tsx` | Macro phase, budget, event feed, and operator controls |
| `frontend/src/components/Terminal.tsx` | PTY-backed xterm tabs, raw input/output, resize handling, and streamed Swarm terminal output |
| `terminal.go` | Additive PTY process manager, Wails terminal methods/events, shell selection, and lifecycle cleanup |
| `terminal_process_unix.go` / `terminal_process_windows.go` | Platform-specific process-tree cleanup for Unix process groups and Windows ConPTY trees |
| `frontend/src/components/SourceControl.tsx` | Git status, staging, commit, branch, sync, conflict, diff, and conditional GitHub PR actions |
| `frontend/src/style.css` and `frontend/src/App.css` | IDE tokens, layout, menus, panels, and visual states |
| `git.go` | Additive native workspace picker, secure file operations, Git status/diff/branch/commit/sync methods |
| `github.go` | Timeout-bounded `gh` detection/auth, PR status/list/create, default branch, and commit summary methods |

## Development

From `ide/shell`:

```powershell
# Start the Wails desktop app with frontend hot reload
$env:GOARCH = "amd64"
wails dev
```

`GOARCH=amd64` is required on this machine's toolchain: the installed Go defaults to `windows/386`, which is far more prone to the crash below, though not immune to it.

### Known crash: `fatal error: traceback: unexpected SPWRITE function sigtramp`

The app can crash — usually shortly after the WebView2 environment initializes and the frontend starts loading its ~100+ asset chunks — with a Go runtime-level (not application) fatal error originating in a goroutine spawned by Wails' `assetserver.(*AssetServer).ServeWebViewRequest`. Every WebView2 resource request spawns a bare `go` goroutine directly from the WebView2 COM callback thread (Wails v2.13.0 has no worker-pool path wired up — `dispatchWorkers` is never set), and under load one of those goroutines can need a stack grow/copy at the exact moment its OS thread is mid-transition through the COM callback trampoline, which trips Go's stack-safety check and aborts the process.

Ruled out so far (none of these fixed it, each confirmed active at the time of a repeat crash):
- `GOARCH=amd64` vs `windows/386` — changes crash frequency, not whether it happens.
- `GODEBUG=asyncpreemptoff=1` — irrelevant; on Windows this crash path isn't scheduler-preemption-related (Windows async-preempt uses `SuspendThread`, not signals).
- `-tags native_webview2loader` (legacy loader) vs the new Go-native loader — both share the same request-callback code path.
- Wails v2.13.0 is the latest available v2 release; there's no newer patch to upgrade to.

Likely cause: a version skew between this Go toolchain and what Wails v2.13.0 was built/tested against. Not yet fixed — see project memory for current status before assuming otherwise.

`wails dev` opens the native Tangent IDE window. The `http://localhost:34115` URL printed by Wails is an optional browser preview; it does not provide the native Go bindings, PTY terminal, or Swarm session controls.

Frontend-only development can be run from `ide/shell/frontend`:

```powershell
npm install
npm run dev
npx tsc --noEmit
npm run build
```

Go validation:

```powershell
cd ide/shell
go test ./...
```

The production bundle contains Monaco and can require additional Node heap on constrained machines:

```powershell
$env:NODE_OPTIONS = "--max-old-space-size=8192"
npm run build
```

## Current boundaries and follow-up work

These limitations are intentional and should not be confused with implemented UI behavior:

1. Git integration requires the host `git` executable and a repository-backed workspace. GitHub controls require the host `gh` executable, an existing `gh auth login`, and an `origin` URL hosted on GitHub; otherwise the GitHub section is not rendered.
2. The local terminal requires the Wails desktop runtime and the platform's shell. Browser-only Vite development displays a native-PTY availability notice; Swarm container command execution remains owned by the existing runtime and exec API.
3. Selecting a session summary after a full application restart does not recreate its WebSocket URL because the current backend has no session-stream-reopen method. Sessions started in the current window reconnect normally.
4. The Swarm chat composer can publish the existing intervention frame, but the current Go WebSocket server only resolves approval-gate frames. Full operator-message routing needs the additive session message bridge described in the frontend upgrade plan.
5. Recent folder entries are persisted in browser local storage. Reopening one prompts for folder access again when the desktop WebView cannot persist a directory handle; in the Wails desktop build, the native picker returns the absolute root and file changes are applied directly there.

The native additions are isolated to workspace, Git, GitHub, and terminal methods and preserve the existing Wails methods and WebSocket envelope sequencing. No Swarm or Python implementation changes are required.
