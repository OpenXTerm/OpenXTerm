use tauri::{AppHandle, State};

use crate::{
    drag,
    models::{
        LibsshProbePayload, LocalX11SupportPayload, MacroDefinition, RemoteDragEntry,
        SessionDefinition, SessionFolderDefinition, StorageModel, UiPreferences,
    },
    platform::{
        auth::{
            get_system_auth_support as get_platform_auth_support,
            request_system_unlock as request_platform_unlock, SystemAuthSupport,
        },
        x11 as x11_support,
    },
    runtime::AppRuntime,
    storage::{load_storage, save_storage},
    transfer,
};

#[tauri::command]
pub fn bootstrap_state(app: AppHandle) -> Result<StorageModel, String> {
    load_storage(&app)
}

#[tauri::command]
pub fn save_session(
    app: AppHandle,
    session: SessionDefinition,
) -> Result<SessionDefinition, String> {
    let mut storage = load_storage(&app)?;
    if let Some(existing) = storage
        .sessions
        .iter_mut()
        .find(|item| item.id == session.id)
    {
        *existing = session.clone();
    } else {
        storage.sessions.push(session.clone());
    }
    save_storage(&app, &storage)?;
    Ok(session)
}

#[tauri::command]
pub fn save_session_folder(
    app: AppHandle,
    folder: SessionFolderDefinition,
) -> Result<SessionFolderDefinition, String> {
    let mut storage = load_storage(&app)?;
    if let Some(existing) = storage
        .session_folders
        .iter_mut()
        .find(|item| item.id == folder.id)
    {
        *existing = folder.clone();
    } else {
        storage.session_folders.push(folder.clone());
    }
    save_storage(&app, &storage)?;
    Ok(folder)
}

#[tauri::command]
pub fn delete_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let mut storage = load_storage(&app)?;
    storage.sessions.retain(|session| session.id != session_id);
    save_storage(&app, &storage)
}

#[tauri::command]
pub fn delete_session_folder(app: AppHandle, folder_id: String) -> Result<(), String> {
    let mut storage = load_storage(&app)?;
    storage
        .session_folders
        .retain(|folder| folder.id != folder_id);
    save_storage(&app, &storage)
}

#[tauri::command]
pub fn save_macro(app: AppHandle, item: MacroDefinition) -> Result<MacroDefinition, String> {
    let mut storage = load_storage(&app)?;
    if let Some(existing) = storage
        .macros
        .iter_mut()
        .find(|macro_item| macro_item.id == item.id)
    {
        *existing = item.clone();
    } else {
        storage.macros.push(item.clone());
    }
    save_storage(&app, &storage)?;
    Ok(item)
}

#[tauri::command]
pub fn delete_macro(app: AppHandle, macro_id: String) -> Result<(), String> {
    let mut storage = load_storage(&app)?;
    storage.macros.retain(|item| item.id != macro_id);
    save_storage(&app, &storage)
}

#[tauri::command]
pub fn save_preferences(
    app: AppHandle,
    preferences: UiPreferences,
) -> Result<UiPreferences, String> {
    let mut storage = load_storage(&app)?;
    storage.preferences = preferences.clone();
    save_storage(&app, &storage)?;
    Ok(preferences)
}

#[tauri::command]
pub fn get_system_auth_support() -> Result<SystemAuthSupport, String> {
    get_platform_auth_support()
}

#[tauri::command]
pub fn request_system_unlock(reason: Option<String>) -> Result<bool, String> {
    request_platform_unlock(reason)
}

#[tauri::command]
pub fn inspect_local_x11_support(
    display_override: Option<String>,
) -> Result<LocalX11SupportPayload, String> {
    Ok(x11_support::inspect_local_x11_support(
        display_override.as_deref(),
    ))
}

#[tauri::command]
pub fn open_external_target(target: String) -> Result<(), String> {
    x11_support::open_external_target(&target)
}

