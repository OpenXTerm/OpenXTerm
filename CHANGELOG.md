# Changelog

All notable changes to OpenXTerm are documented here.

Release entries are generated during the manual CI/CD release flow from GitHub release notes. When `GEMINI_API_KEY` is configured, Gemini 2.5 Flash may rewrite the entry for readability, but the generator validates that pull request references and contributor mentions from GitHub's generated notes are preserved.

## v0.0.5 - 2026-05-10

### Highlights

-   Add flat workspace tabstrip by @GiaNTizmO
-   Add status bar settings and about tab by @GiaNTizmO

### Fixes

-   Fix release changelog source collection by @GiaNTizmO
-   Fix release notes date and asset filtering by @GiaNTizmO

### Maintenance

-   Centralize remote file helpers by @GiaNTizmO
-   Split transfer upload and download modules by @GiaNTizmO
-   Redesign session editor modal by @GiaNTizmO
-   Add AI-assisted release changelog generation by @GiaNTizmO

### Documentation

-   Update agent file references by @GiaNTizmO
-   Update img showcase by @GiaNTizmO
-   Add legal hygiene docs and about links by @GiaNTizmO

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