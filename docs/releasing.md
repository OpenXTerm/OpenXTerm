# Releasing OpenXTerm

OpenXTerm releases are manual and tag-based. Normal commits and pushed tags do not start the CI/CD matrix by themselves.

## Release Flow

1. Update the version in all app version files:

```json
// package.json
"version": "0.2.0"
```

```json
// package-lock.json
"version": "0.2.0"
```

```json
// src-tauri/tauri.conf.json
"version": "0.2.0"
```

```toml
# src-tauri/Cargo.toml
version = "0.2.0"
```

2. Commit the version change:

```bash
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v0.2.0"
```

3. Create and push an annotated tag:

```bash
git tag -a v0.2.0 -m "OpenXTerm v0.2.0"
git push origin main
git push origin v0.2.0
```

4. Open GitHub Actions, choose `CI/CD`, click `Run workflow`, and fill:

- `release_tag`: `v0.2.0`
- `release_type`: `release` or `prerelease`

5. GitHub Actions checks out that tag, builds all release bundles, generates release notes from the previous version tag, and publishes a GitHub Release.

## Release Assets

The release job uploads the native Tauri bundle outputs plus extra portable Windows archives:

- macOS: `.dmg` bundles from Tauri
- Windows: Tauri installer bundles plus `openxterm-windows-*-portable.zip`
- Linux: Tauri Linux bundles such as AppImage / Debian package outputs, depending on the bundler output for that runner

## Release Notes

The workflow finds the previous semver-like tag, then asks GitHub to generate release notes for the diff between:

- previous tag
- selected `release_tag`

Example: running the workflow for `v0.2.0` after `v0.1.0` generates notes for changes since `v0.1.0`.

## Manual Build Matrix

The workflow is started only with `workflow_dispatch`.

Every run builds and publishes a GitHub Release for the selected tag. Use `release_type=prerelease` for alpha/beta builds.

## Version Rule

The workflow fails early if the tag version does not match all app version files:

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

Example: tag `v0.2.0` requires all three files to contain `0.2.0`.
