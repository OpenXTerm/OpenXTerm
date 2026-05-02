use tauri::{AppHandle, Emitter};

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
