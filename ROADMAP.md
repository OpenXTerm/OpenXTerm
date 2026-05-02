# OpenXTerm Roadmap

OpenXTerm is an early-stage open-source terminal workspace for macOS, Linux, and Windows.

The goal for the first stable release is not to copy every MobaXterm feature. The goal is to provide a reliable daily workflow for saved terminal sessions, linked SFTP, file transfers, local shells, session organization, live status, and embedded SSH X11 forwarding.

## Release Positioning

Target statement for v1.0:

> OpenXTerm is a stable open-source terminal workspace for macOS, Linux, and Windows with saved SSH/local sessions, folders, linked SFTP, batch transfers, live status, session import, terminal customization, and embedded SSH X11 forwarding diagnostics.

OpenXTerm is independent software. It is not affiliated with, endorsed by, or connected to MobaXterm, Mobatek, or any other terminal product.

## Current Status

### Highest Priority Next

- Refactor the largest reliability-sensitive modules in small reviewed steps:
  - finish the remaining frontend SFTP consolidation by extracting shared upload/download, selection, and table helpers from `src/components/sidebar/Sidebar.tsx` and `src/components/workspace/FileBrowserView.tsx`;
  - split `src/state/useOpenXTermStore.ts` into UI/domain/transfer slices while preserving existing selectors and persistence behavior;
  - extract shared transfer lifecycle helpers from `src-tauri/src/transfer/mod.rs` with manual SFTP upload/download/retry/cancel smoke tests after each step.

### Recent Refactor Progress

- Split large sidebar UI sections out of `src/components/sidebar/Sidebar.tsx` into focused sidebar components.
- Extracted session-tree drag/drop state into `src/components/sidebar/useSessionTreeDrag.ts`.
- Extracted SFTP selection, table sizing/sorting, conflict resolution, properties-window handling, session import handling, and follow-remote-terminal behavior into hooks/utilities.
- Shared SFTP conflict resolution between sidebar SFTP and workspace file browser through `src/hooks/useSftpConflictResolver.ts`.
- Shared remote properties-window handling between sidebar SFTP and workspace file browser through `src/hooks/useRemotePropertiesWindow.ts`.
- Fixed Windows drag-in basename handling for local paths with backslashes through `src/lib/localPath.ts`.
- Fixed batch transfer aggregation so multi-item downloads do not regress from running progress back to queued/waiting.
- Added Windows SFTP folder drag-out support by expanding dragged folders into virtual file entries for Explorer.
- Added runtime guards for remote properties-window `localStorage` JSON payloads/results.
- Kept X11 failure detection pattern matching data-driven and moved the remaining inline request-failure match into the pattern table.
- Introduced first-pass CSS color variables for the core dark surface, border, hover, text, and accent colors.
- Split session editor defaults, draft creation, terminal presets, and small tab/font helpers into a pure helper module.
- Split the session editor tab panels into focused components so `SessionEditorModal.tsx` now owns state/effects/form composition instead of all tab JSX.
- Split workspace file table rendering out of `FileBrowserView.tsx` while keeping transfer and directory-operation state in the container.
- Started the Zustand store split by extracting public store types and pure helper logic from `useOpenXTermStore.ts`.
- Continued the Zustand store split by moving transfer enqueue/progress aggregation/flush side effects into `openXTermStoreTransfers.ts`.
- Added a dedicated `canceled` transfer state so user-canceled transfers are neutral, auto-close cleanly, and do not appear as operational errors.
- Continued the Zustand store split by moving terminal/status/transfer listener registration into `openXTermStoreListeners.ts`.

### Codebase Refactor Backlog

- Frontend SFTP consolidation:
  - finish reducing `Sidebar.tsx` to orchestration only; current pass reduced it to roughly 1.1k lines, but upload/download/delete/create/rename/native drag wiring still lives there;
  - continue reducing `FileBrowserView.tsx`; current pass reduced it below 1k lines and shares conflict/properties hooks, but table controls, selection, and upload/download orchestration are still local;
  - extract shared SFTP upload/download orchestration only after another smoke pass for drag-in, drag-out, batch downloads, conflict overwrite/skip/rename, retry, and cancel.
