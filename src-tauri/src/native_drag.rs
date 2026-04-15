use std::{
    ffi::{c_char, c_void, CStr},
    path::PathBuf,
    sync::OnceLock,
};

use tauri::{AppHandle, Window};

use crate::{
    file_ops,
    models::{RemoteDragEntry, SessionDefinition},
};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

#[cfg(target_os = "macos")]
extern "C" {
    fn openxterm_start_file_promise_drag_v2(
        ns_window: *mut c_void,
        session_json: *const u8,
        session_json_len: usize,
        entries_json: *const u8,
        entries_json_len: usize,
        client_x: f64,
        client_y: f64,
    ) -> bool;
}

pub fn start_native_file_drag(
    app: &AppHandle,
    window: &Window,
    session: &SessionDefinition,
    remote_path: &str,
    file_name: &str,
    client_x: f64,
    client_y: f64,
) -> Result<bool, String> {
    let _ = APP_HANDLE.set(app.clone());

    start_native_entries_drag(
        app,
        window,
        session,
        &[RemoteDragEntry {
            remote_path: remote_path.to_string(),
            file_name: file_name.to_string(),
            kind: "file".into(),
            transfer_id: None,
        }],
        client_x,
        client_y,
    )
}

pub fn start_native_entries_drag(
    app: &AppHandle,
    window: &Window,
    session: &SessionDefinition,
    entries: &[RemoteDragEntry],
    client_x: f64,
    client_y: f64,
) -> Result<bool, String> {
    let _ = APP_HANDLE.set(app.clone());

    start_native_file_drag_impl(window, session, entries, client_x, client_y)
}

#[cfg(target_os = "macos")]
fn start_native_file_drag_impl(
    window: &Window,
    session: &SessionDefinition,
    entries: &[RemoteDragEntry],
    client_x: f64,
    client_y: f64,
) -> Result<bool, String> {
    if entries.is_empty() {
        return Ok(false);
    }

    let ns_window = window
        .ns_window()
        .map_err(|error| format!("failed to get NSWindow: {error}"))?;
    let session_json = serde_json::to_string(session)
        .map_err(|error| format!("failed to encode session for native drag: {error}"))?;
    let entries = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| NativePromiseEntry {
            remote_path: entry.remote_path.clone(),
            file_name: entry.file_name.clone(),
            kind: entry.kind.clone(),
            transfer_id: entry
                .transfer_id
                .clone()
                .unwrap_or_else(|| format!("native-drag-{}-{index}", uuid_like_stamp())),
        })
        .collect::<Vec<_>>();
    let entries_json = serde_json::to_string(&entries)
        .map_err(|error| format!("failed to encode drag entries: {error}"))?;

    let started = unsafe {
        openxterm_start_file_promise_drag_v2(
            ns_window,
            session_json.as_bytes().as_ptr(),
            session_json.len(),
            entries_json.as_bytes().as_ptr(),
            entries_json.len(),
            client_x,
            client_y,
        )
    };

    Ok(started)
}

#[cfg(not(target_os = "macos"))]
fn start_native_file_drag_impl(
    _window: &Window,
    _session: &SessionDefinition,
    _entries: &[RemoteDragEntry],
    _client_x: f64,
    _client_y: f64,
) -> Result<bool, String> {
    Ok(false)
}

#[no_mangle]
pub extern "C" fn openxterm_native_drag_write_file(
    session_json: *const c_char,
    remote_path: *const c_char,
    destination_path: *const c_char,
    transfer_id: *const c_char,
    file_kind: *const c_char,
) -> i32 {
    match write_promised_file(
        session_json,
        remote_path,
        destination_path,
        transfer_id,
        file_kind,
    ) {
        Ok(()) => 0,
        Err(error) => {
            log::error!("native drag promised-file write failed: {error}");
            1
        }
    }
}

fn write_promised_file(
    session_json: *const c_char,
    remote_path: *const c_char,
    destination_path: *const c_char,
    transfer_id: *const c_char,
    file_kind: *const c_char,
) -> Result<(), String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "OpenXTerm app handle is not initialized for native drag".to_string())?;
    let session_json = c_string(session_json, "session json")?;
    let remote_path = c_string(remote_path, "remote path")?;
    let destination_path = c_string(destination_path, "destination path")?;
    let transfer_id = c_string(transfer_id, "transfer id")?;
    let file_kind = c_string(file_kind, "file kind")?;
    let session = serde_json::from_str::<SessionDefinition>(&session_json)
        .map_err(|error| format!("failed to decode native drag session: {error}"))?;

    file_ops::download_remote_entry_to_path(
        app,
        &session,
        &remote_path,
        &remote_file_name(&remote_path),
        &PathBuf::from(destination_path),
        &file_kind,
        "drag-export",
        Some(transfer_id),
    )
    .map(|_| ())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePromiseEntry {
    remote_path: String,
    file_name: String,
    kind: String,
    transfer_id: String,
}

fn c_string(value: *const c_char, label: &str) -> Result<String, String> {
    if value.is_null() {
        return Err(format!("{label} pointer was null"));
    }

    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(|value| value.to_string())
        .map_err(|error| format!("{label} was not valid UTF-8: {error}"))
}

fn remote_file_name(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or("download.bin")
        .to_string()
}

fn uuid_like_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| "0".into())
}
