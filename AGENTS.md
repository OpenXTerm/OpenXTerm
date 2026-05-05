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

On Windows, `npm run tauri:dev` / `npm run tauri:build` go through `script/run_tauri.mjs`. That wrapper checks for a full Perl before Cargo starts because `libssh-rs` builds vendored OpenSSL; if no usable Perl is found, it prints Strawberry Perl install commands.

Direct `cargo` commands on Windows still require `perl.exe` to be visible in the current shell `PATH`; open a fresh terminal after installing Strawberry Perl or prepend `C:\Strawberry\perl\bin` for that command.

Useful checks:

```bash
npm run check
npm run build
cargo build --manifest-path src-tauri/Cargo.toml
./script/build_and_run.sh --verify
```

`./script/build_and_run.sh` kills old Vite / Tauri / debug app processes before starting a fresh dev run.

CI/CD workflow:

- [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) runs verification plus a gated bundle matrix only through manual `workflow_dispatch`
- configured bundle targets are Linux X64, Linux ARM64, Windows X64, Windows ARM64, macOS ARM64, and macOS X64
- the current enabled CI/CD test-pass targets are Linux X64, Windows X64, and macOS ARM64; disabled targets remain in the matrix with `enabled: false`
- manual runs require a `version` like `0.2.0` and a `release_type` of `release` or `prerelease`
- CI bumps release version files with `npm run version:set -- <version>`, creates a release commit on `main`, then tags it as `v<version>`
- if a release run fails after tag creation, rerunning the same version reuses that tag
- the release job generates release notes from the previous semver-like version tag
- the selected tag publishes GitHub Release assets from those bundle outputs
- Windows release jobs also add portable ZIP archives alongside the Tauri installer outputs
- release steps are documented in [`docs/releasing.md`](docs/releasing.md)

## Repo Map

### Frontend