- Backend transfer layer:
  - split `src-tauri/src/transfer/mod.rs` into transfer lifecycle/progress, upload, download, retry/cancel, listing, and transfer-window modules;
  - avoid behavior rewrites until each extracted path has manual upload/download/retry/cancel smoke coverage.
- Store architecture:
  - split `src/state/useOpenXTermStore.ts` into UI, domain, transfer/status, and runtime-listener slices;
  - preserve persisted state shape and public selectors during the first pass.
- Session editor:
  - split `src/components/forms/SessionEditorModal.tsx` into tab components and focused hooks for terminal presets, X11 settings, and font picker state.
- Styling:
  - continue reducing `src/index.css` by grouping component styles and expanding shared color/spacing variables before theme work.
- Runtime and parsing cleanup:
  - keep X11 diagnostic string matching data-driven rather than long inline condition chains;
  - add lightweight runtime guards for persisted JSON/localStorage boundaries instead of unchecked `as` casts;
  - continue removing dead runtime metadata paths and platform-specific temp-path assumptions when found.

### Done

- Tauri 2 desktop app shell.
- React + TypeScript UI.
- Rust backend command layer.
- xterm.js terminal surface.
- Saved sessions.
- Session folders and tree view.
- Session and folder drag/drop in the sidebar.
- Multiple simultaneous connections to the same saved session.
- Local shell terminal sessions.
- Live SSH terminal sessions.
- Telnet terminal sessions.
- Serial terminal sessions.
- SSH sessions without saved username can prompt for login in the terminal.
- Windows prompt-wrapper support for SSH profiles without saved username.
- Restart/save prompt when terminal sessions stop.
- Clear and reset actions for terminal tabs.
- Linked SFTP sidebar discovery for live SSH tabs.
- Linked SFTP through embedded helper SSH sessions.
- Remote file listing.
- Remote folder creation.
- Remote delete.
- Upload and download flows.
- Batch transfer aggregation for multi-file operations.
- Copy remote path from the file browser.
- Hidden files toggle in the file browser.
- Native desktop drag-out from remote file browser.
- MobaXterm `.mxtsessions` import for common session types.
- Per-session terminal font, font size, foreground color, and background color.
- System font enumeration for the terminal editor.
- Compact tabbed session editor.
- Live lower status bar with host/user/uptime/CPU/memory/disk/network/latency when available.
- CPU history graph in the status bar.
- SSH status through embedded helper SSH sessions.
- App lock via platform authentication where supported.
- Embedded SSH X11 forwarding settings.
- X11 runtime diagnostics for common `sshd` and `xauth` issues.
- Clickable non-macOS topbar menus.
- Error-only frontend console logging for operational failures.
- Macros with create, edit, run, and delete.
- MIT license.
- Agent documentation in `AGENTS.md`.
- Public README refresh.
- Contributing guide.
- GitHub Actions CI/CD for Linux X64, Windows X64, Windows ARM64, macOS ARM64, and macOS X64.

### In Progress

- Hardening linked SFTP behavior through active SSH sessions, especially Windows auth reuse expectations.
- Improving SSH authentication edge cases.
- Improving remote status polling reliability across Linux/macOS/BSD-like targets.
- Hardening the newly unified embedded SSH helper path for status and linked SFTP.
- Polishing compact UI density.
- Cleaning up remaining demo/dev wording in user-facing UI.
- Stabilizing X11 diagnostics and guidance.
- Adding signing/notarization/secrets to the release pipeline.

### Known Gaps

- Secrets are not yet stored through platform credential stores.
- SFTP authentication reuse needs more real-world hardening, especially on Windows where helper connections still cannot recover a password after the originating SSH tab closes.
- File transfer edge cases still need hardening around disconnects, permissions, and low disk space.
- Packaging/signing/notarization is not release-ready.
- GitHub Releases are currently expected to ship unsigned / unnotarized artifacts until signing secrets and release hardening are added.
- Storage migrations need versioning before stable release.
- Automated tests are still minimal.
- Public screenshots and demo clips are not prepared.
- Dependency and license audit still needs to be done before stable release.

