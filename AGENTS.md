# OpenXTerm Agent Notes

This is the fastest way for a fresh AI agent to get productive in this repo.

## What This Project Is

OpenXTerm is a Tauri 2 desktop app that recreates a MobaXterm-like workflow:

- left sidebar with `Sessions`, `SFTP`, `Tools`, `Macros`
- tabbed workspace for terminals and file browsers
- Rust-native transports for Local shell, SSH, Telnet, and Serial
- remote file browser for SFTP / FTP-shaped workflows
- local persistence for sessions, session folders, macros, and UI preferences
- lower status bar with live host metrics and session actions

The README is the public project overview. Treat this file and the code as the source of truth for implementation details and current invariants.

## Quick Start

From repo root:

```bash
npm install
./script/build_and_run.sh
```

`npm install` now provisions the local `@tauri-apps/cli` binary used by `npm run tauri:dev` / `npm run tauri:build`, so the repo no longer assumes a globally installed Tauri CLI.

Useful checks:

```bash
npm run check
npm run build
cargo build --manifest-path src-tauri/Cargo.toml
./script/build_and_run.sh --verify
```

`./script/build_and_run.sh` kills old Vite / Tauri / debug app processes before starting a fresh dev run.

CI/CD workflow:

- [`.github/workflows/ci-cd.yml`](/Volumes/EXT/Projects/OpenXTerm/.github/workflows/ci-cd.yml) runs verification plus a five-platform bundle matrix
- matrix targets currently are Linux X64, Windows X64, Windows ARM64, macOS ARM64, and macOS X64
- tags matching `v*` publish GitHub Release assets from those bundle outputs

## Repo Map

### Frontend

- [`src/App.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/App.tsx): top-level wiring, modals, sidebar/workspace composition
- [`src/state/useOpenXTermStore.ts`](/Volumes/EXT/Projects/OpenXTerm/src/state/useOpenXTermStore.ts): central state and most app workflows
- [`src/components/forms/SessionEditorModal.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/forms/SessionEditorModal.tsx): compact tabbed session editor, X11 assistant, per-session terminal style, font picker
- [`src/components/forms/AppLockOverlay.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/forms/AppLockOverlay.tsx): lock screen for system auth / Touch ID / PIN flows
- [`src/components/sidebar/Sidebar.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/sidebar/Sidebar.tsx): sessions tree, session-folder drag/drop, SFTP sidebar, tools, macros
- [`src/components/status/StatusBar.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/status/StatusBar.tsx): live lower rail, CPU history graph, lock button
- [`src/components/workspace/Workspace.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/Workspace.tsx): active tab rendering
- [`src/components/workspace/TerminalSurface.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/TerminalSurface.tsx): xterm host, stopped-session UX, per-session appearance application
- [`src/components/workspace/FileBrowserView.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/FileBrowserView.tsx): remote directory UI, upload/download/drag flows
- [`src/lib/bridge.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/bridge.ts): Tauri invoke/listen boundary
- [`src/lib/sessionUtils.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/sessionUtils.ts): shared tab/session helpers and startup transcript copy
- [`src/lib/mobaxtermImport.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/mobaxtermImport.ts): `.mxtsessions` parser
- [`src/lib/transferBatch.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/transferBatch.ts): batch transfer aggregation
- [`src/index.css`](/Volumes/EXT/Projects/OpenXTerm/src/index.css): main app styling, including session editor and font picker layout

### Backend

- [`src-tauri/src/lib.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/lib.rs): Tauri app bootstrap and command registration
- [`src-tauri/src/commands.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/commands.rs): invoke handlers
- [`src-tauri/src/runtime.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/runtime.rs): live Local / SSH / Telnet / Serial runtime and X11 diagnostics
- [`src-tauri/src/file_ops.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/file_ops.rs): remote file ops and transfer progress
- [`src-tauri/src/font_support.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/font_support.rs): system font enumeration through `font-kit`
- [`src-tauri/src/libssh_spike.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/libssh_spike.rs): embedded `libssh-rs` spike for helper/backend evaluation
- [`src-tauri/src/x11_support.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/x11_support.rs): local X11 / XQuartz / X server detection helpers
- [`src-tauri/src/native_drag.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/native_drag.rs): native drag bridge
- [`src-tauri/src/native_drag_macos.m`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/native_drag_macos.m): macOS AppKit drag implementation
- [`src-tauri/src/storage.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/storage.rs): persistence
- [`src-tauri/src/models.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/models.rs): serde models mirrored from TS

