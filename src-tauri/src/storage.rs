use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::models::{
    current_storage_schema_version, MacroDefinition, StatusBarMetrics, StorageBackupInfo,
    StorageExportPayload, StorageModel, UiPreferences, CURRENT_STORAGE_SCHEMA_VERSION,
};

const LEGACY_UNVERSIONED_SCHEMA_VERSION: u32 = 1;
const MAX_MIGRATION_BACKUPS: usize = 10;
const MAX_EXPORT_BACKUPS: usize = 20;

#[derive(Debug)]
struct StorageMigrationResult {
    storage: StorageModel,
    migrated: bool,
    source_schema_version: u32,
}

pub fn load_storage(app: &AppHandle) -> Result<StorageModel, String> {
    let storage_path = storage_path(app)?;
    if !storage_path.exists() {
        let seed = seed_storage();
        save_storage(app, &seed)?;
        return Ok(seed);
    }

    let raw = fs::read_to_string(&storage_path)
        .map_err(|error| format!("failed to read {}: {error}", storage_path.display()))?;
    let migration = migrate_storage_json(&raw, &storage_path)?;

    if migration.migrated {
        create_storage_backup(
            &storage_path,
            migration.source_schema_version,
            CURRENT_STORAGE_SCHEMA_VERSION,
            "migration",
        )?;
        write_storage_model(&storage_path, &migration.storage)?;
    }

    Ok(migration.storage)
}

pub fn save_storage(app: &AppHandle, storage: &StorageModel) -> Result<(), String> {
    write_storage_model(&storage_path(app)?, storage)
}

pub fn export_storage_snapshot(app: &AppHandle) -> Result<StorageExportPayload, String> {
    let storage = load_storage(app)?;
    let storage_path = storage_path(app)?;
    let backup_path = create_storage_backup(
        &storage_path,
        storage.schema_version,
        storage.schema_version,
        "export",
    )?;

    Ok(StorageExportPayload {
        path: backup_path.to_string_lossy().to_string(),
        schema_version: storage.schema_version,
    })
}

pub fn list_storage_backups(app: &AppHandle) -> Result<Vec<StorageBackupInfo>, String> {
    let storage_path = storage_path(app)?;
    let backup_dir = storage_backup_dir(&storage_path);
    if !backup_dir.exists() {
        return Ok(vec![]);
    }

    let mut backups = vec![];
    for entry in fs::read_dir(&backup_dir)
        .map_err(|error| format!("failed to read {}: {error}", backup_dir.display()))?
    {
        let entry =
            entry.map_err(|error| format!("failed to read storage backup entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
        if !metadata.is_file() {
            continue;
        }

        backups.push(StorageBackupInfo {
            file_name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            size_bytes: metadata.len(),
            created_at: metadata
                .created()
                .or_else(|_| metadata.modified())
                .map(format_system_time)
                .unwrap_or_else(|_| "unknown".into()),
        });
    }

    backups.sort_by(|left, right| right.file_name.cmp(&left.file_name));
    Ok(backups)
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;

    Ok(app_data_dir.join("state.json"))
}

fn write_storage_model(storage_path: &Path, storage: &StorageModel) -> Result<(), String> {
    let mut next_storage = storage.clone();
    next_storage.schema_version = CURRENT_STORAGE_SCHEMA_VERSION;

    let content = serde_json::to_string_pretty(&next_storage)
        .map_err(|error| format!("failed to serialize storage: {error}"))?;

    write_file_atomically(storage_path, &content)
}

fn write_file_atomically(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("failed to resolve parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;

    let temp_path = temporary_storage_path(path);
    let write_result = (|| {
        let mut temp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("failed to create {}: {error}", temp_path.display()))?;
        temp_file
            .write_all(content.as_bytes())
            .map_err(|error| format!("failed to write {}: {error}", temp_path.display()))?;
        temp_file
            .sync_all()
            .map_err(|error| format!("failed to flush {}: {error}", temp_path.display()))?;
        drop(temp_file);
        fs::rename(&temp_path, path).map_err(|error| {
            format!(
                "failed to replace {} with {}: {error}",
                path.display(),
                temp_path.display()
            )
        })
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    write_result
}

fn temporary_storage_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("state.json");
    path.with_file_name(format!(
        ".{file_name}.tmp-{}-{}",
        process::id(),
        timestamp_for_filename()
    ))
}

fn migrate_storage_json(raw: &str, storage_path: &Path) -> Result<StorageMigrationResult, String> {
    let mut value = serde_json::from_str::<Value>(raw)
        .map_err(|error| format!("failed to parse {}: {error}", storage_path.display()))?;
    let source_schema_version = storage_schema_version(&value)?;

    if source_schema_version > CURRENT_STORAGE_SCHEMA_VERSION {
        return Err(format!(
            "{} uses storage schema v{}, but this OpenXTerm build supports up to v{}. Please upgrade OpenXTerm before opening this profile.",
            storage_path.display(),
            source_schema_version,
            CURRENT_STORAGE_SCHEMA_VERSION
        ));
    }

    let mut migrated = false;
    let mut active_schema_version = source_schema_version;
    while active_schema_version < CURRENT_STORAGE_SCHEMA_VERSION {
        match active_schema_version {
            LEGACY_UNVERSIONED_SCHEMA_VERSION => {
                migrate_v1_to_v2(&mut value)?;
                active_schema_version = 2;
                migrated = true;
            }
            version => {
                return Err(format!(
                    "missing storage migration from schema v{} to v{}",
                    version,
                    version + 1
                ));
            }
        }
    }

    let storage = serde_json::from_value::<StorageModel>(value).map_err(|error| {
        format!(
            "failed to decode migrated storage model from {}: {error}",
            storage_path.display()
        )
    })?;

    Ok(StorageMigrationResult {
        storage,
        migrated,
        source_schema_version,
    })
}

fn storage_schema_version(value: &Value) -> Result<u32, String> {
    match value.get("schemaVersion") {
        Some(Value::Number(version)) => version
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value >= LEGACY_UNVERSIONED_SCHEMA_VERSION)
            .ok_or_else(|| "storage schemaVersion must be a positive integer".to_string()),
        Some(_) => Err("storage schemaVersion must be a number".into()),
        None => Ok(LEGACY_UNVERSIONED_SCHEMA_VERSION),
    }
}

fn migrate_v1_to_v2(value: &mut Value) -> Result<(), String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "storage root must be a JSON object".to_string())?;
    object.insert(
        "schemaVersion".into(),
        Value::Number(current_storage_schema_version().into()),
    );

    ensure_array_field(object, "sessions");
    ensure_array_field(object, "sessionFolders");
    ensure_array_field(object, "macros");
    normalize_v1_preferences(object)?;
    normalize_v1_sessions(object)?;

    Ok(())
}

