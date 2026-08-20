# Frontend mocks — not yet backed by real functionality

This file tracks every piece of `ide/shell/frontend` UI that is currently **visual/mock only** — clickable
(or intentionally inert) but not wired to real backend behavior. It exists so backend work (Go/Wails today,
Tauri later) has a single checklist of what to actually implement, instead of having to diff the whole
frontend against what's real.

**Convention:** only list things that are mocked. Anything already wired to a real Go binding, WS event, or
existing backend concept is NOT listed here, even if it was touched/restyled during the Figma rebuild — e.g.
Explorer, Search, Source Control (Changes + commit list), the swarm session composer/tabs/chat, the footer's
branch/problems/autocomplete/report-issue items, and the Agents page's "Swarm" session list are all real and
intentionally omitted. Add a new entry here every time a new mock/placeholder UI element is built; remove an
entry once its backend is actually wired up.

**Standard mock interaction:** clicking a mocked button/menu item now shows a real toast ("X isn't wired up
yet — frontend only for now.") via `lib/toast.ts` + `components/ToastHost.tsx`, instead of being `disabled`
or silently doing nothing. Use `notYetWired("Feature name")` for any new mock action.

---

## Access Bar — File / Edit / Selection menus (`components/AccessBar.tsx`)

Built out to match VS Code's real menu content from reference screenshots (not Figma — Figma only covers
basic IDE structuring per the user). Most Edit/Selection items are genuinely real (see below); these are the
mocked ones:

- **File > New Window** / **New Window with Profile** — toast. No multi-window support exists (single Wails
  window); would need spawning a new OS process or real multi-window Wails support.
- **File > Open Workspace from File…** / **Add Folder to Workspace…** / **Save Workspace As…** /
  **Duplicate Workspace** — toast. No multi-root `.code-workspace`-style concept exists; `WorkspaceContext`
  only supports one root folder at a time.
- **File > Share** — toast. No sharing/collaboration feature exists.
- **Edit > Replace in Files** — toast. `SearchPanel`/`searchWorkspace` only searches, there's no
  find-and-replace-across-files backend.
- **Edit > Emmet: Expand Abbreviation** — toast. No Emmet package is installed for Monaco.
- **Go > Back / Forward** — toast. No navigation history is tracked.

**What's real in these three menus** (for context, not because it needs tracking): New Text File/New File,
Open File/Folder, Open Recent (real accordion, backed by `recentProjects`), Close Folder, Exit/Close Window,
Save/Save As/Save All/Revert File/Close Editor (new `tangent:save-file` / `tangent:save-file-as` /
`tangent:save-all` / `tangent:revert-file` / `tangent:close-editor` events, handled in `Editor.tsx`), Auto
Save (real settings-backed debounce save), Preferences (opens the real Settings page), and nearly everything
in Edit/Selection — Undo/Redo/Cut/Copy/Paste/Find/Replace/comment-toggling/multi-cursor/line-move commands
all run as real Monaco actions via a new `tangent:editor-command` bridge (`{ detail: { id } }`, dispatched by
AccessBar, handled in `Editor.tsx` by calling `editor.trigger(...)` on the live Monaco instance). "Switch to
Ctrl+Click for Multi-Cursor" and "Column Selection Mode" are real Monaco editor options
(`editorMultiCursorModifier` / `editorColumnSelection` in `lib/settings.ts`).

---

## Access Bar — View / Go / Run menus (`components/AccessBar.tsx`)

Same "real where possible, toast where not" approach, again from reference screenshots (not Figma).

- **View > Open View…** — toast. Redundant with the view list already in the same menu; not worth a second
  quick-pick right now.
- **View > Editor Layout** — toast. No split-editor/multi-pane support exists (`Editor.tsx` is single-pane).
- **View > Testing** — toast. No Testing panel/concept exists anywhere in the sidebar.
- **View > Browser** — toast. No embedded/simple-browser feature.
- **Go > Back / Forward / Last Edit Location** — toast. No navigation-history tracking exists.
- **Go > Switch Editor / Switch Group** — toast. Same single-editor-pane limitation as Editor Layout above.
- **Go > Go to File…** — toast, deliberately **not** implemented naively: a real fuzzy file quick-open needs a
  full recursive file listing, and `WorkspaceContext`/`Editor.tsx` intentionally only load one directory level
  at a time (see the comment above `listEntries` in `WorkspaceContext.tsx`) specifically because eager-walking
  a heavy repo (node_modules, build output) previously crashed the WebView2 renderer. This needs a proper
  backend-side recursive listing endpoint with sensible ignores before it can be built safely.
- **Go > Go to Symbol in Workspace…** — toast. Same reasoning — no workspace-wide symbol index exists.
- **Go > Next Change / Previous Change** — toast. `Editor.tsx` already computes real gutter diff decorations
  (`tangent-gutter-added/modified/deleted`) for the active file, so the data to jump between them exists — just
  no navigation command wired to walk them yet.
