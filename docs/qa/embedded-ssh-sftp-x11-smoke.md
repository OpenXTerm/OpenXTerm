# Embedded SSH, SFTP, and X11 Smoke QA

This file is a living QA map for the embedded `libssh-rs` runtime and linked SFTP flow.

It is not only a checklist. It records what currently works, what still needs manual verification, and what should be tested before a release tag.

## Status Legend

- `PASS`: tested manually and currently expected to work.
- `NEEDS RETEST`: implemented or recently changed, but needs another manual pass.
- `RISK`: known fragile area; test carefully before release.
- `TODO`: not implemented or not ready enough to claim.

## Current Snapshot

Last broad manual pass: May 2, 2026.

| Area | Status | Notes |
| --- | --- | --- |
| Embedded SSH login with saved username | PASS | Password auth worked in daily testing. |
| Embedded SSH login without saved username | PASS | Local `login as:` prompt works and caches username/password for the live tab. |
| Long UTF-8 terminal output | PASS | Russian `apt` output no longer panics; terminal remains usable after long output. |
| Terminal stopped restart flow | PASS | `R` restart flow was tested earlier and should remain active. |
| Linked SFTP appears for live SSH tab | PASS | Sidebar entry appears after SSH connect. |
| Linked SFTP password reuse while SSH tab is alive | PASS | Helper SFTP can reuse interactively entered credentials while the tab is alive. |
| SFTP list/create folder/upload/download/delete | PASS | Manually tested after the SFTP polish pass. |
| SFTP drag-in from Finder | PASS | Works for non-empty and empty remote folders after drop-zone layout fix. |
| SFTP transfer window | PASS | Broad smoke pass confirmed separate transfer window, auto-close, stable progress, drag-in/drag-out visibility, cancel, retry, and disconnect handling. |
| SFTP rename/context menu | PASS | Context menu and rename/delete/download flows passed the latest SFTP smoke pass. |
| SFTP follow remote terminal | PASS | Follow-remote-terminal behavior passed the latest SFTP smoke pass. |
| SFTP upload/download conflict handling | PASS | Existing-name handling passed the latest SFTP smoke pass; no silent overwrite in the checked path. |
| Transfer cancel | PASS | Large transfer cancellation passed; canceled transfers stay neutral and do not log as operational errors. |
| Transfer retry | PASS | Failed transfer retry passed from the transfer window. |
| X11 basic forwarding | PASS | `$DISPLAY` can appear and basic X11 forwarding can work with a local X server. |
| X11 GLX/heavy apps | RISK | `glxgears`/Chromium depend heavily on XQuartz/local GLX support. |
| Cross-platform Windows/Linux SFTP/status | RISK | Needs more real-machine passes. |

## Latest SFTP Transfer Smoke Pass

Completed May 2, 2026 on macOS with Finder drag-in/drag-out against Linux SSH/SFTP targets.

| Check | Result |
| --- | --- |
| Large upload opens transfer window | PASS |
| Create remote folder | PASS |
| Upload single file | PASS |
| Upload several files as one batch | PASS |
| Existing-name conflict does not silently overwrite | PASS |
| Transfer window auto-closes after completion | PASS |
| Retry failed transfer | PASS |
| Transfer progress does not flicker back to waiting/details state | PASS |
| Network interruption during upload fails clearly and does not hang | PASS |
| Finder drag-in upload | PASS |
| Native drag-out export | PASS |
| SFTP context menu / entry actions | PASS |

## Test Next

Run these first when validating the current branch:

1. Re-run the SFTP transfer smoke pass after any transfer, drag, or file-browser behavior change.
2. Test the same transfer matrix on Windows and Linux desktop builds.
3. Test remote folder download with a nested directory and mixed file sizes.
4. Test permission denied and no-space-left failures on the remote side.
5. Re-test linked SFTP auth reuse after closing the originating SSH tab.

## Baseline Setup

- Run the app through `./script/build_and_run.sh`.
- Use at least one Linux SSH target with password auth.
- Keep XQuartz or another local X server running when testing X11.
- Start a new SSH tab after changing local X11 or remote `sshd_config` settings.