## Stable Release Blockers

These must be handled before calling OpenXTerm stable.

- Platform secret storage:
  - macOS Keychain.
  - Linux Secret Service or compatible backend.
  - Windows Credential Manager if Windows remains in release scope.
- SSH/SFTP auth reuse:
  - linked SFTP should not ask for the same password again in the normal active SSH flow.
  - Windows fallback behavior must clearly explain when saved password/key/agent auth is required.
  - errors must be understandable.
- Packaging:
  - macOS signed and notarized build.
  - Linux AppImage and/or `.deb`.
  - repeatable release workflow.
- Storage migrations:
  - versioned storage schema.
  - safe migration path for existing users.
  - backup/export story.
- Crash audit:
  - native desktop drag.
  - transfer queue.
  - terminal lifecycle.
  - app restart/reconnect flows.
- Public documentation:
  - install guide.
  - security guide.
  - troubleshooting guide.
  - X11 guide.
  - known limitations.
- QA matrix:
  - SSH password auth.
  - SSH key auth.
  - SSH agent auth.
  - username prompt flow.
  - linked SFTP.
  - Windows linked SFTP with saved password.
  - Windows linked SFTP with key auth.
  - Windows live status with saved password/key/agent.
  - large remote directory.
  - large upload/download.
  - interrupted network.
  - session import.
  - native drag.
  - X11 with XQuartz/Xorg/XWayland.

## Milestones

## v0.2 Alpha: Core Reliability

Goal: terminal sessions and linked SFTP should become predictable enough for daily testing.

### Done

- Local shell sessions.
- SSH terminal runtime.
- Telnet terminal runtime.
- Serial terminal runtime.
- Restart flow for stopped sessions.
- Username prompt flow for SSH profiles without saved username.
- Multiple concurrent tabs for the same saved session.
- Hardened SSH host-key guidance for interactive terminal sessions.
- Improved SSH runtime/status error messages for common auth, DNS, reachability, and host-key failures.
- Terminal search.
- Local-session working-directory support.
- SFTP password reuse through active SSH sessions via embedded helper.
- Migrated live terminal SSH to embedded `libssh-rs` backend.

### In Progress

- SSH edge-case cleanup.
- Remote status polling accuracy.
- Manual copy/paste and resize verification across macOS, Linux, and Windows.

### TODO

## v0.3 Alpha: File Browser Polish

Goal: SFTP should cover common daily file-management tasks.

### Done

- Remote list.
- Create folder.
- Delete remote entry.
- Upload.
- Download.
- Batch progress for multiple files.
- Native desktop drag-out.
- Drag-in upload from desktop into the file browser.
- Rename remote files and folders.
- Cancel transfer.
- Sortable remote file table columns.
- Manual remote path input.
- Linked SFTP can follow the active remote terminal directory.
- Overwrite/skip/rename conflict handling.
- Retry failed transfer from the transfer window.
- Chmod support.

### In Progress

- Linked SFTP auth reuse and Windows fallback clarity.
- Transfer progress polish.

### TODO

- Clickable breadcrumb navigation.
- Remote folder download hardening.
- Better permission/no-space/disconnect errors.
- Better Windows auth guidance when terminal password entry cannot be reused.

## v0.4 Alpha: Sessions And Productivity

Goal: working with many sessions should feel fast and organized.

### Done

- Session folders.
- Tree view.
- Drag/drop organization.
- Create session inside folder.
- Move session to folder.
- MobaXterm import.
- Session duplication by opening the same saved profile multiple times.

### In Progress

- UI density polish.
- Session editor polish.

### TODO