### CI/CD

- [`.github/workflows/ci-cd.yml`](/Volumes/EXT/Projects/OpenXTerm/.github/workflows/ci-cd.yml): GitHub Actions verification/build/release pipeline

## Core Architecture

### 1. Store-first app flow

Most user actions route through Zustand:

- UI triggers store action
- store updates optimistic/local state
- store calls Tauri bridge when needed
- backend emits terminal/status/transfer events
- store listens once and fans those events back into UI state

If you are changing behavior, start in [`useOpenXTermStore.ts`](/Volumes/EXT/Projects/OpenXTerm/src/state/useOpenXTermStore.ts).

### 2. Terminal tabs vs file tabs

`createSessionTab()` in [`sessionUtils.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/sessionUtils.ts) maps:

- `local`, `ssh`, `telnet`, `serial` -> terminal tab
- `sftp`, `ftp` -> file browser tab

Linked SFTP tabs for live SSH sessions are synthetic sessions with ids like `linked-sftp-<ssh-tab-id>`.

### 3. Frontend/backend contract

If you add a new persisted field or command, you usually need to touch all of:

1. [`src/types/domain.ts`](/Volumes/EXT/Projects/OpenXTerm/src/types/domain.ts)
2. [`src-tauri/src/models.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/models.rs)
3. [`src/lib/bridge.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/bridge.ts)
4. [`src-tauri/src/commands.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/commands.rs)
5. [`src-tauri/src/lib.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/lib.rs)
6. Store/UI call sites

[`bridge.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/bridge.ts) also contains a browser/localStorage fallback for non-Tauri runs. It is useful for UI iteration, but desktop behavior should be validated in real Tauri because terminal transports, remote file ops, native drag, X11 checks, font enumeration, and window behavior only exist there.

## Important Invariants

### Terminal stopped state is explicit

Do not infer “session stopped” from terminal text.

The correct source is [`terminalStoppedByTabId`](/Volumes/EXT/Projects/OpenXTerm/src/state/useOpenXTermStore.ts) in the store, which is driven by terminal-exit events.

Relevant files:

- [`src/state/useOpenXTermStore.ts`](/Volumes/EXT/Projects/OpenXTerm/src/state/useOpenXTermStore.ts)
- [`src/components/workspace/TerminalSurface.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/TerminalSurface.tsx)

`TerminalSurface` should swallow all normal input while stopped, except:

- `Enter` -> close tab
- `R` -> restart tab
- `S` -> save terminal output

### Session/folder drag in `Sessions` is pointer-based

The sessions tree drag/drop is not native HTML5 DnD. It uses pointer tracking in [`Sidebar.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/sidebar/Sidebar.tsx) because that proved more reliable inside Tauri/WebKit.

If drag in `Sessions` breaks, inspect `Sidebar.tsx` first and be careful about replacing it with browser DnD APIs.

### Session folders are real persisted entities

Folders are not just a display-only path string.

- sessions still carry `folderPath`
- folder objects are separately persisted as `SessionFolderDefinition`
- empty folders should survive restart
- moving a folder moves the subtree and rewrites child `folderPath` values

Relevant files:

- [`src/components/forms/SessionFolderModal.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/forms/SessionFolderModal.tsx)
- [`src/components/forms/MoveSessionModal.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/forms/MoveSessionModal.tsx)
- [`src/state/useOpenXTermStore.ts`](/Volumes/EXT/Projects/OpenXTerm/src/state/useOpenXTermStore.ts)

### Multi-transfer progress is job-based

Multiple uploads/downloads/drag exports should appear as one parent transfer job, not one modal per item.

Implementation:

- parent ids: `createBatchTransferId(...)`
- child ids: `createBatchChildTransferId(...)`
- aggregation: [`src/lib/transferBatch.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/transferBatch.ts)

If you add a new multi-item transfer path, wire it into batch aggregation instead of emitting standalone child UI jobs.

### macOS native drag-out has a fragile ABI boundary

This area already caused real crashes.

Current rule:

- Rust passes JSON bytes plus explicit length
- Objective-C reconstructs `NSData` / `NSString` using that length
- exported native symbol is `openxterm_start_file_promise_drag_v2`

Do not revert this to `CString` + `stringWithUTF8String`.

Relevant files:

- [`src-tauri/src/native_drag.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/native_drag.rs)
- [`src-tauri/src/native_drag_macos.m`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/native_drag_macos.m)
- [`src-tauri/build.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/build.rs)

### SSH sessions without username are special

If `session.username` is empty, the embedded SSH runtime cannot connect yet because it still needs a resolved remote login before authentication starts.

Current behavior in [`runtime.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/runtime.rs):

- the terminal prints `login as:` locally
- entered value is cached in per-tab runtime metadata before the SSH connection is opened
- if password auth is selected and the profile has no saved password, the terminal then prompts locally for `<user>@<host>'s password:`
- the entered password is kept in runtime memory for the life of that tab so linked SFTP/status helpers can reuse it without persisting it to storage

Do not change this back to “just use the local OS username” if the goal is MobaXterm-like login behavior.

### Linked SFTP and status use helper SSH sessions, not OpenSSH control sockets

OpenXTerm no longer relies on OpenSSH control-socket reuse for live SSH tabs.

Current behavior:

- terminal SSH tabs use the embedded `libssh-rs` runtime
- live status uses a separate embedded helper SSH session
- linked SFTP uses a separate embedded helper SSH/SFTP session
- helper connections can resolve username from per-tab runtime metadata when the saved profile leaves `username` empty
- helper connections can reuse a live interactively entered password from per-tab runtime metadata while the SSH tab is still connected

Operational consequence:

- if the user closes the live SSH tab, transient username/password metadata is cleared with it
- after that point, helper reconnects still require one of:
  - saved password in the profile
  - private key auth
  - working SSH agent auth
- if none of those are available, the UI should surface a clear error instead of pretending the connection is “limited”

Relevant files:

- [`src-tauri/src/runtime.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/runtime.rs)
- [`src-tauri/src/file_ops.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/file_ops.rs)

### X11 forwarding uses the embedded SSH bridge

OpenXTerm's GUI forwarding path uses the embedded `libssh-rs` runtime:

- request X11 forwarding on the live SSH session channel
- accept SSH X11 channels from the server
- proxy each X11 channel to the user's local X server
- local X server on the user's desktop
- no extra GUI transport installed on the remote host by OpenXTerm

Current product guidance:

- on macOS, built-in X11 should prefer XQuartz
- on Linux, prefer the current desktop Xorg/XWayland environment
- on Windows, users need a local X server such as VcXsrv or X410

Relevant files:

- [`src/components/forms/SessionEditorModal.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/forms/SessionEditorModal.tsx)
- [`src-tauri/src/x11_support.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/x11_support.rs)
- [`src-tauri/src/runtime.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/runtime.rs)

### X11 diagnostics are runtime-driven and session-scoped

The SSH runtime detects real X11 failure text from the interactive PTY and then emits one-shot diagnostics based on:

- remote `xauth`
- `sshd -T`
- `sshd -T -C ...` for the active user/client
- `HOME` / `~/.Xauthority` writability
- IPv6-disabled edge cases

Important nuance:

- changes in `sshd_config` only affect brand-new SSH logins
- the current shell will not gain `DISPLAY` retroactively
- the older control-socket `DISPLAY` probe was removed because it was misleading

If you touch X11 behavior, preserve that distinction.

### Session terminal appearance is per-session data

Sessions can persist their own terminal appearance overrides:

- `terminalFontFamily`
- `terminalFontSize`
- `terminalForeground`
- `terminalBackground`

The editor can enumerate real system fonts through the Rust `font-kit` bridge. Terminal rendering applies these values in [`TerminalSurface.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/TerminalSurface.tsx).

If you add a new appearance field, update:

- [`src/types/domain.ts`](/Volumes/EXT/Projects/OpenXTerm/src/types/domain.ts)
- [`src-tauri/src/models.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/models.rs)
- [`src/state/useOpenXTermStore.ts`](/Volumes/EXT/Projects/OpenXTerm/src/state/useOpenXTermStore.ts)
- [`src/components/forms/SessionEditorModal.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/forms/SessionEditorModal.tsx)
- [`src/components/workspace/Workspace.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/Workspace.tsx)
- [`src/components/workspace/TerminalSurface.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/TerminalSurface.tsx)