- [`src/App.tsx`](src/App.tsx): top-level wiring, modals, sidebar/workspace composition
- [`src/state/useOpenXTermStore.ts`](src/state/useOpenXTermStore.ts): central state and most app workflows
- [`src/state/openXTermStoreTypes.ts`](src/state/openXTermStoreTypes.ts): Zustand store public state/action types and import summary type
- [`src/state/openXTermStoreHelpers.ts`](src/state/openXTermStoreHelpers.ts): pure store helpers for sorting, folder paths, status mapping, tab seeding, and transfer ordering
- [`src/state/openXTermStoreTransfers.ts`](src/state/openXTermStoreTransfers.ts): store transfer enqueue, progress aggregation, flush scheduling, and transfer-window side effects
- [`src/state/openXTermStoreListeners.ts`](src/state/openXTermStoreListeners.ts): one-time terminal/status/transfer event listener registration for the store
- [`src/state/openXTermStoreDomain.ts`](src/state/openXTermStoreDomain.ts): session, folder, import, and macro domain actions
- [`src/state/openXTermStoreTerminalActions.ts`](src/state/openXTermStoreTerminalActions.ts): macro execution, terminal input, and terminal resize actions
- [`src/state/openXTermStoreTabActions.ts`](src/state/openXTermStoreTabActions.ts): tab selection, tab close, session launch, restart, and linked-SFTP tab actions
- [`src/components/forms/SessionEditorModal.tsx`](src/components/forms/SessionEditorModal.tsx): compact tabbed session editor shell and save/close composition
- [`src/components/forms/SessionEditorTabs.tsx`](src/components/forms/SessionEditorTabs.tsx): session editor tab panels for general, connection, terminal, and advanced settings
- [`src/components/forms/sessionEditorHelpers.ts`](src/components/forms/sessionEditorHelpers.ts): pure session-editor draft/default/preset helpers
- [`src/components/forms/sessionEditorHooks.ts`](src/components/forms/sessionEditorHooks.ts): session-editor system-font loading and local X11 support inspection hooks
- [`src/components/forms/FontFamilyPicker.tsx`](src/components/forms/FontFamilyPicker.tsx): searchable system-font picker for per-session terminal fonts
- [`src/components/forms/AppSettingsModal.tsx`](src/components/forms/AppSettingsModal.tsx): app-level settings for interface preferences and app lock entry points
- [`src/components/forms/AppLockOverlay.tsx`](src/components/forms/AppLockOverlay.tsx): lock screen for system auth / Touch ID / PIN flows
- [`src/components/sidebar/Sidebar.tsx`](src/components/sidebar/Sidebar.tsx): sidebar composition shell for sessions, SFTP, tools, and macros
- [`src/components/sidebar/SessionsSection.tsx`](src/components/sidebar/SessionsSection.tsx): session tree UI, folder actions, and session launch/edit controls
- [`src/components/sidebar/SftpSection.tsx`](src/components/sidebar/SftpSection.tsx): linked SFTP sidebar composition
- [`src/components/sidebar/SftpDirectoryList.tsx`](src/components/sidebar/SftpDirectoryList.tsx): SFTP table/list rendering, row selection, sorting, and context-menu wiring
- [`src/components/sidebar/useSessionTreeDrag.ts`](src/components/sidebar/useSessionTreeDrag.ts): pointer-based session/folder drag state
- [`src/components/sidebar/useSftpSelection.ts`](src/components/sidebar/useSftpSelection.ts): SFTP sidebar selection and context-menu state
- [`src/components/sidebar/useSftpTableControls.ts`](src/components/sidebar/useSftpTableControls.ts): SFTP sidebar column sorting and resizing state
- [`src/components/sidebar/useSftpEntryOperations.ts`](src/components/sidebar/useSftpEntryOperations.ts): SFTP create, rename, delete, path-submit, and download operations
- [`src/components/sidebar/useSftpUploads.ts`](src/components/sidebar/useSftpUploads.ts): SFTP upload input, drag-in, and native file-drop handling
- [`src/components/sidebar/useSftpNativeDragOut.ts`](src/components/sidebar/useSftpNativeDragOut.ts): SFTP native drag-out pointer handling
- [`src/components/sidebar/useSftpFollowTerminal.ts`](src/components/sidebar/useSftpFollowTerminal.ts): follow-remote-terminal directory synchronization
- [`src/components/status/StatusBar.tsx`](src/components/status/StatusBar.tsx): live lower rail, CPU history graph, lock button
- [`src/components/workspace/Workspace.tsx`](src/components/workspace/Workspace.tsx): active tab rendering
- [`src/components/workspace/TerminalSurface.tsx`](src/components/workspace/TerminalSurface.tsx): xterm host, stopped-session UX, per-session appearance application
- [`src/components/workspace/FileBrowserView.tsx`](src/components/workspace/FileBrowserView.tsx): remote file-browser container and directory-operation composition
- [`src/components/workspace/FileTable.tsx`](src/components/workspace/FileTable.tsx): remote file table rendering, column headers, selection, sorting UI, and row context-menu wiring
- [`src/components/workspace/fileTableModel.ts`](src/components/workspace/fileTableModel.ts): file table sort types and column width constants
- [`src/components/workspace/fileBrowserUtils.ts`](src/components/workspace/fileBrowserUtils.ts): file-browser path, clipboard, and error-context helpers
- [`src/components/workspace/useFileTableControls.ts`](src/components/workspace/useFileTableControls.ts): workspace file-table sorting and column sizing
- [`src/components/workspace/useFileBrowserSelection.ts`](src/components/workspace/useFileBrowserSelection.ts): workspace file selection, copy path, and context-menu lifecycle
- [`src/components/workspace/useFileBrowserUploads.ts`](src/components/workspace/useFileBrowserUploads.ts): file-browser upload input, browser drop, and Tauri native drop handling
- [`src/components/workspace/useFileNativeDragOut.ts`](src/components/workspace/useFileNativeDragOut.ts): workspace native drag-out pointer handling
- [`src/hooks/useSftpConflictResolver.ts`](src/hooks/useSftpConflictResolver.ts): shared SFTP upload/download conflict resolution
- [`src/hooks/useRemotePropertiesWindow.ts`](src/hooks/useRemotePropertiesWindow.ts): shared remote properties OS-window/fallback modal handling
- [`src/lib/bridge.ts`](src/lib/bridge.ts): Tauri invoke/listen boundary
- [`src/lib/remotePropertiesWindow.ts`](src/lib/remotePropertiesWindow.ts): remote entry properties window payload/result storage helpers
- [`src/lib/localPath.ts`](src/lib/localPath.ts): cross-platform local path basename helper for drag/upload paths
- [`src/lib/sessionUtils.ts`](src/lib/sessionUtils.ts): shared tab/session helpers and startup transcript copy
- [`src/lib/sftpTransfers.ts`](src/lib/sftpTransfers.ts): shared SFTP upload/download orchestration and transfer queue wiring
- [`src/lib/mobaxtermImport.ts`](src/lib/mobaxtermImport.ts): `.mxtsessions` parser
- [`src/lib/transferBatch.ts`](src/lib/transferBatch.ts): batch transfer aggregation
- [`src/index.css`](src/index.css): ordered CSS import entrypoint
- [`src/styles/`](src/styles): focused app styles for base tokens, sidebar, workspace, files, status bar, transfers, settings, and session editor

