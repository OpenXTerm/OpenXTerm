use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::models::TransferProgressPayload;

const TRANSFER_PROGRESS_EVENT: &str = "openxterm://transfer-progress";

pub(super) struct TransferProgressEvent<'a> {
    pub transfer_id: &'a str,
    pub file_name: &'a str,
    pub remote_path: &'a str,
    pub direction: &'a str,
    pub purpose: &'a str,
    pub state: &'a str,
    pub transferred_bytes: u64,
    pub total_bytes: Option<u64>,
    pub message: &'a str,
    pub local_path: Option<String>,
    pub retryable: Option<bool>,
}

pub(super) fn emit_transfer(app: &AppHandle, event: TransferProgressEvent<'_>) {
    if event.state == "queued"
        && event.purpose != "drag-export"
        && !is_batch_child_transfer_id(event.transfer_id)
    {
        reveal_transfer_window(app, event.transfer_id, event.file_name);
    }

    let _ = app.emit(
        TRANSFER_PROGRESS_EVENT,
        TransferProgressPayload {
            transfer_id: event.transfer_id.to_string(),
            file_name: event.file_name.to_string(),
            remote_path: event.remote_path.to_string(),
            direction: event.direction.to_string(),
            purpose: event.purpose.to_string(),
            state: event.state.to_string(),
            transferred_bytes: event.transferred_bytes,
            total_bytes: event.total_bytes,
            message: event.message.to_string(),
            local_path: event.local_path,
            retryable: event.retryable,
        },
    );
}

fn is_batch_child_transfer_id(transfer_id: &str) -> bool {
    transfer_id.contains("::item::")
}

fn reveal_transfer_window(app: &AppHandle, transfer_id: &str, file_name: &str) {
    let label = transfer_window_label(transfer_id);

    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let app = app.clone();
    let transfer_id = transfer_id.to_string();
    let file_name = file_name.to_string();
    tauri::async_runtime::spawn(async move {
        let label = transfer_window_label(&transfer_id);

        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }

        let window = WebviewWindowBuilder::new(
            &app,
            &label,
            WebviewUrl::App(PathBuf::from(format!(
                "index.html?transfer-window=1&transfer-id={transfer_id}"
            ))),
        )
        .title(format!("OpenXTerm Transfer - {file_name}"))
        .inner_size(540.0, 265.0)
        .min_inner_size(420.0, 240.0)
        .resizable(true)
        .center()
        .visible(true)
        .focused(true)
        .always_on_top(true)
        .build();

        match window {
            Ok(window) => {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Err(error) => {
                log::debug!("transfer window reveal skipped: {error}");
            }
        }
    });
}

fn transfer_window_label(transfer_id: &str) -> String {
    let safe_id = transfer_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == ':' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("transfer-{safe_id}")
}
