# Embedded SSH, SFTP, and X11 Smoke QA

This file is a living QA map for the embedded `libssh-rs` runtime and linked SFTP flow.

It is not only a checklist. It records what currently works, what still needs manual verification, and what should be tested before a release tag.

## Status Legend

- `PASS`: tested manually and currently expected to work.
- `NEEDS RETEST`: implemented or recently changed, but needs another manual pass.
- `RISK`: known fragile area; test carefully before release.
- `TODO`: not implemented or not ready enough to claim.

## Current Snapshot

Last broad manual pass: April 24, 2026.

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
| SFTP transfer window | NEEDS RETEST | Recent changes restored separate transfer window, added cancel, and auto-close after 2 seconds. |
| SFTP rename/context menu | NEEDS RETEST | Added after the last confirmed SFTP pass. |
| SFTP follow remote terminal | NEEDS RETEST | Enable `follow remote terminal`, run `pwd`/`cd` in the linked SSH tab, and confirm the SFTP sidebar follows the shell directory. |
| SFTP upload/download conflict handling | NEEDS RETEST | Existing names should prompt for overwrite, skip, or rename; batch conflicts should honor apply-to-all. |
| Transfer cancel | NEEDS RETEST | Backend cancellation exists, but must be tested with large files/folders. |
| Transfer retry | NEEDS RETEST | Failed upload/download rows should expose `Retry` and restart from the same transfer window. |
| X11 basic forwarding | PASS | `$DISPLAY` can appear and basic X11 forwarding can work with a local X server. |
| X11 GLX/heavy apps | RISK | `glxgears`/Chromium depend heavily on XQuartz/local GLX support. |
| Cross-platform Windows/Linux SFTP/status | RISK | Needs more real-machine passes. |

## Test Next

Run these first when validating the current branch:

1. Upload a large file and confirm the transfer window appears immediately.
2. Click `Cancel` during upload and confirm the upload stops with a clear canceled/error state.
3. Upload several files and confirm the transfer window shows one batch progress item.
4. Upload a file whose name already exists and confirm it is skipped, not overwritten.
5. Right-click an SFTP entry and test `Rename`, `Delete`, and `Download`.
6. Confirm the transfer window closes automatically about 2 seconds after completion.
7. Force a transfer failure, then click `Retry` and confirm it restarts and completes.

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
| Upload single file | Transfer window appears and file appears remotely. | NEEDS RETEST |
| Upload multiple files | One batch transfer is shown. | NEEDS RETEST |
| Upload existing name | Existing file is skipped; no silent overwrite. | NEEDS RETEST |
| Drag file from Finder into empty remote folder | Drop-zone accepts file. | PASS |
| Download file | File is saved locally and transfer completes. | PASS |
| Delete file/folder | Entry disappears after reload. | PASS |
| Right-click context menu | Menu opens with Rename/Delete/Download. | NEEDS RETEST |
| Rename file/folder | Entry is renamed remotely and list refreshes. | NEEDS RETEST |
| Cancel large upload/download | Backend stops transfer and UI shows canceled/error state. | NEEDS RETEST |
| Retry failed upload/download | Failed row offers `Retry`; retry returns to queued/running and can complete. | NEEDS RETEST |

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
| Network interruption during transfer | Transfer should fail clearly and not leave UI stuck. | NEEDS RETEST |
