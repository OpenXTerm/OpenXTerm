# Releasing OpenXTerm

OpenXTerm releases are manual. Normal commits and pushed tags do not start the CI/CD matrix by themselves.

## Release Flow

1. Open GitHub Actions, choose `CI/CD`, click `Run workflow`, and fill:

- `version`: `0.2.0`
- `release_type`: `release` or `prerelease`

2. GitHub Actions generates a `CHANGELOG.md` entry from GitHub release notes, optionally asks Gemini 2.5 Flash to rewrite it when `GEMINI_API_KEY` is configured, validates that pull request references and contributor mentions are preserved, updates all version files on `main`, creates a release commit, and pushes it:

```bash
git commit -m "Release v0.2.0"
```

3. GitHub Actions creates and pushes an annotated tag:

```bash
git tag -a v0.2.0 -m "OpenXTerm v0.2.0"
```

4. GitHub Actions checks out that tag, builds the currently enabled release bundles, generates polished GitHub Release notes from the same source data, and publishes a GitHub Release.

The local helper is still available if a version must be changed outside CI:

```bash
npm run version:set -- 0.2.0
```

The changelog generator can also be run locally with an already-generated notes file:

```bash
npm run changelog:generate -- \
  --input generated-release-notes.md \
  --output generated-changelog-entry.md \
  --release-tag v0.2.0 \
  --previous-tag v0.1.0 \
  --changelog-path CHANGELOG.md
```

Set the GitHub Actions secret `GEMINI_API_KEY` to enable the Gemini rewrite path in CI. If the key is missing, the model call fails, or the model output drops pull request references or contributor mentions, the script falls back to the original GitHub-generated notes.

## Release Assets

The release job uploads the native Tauri bundle outputs from enabled matrix targets plus extra portable Windows archives:

- macOS: `.dmg` bundles from Tauri
- Windows: Tauri installer bundles plus `openxterm-windows-*-portable.zip`
- Linux: Tauri Linux bundles such as AppImage / Debian package outputs, depending on the bundler output for that runner

The configured build matrix includes Linux X64, Linux ARM64, Windows X64, Windows ARM64, macOS ARM64, and macOS X64. For the current CI/CD test pass only Linux X64, Windows X64, and macOS ARM64 are enabled; disabled targets remain in the workflow with `enabled: false`.

## License Notices

Release artifacts must preserve third-party license notices. Before publishing a release, review:

- [`LICENSE`](../LICENSE)
- [`THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md)
- [`TRADEMARKS.md`](../TRADEMARKS.md)

The current hand-written third-party notice file covers the known release-sensitive dependencies: vendored libssh, vendored OpenSSL, and `serialport`. The first-pass legal hygiene task is tracked in [#28](https://github.com/OpenXTerm/OpenXTerm/issues/28). Automated dependency license report generation is tracked in [#29](https://github.com/OpenXTerm/OpenXTerm/issues/29) and should be run once it exists.

## Release Notes

The workflow creates `v<version>`, finds the previous semver-like tag, then asks GitHub to generate release notes for the diff between:

- previous tag
- selected release tag

Those GitHub-generated notes are the source of truth for pull request references and contributor mentions. The changelog generator then either:

- rewrites them with Gemini 2.5 Flash when `GEMINI_API_KEY` is configured, or
- uses the GitHub notes directly as a fallback.

The generator validates that pull request URLs, `#123` references, and `@contributor` mentions from the GitHub notes are still present. If validation fails, it uses the fallback notes.

Example: running the workflow for `v0.2.0` after `v0.1.0` creates a `CHANGELOG.md` entry and GitHub Release notes for changes since `v0.1.0`.

## Manual Build Matrix

The workflow is started only with `workflow_dispatch`.

Every run creates a release commit/tag, builds bundles, and publishes a GitHub Release for the selected version. Use `release_type=prerelease` for alpha/beta builds.

If a run fails after the tag has already been created, rerun the same version. The workflow reuses the existing tag and republishes release assets.

## Version Rule

The workflow fails early if the generated release version does not match all app version files:

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`

Example: input `0.2.0` creates tag `v0.2.0` and requires all version files to contain `0.2.0`.
