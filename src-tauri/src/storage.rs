use std::{fs, path::PathBuf};

use tauri::{AppHandle, Manager};

use crate::models::{
    MacroDefinition, SessionDefinition, SessionFolderDefinition, StorageModel, UiPreferences,
};

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
        sessions: vec![
            SessionDefinition {
                id: "session-local-shell".into(),
                name: "local-shell".into(),
                folder_path: Some("Local".into()),
                kind: "local".into(),
                host: "".into(),
                port: 0,
                username: "".into(),
                auth_type: "none".into(),
                password: None,
                key_path: None,
                x11_forwarding: false,
                x11_trusted: true,
                x11_display: None,
                terminal_font_family: None,
                terminal_font_size: None,
                terminal_foreground: None,
                terminal_background: None,
                linked_ssh_tab_id: None,
                serial_port: None,
                baud_rate: None,
                parity: "none".into(),
                stop_bits: 1,
                data_bits: 8,
                created_at: "2026-04-13T08:58:00.000Z".into(),
                updated_at: "2026-04-13T08:58:00.000Z".into(),
            },
            SessionDefinition {
                id: "session-ssh-edge".into(),
                name: "edge-gateway".into(),
                folder_path: Some("Production/Edge".into()),
                kind: "ssh".into(),
                host: "192.168.56.62".into(),
                port: 22,
                username: "root".into(),
                auth_type: "password".into(),
                password: Some("".into()),
                key_path: None,
                x11_forwarding: false,
                x11_trusted: true,
                x11_display: None,
                terminal_font_family: None,
                terminal_font_size: None,
                terminal_foreground: None,
                terminal_background: None,
                linked_ssh_tab_id: None,
                serial_port: None,
                baud_rate: None,
                parity: "none".into(),
                stop_bits: 1,
                data_bits: 8,
                created_at: "2026-04-13T09:00:00.000Z".into(),
                updated_at: "2026-04-13T09:00:00.000Z".into(),
            },
            SessionDefinition {
                id: "session-ssh-debian".into(),
                name: "debian-lab".into(),
                folder_path: Some("Lab/Linux".into()),
                kind: "ssh".into(),
                host: "10.0.0.21".into(),
                port: 22,
                username: "admin".into(),
                auth_type: "key".into(),
                password: None,
                key_path: Some("~/.ssh/id_ed25519".into()),
                x11_forwarding: false,
                x11_trusted: true,
                x11_display: None,
                terminal_font_family: None,
                terminal_font_size: None,
                terminal_foreground: None,
                terminal_background: None,
                linked_ssh_tab_id: None,
                serial_port: None,
                baud_rate: None,
                parity: "none".into(),
                stop_bits: 1,
                data_bits: 8,
                created_at: "2026-04-13T09:05:00.000Z".into(),
                updated_at: "2026-04-13T09:05:00.000Z".into(),
            },
            SessionDefinition {
                id: "session-telnet-router".into(),
                name: "router-console".into(),
                folder_path: Some("Network".into()),
                kind: "telnet".into(),
                host: "10.10.0.1".into(),
                port: 23,
                username: "admin".into(),
                auth_type: "password".into(),
                password: Some("".into()),
                key_path: None,
                x11_forwarding: false,
                x11_trusted: true,
                x11_display: None,
                terminal_font_family: None,
                terminal_font_size: None,
                terminal_foreground: None,
                terminal_background: None,
                linked_ssh_tab_id: None,
                serial_port: None,
                baud_rate: None,
                parity: "none".into(),
                stop_bits: 1,
                data_bits: 8,
                created_at: "2026-04-13T09:10:00.000Z".into(),
                updated_at: "2026-04-13T09:10:00.000Z".into(),
            },
            SessionDefinition {
                id: "session-serial-usb".into(),
                name: "usb-serial".into(),
                folder_path: Some("Lab/Serial".into()),
                kind: "serial".into(),
                host: "".into(),
                port: 0,
                username: "".into(),
                auth_type: "none".into(),
                password: None,
                key_path: None,
                x11_forwarding: false,
                x11_trusted: true,
                x11_display: None,
                terminal_font_family: None,
                terminal_font_size: None,
                terminal_foreground: None,
                terminal_background: None,
                linked_ssh_tab_id: None,
                serial_port: Some("/dev/tty.usbserial-1420".into()),
                baud_rate: Some(115200),
                parity: "none".into(),
                stop_bits: 1,
                data_bits: 8,
                created_at: "2026-04-13T09:15:00.000Z".into(),
                updated_at: "2026-04-13T09:15:00.000Z".into(),
            },
            SessionDefinition {
                id: "session-sftp-home".into(),
                name: "sftp-home".into(),
                folder_path: Some("Production/Files".into()),
                kind: "sftp".into(),
                host: "192.168.56.62".into(),
                port: 22,
                username: "root".into(),
                auth_type: "password".into(),
                password: Some("".into()),
                key_path: None,
                x11_forwarding: false,
                x11_trusted: true,
                x11_display: None,
                terminal_font_family: None,
                terminal_font_size: None,
                terminal_foreground: None,
                terminal_background: None,
                linked_ssh_tab_id: None,
                serial_port: None,
                baud_rate: None,
                parity: "none".into(),
                stop_bits: 1,
                data_bits: 8,
                created_at: "2026-04-13T09:20:00.000Z".into(),
                updated_at: "2026-04-13T09:20:00.000Z".into(),
            },
            SessionDefinition {
                id: "session-ftp-archive".into(),
                name: "ftp-archive".into(),
                folder_path: Some("Archive".into()),
                kind: "ftp".into(),
                host: "172.16.20.12".into(),
                port: 21,
                username: "deploy".into(),
                auth_type: "password".into(),
                password: Some("".into()),
                key_path: None,
                x11_forwarding: false,
                x11_trusted: true,
                x11_display: None,
                terminal_font_family: None,
                terminal_font_size: None,
                terminal_foreground: None,
                terminal_background: None,
                linked_ssh_tab_id: None,
                serial_port: None,
                baud_rate: None,
                parity: "none".into(),
                stop_bits: 1,
                data_bits: 8,
                created_at: "2026-04-13T09:25:00.000Z".into(),
                updated_at: "2026-04-13T09:25:00.000Z".into(),
            },
        ],
        session_folders: vec![
            SessionFolderDefinition {
                id: "folder-local".into(),
                path: "Local".into(),
                created_at: "2026-04-13T08:55:00.000Z".into(),
                updated_at: "2026-04-13T08:55:00.000Z".into(),
            },
            SessionFolderDefinition {
                id: "folder-production".into(),
                path: "Production".into(),
                created_at: "2026-04-13T08:55:00.000Z".into(),
                updated_at: "2026-04-13T08:55:00.000Z".into(),
            },
            SessionFolderDefinition {
                id: "folder-production-edge".into(),
                path: "Production/Edge".into(),
                created_at: "2026-04-13T08:55:00.000Z".into(),
                updated_at: "2026-04-13T08:55:00.000Z".into(),
            },
            SessionFolderDefinition {
                id: "folder-production-files".into(),
                path: "Production/Files".into(),
                created_at: "2026-04-13T08:55:00.000Z".into(),
                updated_at: "2026-04-13T08:55:00.000Z".into(),
            },
            SessionFolderDefinition {
                id: "folder-lab".into(),
                path: "Lab".into(),
                created_at: "2026-04-13T08:55:00.000Z".into(),
                updated_at: "2026-04-13T08:55:00.000Z".into(),
            },
            SessionFolderDefinition {
                id: "folder-lab-linux".into(),
                path: "Lab/Linux".into(),
                created_at: "2026-04-13T08:55:00.000Z".into(),
                updated_at: "2026-04-13T08:55:00.000Z".into(),
            },
            SessionFolderDefinition {
                id: "folder-lab-serial".into(),
                path: "Lab/Serial".into(),
                created_at: "2026-04-13T08:55:00.000Z".into(),
                updated_at: "2026-04-13T08:55:00.000Z".into(),
            },
            SessionFolderDefinition {
                id: "folder-network".into(),
                path: "Network".into(),
                created_at: "2026-04-13T08:55:00.000Z".into(),
                updated_at: "2026-04-13T08:55:00.000Z".into(),
            },
            SessionFolderDefinition {
                id: "folder-archive".into(),
                path: "Archive".into(),
                created_at: "2026-04-13T08:55:00.000Z".into(),
                updated_at: "2026-04-13T08:55:00.000Z".into(),
            },
        ],
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
        },
    }
}