#[tauri::command]
pub fn list_system_font_families() -> Result<Vec<String>, String> {
    crate::platform::fonts::list_system_font_families()
}

#[tauri::command]
pub async fn run_libssh_probe(
    session: SessionDefinition,
    remote_command: Option<String>,
    remote_path: Option<String>,
) -> Result<LibsshProbePayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::probe::run_probe(&session, remote_command.as_deref(), remote_path.as_deref())
    })
    .await
    .map_err(|error| format!("failed to join libssh probe task: {error}"))?
}

#[tauri::command]
pub fn start_ssh_session(
    app: AppHandle,
    runtime: State<'_, AppRuntime>,
    tab_id: String,
    session: SessionDefinition,
) -> Result<bool, String> {
    runtime.start_ssh_session(&app, tab_id, session)
}

#[tauri::command]
pub fn start_local_session(
    app: AppHandle,
    runtime: State<'_, AppRuntime>,
    tab_id: String,
    session: SessionDefinition,
) -> Result<bool, String> {
    runtime.start_local_session(&app, tab_id, session)
}

#[tauri::command]
pub fn start_telnet_session(
    app: AppHandle,
    runtime: State<'_, AppRuntime>,
    tab_id: String,
    session: SessionDefinition,
) -> Result<bool, String> {
    runtime.start_telnet_session(&app, tab_id, session)
}

#[tauri::command]
pub fn start_serial_session(
    app: AppHandle,
    runtime: State<'_, AppRuntime>,
    tab_id: String,
    session: SessionDefinition,
) -> Result<bool, String> {
    runtime.start_serial_session(&app, tab_id, session)
}

#[tauri::command]
pub fn send_terminal_input(
    runtime: State<'_, AppRuntime>,
    tab_id: String,
    data: String,
) -> Result<(), String> {
    runtime.send_input(&tab_id, &data)
}

#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("failed to open clipboard: {error}"))?;
    clipboard
        .get_text()
        .map_err(|error| format!("failed to read clipboard text: {error}"))
}

#[tauri::command]
pub fn stop_terminal_session(runtime: State<'_, AppRuntime>, tab_id: String) -> Result<(), String> {
    runtime.stop_terminal(&tab_id)
}

#[tauri::command]
pub fn resize_terminal_session(
    runtime: State<'_, AppRuntime>,
    tab_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    runtime.resize_terminal(&tab_id, cols, rows)
}

#[tauri::command]
pub async fn list_remote_directory(
    session: SessionDefinition,
    path: Option<String>,
) -> Result<crate::models::RemoteDirectorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || transfer::list_remote_directory(&session, path))
        .await
        .map_err(|error| format!("failed to join remote list task: {error}"))?
}

#[tauri::command]
pub async fn create_remote_directory(
    session: SessionDefinition,
    parent_path: String,
    name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer::create_remote_directory(&session, &parent_path, &name)
    })
    .await
    .map_err(|error| format!("failed to join remote mkdir task: {error}"))?
}

#[tauri::command]
pub async fn delete_remote_entry(
    session: SessionDefinition,
    path: String,
    kind: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer::delete_remote_entry(&session, &path, &kind)
    })
    .await
    .map_err(|error| format!("failed to join remote delete task: {error}"))?
}

#[tauri::command]
pub async fn rename_remote_entry(
    session: SessionDefinition,
    path: String,
    new_name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer::rename_remote_entry(&session, &path, &new_name)
    })
    .await
    .map_err(|error| format!("failed to join remote rename task: {error}"))?
}

#[tauri::command]
pub async fn update_remote_entry_permissions(
    session: SessionDefinition,
    path: String,
    permissions: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer::update_remote_entry_permissions(&session, &path, permissions)
    })
    .await
    .map_err(|error| format!("failed to join remote chmod task: {error}"))?
}

