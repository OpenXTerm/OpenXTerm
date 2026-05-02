use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
};

use crate::models::SessionDefinition;

static CANCELLED_TRANSFERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static TRANSFER_RETRY_OPERATIONS: OnceLock<Mutex<HashMap<String, TransferRetryOperation>>> =
    OnceLock::new();

#[derive(Clone)]
pub(super) enum TransferRetryOperation {
    UploadRemoteFile {
        session: SessionDefinition,
        remote_dir: String,
        file_name: String,
        bytes: Vec<u8>,
        conflict_action: String,
    },
    UploadLocalFile {
        session: SessionDefinition,
        remote_dir: String,
        local_path: String,
        remote_name: Option<String>,
        conflict_action: String,
    },
    DownloadRemoteEntry {
        session: SessionDefinition,
        remote_path: String,
        kind: String,
        file_name: String,
        conflict_action: String,
    },
}

pub(super) fn mark_transfer_cancelled(transfer_id: &str) -> Result<(), String> {
    let mut cancelled = cancelled_transfers()
        .lock()
        .map_err(|_| "transfer cancellation state is poisoned".to_string())?;
    cancelled.insert(transfer_id.to_string());
    Ok(())
}

pub(super) fn retry_operation(transfer_id: &str) -> Result<TransferRetryOperation, String> {
    let retry_operations = transfer_retry_operations()
        .lock()
        .map_err(|_| "transfer retry state is poisoned".to_string())?;
    retry_operations
        .get(transfer_id)
        .cloned()
        .ok_or_else(|| "No retry data is available for this transfer.".to_string())
}

pub(super) fn clear_transfer_cancel(transfer_id: &str) {
    if let Ok(mut cancelled) = cancelled_transfers().lock() {
        cancelled.remove(transfer_id);
    }
}

pub(super) fn remember_transfer_retry(transfer_id: &str, operation: TransferRetryOperation) {
    if let Ok(mut retry_operations) = transfer_retry_operations().lock() {
        retry_operations.insert(transfer_id.to_string(), operation);
    }
}

pub(super) fn clear_transfer_retry(transfer_id: &str) {
    if let Ok(mut retry_operations) = transfer_retry_operations().lock() {
        retry_operations.remove(transfer_id);
    }
}

pub(super) fn transfer_retryable(transfer_id: &str) -> bool {
    transfer_retry_operations()
        .lock()
        .is_ok_and(|retry_operations| retry_operations.contains_key(transfer_id))
}

pub(super) fn stop_if_transfer_cancelled(transfer_id: &str) -> Result<(), String> {
    if is_transfer_cancelled(transfer_id) {
        Err("Transfer canceled".into())
    } else {
        Ok(())
    }
}

fn cancelled_transfers() -> &'static Mutex<HashSet<String>> {
    CANCELLED_TRANSFERS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn transfer_retry_operations() -> &'static Mutex<HashMap<String, TransferRetryOperation>> {
    TRANSFER_RETRY_OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_transfer_cancelled(transfer_id: &str) -> bool {
    let Ok(cancelled) = cancelled_transfers().lock() else {
        return false;
    };

    if cancelled.contains(transfer_id) {
        return true;
    }

    transfer_id
        .split_once("::item::")
        .is_some_and(|(parent_id, _)| cancelled.contains(parent_id))
}