### Backend

- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs): Tauri app bootstrap and command registration
- [`src-tauri/src/commands.rs`](src-tauri/src/commands.rs): invoke handlers
- [`src-tauri/src/runtime.rs`](src-tauri/src/runtime.rs): main runtime registry, session startup dispatch, PTY glue, terminal lifecycle, and shared runtime events
- [`src-tauri/src/runtime/local_shell.rs`](src-tauri/src/runtime/local_shell.rs): local shell command and working-directory resolution
- [`src-tauri/src/runtime/serial.rs`](src-tauri/src/runtime/serial.rs): serial reader and serial option mapping
- [`src-tauri/src/runtime/ssh/auth.rs`](src-tauri/src/runtime/ssh/auth.rs): transient SSH auth state; username helper metadata is written to a temp file, password stays process-memory only
- [`src-tauri/src/runtime/ssh/guidance.rs`](src-tauri/src/runtime/ssh/guidance.rs): SSH password prompt handling, error text normalization, and terminal guidance messages
- [`src-tauri/src/runtime/ssh/interactive.rs`](src-tauri/src/runtime/ssh/interactive.rs): embedded interactive SSH tab controller, writer, reader loop, resize, and X11/status startup
- [`src-tauri/src/runtime/ssh/session.rs`](src-tauri/src/runtime/ssh/session.rs): embedded SSH helper/session creation, remote command execution, and SFTP helper opening
- [`src-tauri/src/runtime/status/mod.rs`](src-tauri/src/runtime/status/mod.rs): status poller, local/SSH status probes, parser, latency, and status event emission
- [`src-tauri/src/runtime/status_scripts.rs`](src-tauri/src/runtime/status_scripts.rs): embedded local/remote status probe scripts
- [`src-tauri/src/runtime/telnet.rs`](src-tauri/src/runtime/telnet.rs): Telnet connector, reader, protocol negotiation, and writer
- [`src-tauri/src/runtime/x11.rs`](src-tauri/src/runtime/x11.rs): X11 forwarding proxy, local auth lookup, and runtime diagnostics
- [`src-tauri/src/transfer/mod.rs`](src-tauri/src/transfer/mod.rs): transfer command orchestration and protocol dispatch
- [`src-tauri/src/transfer/lifecycle.rs`](src-tauri/src/transfer/lifecycle.rs): shared transfer queued/running/completed/error emission plus cancel/retry cleanup
- [`src-tauri/src/transfer/progress.rs`](src-tauri/src/transfer/progress.rs): transfer progress event emission and transfer-window reveal logic
- [`src-tauri/src/transfer/state.rs`](src-tauri/src/transfer/state.rs): transfer cancel/retry runtime state
- [`src-tauri/src/transfer/errors.rs`](src-tauri/src/transfer/errors.rs): shared local/SFTP transfer error classification for permission, no-space, connection, missing-path, and unsupported-operation failures
- [`src-tauri/src/transfer/entries.rs`](src-tauri/src/transfer/entries.rs): remote entry list/create/delete/rename/properties/chmod commands
- [`src-tauri/src/transfer/sftp.rs`](src-tauri/src/transfer/sftp.rs): SFTP helper operations and metadata/conflict checks
- [`src-tauri/src/transfer/ftp.rs`](src-tauri/src/transfer/ftp.rs): FTP/curl upload and download helpers
- [`src-tauri/src/transfer/paths.rs`](src-tauri/src/transfer/paths.rs): transfer path/name/local-size helpers
- [`src-tauri/src/transfer/metadata.rs`](src-tauri/src/transfer/metadata.rs): remote metadata formatting helpers
- [`src-tauri/src/drag/mod.rs`](src-tauri/src/drag/mod.rs): native drag bridge (macOS file-promise drag, Windows IDataObject drag)
- [`src-tauri/src/drag/macos.m`](src-tauri/src/drag/macos.m): macOS AppKit drag implementation
- [`src-tauri/src/platform/auth.rs`](src-tauri/src/platform/auth.rs): platform authentication for app lock
- [`src-tauri/src/platform/auth_macos.m`](src-tauri/src/platform/auth_macos.m): macOS LocalAuthentication implementation
- [`src-tauri/src/platform/fonts.rs`](src-tauri/src/platform/fonts.rs): system font enumeration through `font-kit`
- [`src-tauri/src/platform/menu.rs`](src-tauri/src/platform/menu.rs): native menu integration and topbar action routing
- [`src-tauri/src/platform/x11.rs`](src-tauri/src/platform/x11.rs): local X11 / XQuartz / X server detection helpers
- [`src-tauri/src/probe.rs`](src-tauri/src/probe.rs): embedded `libssh-rs` probe for backend evaluation
- [`src-tauri/src/proxy.rs`](src-tauri/src/proxy.rs): per-session HTTP CONNECT / SOCKS5 proxy helpers for libssh, Telnet, and FTP/curl paths
- [`src-tauri/src/storage.rs`](src-tauri/src/storage.rs): persistence
- [`src-tauri/src/models.rs`](src-tauri/src/models.rs): serde models mirrored from TS