fn ensure_array_field(object: &mut Map<String, Value>, key: &str) {
    if !object.get(key).is_some_and(Value::is_array) {
        object.insert(key.into(), Value::Array(vec![]));
    }
}

fn normalize_v1_preferences(object: &mut Map<String, Value>) -> Result<(), String> {
    if !object.get("preferences").is_some_and(Value::is_object) {
        object.insert(
            "preferences".into(),
            serde_json::to_value(seed_preferences())
                .map_err(|error| format!("failed to seed default preferences: {error}"))?,
        );
        return Ok(());
    }

    let preferences = object
        .get_mut("preferences")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "preferences must be a JSON object".to_string())?;
    preferences
        .entry("theme")
        .or_insert_with(|| Value::String("dark".into()));
    preferences
        .entry("activeSidebar")
        .or_insert_with(|| Value::String("sessions".into()));
    preferences
        .entry("statusBarVisible")
        .or_insert_with(|| Value::Bool(true));
    preferences
        .entry("statusBarSize")
        .or_insert_with(|| Value::String("regular".into()));
    preferences.entry("statusBarMetrics").or_insert_with(|| {
        serde_json::to_value(seed_status_bar_metrics())
            .unwrap_or_else(|_| Value::Object(Map::new()))
    });

    Ok(())
}

fn normalize_v1_sessions(object: &mut Map<String, Value>) -> Result<(), String> {
    let Some(sessions) = object.get_mut("sessions").and_then(Value::as_array_mut) else {
        return Ok(());
    };

    for session in sessions {
        let session = session
            .as_object_mut()
            .ok_or_else(|| "session entries must be JSON objects".to_string())?;
        session
            .entry("host")
            .or_insert_with(|| Value::String(String::new()));
        session
            .entry("port")
            .or_insert_with(|| Value::Number(0_u16.into()));
        session
            .entry("username")
            .or_insert_with(|| Value::String(String::new()));
        session
            .entry("authType")
            .or_insert_with(|| Value::String("password".into()));
        session.entry("password").or_insert(Value::Null);
        session.entry("keyPath").or_insert(Value::Null);
        session
            .entry("proxyType")
            .or_insert_with(|| Value::String("none".into()));
        session.entry("serialPort").or_insert(Value::Null);
        session
            .entry("parity")
            .or_insert_with(|| Value::String("none".into()));
        session
            .entry("stopBits")
            .or_insert_with(|| Value::Number(1_u8.into()));
        session
            .entry("dataBits")
            .or_insert_with(|| Value::Number(8_u8.into()));
    }

    Ok(())
}

