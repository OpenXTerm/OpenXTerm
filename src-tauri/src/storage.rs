use std::{fs, path::PathBuf};

use tauri::{AppHandle, Manager};

use crate::models::{MacroDefinition, StorageModel, UiPreferences};

pub fn load_storage(app: &AppHandle) -> Result<StorageModel, String> {
    let storage_path = storage_path(app)?;
    if !storage_path.exists() {
        let seed = seed_storage();
        save_storage(app, &seed)?;
        return Ok(seed);
    }

    let raw = fs::read_to_string(&storage_path)
        .map_err(|error| format!("failed to read {}: {error}", storage_path.display()))?;

    serde_json::from_str::<StorageModel>(&raw)
        .map_err(|error| format!("failed to parse {}: {error}", storage_path.display()))
}

pub fn save_storage(app: &AppHandle, storage: &StorageModel) -> Result<(), String> {
    let storage_path = storage_path(app)?;
    if let Some(parent) = storage_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    let content = serde_json::to_string_pretty(storage)
        .map_err(|error| format!("failed to serialize storage: {error}"))?;

    fs::write(&storage_path, content)
        .map_err(|error| format!("failed to write {}: {error}", storage_path.display()))
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;

    Ok(app_data_dir.join("state.json"))
}

fn seed_storage() -> StorageModel {
    StorageModel {
        sessions: vec![],
        session_folders: vec![],
        macros: vec![
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
        ],
        preferences: UiPreferences {
            theme: "dark".into(),
            active_sidebar: "sessions".into(),
            sidebar_width: Some(252),
            status_bar_visible: true,
        },
    }
}
