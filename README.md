# OpenXTerm

OpenXTerm is an early-stage open-source desktop terminal workspace for macOS and Linux.

It is inspired by the session-first workflow popularized by tools like MobaXterm: saved connections, folders, terminal tabs, SFTP sidebars, file transfers, macros, and live host status in one compact app.

OpenXTerm is not affiliated with, endorsed by, or connected to MobaXterm or Mobatek.

## Status

This project is usable for development and testing, but it is still alpha software. Expect rough edges, missing packaging polish, and behavior that may change between releases.

The current focus is:

- reliable SSH sessions
- integrated SFTP workflows
- session tree management
- compact cross-platform desktop UX
- local shell support
- standard SSH X11 forwarding diagnostics

## Features

- Local shell sessions for macOS, Linux, and Windows-compatible runtime paths
- SSH, Telnet, and Serial terminal transports
- Session folders with tree view and drag/drop organization
- Multiple simultaneous connections to the same saved session
- MobaXterm `.mxtsessions` import for common session types
- Linked SFTP sidebar for active SSH sessions
- Remote file browsing, folder creation, delete, upload, and download
- Batch transfer progress for multi-file operations
- Native macOS drag-out from remote file browser to Finder
- Restart/save prompt when terminal sessions stop
- Per-session terminal font, size, foreground color, and background color
- System font picker in the session editor
- Live lower status bar with host, user, uptime, CPU history, memory, disk, network, and latency when available
- Optional app lock through platform authentication where supported
- SSH X11 forwarding settings and diagnostics for local X server setups

## Known Limits

- The app is not a finished MobaXterm clone. It covers a focused subset and is evolving quickly.
- X11 forwarding uses standard OpenSSH `-X` / `-Y`; it still requires a working local X server such as XQuartz on macOS, Xorg/XWayland on Linux, or a Windows X server.
- Remote status metrics are best-effort and depend on the remote OS and available shell tools.
- SFTP is actively improving; password and control-socket reuse are areas to keep testing carefully.
- Packaging, signing, and distribution workflows still need a dedicated release pass.
- There is no broad automated test suite yet.

## Stack

- Tauri 2
- Rust backend
- React 19 + TypeScript + Vite
- Zustand
- xterm.js

## Quick Start

Install dependencies:

```bash
npm install
```

Run the desktop app:

```bash
./script/build_and_run.sh
```

Verify launch without keeping the dev loop attached:

```bash
./script/build_and_run.sh --verify
```

Typecheck and lint:

```bash
npm run check
```

Build the Rust backend:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
```

## Development Notes

Fresh agents and contributors should start with [`AGENTS.md`](AGENTS.md). It is more detailed than this README and maps the current architecture, invariants, and common edit points.

High-level map:

```text
OpenXTerm/
  src/
    components/
      forms/
      layout/
      sidebar/
      status/
      workspace/
    lib/
    state/
    types/
  src-tauri/
    src/
      commands.rs
      file_ops.rs
      font_support.rs
      models.rs
      native_drag.rs
      runtime.rs
      storage.rs
      x11_support.rs
  script/
```

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the current release plan, stable-release blockers, and feature status.

## License

MIT. See [LICENSE](LICENSE).
