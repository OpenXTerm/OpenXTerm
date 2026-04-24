# Embedded SSH, SFTP, and X11 Smoke QA

This checklist covers the embedded `libssh-rs` runtime after the move away from the system `ssh` process.

## Baseline Setup

- Run the app through `./script/build_and_run.sh`.
- Use at least one Linux SSH target with password auth.
- Keep XQuartz or another local X server running when testing X11.
- Start a new SSH tab after changing local X11 or remote `sshd_config` settings.

## SSH Login

1. Open an SSH session with a saved username.
2. Open an SSH session without a saved username and enter `login as:` manually.
3. Confirm password prompts accept input once and do not repeat after successful auth.
4. Run commands with non-ASCII output, for example `apt update` on a Russian locale.
5. Confirm terminal input still works after long output.
6. Close the session and use `R` on the stopped footer to restart it.

## Status Bar

1. Confirm the status bar starts in loading state.
2. Wait for live metrics to appear.
3. Confirm CPU history changes over time.
4. Stop the SSH tab and confirm status polling stops cleanly.

## Linked SFTP

1. Connect to SSH.
2. Confirm the linked SFTP sidebar entry appears.
3. Open the linked SFTP browser.
4. List `/root` or the remote home directory.
5. Create a folder.
6. Upload a small file.
7. Download a file.
8. Delete the test file/folder.
9. Confirm password is not requested again while the SSH tab is alive.

## X11 2D Apps

1. Enable X11 in the session.
2. Connect and run `echo $DISPLAY`; it should be non-empty.
3. Install test apps if needed: `apt install -y x11-apps`.
4. Run `xeyes`.
5. Run `xclock`.
6. Close the GUI windows and confirm the SSH terminal remains usable.

## X11 Heavy Apps

1. Run `chromium --no-sandbox --disable-gpu --use-gl=swiftshader`.
2. Confirm either a window opens or OpenXTerm prints a specific X11/GLX diagnostic.
3. Run `glxinfo -B` or `glxgears` only as a GLX best-effort check.
4. On macOS/XQuartz, treat GLX failures such as `GLXBadContext` as expected unless local XQuartz GLX works outside OpenXTerm too.

## Failure Handling

1. Trigger a remote command that prints a large amount of UTF-8 text.
2. Confirm no Rust panic appears in the dev console.
3. Confirm no `embedded SSH channel is poisoned` message appears after X11 or command failures.
4. Confirm new terminal input still reaches the remote shell.

## Record

For each pass, capture:

- platform
- remote OS
- auth method
- X11 server
- pass/fail per section
- exact command output for failures