- **Run menu** — everything debugging-related (Start/Stop/Restart Debugging, Run Without Debugging, Step
  Over/Into/Out, Continue, breakpoints, launch configurations) is toast. Same root cause as
  `RunDebugPanel.tsx`: no debug-adapter/launch-config system exists in the app at all.

**What's real in these three menus:** Command Palette (Ctrl+Shift+P — a genuinely working quick-open/fuzzy
filter over every real action across all six menus, `components/QuickOpen.tsx`), Appearance's Full Screen and
Zoom In/Out/Reset (real window/CSS state), Explorer/Search/Source Control/Run/Extensions view switches, Chat
(switches to the Agents page), Problems/Output/Debug Console/Terminal (real, and now also un-collapses the
panel if it was hidden), Word Wrap, and — in Go — Go to Symbol in Editor/Definition/Declaration/Type
Definition/Implementations/References/Line-Column/Bracket and Next/Previous Problem, which all dispatch real
Monaco commands via the same `tangent:editor-command` bridge (their usefulness for a given file depends on
Monaco's per-language provider support, exactly like vanilla Monaco/VS Code without a language extension —
that's a pre-existing nuance, not something mocked). "Install Additional Debuggers…" opens the real Extensions
view. "Start Session from Agent Swarm" (Tangent-specific, not in the VS Code reference) stays real, appended to
the bottom of Run.

---

## Access Bar — Terminal / Help menus (`components/AccessBar.tsx`)

- **Terminal > Split Terminal / New Terminal Window** — toast. `Terminal.tsx` supports multiple terminal
  *tabs* (now wired to "New Terminal" for real) but not split-pane layout or a second OS window.
- **Terminal > Run Task… / Run Build Task… / Show Running Tasks… / Restart Running Task… /
  Terminate Task… / Configure Tasks… / Configure Default Build Task…** — toast. No `tasks.json`-style task
  system exists anywhere in the app.
- **Help > Welcome / Editor Playground / Open Walkthrough… / Show Release Notes / Get Started with
  Accessibility Features / Keyboard Shortcuts Reference / Video Tutorials / Tips and Tricks / Join Us on
  YouTube / View License (no LICENSE file in the repo) / Privacy Statement / Toggle Developer Tools / Open
  Process Explorer / Check for Updates…** — toast, no real content/binding behind any of these.
- Renamed VS Code's **"Ask @vscode"** to **"Ask Tangent"** — same reasoning as the earlier Kiro→Agents rename,
  don't ship another product's branding. Wired for real: switches to the Agents page.

**What's real:** "New Terminal" now really spawns a terminal via `Terminal.tsx`'s existing (previously only
UI-button-triggered) `addTerminal()`. "Run Active File" and "Run Selected Text" are genuinely new real
features — `Editor.tsx` computes a run command from the active file's extension (a small honest set: py/js/ts/
go/sh/ps1 — anything else toasts rather than guessing) or the live Monaco selection, and hands it to
`Terminal.tsx` via a new `tangent:terminal-run` event, which reuses the active terminal or spins up a new one
and queues the command until it's ready. "Show All Commands" and "Documentation"/"Search Feature
Requests"/"Report Issue" reuse the real Command Palette and real external-URL opening (same pattern as the
footer's Report Issue). "About" is unchanged/real (was already just a `window.alert`).

---

## Access Bar — Customize Layout panel (`components/CustomizeLayout.tsx`)

Opened from the layout icon (now correctly ordered to match VS Code: Customize Layout, Primary Side Bar,
Panel, Secondary Side Bar). Almost entirely real — reuses the same collapse state the individual layout-toggle
icons already drive, plus new settings-backed toggles (`lib/settings.ts`: `menuBarVisible`,
`activityBarVisible`, `statusBarVisible`, `primarySideBarPosition`, `quickInputPosition`, `zenMode`,
`centeredLayout`). Primary Side Bar Position genuinely flips the grid — both the column track sizes and DOM
order swap together, the explorer's resize handle moves to the correct edge, and drag direction inverts to
match. Zen Mode really collapses both sidebars + the panel and hides the menu/activity/status bars (Escape
exits). Centered Layout really constrains the editor pane to a max-width. Quick Input Position really moves
where the Command Palette opens (top vs. vertically centered).

- **Panel Alignment (Left/Right/Center/Justify)** — the one mocked section. VS Code aligns the panel against
  the *whole window* (it can extend under the sidebars); ours only ever spans the editor column, so there's
  nothing real for Left/Right/Justify to mean without a structural change to how the panel is laid out. Toasts
  explain why on click; "Center" stays visually checked since that's effectively our only real state.

---

## IDE page — left sidebar

