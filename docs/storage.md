# OpenXTerm storage lifecycle

OpenXTerm stores the desktop app state in the Tauri app data directory as `state.json`.
The file includes sessions, session folders, macros, and UI preferences.

## Schema version

`state.json` has a top-level `schemaVersion` field. The current schema version is `2`.

Older unversioned files are treated as schema `1` and migrated on load. Future schema versions are rejected with a clear error instead of being downgraded or overwritten.

## Migration safety

When OpenXTerm loads an older storage schema:

1. It parses the old JSON without modifying the file.
2. It migrates the parsed model in memory.
3. It copies the original file to `backups/` next to `state.json`.
4. It writes the migrated model through a temporary file in the same directory.
5. It replaces `state.json` with the temporary file after the temporary file is flushed.

The backup filename includes the reason, source schema, target schema, and UTC timestamp.

Example:

```text
state.migration.v1-v2.2026-05-11T12-30-00Z.json
```

## Export and backup story

The backend exposes two Tauri commands for future UI wiring and manual support workflows:

- `export_storage` creates an explicit snapshot in the same `backups/` directory.
- `list_storage_backups` returns known backup/export files with path, size, and creation time.

Exports use the same copy-based backup path as migrations, so they do not rewrite active storage.

## Retention

Backups are pruned by reason after a new backup is created:

- migration backups: keep the newest 10 files
- manual export backups: keep the newest 20 files

Cleanup is scoped by filename prefix, so migration cleanup does not remove manual exports, and export cleanup does not remove migration backups.

## Restore

To restore manually:

1. Quit OpenXTerm.
2. Find the app data directory for the platform.
3. Replace `state.json` with a selected file from `backups/`.
4. Start OpenXTerm again.

Do not restore a backup created by a newer OpenXTerm build into an older build unless the older build supports that `schemaVersion`.