### CI/CD

- [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml): GitHub Actions verification/build/release pipeline
- [`docs/releasing.md`](docs/releasing.md): manual release checklist

## Core Architecture

### 1. Store-first app flow

Most user actions route through Zustand:

- UI triggers store action
- store updates optimistic/local state
- store calls Tauri bridge when needed
- backend emits terminal/status/transfer events
- store listens once and fans those events back into UI state

If you are changing behavior, start in [`useOpenXTermStore.ts`](src/state/useOpenXTermStore.ts).

### 2. Terminal tabs vs file tabs

`createSessionTab()` in [`sessionUtils.ts`](src/lib/sessionUtils.ts) maps:

- `local`, `ssh`, `telnet`, `serial` -> terminal tab
- `sftp`, `ftp` -> file browser tab

Linked SFTP tabs for live SSH sessions are synthetic sessions with ids like `linked-sftp-<ssh-tab-id>`.

### 3. Frontend/backend contract

If you add a new persisted field or command, you usually need to touch all of:

1. [`src/types/domain.ts`](src/types/domain.ts)
2. [`src-tauri/src/models.rs`](src-tauri/src/models.rs)
3. [`src/lib/bridge.ts`](src/lib/bridge.ts)
4. [`src-tauri/src/commands.rs`](src-tauri/src/commands.rs)
5. [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)
6. Store/UI call sites

[`bridge.ts`](src/lib/bridge.ts) also contains a browser/localStorage fallback for non-Tauri runs. It is useful for UI iteration, but desktop behavior should be validated in real Tauri because terminal transports, remote file ops, native drag, X11 checks, font enumeration, and window behavior only exist there.

## Important Invariants

### Terminal stopped state is explicit

Do not infer “session stopped” from terminal text.

The correct source is [`terminalStoppedByTabId`](src/state/useOpenXTermStore.ts) in the store, which is driven by terminal-exit events.

Relevant files:

- [`src/state/useOpenXTermStore.ts`](src/state/useOpenXTermStore.ts)
- [`src/components/workspace/TerminalSurface.tsx`](src/components/workspace/TerminalSurface.tsx)

`TerminalSurface` should swallow all normal input while stopped, except:

- `Enter` -> close tab
- `R` -> restart tab
- `S` -> save terminal output

### Session/folder drag in `Sessions` is pointer-based

The sessions tree drag/drop is not native HTML5 DnD. It uses pointer tracking in [`Sidebar.tsx`](src/components/sidebar/Sidebar.tsx) because that proved more reliable inside Tauri/WebKit.

If drag in `Sessions` breaks, inspect `Sidebar.tsx` first and be careful about replacing it with browser DnD APIs.

### Session folders are real persisted entities

Folders are not just a display-only path string.

- sessions still carry `folderPath`
- folder objects are separately persisted as `SessionFolderDefinition`
- empty folders should survive restart
- moving a folder moves the subtree and rewrites child `folderPath` values

Relevant files:

- [`src/components/forms/SessionFolderModal.tsx`](src/components/forms/SessionFolderModal.tsx)
- [`src/components/forms/MoveSessionModal.tsx`](src/components/forms/MoveSessionModal.tsx)
- [`src/state/useOpenXTermStore.ts`](src/state/useOpenXTermStore.ts)