fn create_storage_backup(
    storage_path: &Path,
    from_schema_version: u32,
    to_schema_version: u32,
    reason: &str,
) -> Result<PathBuf, String> {
    if !storage_path.exists() {
        return Err(format!(
            "cannot create storage backup because {} does not exist",
            storage_path.display()
        ));
    }

    let backup_dir = storage_backup_dir(storage_path);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("failed to create {}: {error}", backup_dir.display()))?;
    let backup_path = backup_dir.join(format!(
        "state.{reason}.v{from_schema_version}-v{to_schema_version}.{}.json",
        timestamp_for_filename()
    ));
    fs::copy(storage_path, &backup_path).map_err(|error| {
        format!(
            "failed to back up {} to {}: {error}",
            storage_path.display(),
            backup_path.display()
        )
    })?;
    prune_storage_backups_for_reason(&backup_dir, reason);

    Ok(backup_path)
}

fn prune_storage_backups_for_reason(backup_dir: &Path, reason: &str) {
    let keep_count = match reason {
        "migration" => MAX_MIGRATION_BACKUPS,
        "export" => MAX_EXPORT_BACKUPS,
        _ => return,
    };
    let _ = prune_storage_backups(backup_dir, reason, keep_count);
}

fn prune_storage_backups(backup_dir: &Path, reason: &str, keep_count: usize) -> Result<(), String> {
    if !backup_dir.exists() {
        return Ok(());
    }

    let backup_prefix = format!("state.{reason}.");
    let mut backups = vec![];
    for entry in fs::read_dir(backup_dir)
        .map_err(|error| format!("failed to read {}: {error}", backup_dir.display()))?
    {
        let entry =
            entry.map_err(|error| format!("failed to read storage backup entry: {error}"))?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !file_name.starts_with(&backup_prefix)
            || path.extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }

        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
        if !metadata.is_file() {
            continue;
        }
        let timestamp = metadata
            .modified()
            .or_else(|_| metadata.created())
            .unwrap_or(UNIX_EPOCH);
        backups.push((path, file_name, timestamp));
    }

    backups.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| right.1.cmp(&left.1)));
    for (path, _, _) in backups.into_iter().skip(keep_count) {
        fs::remove_file(&path)
            .map_err(|error| format!("failed to remove old backup {}: {error}", path.display()))?;
    }

    Ok(())
}

fn storage_backup_dir(storage_path: &Path) -> PathBuf {
    storage_path
        .parent()
        .map(|parent| parent.join("backups"))
        .unwrap_or_else(|| PathBuf::from("backups"))
}

fn format_system_time(value: SystemTime) -> String {
    let offset = value
        .duration_since(UNIX_EPOCH)
        .map(|duration| OffsetDateTime::from_unix_timestamp(duration.as_secs() as i64).ok())
        .ok()
        .flatten();
    offset
        .and_then(|value| value.format(&Rfc3339).ok())
        .unwrap_or_else(|| "unknown".into())
}

fn timestamp_for_filename() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown-time".into())
        .replace(':', "-")
}

fn seed_storage() -> StorageModel {
    StorageModel {
        schema_version: CURRENT_STORAGE_SCHEMA_VERSION,
        sessions: vec![],
        session_folders: vec![],
        macros: seed_macros(),
        preferences: seed_preferences(),
    }
}

fn seed_macros() -> Vec<MacroDefinition> {
    vec![
        MacroDefinition {
            id: "macro-df".into(),
            name: "Disk usage".into(),
            command: "df -h".into(),
            created_at: "2026-04-13T09:30:00.000Z".into(),
            updated_at: "2026-04-13T09:30:00.000Z".into(),
        },
        MacroDefinition {
            id: "macro-top".into(),
            name: "Load snapshot".into(),
            command: "uptime && free -m".into(),
            created_at: "2026-04-13T09:31:00.000Z".into(),
            updated_at: "2026-04-13T09:31:00.000Z".into(),
        },
        MacroDefinition {
            id: "macro-tail".into(),
            name: "Tail auth log".into(),
            command: "tail -n 100 /var/log/auth.log".into(),
            created_at: "2026-04-13T09:32:00.000Z".into(),
            updated_at: "2026-04-13T09:32:00.000Z".into(),
        },
    ]
}

fn seed_preferences() -> UiPreferences {
    UiPreferences {
        theme: "dark".into(),
        active_sidebar: "sessions".into(),
        sidebar_width: Some(252),
        status_bar_visible: true,
        status_bar_size: "regular".into(),
        status_bar_metrics: seed_status_bar_metrics(),
    }
}