Record each pass in a small note with:

- date
- platform
- remote OS
- auth method
- X11 server, if tested
- pass/fail per section
- exact command output for failures

## SSH Login

| Test | Expected | Status |
| --- | --- | --- |
| Open SSH session with saved username | Connects after one password prompt. | PASS |
| Open SSH session without saved username | Terminal shows local `login as:` prompt before password. | PASS |
| Password auth after username prompt | Password is accepted once and does not repeat after successful auth. | PASS |
| Long non-ASCII output, for example `apt update` in Russian locale | No Rust panic, no poisoned channel, terminal input still works. | PASS |
| Close session and press `R` in stopped footer | Session restarts in the same tab. | PASS |

## Status Bar

| Test | Expected | Status |
| --- | --- | --- |
| Connect SSH and wait for status | Status starts loading, then shows live data. | PASS |
| CPU graph over time | CPU history changes horizontally over time. | PASS |
| Stop SSH tab | Status becomes offline and polling stops cleanly. | NEEDS RETEST |
| Linux remote with limited tools | Missing fields should become loading/error, not fake data. | PASS |

## Linked SFTP

| Test | Expected | Status |
| --- | --- | --- |
| Connect SSH | Linked SFTP appears in sidebar. | PASS |
| Open SFTP sidebar | Remote directory loads. | PASS |
| Create folder | Folder appears after refresh/list reload. | PASS |
| Upload single file | Transfer window appears and file appears remotely. | PASS |
| Upload multiple files | One batch transfer is shown. | PASS |
| Upload existing name | Conflict handling appears or applies the selected action; no silent overwrite. | PASS |
| Drag file from Finder into empty remote folder | Drop-zone accepts file. | PASS |
| Drag remote file out to Finder | Transfer window appears and file exports without flickering to waiting state. | PASS |
| Download file | File is saved locally and transfer completes. | PASS |
| Delete file/folder | Entry disappears after reload. | PASS |
| Right-click context menu | Menu opens with Rename/Delete/Download. | PASS |
| Rename file/folder | Entry is renamed remotely and list refreshes. | PASS |
| Cancel large upload/download | Backend stops transfer and UI shows canceled state. | PASS |
| Retry failed upload/download | Failed row offers `Retry`; retry returns to queued/running and can complete. | PASS |

## X11 2D Apps

| Test | Expected | Status |
| --- | --- | --- |
| Enable X11 and connect | Runtime requests trusted/untrusted forwarding according to session settings. | PASS |
| Run `echo $DISPLAY` | Remote `DISPLAY` is non-empty when forwarding succeeds. | PASS |
| Run `xeyes` or `xclock` | Window opens on local desktop. | PASS |
| Close GUI app | SSH terminal remains usable. | PASS |

Install test apps on Debian-like hosts if needed:

```bash
apt install -y x11-apps
```

## X11 Heavy Apps

| Test | Expected | Status |
| --- | --- | --- |
| Run Chromium with software rendering | Window opens or diagnostic is specific and useful. | RISK |
| Run `glxinfo -B` | Either succeeds or fails with clear GLX/XQuartz guidance. | RISK |
| Run `glxgears` | Best-effort only; GLX can fail depending on local X server. | RISK |

Suggested Chromium command:

```bash
chromium --no-sandbox --disable-gpu --use-gl=swiftshader
```

On macOS/XQuartz, treat `GLXBadContext` as a local XQuartz/GLX capability issue unless the same command works outside OpenXTerm.

## Failure Handling

| Test | Expected | Status |
| --- | --- | --- |
| Large UTF-8 output | No panic and no broken terminal input. | PASS |
| SSH auth failure | Auth guidance appears only for real auth failures, not for `apt permission denied`. | PASS |
| X11 forwarding failure | Diagnostic explains local display/remote sshd/xauth state. | PASS |
| Network interruption during transfer | Transfer fails clearly and does not leave UI stuck. | PASS |