### Multi-transfer progress is job-based

Multiple uploads/downloads/drag exports should appear as one parent transfer job, not one modal per item.

Implementation:

- parent ids: `createBatchTransferId(...)`
- child ids: `createBatchChildTransferId(...)`
- aggregation: [`src/lib/transferBatch.ts`](src/lib/transferBatch.ts)

If you add a new multi-item transfer path, wire it into batch aggregation instead of emitting standalone child UI jobs.

### macOS native drag-out has a fragile ABI boundary

This area already caused real crashes.

Current rule:

- Rust passes JSON bytes plus explicit length
- Objective-C reconstructs `NSData` / `NSString` using that length
- exported native symbol is `openxterm_start_file_promise_drag_v2`

Do not revert this to `CString` + `stringWithUTF8String`.

Relevant files:

- [`src-tauri/src/drag/mod.rs`](src-tauri/src/drag/mod.rs)
- [`src-tauri/src/drag/macos.m`](src-tauri/src/drag/macos.m)
- [`src-tauri/build.rs`](src-tauri/build.rs)

### SSH sessions without username are special

If `session.username` is empty, the embedded SSH runtime cannot connect yet because it still needs a resolved remote login before authentication starts.

Current behavior in [`runtime.rs`](src-tauri/src/runtime.rs):

- the terminal prints `login as:` locally
- entered username is cached in per-tab runtime state and a temp username metadata file before the SSH connection is opened
- if password auth is selected and the profile has no saved password, the terminal then prompts locally for `<user>@<host>'s password:`
- the entered password is kept in runtime memory for the life of that tab so linked SFTP/status helpers can reuse it without persisting it to storage

Do not change this back to “just use the local OS username” if the goal is MobaXterm-like login behavior.

### Linked SFTP and status use helper SSH sessions, not OpenSSH control sockets

OpenXTerm no longer relies on OpenSSH control-socket reuse for live SSH tabs.

Current behavior:

- terminal SSH tabs use the embedded `libssh-rs` runtime
- live status uses a separate embedded helper SSH session
- linked SFTP uses a separate embedded helper SSH/SFTP session
- helper connections can resolve username from per-tab runtime state or the temp username metadata file when the saved profile leaves `username` empty
- helper connections can reuse a live interactively entered password from process memory while the SSH tab is still connected

Operational consequence:

- if the user closes the live SSH tab, transient username metadata and process-memory password state are cleared with it
- after that point, helper reconnects still require one of:
  - saved password in the profile
  - private key auth
  - working SSH agent auth
- if none of those are available, the UI should surface a clear error instead of pretending the connection is “limited”

Relevant files:

- [`src-tauri/src/runtime.rs`](src-tauri/src/runtime.rs)
- [`src-tauri/src/transfer/mod.rs`](src-tauri/src/transfer/mod.rs)

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

- [`src/components/forms/SessionEditorModal.tsx`](src/components/forms/SessionEditorModal.tsx)
- [`src-tauri/src/platform/x11.rs`](src-tauri/src/platform/x11.rs)
- [`src-tauri/src/runtime/x11.rs`](src-tauri/src/runtime/x11.rs)
- [`src-tauri/src/runtime.rs`](src-tauri/src/runtime.rs)

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

The editor can enumerate real system fonts through the Rust `font-kit` bridge. Terminal rendering applies these values in [`TerminalSurface.tsx`](src/components/workspace/TerminalSurface.tsx).

If you add a new appearance field, update:

- [`src/types/domain.ts`](src/types/domain.ts)
- [`src-tauri/src/models.rs`](src-tauri/src/models.rs)
- [`src/state/useOpenXTermStore.ts`](src/state/useOpenXTermStore.ts)
- [`src/components/forms/SessionEditorModal.tsx`](src/components/forms/SessionEditorModal.tsx)
- [`src/components/workspace/Workspace.tsx`](src/components/workspace/Workspace.tsx)
- [`src/components/workspace/TerminalSurface.tsx`](src/components/workspace/TerminalSurface.tsx)

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

- [`src/components/status/StatusBar.tsx`](src/components/status/StatusBar.tsx)
- [`src/state/useOpenXTermStore.ts`](src/state/useOpenXTermStore.ts)
- [`src-tauri/src/runtime.rs`](src-tauri/src/runtime.rs)

### Console logging is error-only and intentional

Frontend console logging is now deliberately scoped to errors.

Current rule:

- use [`src/lib/errorLog.ts`](src/lib/errorLog.ts) for UI/runtime error reporting
- log only through `console.error`
- do not add ambient info/debug noise to the console just to trace normal flow
- repeated status/transfer poller failures should be deduplicated so the console is still usable during retries

Relevant files:

- [`src/lib/errorLog.ts`](src/lib/errorLog.ts)
- [`src/state/useOpenXTermStore.ts`](src/state/useOpenXTermStore.ts)
- [`src/components/sidebar/Sidebar.tsx`](src/components/sidebar/Sidebar.tsx)
- [`src/components/workspace/FileBrowserView.tsx`](src/components/workspace/FileBrowserView.tsx)

### Non-macOS topbar menus are app-owned UI, not native shell menus

On macOS the app still uses the native menu integration from Tauri. On non-macOS platforms, the visible topbar menu row is a React-owned control surface and must remain clickable.

Current rule:

- do not treat the whole topbar as a drag region
- only non-interactive portions such as the breadcrumb should carry `data-tauri-drag-region`
- topbar dropdown actions should route through the same handler path as native menu actions so behavior stays consistent across platforms

Relevant files:

- [`src/components/layout/TopBar.tsx`](src/components/layout/TopBar.tsx)
- [`src/App.tsx`](src/App.tsx)
- [`src-tauri/src/platform/menu.rs`](src-tauri/src/platform/menu.rs)
- [`src/index.css`](src/index.css)

### MobaXterm import support

Parser lives in [`src/lib/mobaxtermImport.ts`](src/lib/mobaxtermImport.ts).

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

This is the practical feature state as of April 25, 2026:

- local shell transport exists
- live SSH / Telnet / Serial transports exist
- remote file listing / create folder / rename / delete / upload / download exist
- drag-in upload from desktop into the SFTP file browser exists
- native desktop drag-out exists
- cancel transfer exists through the transfer window
- macros with create, edit, run, and delete exist
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
- GitHub Actions CI/CD is manual-dispatch/version-input driven; the matrix includes Linux X64, Linux ARM64, Windows X64, Windows ARM64, macOS ARM64, and macOS X64, with only Linux X64, Windows X64, and macOS ARM64 enabled for the current test pass

Important caveats:

- embedded X11 forwarding still depends on a working local X server and correct remote `sshd` behavior
- linked SFTP/status can reuse an interactively entered SSH password only while the live SSH tab that captured it is still running
- after the live tab stops, helper reconnects fall back to saved password, key, or agent auth
- on Windows, drag-out starts immediately and only stages the remote file into the local temp cache lazily if the shell requests file contents on drop
- GitHub Actions currently publishes unsigned / unnotarized bundles unless release signing secrets are added in the future

Some startup transcript copy still exists in helpers like [`sessionUtils.ts`](src/lib/sessionUtils.ts). Do not assume every “preview” string means the feature is fake.

## Where To Edit For Common Tasks

### Add or change session fields

Start with:

- [`src/types/domain.ts`](src/types/domain.ts)
- [`src-tauri/src/models.rs`](src-tauri/src/models.rs)
- [`src/components/forms/SessionEditorModal.tsx`](src/components/forms/SessionEditorModal.tsx)
- storage and bridge files

### Change session tree behavior

Start with:

- [`src/components/sidebar/Sidebar.tsx`](src/components/sidebar/Sidebar.tsx)
- [`src/components/sidebar/SessionsSection.tsx`](src/components/sidebar/SessionsSection.tsx)
- [`src/components/sidebar/useSessionTreeDrag.ts`](src/components/sidebar/useSessionTreeDrag.ts)
- [`src/state/openXTermStoreDomain.ts`](src/state/openXTermStoreDomain.ts)
- [`src/state/useOpenXTermStore.ts`](src/state/useOpenXTermStore.ts)

### Change terminal UX

Start with:

- [`src/components/workspace/TerminalSurface.tsx`](src/components/workspace/TerminalSurface.tsx)
- [`src/components/workspace/Workspace.tsx`](src/components/workspace/Workspace.tsx)
- [`src/components/status/StatusBar.tsx`](src/components/status/StatusBar.tsx)
- [`src/state/useOpenXTermStore.ts`](src/state/useOpenXTermStore.ts)
- [`src-tauri/src/runtime.rs`](src-tauri/src/runtime.rs)

### Change session editor or appearance controls

Start with:

