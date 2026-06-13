use tauri::AppHandle;

use super::{
    progress::{self, TransferProgressEvent},
    state::{
        clear_transfer_cancel, clear_transfer_retry, stop_if_transfer_cancelled, transfer_retryable,
    },
};

pub(super) struct TransferLifecycle<'a> {
    app: &'a AppHandle,
    transfer_id: String,
    file_name: String,
    remote_path: String,
    direction: String,
    purpose: String,
    local_path: Option<String>,
}

pub(super) struct TransferInit<'a> {
    pub app: &'a AppHandle,
    pub transfer_id: Option<String>,
    pub id_prefix: &'a str,
    pub file_name: &'a str,
    pub remote_path: &'a str,
    pub direction: &'a str,
    pub purpose: &'a str,
    pub local_path: Option<&'a str>,
    pub total_bytes: Option<u64>,
    pub queued_message: &'a str,
}

pub(super) fn init_transfer<'a>(args: TransferInit<'a>) -> (String, TransferLifecycle<'a>) {
    let transfer_id = args
        .transfer_id
        .unwrap_or_else(|| super::generate_transfer_id(args.id_prefix));
    let lifecycle = TransferLifecycle::new(
        args.app,
        &transfer_id,
        args.file_name,
        args.remote_path,
        args.direction,
        args.purpose,
        args.local_path,
    );
    lifecycle.reset_cancel();
    lifecycle.queued(args.total_bytes, args.queued_message);
    (transfer_id, lifecycle)
}

impl<'a> TransferLifecycle<'a> {
    pub(super) fn new(
        app: &'a AppHandle,
        transfer_id: &str,
        file_name: &str,
        remote_path: &str,
        direction: &str,
        purpose: &str,
        local_path: Option<&str>,
    ) -> Self {
        Self {
            app,
            transfer_id: transfer_id.into(),
            file_name: file_name.into(),
            remote_path: remote_path.into(),
            direction: direction.into(),
            purpose: purpose.into(),
            local_path: local_path.map(str::to_string),
        }
    }

    pub(super) fn reset_cancel(&self) {
        clear_transfer_cancel(&self.transfer_id);
    }

    pub(super) fn check_cancel(&self) -> Result<(), String> {
        stop_if_transfer_cancelled(&self.transfer_id)
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
        clear_transfer_retry(&self.transfer_id);
        self.emit("completed", transferred_bytes, total_bytes, message);
        clear_transfer_cancel(&self.transfer_id);
    }

    pub(super) fn failed(&self, transferred_bytes: u64, total_bytes: Option<u64>, message: &str) {
        self.emit("error", transferred_bytes, total_bytes, message);
        clear_transfer_cancel(&self.transfer_id);
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
                transfer_id: &self.transfer_id,
                file_name: &self.file_name,
                remote_path: &self.remote_path,
                direction: &self.direction,
                purpose: &self.purpose,
                state,
                transferred_bytes,
                total_bytes,
                message,
                local_path: self.local_path.as_deref(),
                retryable: (state == "error").then(|| transfer_retryable(&self.transfer_id)),
            },
        );
    }
}