### Extensions panel (`components/ExtensionsPanel.tsx`)
- **Mocked:** The entire panel. The extension list (Python, Go, Docker, GitLens, Claude Code, etc.) is
  hardcoded example data — there is no extension host, marketplace, or install system. The search box doesn't
  search anything. "Install" buttons are disabled and do nothing.
- **Needs from backend:** An actual extension/plugin system (discovery, install, enable/disable), or a decision
  that this stays permanently cosmetic.

### Powers panel (`components/PowersPanel.tsx`)
- **Mocked:** The entire panel. "Installed" and "Available" entries (Postman, AWS Transform, Figma, Miro,
  "Add Custom Power") are hardcoded example marketplace content with no install/runtime system behind them.
- **Needs from backend:** A real "power"/capability marketplace and install flow, or a decision this stays
  cosmetic.

### Run and Debug panel (`components/RunDebugPanel.tsx`)
- **Mocked:** Everything. "Run and Debug" button is disabled. "create a launch.json file" link is disabled.
- **Needs from backend:** A debug-adapter/launch-config system (no such concept exists anywhere in the app
  today — there's no debugger integration at all, only the plain integrated terminal).

### Agents panel (`components/AgentsPanel.tsx`) — sidebar panel, distinct from the top-level Agents page
- **Mocked:** "Create New Spec" and "Create New Hook" buttons are disabled. The "Agent Steering & Skills" list
  (`architecture-selection`, `quick-spec`, `bug-fix`) is hardcoded static text, **not** read from the swarm's
  real 34 `agents/*/spec.yaml`. "MCP Servers" section is static placeholder text only.
- **Needs from backend:** A Go binding to list/read the real agent specs (small, was explicitly scoped out of
  the first pass), plus real spec-authoring, agent-hooks, and MCP-server-management systems, none of which
  exist today.

### Activity bar — Account icon (`App.tsx`)
- **Mocked:** No `onClick` at all. Purely decorative. No account/auth/sign-in system exists anywhere in the app.
- **Needs from backend:** An actual account system, or a decision to remove/repurpose the icon.

### Bottom panel — "Ports" tab (`App.tsx`)
- **Mocked:** Disabled tab, no content behind it.
- **Needs from backend:** Port-forwarding/dev-server-detection support (doesn't exist).

### Footer — Warnings count (`App.tsx`)
- **Mocked:** Hardcoded to always display `0`. The code-intel diagnostics model only tracks one combined
  `diagnosticCount` (rendered correctly next to the error icon) — there's no separate warnings classification.
- **Needs from backend:** Diagnostics need a severity field (error vs. warning) surfaced from
  `internal/codeintel` through to the frontend event, instead of the current single count.

---

## Agents page (`components/AgentsWorkspace.tsx`, `components/AgentsChatTranscript.tsx`)

### "Artifacts" nav view
- **Mocked:** Fully static empty state ("Artifacts will appear here once a session writes build output").
  Nothing tracks build/session artifacts anywhere in the app.
- **Needs from backend:** An artifacts/build-output tracking system tied to sessions.

### "Connect to GitHub" icon (Projects header)
- **Mocked:** Disabled. No GitHub org/account-level connect flow (this is separate from `SourceControl.tsx`'s
  already-real per-repo GitHub PR integration, which stays out of this file since it's genuinely wired).
- **Needs from backend:** An actual GitHub App/OAuth connect flow at the account level, if that's ever wanted.

### "Agent Session History" — Workspace / Project / All filter tabs
- **Mocked:** Visually distinct tabs that currently all show the identical list. `SessionSummary` has no
  per-workspace/project field to filter by yet, so there's nothing to differentiate them. Only the adjacent
  search box does real filtering (client-side, over real session goals).
- **Needs from backend:** A `root`/workspace field on `SessionSummary` (Go: `internal/session/types.go` +
  `ListSessions`) so sessions can actually be grouped/filtered by which project they belong to.

### Hero composer — mode is hardcoded to "simulated"
- **Not a fake button, but a scope gap worth tracking:** unlike the IDE sidebar's fuller composer
  (`SessionList.tsx`, which exposes Simulated/Container mode + a provider-key panel), the Agents page's hero
  composer always calls `startSession(goal, topology, "simulated")` — there's currently no way to start a
  **container**-mode session from this entry point.
- **Needs from backend:** Nothing new on the backend side — this is a frontend follow-up (add the mode/provider
  picker here too) whenever it's prioritized.

### Source Control "Graph" section (`components/SourceControl.tsx`)
- **Not mocked, but a fidelity gap worth tracking:** renders real commit messages via the existing `GitLog`
  binding, but as a flat list, not the branch-line graph Figma's design shows. `GitHubCommit` also only carries
  `message` today (no hash/author/date).
- **Needs from backend:** `GitLog` would need to return hash/author/date/parents (Go: `git.go`) to support a
  real graph render; the graph-line layout itself is a frontend data-viz task on top of that.