- [`src/components/forms/SessionEditorModal.tsx`](src/components/forms/SessionEditorModal.tsx)
- [`src/components/forms/SessionEditorTabs.tsx`](src/components/forms/SessionEditorTabs.tsx)
- [`src/components/forms/FontFamilyPicker.tsx`](src/components/forms/FontFamilyPicker.tsx)
- [`src/components/forms/sessionEditorHooks.ts`](src/components/forms/sessionEditorHooks.ts)
- [`src/components/forms/sessionEditorHelpers.ts`](src/components/forms/sessionEditorHelpers.ts)
- [`src/index.css`](src/index.css)
- [`src/styles/session-editor.css`](src/styles/session-editor.css)
- [`src/lib/bridge.ts`](src/lib/bridge.ts)
- [`src-tauri/src/platform/fonts.rs`](src-tauri/src/platform/fonts.rs)

### Change X11 / GUI forwarding behavior

Start with:

- [`src/components/forms/SessionEditorModal.tsx`](src/components/forms/SessionEditorModal.tsx)
- [`src-tauri/src/platform/x11.rs`](src-tauri/src/platform/x11.rs)
- [`src-tauri/src/runtime/x11.rs`](src-tauri/src/runtime/x11.rs)
- [`src-tauri/src/runtime.rs`](src-tauri/src/runtime.rs)

### Change file transfer behavior

Start with:

- [`src/components/workspace/FileBrowserView.tsx`](src/components/workspace/FileBrowserView.tsx)
- [`src/components/workspace/FileTable.tsx`](src/components/workspace/FileTable.tsx)
- [`src/components/workspace/useFileBrowserUploads.ts`](src/components/workspace/useFileBrowserUploads.ts)
- [`src/components/workspace/useFileNativeDragOut.ts`](src/components/workspace/useFileNativeDragOut.ts)
- [`src/components/sidebar/Sidebar.tsx`](src/components/sidebar/Sidebar.tsx)
- [`src/components/sidebar/SftpSection.tsx`](src/components/sidebar/SftpSection.tsx)
- [`src/components/sidebar/SftpDirectoryList.tsx`](src/components/sidebar/SftpDirectoryList.tsx)
- [`src/components/sidebar/useSftpEntryOperations.ts`](src/components/sidebar/useSftpEntryOperations.ts)
- [`src/components/sidebar/useSftpUploads.ts`](src/components/sidebar/useSftpUploads.ts)
- [`src/components/sidebar/useSftpNativeDragOut.ts`](src/components/sidebar/useSftpNativeDragOut.ts)
- [`src/lib/sftpTransfers.ts`](src/lib/sftpTransfers.ts)
- [`src/lib/transferBatch.ts`](src/lib/transferBatch.ts)
- [`src-tauri/src/transfer/mod.rs`](src-tauri/src/transfer/mod.rs)
- [`src-tauri/src/transfer/lifecycle.rs`](src-tauri/src/transfer/lifecycle.rs)
- [`src-tauri/src/transfer/progress.rs`](src-tauri/src/transfer/progress.rs)
- [`src-tauri/src/transfer/state.rs`](src-tauri/src/transfer/state.rs)
- [`src-tauri/src/transfer/errors.rs`](src-tauri/src/transfer/errors.rs)
- [`src-tauri/src/transfer/entries.rs`](src-tauri/src/transfer/entries.rs)
- [`src-tauri/src/transfer/sftp.rs`](src-tauri/src/transfer/sftp.rs)
- [`src-tauri/src/transfer/ftp.rs`](src-tauri/src/transfer/ftp.rs)
- [`src-tauri/src/drag/mod.rs`](src-tauri/src/drag/mod.rs)

## Verification Checklist

For UI/state changes:

```bash
npm run check
npm run test
./script/build_and_run.sh --verify
```

For Rust/native changes:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run check
./script/build_and_run.sh --verify
```

For anything touching native drag or transfers, do at least one manual pass in the running app.

Automated coverage is still intentionally small, but `npm run test` covers selected frontend pure helpers and `cargo test --manifest-path src-tauri/Cargo.toml` covers selected backend pure helpers. A real app smoke test is still required for terminal transports, native drag, and transfers.

For v0.2 terminal copy/paste/resize QA across macOS, Linux, and Windows, use the manual checklist in `docs/qa/v0.2-core-reliability.md`.

For release-pipeline changes:

```bash
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Then inspect [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) carefully for:

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
