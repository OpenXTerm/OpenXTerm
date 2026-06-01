# Changelog

All notable changes to OpenXTerm are documented here.

Release entries are generated during the manual CI/CD release flow from GitHub release notes. When `GEMINI_API_KEY` is configured, Gemini 2.5 Flash may rewrite the entry for readability, but the generator validates that pull request references and contributor mentions from GitHub's generated notes are preserved.

## v0.0.6 - 2026-06-01

Changes since `v0.0.5`.

### Pull Requests

- #31: Ssh key auth legacy toggle by @GoGixdd (https://github.com/OpenXTerm/OpenXTerm/pull/31)
- #32: refactor(ssh): auto-detect SSH compatibility from private key type (follow-up to #31) by @GiaNTizmO (https://github.com/OpenXTerm/OpenXTerm/pull/32)
- #33: feat(session-editor): pick SSH private key with a native file dialog by @GiaNTizmO (https://github.com/OpenXTerm/OpenXTerm/pull/33)
- #34: fix(deps): pin @tauri-apps/plugin-dialog to 2.6.x for tauri 2.10 compat by @GiaNTizmO (https://github.com/OpenXTerm/OpenXTerm/pull/34)

### Direct Commits

- 5eef919: fix(ci): pin Rust dialog plugin to npm version by @GiaNTizmO
- 1bd4783: fix(macOS): include native drag system headers by @GiaNTizmO
- c288e88: Support PuTTY PPK SSH keys by @GiaNTizmO
- cea397a: Speed up manual CI/CD pipeline by @GiaNTizmO
- 552867e: Fix sccache scope in CI workflow by @GiaNTizmO
- 80ef5ec: Disable sccache in release builds by @GiaNTizmO

## v0.0.5 - 2026-05-11

### Features
- Add flat workspace tabstrip by @GiaNTizmO
- Add status bar settings and about tab by @GiaNTizmO
- Add AI-assisted release changelog generation by @GiaNTizmO
- Add versioned storage migrations by @GiaNTizmO

### Fixes
- Fix release changelog source collection by @GiaNTizmO
- Fix release notes date and asset filtering by @GiaNTizmO
- Fix about legal document links by @GiaNTizmO
- Keep linked SFTP bound to active SSH by @GiaNTizmO

### Refactors & Improvements
- refactor: centralize remote file helpers by @GiaNTizmO
- refactor: split transfer upload and download modules by @GiaNTizmO
- refactor: redesign session editor modal by @GiaNTizmO
- Simplify application menus by @GiaNTizmO
- Refactor embedded SSH interactive runtime by @GiaNTizmO

### Maintenance
- Automate dependency license audit by @GiaNTizmO
- Stop committing generated license reports by @GiaNTizmO

### Documentation
- #27: docs: add initial CHANGELOG.md by @Loumo-on (https://github.com/OpenXTerm/OpenXTerm/pull/27)
- docs: update agent file references by @GiaNTizmO
- docs: Update img showcase by @GiaNTizmO
- Add legal hygiene docs and about links by @GiaNTizmO

### New Contributors
* @Loumo-on made their first contribution in https://github.com/OpenXTerm/OpenXTerm/pull/27

## v0.0.4 - 2026-05-08

### Added

- Improved status bar resource metrics

### Fixed

- Legacy RSA SSH key authentication
- SSH PTY sizing and shell startup preservation

### Changed

- Tightened terminal surface spacing

## v0.0.3 - 2026-05-05

### Added

- Minimal unit test baseline 
- Confirmation dialog before deleting non-empty session folders 

### Fixed

- SSH launch UI responsiveness
- Local session console freezes
- Fresh install startup behavior
- Session editor draft validation before save
- SSH hostname trimming before persistence and connect
- Session-folder move state synchronization

### Changed

- Centralized proxy type dispatch
- Shared remote file drag and upload hooks


## v0.0.2 - 2026-05-04

### Added

- App settings menu
- Per-session proxy support
- Native SFTP properties window
- SFTP follow active remote terminal support
- Sortable SFTP table and manual path input

### Fixed

- Hardened SFTP transfers and editable paste handling
- Improved transfer reliability and terminal input behavior
- Improved SFTP transfer conflict handling

### Changed

- Reorganized Rust source tree into functional modules
- Refactored Tauri runtime modules
- Refactored stylesheet structure
- Consolidated SFTP transfer orchestration
- Tightened SSH runtime authentication metadata handling
- Split transfer backend helpers into focused modules
- Extracted store tab and terminal actions
- Extracted store domain actions
- Extracted file browser selection and UI hooks
- Extracted sidebar SFTP hooks
- Split session editor and file table UI components
- Refactored low-risk editor/runtime helpers
- Updated roadmap and SFTP smoke QA documentation
- Updated documentation to match implementation state

## v0.0.1 - 2026-04-25

### Added

- Initial public OpenXTerm alpha release
- Multi-platform GitHub Actions pipeline
- Embedded SSH runtime and X11 forwarding support
- Improved SFTP transfers and file actions
- Improved SFTP file table controls
- Proper Windows SFTP drag-out support
- Manual release pipeline preparation
- Simplified application chrome and Telnet startup flow
- Release workflow version handling improvements
- Windows SSH flow reliability
- Windows drag-out streaming and build setup
- Linux GitHub Actions dependency handling
- Release workflow Rust version parsing
- v0.0.1 release version validation
