# Releasing OpenXTerm

OpenXTerm releases are manual. Normal commits and pushed tags do not start the CI/CD matrix by themselves.

## Release Flow

1. Open GitHub Actions, choose `CI/CD`, click `Run workflow`, and fill:

- `version`: `0.2.0`
- `release_type`: `release` or `prerelease`

2. GitHub Actions updates all version files on `main`, creates a release commit, and pushes it:

```bash
git commit -m "Release v0.2.0"
```

3. GitHub Actions creates and pushes an annotated tag:

```bash
git tag -a v0.2.0 -m "OpenXTerm v0.2.0"
```

4. GitHub Actions checks out that tag, builds all release bundles, generates release notes from the previous version tag, and publishes a GitHub Release.

The local helper is still available if a version must be changed outside CI:

```bash
npm run version:set -- 0.2.0
```

## Release Assets

The release job uploads the native Tauri bundle outputs plus extra portable Windows archives:

- macOS: `.dmg` bundles from Tauri
- Windows: Tauri installer bundles plus `openxterm-windows-*-portable.zip`
- Linux: Tauri Linux bundles such as AppImage / Debian package outputs, depending on the bundler output for that runner

## Release Notes

The workflow creates `v<version>`, finds the previous semver-like tag, then asks GitHub to generate release notes for the diff between:

- previous tag
- selected release tag

Example: running the workflow for `v0.2.0` after `v0.1.0` generates notes for changes since `v0.1.0`.

## Manual Build Matrix

The workflow is started only with `workflow_dispatch`.

Every run creates a release commit/tag, builds bundles, and publishes a GitHub Release for the selected version. Use `release_type=prerelease` for alpha/beta builds.

## Version Rule

The workflow fails early if the generated release version does not match all app version files:

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`

Example: input `0.2.0` creates tag `v0.2.0` and requires all version files to contain `0.2.0`.
