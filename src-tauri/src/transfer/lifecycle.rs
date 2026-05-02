use tauri::AppHandle;

use super::{
    progress::{self, TransferProgressEvent},
    state::{
        clear_transfer_cancel, clear_transfer_retry, stop_if_transfer_cancelled, transfer_retryable,
    },
};

pub(super) struct TransferLifecycle<'a> {
    app: &'a AppHandle,
    transfer_id: &'a str,
    file_name: &'a str,
    remote_path: &'a str,
    direction: &'a str,
    purpose: &'a str,
    local_path: Option<&'a str>,
}

impl<'a> TransferLifecycle<'a> {
    pub(super) fn new(
        app: &'a AppHandle,
        transfer_id: &'a str,
        file_name: &'a str,
        remote_path: &'a str,
        direction: &'a str,
        purpose: &'a str,
        local_path: Option<&'a str>,
    ) -> Self {
        Self {
            app,
            transfer_id,
            file_name,
            remote_path,
            direction,
            purpose,
            local_path,
        }
    }

    pub(super) fn reset_cancel(&self) {
        clear_transfer_cancel(self.transfer_id);
    }

    pub(super) fn check_cancel(&self) -> Result<(), String> {
        stop_if_transfer_cancelled(self.transfer_id)
    }

    pub(super) fn queued(&self, total_bytes: Option<u64>, message: &str) {
        self.emit("queued", 0, total_bytes, message);
    }

    pub(super) fn running(&self, transferred_bytes: u64, total_bytes: Option<u64>, message: &str) {
        self.emit("running", transferred_bytes, total_bytes, message);
    }

    pub(super) fn completed(
        &self,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
        message: &str,
    ) {
        clear_transfer_retry(self.transfer_id);
        self.emit("completed", transferred_bytes, total_bytes, message);
        clear_transfer_cancel(self.transfer_id);
    }

    pub(super) fn failed(&self, transferred_bytes: u64, total_bytes: Option<u64>, message: &str) {
        self.emit("error", transferred_bytes, total_bytes, message);
        clear_transfer_cancel(self.transfer_id);
    }

    fn emit<'event>(
        &'event self,
        state: &'event str,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
        message: &'event str,
    ) {
        progress::emit_transfer(
            self.app,
            TransferProgressEvent {
                transfer_id: self.transfer_id,
                file_name: self.file_name,
                remote_path: self.remote_path,
                direction: self.direction,
                purpose: self.purpose,
                state,
                transferred_bytes,
                total_bytes,
                message,
                local_path: self.local_path,
                retryable: (state == "error").then(|| transfer_retryable(self.transfer_id)),
            },
        );
    }
}
