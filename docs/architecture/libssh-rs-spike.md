# libssh-rs Spike

This note captures the first embedded-SSH spike for OpenXTerm.

## Goal

Capture the staged migration away from system OpenSSH and document what remains while helper, status, and file flows finish converging on native backends.

Current production behavior after this pass:

- terminal SSH tabs -> embedded `libssh-rs`
- status probe -> embedded helper SSH session
- linked SFTP -> embedded helper SSH/SFTP session

The spike started on the helper side first:

- native connect + auth
- PTY-capable exec channel
- SFTP directory listing
- known-host state inspection

## What Landed

### New dependency

- [`src-tauri/Cargo.toml`](../../src-tauri/Cargo.toml) now includes `libssh-rs` with vendored libssh/OpenSSL features so the repo can build the spike without assuming a preinstalled system libssh.

### New backend module

- [`src-tauri/src/probe.rs`](../../src-tauri/src/probe.rs)

It currently proves that we can:

- open a `libssh-rs` session
- authenticate with:
  - saved password
  - private key path + optional passphrase
  - SSH agent
- inspect known-host state through libssh
- open a session channel
- request a PTY
- execute a remote command
- open an SFTP subsystem
- list a remote directory and map entries into OpenXTerm-style `RemoteFileEntry`

### Debug command

- backend command: `run_libssh_probe`
- frontend bridge helper: [`runLibsshProbe()`](../../src/lib/bridge.ts)

The command intentionally is not wired into the main UI yet. It remains a probe path for manual/dev validation and backend comparison while helper flows are cleaned up.

## Probe Shape

`run_libssh_probe(session, remoteCommand?, remotePath?)` returns:

- authenticated user
- known-host verdict
- whether PTY request succeeded
- stdout/stderr/exit status from a probe command
- SFTP entries for the requested path
- notes collected during the run

The default remote command is a small identity/pwd probe so the backend can be checked with minimal side effects.

## Current Constraints

- The original spike expected a resolved username in the session, but the production helper path now reuses the interactive `login as:` metadata and live password cache when the tab is still connected.
- The embedded runtime now owns live terminal SSH tabs.
- The embedded helper path now owns status polling and linked SFTP too.
- X11 forwarding now has an embedded first-pass bridge through `libssh-rs` X11 channel requests and local display proxying, but still needs real-world testing across XQuartz, Xorg/XWayland, and Windows X servers.
- Wayland forwarding is still a separate future problem and should not be treated as “part of SSH backend parity”.

## Why This Is Useful

This gave us a safe test bed for the question:

> Can OpenXTerm move SSH work off system OpenSSH without losing control over auth/session flow?

The answer is now “yes, for terminal tabs and helper flows”:

- dependency builds in this repo
- API surface is workable
- PTY exec + SFTP list + auth matrix are reachable from Rust
- embedded shell tabs can run without shelling out to system `ssh`

## Recommended Next Step

If we continue this path, the most sensible next migration target is:

1. harden status and linked SFTP against more real-world auth/server edge cases
2. harden native X11 forwarding with real-world XQuartz/Xorg/Windows X server testing
3. evaluate whether a shared helper/session pool abstraction would simplify reconnect behavior

That keeps the blast radius controlled while turning the migration into boring, reliable product behavior.