fn seed_status_bar_metrics() -> StatusBarMetrics {
    StatusBarMetrics {
        host: true,
        user: true,
        cpu: true,
        memory: true,
        disk: true,
        network_down: true,
        network_up: true,
        uptime: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_storage_path() -> PathBuf {
        PathBuf::from("/tmp/openxterm-test-state.json")
    }

    #[test]
    fn migrates_unversioned_storage_to_current_schema() {
        let raw = r#"{
          "sessions": [{
            "id": "session-1",
            "name": "Server",
            "kind": "ssh",
            "host": "example.com",
            "port": 22,
            "username": "alice",
            "authType": "password",
            "createdAt": "2026-05-01T00:00:00.000Z",
            "updatedAt": "2026-05-01T00:00:00.000Z"
          }],
          "macros": [],
          "preferences": { "theme": "dark", "activeSidebar": "sessions" }
        }"#;

        let result = migrate_storage_json(raw, &test_storage_path()).expect("migration succeeds");

        assert!(result.migrated);
        assert_eq!(
            result.source_schema_version,
            LEGACY_UNVERSIONED_SCHEMA_VERSION
        );
        assert_eq!(
            result.storage.schema_version,
            CURRENT_STORAGE_SCHEMA_VERSION
        );
        assert_eq!(result.storage.session_folders.len(), 0);
        assert!(result.storage.preferences.status_bar_visible);
        assert_eq!(result.storage.preferences.status_bar_size, "regular");
        assert_eq!(result.storage.sessions[0].proxy_type, "none");
        assert_eq!(result.storage.sessions[0].data_bits, 8);
    }

    #[test]
    fn accepts_current_storage_without_migration() {
        let raw = r#"{
          "schemaVersion": 2,
          "sessions": [],
          "sessionFolders": [],
          "macros": [],
          "preferences": {
            "theme": "dark",
            "activeSidebar": "sessions",
            "statusBarVisible": true,
            "statusBarSize": "regular",
            "statusBarMetrics": {
              "host": true,
              "user": true,
              "cpu": true,
              "memory": true,
              "disk": true,
              "networkDown": true,
              "networkUp": true,
              "uptime": true
            }
          }
        }"#;

        let result = migrate_storage_json(raw, &test_storage_path()).expect("decode succeeds");

        assert!(!result.migrated);
        assert_eq!(
            result.storage.schema_version,
            CURRENT_STORAGE_SCHEMA_VERSION
        );
    }

    #[test]
    fn rejects_future_storage_versions() {
        let raw = r#"{
          "schemaVersion": 99,
          "sessions": [],
          "sessionFolders": [],
          "macros": [],
          "preferences": { "theme": "dark", "activeSidebar": "sessions" }
        }"#;

        let error = migrate_storage_json(raw, &test_storage_path()).expect_err("future version");

        assert!(error.contains("supports up to v2"));
    }

    #[test]
    fn backup_dir_is_next_to_state_file() {
        assert_eq!(
            storage_backup_dir(Path::new("/tmp/openxterm/state.json")),
            PathBuf::from("/tmp/openxterm/backups")
        );
    }

    #[test]
    fn prunes_backups_by_reason_without_touching_other_files() {
        let backup_dir = std::env::temp_dir().join(format!(
            "openxterm-storage-backup-test-{}",
            timestamp_for_filename()
        ));
        fs::create_dir_all(&backup_dir).expect("create backup dir");

        for index in 0..12 {
            fs::write(
                backup_dir.join(format!(
                    "state.migration.v1-v2.2026-05-11T00-00-{index:02}Z.json"
                )),
                "{}",
            )
            .expect("write migration backup");
        }
        fs::write(
            backup_dir.join("state.export.v2-v2.2026-05-11T00-00-00Z.json"),
            "{}",
        )
        .expect("write export backup");
        fs::write(backup_dir.join("notes.txt"), "keep").expect("write unrelated file");

        prune_storage_backups(&backup_dir, "migration", 10).expect("prune backups");

        let files = fs::read_dir(&backup_dir)
            .expect("read backup dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .to_string()
            })
            .collect::<Vec<_>>();
        let migration_count = files
            .iter()
            .filter(|name| name.starts_with("state.migration."))
            .count();

        assert_eq!(migration_count, 10);
        assert!(files.iter().any(|name| name.starts_with("state.export.")));
        assert!(files.iter().any(|name| name == "notes.txt"));

        fs::remove_dir_all(&backup_dir).expect("cleanup backup dir");
    }
}