- Global session search.
- Favorites.
- Recent sessions.
- Duplicate/clone session action.
- Session templates.
- Bulk edit for folders or selected sessions.
- Export OpenXTerm sessions.
- Import OpenXTerm sessions.
- Safer import conflict UI.

## v0.5 Beta: Security And Secrets

Goal: credentials and host trust should be release-worthy.

### Done

- Optional app lock through system authentication where supported.
- Password/key fields exist in session definitions.

### In Progress

- None yet.

### TODO

- Store saved passwords in platform credential storage.
- Add "ask every time" behavior.
- Add "save password" behavior.
- Add SSH agent-first behavior controls.
- Add host key verification UI.
- Add changed host key warning.
- Add security documentation.
- Add idle auto-lock option.
- Add lock-on-start option.

## v0.6 Beta: Cross-Platform Packaging

Goal: users should be able to install OpenXTerm without building from source.

### Done

- Tauri bundle config exists.
- Build script exists.

### In Progress

- None yet.

### TODO

- macOS `.dmg`.
- macOS signing.
- macOS notarization.
- Windows signing.
- Linux AppImage.
- Linux `.deb`.
- Release hardening in CI.
- GitHub Releases workflow polish.
- Changelog generation.
- Decide updater strategy.

## v0.7 Beta: X11 And Remote GUI

Goal: embedded SSH X11 forwarding should be understandable and debuggable.

### Done

- Per-session X11 enable/disable.
- Trusted/untrusted forwarding toggle.
- Local display override.
- Local X11 detection.
- X11 failure detection from terminal output.
- Remote diagnostics for `xauth`, `sshd -T`, effective `sshd -T -C`, HOME, `.Xauthority`, and IPv6-disabled cases.

### In Progress

- Guidance wording and troubleshooting quality.

### TODO

- Dedicated X11 troubleshooting documentation.
- Manual test matrix with `xclock`, `xeyes`, `glxgears`, and Chromium caveats.
- Better UI hint when XQuartz is not running on macOS.
- Better Linux Wayland/XWayland guidance.
- Make it obvious that changes to `sshd_config` require a new SSH login.

## v0.8 Beta: UI Polish

Goal: the app should no longer feel like a development prototype.

### Done

- Compact session editor.
- Terminal appearance presets.
- System font picker.
- Status bar icons and CPU graph.
- Sidebar resize behavior.

### In Progress

- Density tuning.
- Removing leftover demo wording.

### TODO

- App settings screen.
- Default terminal theme settings.
- Default font settings.
- Status bar visibility setting.
- Transfer behavior settings.
- Keyboard shortcuts.
- Command palette.
- Better empty states.
- Better confirmations.
- Accessibility pass for focus, labels, keyboard navigation, and contrast.
- Decide whether topbar search/play actions become functional controls or are removed.

## v0.9 Release Candidate

Goal: feature freeze and stabilization.

### TODO

- No major new features.
- Full manual QA matrix.
- Memory and CPU profiling.
- Crash report review.
- Documentation freeze.
- Public screenshots.
- Public demo clips.
- Dependency audit.
- License audit.
- Release notes.
- Upgrade/migration test from previous alpha/beta storage.

## v1.0 Stable

Goal: first stable public release.

### Required

- SSH is stable enough for daily use.
- Linked SFTP does not require duplicate password entry in normal active SSH flows.
- Sessions and folders survive restart and migration.
- Imports do not lose structure.
- Secrets are stored through platform credential storage.
- macOS, Linux, and Windows packages are available if Windows remains in release scope.
- Known limitations are documented.
- Troubleshooting docs exist for SSH, SFTP, transfers, and X11.
- No mock/demo/stub wording appears in user-facing UI.
- The app handles reconnects, failed transfers, and bad networks without getting stuck in confusing states.

## Explicitly Not Required For v1.0

- RDP.
- VNC.
- Cloud sync.
- Collaboration features.
- Plugin system.
- Full Windows parity beyond the supported SSH/SFTP/status baseline.
- Built-in remote file editor.
- Replacing every advanced feature from commercial terminal suites.