### Status bar data is live only

The lower bar is no longer a mock/preview strip. It is driven by live state:

- no fake preview mode
- loading until real data arrives
- error after repeated failed polls, but polling keeps retrying
- CPU history is real per-tab history, not a fabricated graph

Current Windows nuance:

- Windows SSH status should attempt a real status probe through the embedded helper connection
- showing `limited` is not the steady-state success path anymore; missing saved credentials should become an explicit error instead

Relevant files:

- [`src/components/status/StatusBar.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/status/StatusBar.tsx)
- [`src/state/useOpenXTermStore.ts`](/Volumes/EXT/Projects/OpenXTerm/src/state/useOpenXTermStore.ts)
- [`src-tauri/src/runtime.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/runtime.rs)

### Console logging is error-only and intentional

Frontend console logging is now deliberately scoped to errors.

Current rule:

- use [`src/lib/errorLog.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/errorLog.ts) for UI/runtime error reporting
- log only through `console.error`
- do not add ambient info/debug noise to the console just to trace normal flow
- repeated status/transfer poller failures should be deduplicated so the console is still usable during retries

Relevant files:

- [`src/lib/errorLog.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/errorLog.ts)
- [`src/state/useOpenXTermStore.ts`](/Volumes/EXT/Projects/OpenXTerm/src/state/useOpenXTermStore.ts)
- [`src/components/sidebar/Sidebar.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/sidebar/Sidebar.tsx)
- [`src/components/workspace/FileBrowserView.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/FileBrowserView.tsx)

### Non-macOS topbar menus are app-owned UI, not native shell menus

On macOS the app still uses the native menu integration from Tauri. On non-macOS platforms, the visible topbar menu row is a React-owned control surface and must remain clickable.

Current rule:

- do not treat the whole topbar as a drag region
- only non-interactive portions such as the breadcrumb should carry `data-tauri-drag-region`
- topbar dropdown actions should route through the same handler path as native menu actions so behavior stays consistent across platforms

Relevant files:

- [`src/components/layout/TopBar.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/layout/TopBar.tsx)
- [`src/App.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/App.tsx)
- [`src-tauri/src/native_menu.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/native_menu.rs)
- [`src/index.css`](/Volumes/EXT/Projects/OpenXTerm/src/index.css)

### MobaXterm import support

Parser lives in [`src/lib/mobaxtermImport.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/mobaxtermImport.ts).

Currently supported:

- SSH
- Telnet
- FTP
- SFTP
- Serial

Current unsupported examples seen in real data:

- VNC
- WSL

`SubRep` is used to build the folder tree.

## Current Feature Snapshot

This is the practical feature state as of April 16, 2026:

- local shell transport exists
- live SSH / Telnet / Serial transports exist
- remote file listing / create folder / delete / upload / download exist
- native desktop drag-out exists
- session folders/tree exist
- session and folder drag/drop in sidebar exist
- MobaXterm import exists
- terminal stopped footer with restart/save shortcuts exists
- terminal search exists through `Ctrl+F` / `Cmd+F`, topbar search, and terminal menu actions
- linked SFTP session discovery from live SSH tabs exists
- live SSH terminal tabs now run through an embedded `libssh-rs` backend instead of system `ssh`
- linked SFTP and live status helper flows now run through embedded helper SSH sessions
- app lock via system auth exists
- X11 session settings and runtime diagnostics exist
- embedded `libssh-rs` probe exists for backend evaluation and backend comparison work
- per-session terminal font / size / foreground / background exist
- local sessions can persist their own working directory
- session editor is compact and tabbed
- system font enumeration for the terminal editor exists
- status bar is live and session-aware
- non-macOS topbar menus are clickable dropdowns
- frontend error-only console logging exists for status, transfers, terminal launch/input, and file-browser flows
- GitHub Actions CI/CD exists for Linux X64, Windows X64, Windows ARM64, macOS ARM64, and macOS X64

Important caveats:

- embedded X11 forwarding still depends on a working local X server and correct remote `sshd` behavior
- linked SFTP/status can reuse an interactively entered SSH password only while the live SSH tab that captured it is still running
- after the live tab stops, helper reconnects fall back to saved password, key, or agent auth
- on Windows, drag-out starts immediately and only stages the remote file into the local temp cache lazily if the shell requests file contents on drop
- GitHub Actions currently publishes unsigned / unnotarized bundles unless release signing secrets are added in the future