#[tauri::command]
pub async fn inspect_download_target(
    app: AppHandle,
    file_name: String,
) -> Result<crate::models::DownloadTargetInspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer::inspect_download_target(&app, &file_name)
    })
    .await
    .map_err(|error| format!("failed to join download target inspection task: {error}"))?
}

#[tauri::command]
pub fn cancel_transfer(transfer_id: String) -> Result<(), String> {
    transfer::cancel_transfer(&transfer_id)
}

#[tauri::command]
pub async fn retry_transfer(app: AppHandle, transfer_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || transfer::retry_transfer(&app, &transfer_id))
        .await
        .map_err(|error| format!("failed to join transfer retry task: {error}"))?
}

#[tauri::command]
pub async fn upload_remote_file(
    app: AppHandle,
    session: SessionDefinition,
    remote_dir: String,
    file_name: String,
    bytes: Vec<u8>,
    transfer_id: Option<String>,
    conflict_action: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer::upload_remote_file(
            &app,
            &session,
            &remote_dir,
            &file_name,
            bytes,
            transfer_id,
            conflict_action,
        )
    })
    .await
    .map_err(|error| format!("failed to join upload task: {error}"))?
}

#[tauri::command]
pub async fn upload_local_file(
    app: AppHandle,
    session: SessionDefinition,
    remote_dir: String,
    local_path: String,
    transfer_id: Option<String>,
    remote_name: Option<String>,
    conflict_action: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer::upload_local_file(
            &app,
            &session,
            &remote_dir,
            &local_path,
            transfer_id,
            remote_name,
            conflict_action,
        )
    })
    .await
    .map_err(|error| format!("failed to join local upload task: {error}"))?
}

#[tauri::command]
pub async fn download_remote_file(
    app: AppHandle,
    session: SessionDefinition,
    remote_path: String,
    transfer_id: Option<String>,
    file_name: Option<String>,
    conflict_action: Option<String>,
) -> Result<crate::models::FileDownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer::download_remote_file(
            &app,
            &session,
            &remote_path,
            transfer_id,
            file_name,
            conflict_action,
        )
    })
    .await
    .map_err(|error| format!("failed to join download task: {error}"))?
}

#[tauri::command]
pub async fn download_remote_entry(
    app: AppHandle,
    session: SessionDefinition,
    remote_path: String,
    kind: String,
    transfer_id: Option<String>,
    file_name: Option<String>,
    conflict_action: Option<String>,
) -> Result<crate::models::FileDownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer::download_remote_entry(
            &app,
            &session,
            &remote_path,
            &kind,
            transfer_id,
            file_name,
            conflict_action,
        )
    })
    .await
    .map_err(|error| format!("failed to join download task: {error}"))?
}

#[tauri::command]
pub async fn prepare_remote_drag_file(
    app: AppHandle,
    session: SessionDefinition,
    remote_path: String,
    transfer_id: String,
) -> Result<crate::models::FileDownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer::prepare_remote_drag_file(&app, &session, &remote_path, transfer_id)
    })
    .await
    .map_err(|error| format!("failed to join drag-export task: {error}"))?
}

#[tauri::command]
pub fn start_native_file_drag(
    app: AppHandle,
    window: tauri::Window,
    session: SessionDefinition,
    remote_path: String,
    file_name: String,
    size_bytes: Option<u64>,
    client_x: f64,
    client_y: f64,
) -> Result<bool, String> {
    drag::start_native_file_drag(
        &app,
        &window,
        &session,
        &remote_path,
        &file_name,
        size_bytes,
        client_x,
        client_y,
    )
}

#[tauri::command]
pub fn start_native_entries_drag(
    app: AppHandle,
    window: tauri::Window,
    session: SessionDefinition,
    entries: Vec<RemoteDragEntry>,
    client_x: f64,
    client_y: f64,
) -> Result<bool, String> {
    drag::start_native_entries_drag(&app, &window, &session, &entries, client_x, client_y)
}
