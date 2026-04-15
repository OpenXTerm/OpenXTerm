# Contributing to OpenXTerm

Thanks for taking a look at OpenXTerm. The project is still early, so small, focused contributions are especially valuable.

## Before You Start

- Read [`AGENTS.md`](AGENTS.md) for the current architecture and important invariants.
- Keep changes scoped. Drag/drop, terminal lifecycle, transfers, and native macOS drag have some hard-won behavior behind them.
- Prefer existing patterns in the store, bridge, and Rust command layers.

## Local Checks

Run these before opening a pull request when possible:

```bash
npm run check
cargo build --manifest-path src-tauri/Cargo.toml
./script/build_and_run.sh --verify
```

For native drag, transfers, terminal lifecycle, or X11 changes, also do a manual smoke test in the running desktop app.

## Pull Request Guidance

- Explain the user-facing behavior change.
- Mention manual test coverage.
- Call out platform-specific behavior, especially macOS/Linux/Windows differences.
- Avoid broad refactors mixed with feature work.

## Project Positioning

OpenXTerm is inspired by terminal workspace workflows, but it is independent software. Avoid branding, assets, or copy that implies affiliation with MobaXterm, Mobatek, or other products.