Some startup transcript copy still exists in helpers like [`sessionUtils.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/sessionUtils.ts). Do not assume every “preview” string means the feature is fake.

## Where To Edit For Common Tasks

### Add or change session fields

Start with:

- [`src/types/domain.ts`](/Volumes/EXT/Projects/OpenXTerm/src/types/domain.ts)
- [`src-tauri/src/models.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/models.rs)
- [`src/components/forms/SessionEditorModal.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/forms/SessionEditorModal.tsx)
- storage and bridge files

### Change session tree behavior

Start with:

- [`src/components/sidebar/Sidebar.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/sidebar/Sidebar.tsx)
- [`src/state/useOpenXTermStore.ts`](/Volumes/EXT/Projects/OpenXTerm/src/state/useOpenXTermStore.ts)

### Change terminal UX

Start with:

- [`src/components/workspace/TerminalSurface.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/TerminalSurface.tsx)
- [`src/components/workspace/Workspace.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/Workspace.tsx)
- [`src/components/status/StatusBar.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/status/StatusBar.tsx)
- [`src/state/useOpenXTermStore.ts`](/Volumes/EXT/Projects/OpenXTerm/src/state/useOpenXTermStore.ts)
- [`src-tauri/src/runtime.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/runtime.rs)

### Change session editor or appearance controls

Start with:

- [`src/components/forms/SessionEditorModal.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/forms/SessionEditorModal.tsx)
- [`src/index.css`](/Volumes/EXT/Projects/OpenXTerm/src/index.css)
- [`src/lib/bridge.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/bridge.ts)
- [`src-tauri/src/font_support.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/font_support.rs)

### Change X11 / GUI forwarding behavior

Start with:

- [`src/components/forms/SessionEditorModal.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/forms/SessionEditorModal.tsx)
- [`src-tauri/src/x11_support.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/x11_support.rs)
- [`src-tauri/src/runtime.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/runtime.rs)

### Change file transfer behavior

Start with:

- [`src/components/workspace/FileBrowserView.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/workspace/FileBrowserView.tsx)
- [`src/components/sidebar/Sidebar.tsx`](/Volumes/EXT/Projects/OpenXTerm/src/components/sidebar/Sidebar.tsx)
- [`src/lib/transferBatch.ts`](/Volumes/EXT/Projects/OpenXTerm/src/lib/transferBatch.ts)
- [`src-tauri/src/file_ops.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/file_ops.rs)
- [`src-tauri/src/native_drag.rs`](/Volumes/EXT/Projects/OpenXTerm/src-tauri/src/native_drag.rs)

## Verification Checklist

For UI/state changes:

```bash
npm run check
./script/build_and_run.sh --verify
```

For Rust/native changes:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
npm run check
./script/build_and_run.sh --verify
```

For anything touching native drag or transfers, do at least one manual pass in the running app.

There is no broad automated test suite yet. In practice, `npm run check`, Rust build, and a real app smoke test are the main safety net.

For v0.2 terminal copy/paste/resize QA across macOS, Linux, and Windows, use the manual checklist in `docs/qa/v0.2-core-reliability.md`.

For release-pipeline changes:

```bash
npm run check
cargo check --manifest-path src-tauri/Cargo.toml
```

Then inspect [`.github/workflows/ci-cd.yml`](/Volumes/EXT/Projects/OpenXTerm/.github/workflows/ci-cd.yml) carefully for:

- runner label correctness
- target triple correctness
- Linux package dependencies
- release trigger scope
- asset upload paths

## Notes For Future Agents

- Prefer this file over the README for feature status.
- Prefer reading the store before making assumptions about flow.
- If a behavior seems duplicated between frontend and backend, verify whether one side is preview copy and the other side is the real implementation.
- When fixing regressions around drag, transfers, terminal lifecycle, or X11, assume there was previous hard-won behavior there for a reason and inspect git history before simplifying aggressively.
- If you change `sshd_config` assumptions while debugging X11, remember that only a brand-new SSH login can prove the fix.
- If the session editor starts feeling crowded, keep favoring progressive disclosure and tabs over stacking more controls in one column.
