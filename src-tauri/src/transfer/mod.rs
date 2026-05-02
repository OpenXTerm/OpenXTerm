use std::{
    fs,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

mod entries;
mod ftp;
mod metadata;
mod paths;
mod progress;
mod sftp;
mod state;

use ftp::{run_ftp_download, run_ftp_upload};
use libssh_rs::{OpenFlags, Sftp};
use metadata::is_directory;
use paths::{
    download_target_path, drag_cache_path, join_remote_path, local_directory_total_size,
    remote_file_name, sanitize_transfer_name, temp_upload_path,
};
use progress::TransferProgressEvent;
use sftp::{
    ensure_sftp_directory_allowed, ensure_sftp_write_allowed, open_sftp, sftp_directory_total_size,
};
use state::{
    clear_transfer_cancel, clear_transfer_retry, remember_transfer_retry,
    stop_if_transfer_cancelled, transfer_retryable, TransferRetryOperation,
};
use tauri::AppHandle;

use crate::models::{FileDownloadResult, SessionDefinition};

pub use entries::{
    create_remote_directory, delete_remote_entry, inspect_download_target, list_remote_directory,
    rename_remote_entry, update_remote_entry_permissions,
};

const TRANSFER_CHUNK_SIZE: usize = 256 * 1024;
const TRANSFER_RETRY_MESSAGE: &str = "Retrying transfer";

pub fn cancel_transfer(transfer_id: &str) -> Result<(), String> {
    state::mark_transfer_cancelled(transfer_id)
}

pub fn retry_transfer(app: &AppHandle, transfer_id: &str) -> Result<(), String> {
    let operation = state::retry_operation(transfer_id)?;

    emit_retry_started(app, transfer_id, &operation);

    match operation {
        TransferRetryOperation::UploadRemoteFile {
            session,
            remote_dir,
            file_name,
            bytes,
            conflict_action,
        } => upload_remote_file(
            app,
            &session,
            &remote_dir,
            &file_name,
            bytes,
            Some(transfer_id.to_string()),
            Some(conflict_action),
        ),
        TransferRetryOperation::UploadLocalFile {
            session,
            remote_dir,
            local_path,
            remote_name,
            conflict_action,
        } => upload_local_file(
            app,
            &session,
            &remote_dir,
            &local_path,
            Some(transfer_id.to_string()),
            remote_name,
            Some(conflict_action),
        ),
        TransferRetryOperation::DownloadRemoteEntry {
            session,
            remote_path,
            kind,
            file_name,
            conflict_action,
        } => download_remote_entry(
            app,
            &session,
            &remote_path,
            &kind,
            Some(transfer_id.to_string()),
            Some(file_name),
            Some(conflict_action),
        )
        .map(|_| ()),
    }
}

fn generate_transfer_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    )
}

fn emit_retry_started(app: &AppHandle, transfer_id: &str, operation: &TransferRetryOperation) {
    match operation {
        TransferRetryOperation::UploadRemoteFile {
            file_name,
            remote_dir,
            ..
        } => emit_transfer(
            app,
            transfer_id,
            file_name,
            &join_remote_path(remote_dir, file_name),
            "upload",
            "upload",
            "queued",
            0,
            None,
            TRANSFER_RETRY_MESSAGE,
            None,
        ),
        TransferRetryOperation::UploadLocalFile {
            remote_dir,
            local_path,
            remote_name,
            ..
        } => {
            let local_path_buf = PathBuf::from(local_path);
            let file_name = remote_name
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(sanitize_transfer_name)
                .or_else(|| {
                    local_path_buf
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_else(|| "upload.bin".to_string());
            emit_transfer(
                app,
                transfer_id,
                &file_name,
                &join_remote_path(remote_dir, &file_name),
                "upload",
                "upload",
                "queued",
                0,
                None,
                TRANSFER_RETRY_MESSAGE,
                Some(local_path.clone()),
            );
        }
        TransferRetryOperation::DownloadRemoteEntry {
            remote_path,
            file_name,
            ..
        } => emit_transfer(
            app,
            transfer_id,
            file_name,
            remote_path,
            "download",
            "download",
            "queued",
            0,
            None,
            TRANSFER_RETRY_MESSAGE,
            None,
        ),
    }
}

fn ensure_local_write_allowed(path: &Path, conflict_action: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if conflict_action == "overwrite" {
        return Ok(());
    }

    Err(format!(
        "{} already exists. Choose overwrite, skip, or rename.",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ))
}

pub fn upload_remote_file(
    app: &AppHandle,
    session: &SessionDefinition,
    remote_dir: &str,
    file_name: &str,
    bytes: Vec<u8>,
    transfer_id: Option<String>,
    conflict_action: Option<String>,
) -> Result<(), String> {
    let file_name = sanitize_transfer_name(file_name);
    let remote_path = join_remote_path(remote_dir, &file_name);
    let total_bytes = bytes.len() as u64;
    let conflict_action = conflict_action.unwrap_or_else(|| "error".into());
    let transfer_id = transfer_id.unwrap_or_else(|| generate_transfer_id("upload"));
    clear_transfer_cancel(&transfer_id);

    emit_transfer(
        app,
        &transfer_id,
        &file_name,
        &remote_path,
        "upload",
        "upload",
        "queued",
        0,
        Some(total_bytes),
        "Queued for upload",
        None,
    );

    let result = match session.kind.as_str() {
        "sftp" => {
            stop_if_transfer_cancelled(&transfer_id)?;
            let sftp = open_sftp(session)?;
            ensure_sftp_write_allowed(&sftp, &remote_path, &conflict_action)?;
            let mut file = sftp
                .open(
                    &remote_path,
                    OpenFlags::CREATE | OpenFlags::WRITE_ONLY | OpenFlags::TRUNCATE,
                    0o644,
                )
                .map_err(|error| format!("failed to create remote file: {error}"))?;
            let mut transferred = 0u64;
            for chunk in bytes.chunks(TRANSFER_CHUNK_SIZE) {
                stop_if_transfer_cancelled(&transfer_id)?;
                file.write_all(chunk)
                    .map_err(|error| format!("failed to upload remote file: {error}"))?;
                transferred += chunk.len() as u64;
                emit_transfer(
                    app,
                    &transfer_id,
                    &file_name,
                    &remote_path,
                    "upload",
                    "upload",
                    "running",
                    transferred,
                    Some(total_bytes),
                    "Uploading to remote host",
                    None,
                );
            }
            Ok(())
        }
        "ftp" => {
            stop_if_transfer_cancelled(&transfer_id)?;
            let temp_path = temp_upload_path(&file_name);
            fs::write(&temp_path, &bytes).map_err(|error| {
                format!("failed to stage upload {}: {error}", temp_path.display())
            })?;
            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                &remote_path,
                "upload",
                "upload",
                "running",
                0,
                Some(total_bytes),
                "Uploading to remote host",
                None,
            );

            let result = run_ftp_upload(session, &remote_path, &temp_path);
            let _ = fs::remove_file(&temp_path);
            stop_if_transfer_cancelled(&transfer_id)?;
            result
        }
        _ => Err(format!("{} does not support upload", session.kind)),
    };

    match result {
        Ok(()) => {
            clear_transfer_retry(&transfer_id);
            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                &remote_path,
                "upload",
                "upload",
                "completed",
                total_bytes,
                Some(total_bytes),
                "Upload complete",
                None,
            );
            clear_transfer_cancel(&transfer_id);
            Ok(())
        }
        Err(error) => {
            remember_transfer_retry(
                &transfer_id,
                TransferRetryOperation::UploadRemoteFile {
                    session: session.clone(),
                    remote_dir: remote_dir.to_string(),
                    file_name: file_name.clone(),
                    bytes,
                    conflict_action: conflict_action.clone(),
                },
            );
            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                &remote_path,
                "upload",
                "upload",
                "error",
                0,
                Some(total_bytes),
                &error,
                None,
            );
            clear_transfer_cancel(&transfer_id);
            Err(error)
        }
    }
}

pub fn upload_local_file(
    app: &AppHandle,
    session: &SessionDefinition,
    remote_dir: &str,
    local_path: &str,
    transfer_id: Option<String>,
    remote_name: Option<String>,
    conflict_action: Option<String>,
) -> Result<(), String> {
    let local_path = PathBuf::from(local_path);
    let local_file_name = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("invalid local file path: {}", local_path.display()))?
        .to_string();
    let file_name = remote_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(sanitize_transfer_name)
        .unwrap_or(local_file_name);
    let metadata = fs::metadata(&local_path)
        .map_err(|error| format!("failed to read {}: {error}", local_path.display()))?;
    let total_bytes = if metadata.is_dir() {
        local_directory_total_size(&local_path)?
    } else {
        metadata.len()
    };
    let remote_path = join_remote_path(remote_dir, &file_name);
    let conflict_action = conflict_action.unwrap_or_else(|| "error".into());
    let transfer_id = transfer_id.unwrap_or_else(|| generate_transfer_id("upload"));
    clear_transfer_cancel(&transfer_id);
    remember_transfer_retry(
        &transfer_id,
        TransferRetryOperation::UploadLocalFile {
            session: session.clone(),
            remote_dir: remote_dir.to_string(),
            local_path: local_path.display().to_string(),
            remote_name: Some(file_name.clone()),
            conflict_action: conflict_action.clone(),
        },
    );

    emit_transfer(
        app,
        &transfer_id,
        &file_name,
        &remote_path,
        "upload",
        "upload",
        "queued",
        0,
        Some(total_bytes),
        "Queued for upload",
        Some(local_path.display().to_string()),
    );

    let result = match session.kind.as_str() {
        "sftp" => {
            stop_if_transfer_cancelled(&transfer_id)?;
            let sftp = open_sftp(session)?;
            let mut transferred = 0u64;
            if metadata.is_dir() {
                upload_sftp_directory_recursive(
                    app,
                    &sftp,
                    &local_path,
                    &remote_path,
                    &transfer_id,
                    &file_name,
                    total_bytes,
                    &mut transferred,
                    &conflict_action,
                )?;
            } else {
                upload_sftp_file_with_progress(
                    app,
                    &sftp,
                    &local_path,
                    &remote_path,
                    &transfer_id,
                    &file_name,
                    total_bytes,
                    &mut transferred,
                    &conflict_action,
                )?;
            }
            Ok(())
        }
        "ftp" => {
            stop_if_transfer_cancelled(&transfer_id)?;
            if metadata.is_dir() {
                return Err("FTP folder upload is not implemented yet".into());
            }

            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                &remote_path,
                "upload",
                "upload",
                "running",
                0,
                Some(total_bytes),
                "Uploading to remote host",
                Some(local_path.display().to_string()),
            );
            let result = run_ftp_upload(session, &remote_path, &local_path);
            stop_if_transfer_cancelled(&transfer_id)?;
            result
        }
        _ => Err(format!("{} does not support upload", session.kind)),
    };

    match result {
        Ok(()) => {
            clear_transfer_retry(&transfer_id);
            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                &remote_path,
                "upload",
                "upload",
                "completed",
                total_bytes,
                Some(total_bytes),
                "Upload complete",
                Some(local_path.display().to_string()),
            );
            clear_transfer_cancel(&transfer_id);
            Ok(())
        }
        Err(error) => {
            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                &remote_path,
                "upload",
                "upload",
                "error",
                0,
                Some(total_bytes),
                &error,
                Some(local_path.display().to_string()),
            );
            clear_transfer_cancel(&transfer_id);
            Err(error)
        }
    }
}

fn upload_sftp_directory_recursive(
    app: &AppHandle,
    sftp: &Sftp,
    local_dir: &Path,
    remote_dir: &str,
    transfer_id: &str,
    display_name: &str,
    total_bytes: u64,
    transferred: &mut u64,
    conflict_action: &str,
) -> Result<(), String> {
    stop_if_transfer_cancelled(transfer_id)?;
    ensure_sftp_directory_allowed(sftp, remote_dir, conflict_action)?;
    let _ = sftp.create_dir(remote_dir, 0o755);

    let entries = fs::read_dir(local_dir)
        .map_err(|error| format!("failed to read {}: {error}", local_dir.display()))?;
    for entry in entries {
        stop_if_transfer_cancelled(transfer_id)?;
        let entry =
            entry.map_err(|error| format!("failed to read {}: {error}", local_dir.display()))?;
        let local_path = entry.path();
        let remote_path = join_remote_path(remote_dir, &entry.file_name().to_string_lossy());
        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to read {}: {error}", local_path.display()))?;

        if metadata.is_dir() {
            upload_sftp_directory_recursive(
                app,
                sftp,
                &local_path,
                &remote_path,
                transfer_id,
                display_name,
                total_bytes,
                transferred,
                conflict_action,
            )?;
        } else {
            upload_sftp_file_with_progress(
                app,
                sftp,
                &local_path,
                &remote_path,
                transfer_id,
                display_name,
                total_bytes,
                transferred,
                conflict_action,
            )?;
        }
    }

    Ok(())
}

fn upload_sftp_file_with_progress(
    app: &AppHandle,
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &str,
    transfer_id: &str,
    display_name: &str,
    total_bytes: u64,
    transferred: &mut u64,
    conflict_action: &str,
) -> Result<(), String> {
    stop_if_transfer_cancelled(transfer_id)?;
    let mut source = File::open(local_path)
        .map_err(|error| format!("failed to open {}: {error}", local_path.display()))?;
    ensure_sftp_write_allowed(sftp, remote_path, conflict_action)?;
    let mut target = sftp
        .open(
            remote_path,
            OpenFlags::CREATE | OpenFlags::WRITE_ONLY | OpenFlags::TRUNCATE,
            0o644,
        )
        .map_err(|error| format!("failed to create remote file {remote_path}: {error}"))?;
    let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];

    loop {
        stop_if_transfer_cancelled(transfer_id)?;
        let read = source
            .read(&mut buffer)
            .map_err(|error| format!("failed to read {}: {error}", local_path.display()))?;
        if read == 0 {
            break;
        }

        target
            .write_all(&buffer[..read])
            .map_err(|error| format!("failed to upload remote file {remote_path}: {error}"))?;
        *transferred += read as u64;
        emit_transfer(
            app,
            transfer_id,
            display_name,
            remote_path,
            "upload",
            "upload",
            "running",
            *transferred,
            Some(total_bytes),
            "Uploading to remote host",
            Some(local_path.display().to_string()),
        );
    }

    Ok(())
}

pub fn download_remote_entry(
    app: &AppHandle,
    session: &SessionDefinition,
    remote_path: &str,
    kind: &str,
    transfer_id: Option<String>,
    file_name_override: Option<String>,
    conflict_action: Option<String>,
) -> Result<FileDownloadResult, String> {
    let file_name = file_name_override
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(sanitize_transfer_name)
        .unwrap_or_else(|| remote_file_name(remote_path));
    let save_path = download_target_path(app, &file_name)?;
    let transfer_id = transfer_id.unwrap_or_else(|| generate_transfer_id("download"));
    let conflict_action = conflict_action.unwrap_or_else(|| "error".into());
    remember_transfer_retry(
        &transfer_id,
        TransferRetryOperation::DownloadRemoteEntry {
            session: session.clone(),
            remote_path: remote_path.to_string(),
            kind: kind.to_string(),
            file_name: file_name.clone(),
            conflict_action: conflict_action.clone(),
        },
    );
    download_remote_entry_to_path(
        app,
        session,
        remote_path,
        &file_name,
        &save_path,
        kind,
        "download",
        Some(transfer_id),
        Some(conflict_action),
    )
}

pub fn download_remote_file(
    app: &AppHandle,
    session: &SessionDefinition,
    remote_path: &str,
    transfer_id: Option<String>,
    file_name_override: Option<String>,
    conflict_action: Option<String>,
) -> Result<FileDownloadResult, String> {
    download_remote_entry(
        app,
        session,
        remote_path,
        "file",
        transfer_id,
        file_name_override,
        conflict_action,
    )
}

pub fn prepare_remote_drag_file(
    app: &AppHandle,
    session: &SessionDefinition,
    remote_path: &str,
    transfer_id: String,
) -> Result<FileDownloadResult, String> {
    let file_name = remote_file_name(remote_path);
    let save_path = drag_cache_path(&file_name);
    if let Some(parent) = save_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    download_remote_file_to_path(
        app,
        session,
        remote_path,
        &file_name,
        &save_path,
        "drag-export",
        Some(transfer_id),
        Some("overwrite".into()),
    )
}

pub fn download_remote_entry_to_path(
    app: &AppHandle,
    session: &SessionDefinition,
    remote_path: &str,
    file_name: &str,
    save_path: &Path,
    kind: &str,
    purpose: &str,
    transfer_id: Option<String>,
    conflict_action: Option<String>,
) -> Result<FileDownloadResult, String> {
    if kind != "folder" {
        return download_remote_file_to_path(
            app,
            session,
            remote_path,
            file_name,
            save_path,
            purpose,
            transfer_id,
            conflict_action,
        );
    }

    let transfer_id = transfer_id.unwrap_or_else(|| generate_transfer_id("download"));
    clear_transfer_cancel(&transfer_id);
    let local_path = save_path.display().to_string();
    let conflict_action = conflict_action.unwrap_or_else(|| "error".into());

    emit_transfer(
        app,
        &transfer_id,
        &file_name,
        remote_path,
        "download",
        purpose,
        "queued",
        0,
        None,
        if purpose == "drag-export" {
            "Preparing local drag folder"
        } else {
            "Queued folder download"
        },
        Some(local_path.clone()),
    );

    let result = match session.kind.as_str() {
        "sftp" => {
            stop_if_transfer_cancelled(&transfer_id)?;
            let sftp = open_sftp(session)?;
            let total_bytes = sftp_directory_total_size(&sftp, remote_path)?;
            stop_if_transfer_cancelled(&transfer_id)?;
            ensure_local_write_allowed(save_path, &conflict_action)?;
            fs::create_dir_all(save_path)
                .map_err(|error| format!("failed to create {}: {error}", save_path.display()))?;

            let mut transferred = 0u64;
            download_sftp_directory_recursive(
                app,
                &sftp,
                remote_path,
                save_path,
                &transfer_id,
                file_name,
                remote_path,
                purpose,
                total_bytes,
                &mut transferred,
            )?;
            Ok(total_bytes)
        }
        "ftp" => Err("FTP folder download is not implemented yet".into()),
        _ => Err(format!("{} does not support download", session.kind)),
    };

    match result {
        Ok(total_bytes) => {
            clear_transfer_retry(&transfer_id);
            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                remote_path,
                "download",
                purpose,
                "completed",
                total_bytes,
                Some(total_bytes),
                if purpose == "drag-export" {
                    "Drag folder ready"
                } else {
                    "Folder download complete"
                },
                Some(local_path.clone()),
            );
            clear_transfer_cancel(&transfer_id);
            Ok(FileDownloadResult {
                file_name: file_name.to_string(),
                saved_to: local_path,
            })
        }
        Err(error) => {
            let _ = fs::remove_dir_all(save_path);
            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                remote_path,
                "download",
                purpose,
                "error",
                0,
                None,
                &error,
                Some(local_path),
            );
            clear_transfer_cancel(&transfer_id);
            Err(error)
        }
    }
}

pub fn download_remote_file_to_path(
    app: &AppHandle,
    session: &SessionDefinition,
    remote_path: &str,
    file_name: &str,
    save_path: &Path,
    purpose: &str,
    transfer_id: Option<String>,
    conflict_action: Option<String>,
) -> Result<FileDownloadResult, String> {
    let transfer_id = transfer_id.unwrap_or_else(|| generate_transfer_id("download"));
    clear_transfer_cancel(&transfer_id);
    let local_path = save_path.display().to_string();
    let conflict_action = conflict_action.unwrap_or_else(|| "error".into());

    emit_transfer(
        app,
        &transfer_id,
        &file_name,
        remote_path,
        "download",
        purpose,
        "queued",
        0,
        None,
        if purpose == "drag-export" {
            "Preparing local drag copy"
        } else {
            "Queued for download"
        },
        Some(local_path.clone()),
    );

    let result = match session.kind.as_str() {
        "sftp" => {
            stop_if_transfer_cancelled(&transfer_id)?;
            let sftp = open_sftp(session)?;
            let total_bytes = sftp
                .metadata(remote_path)
                .ok()
                .and_then(|metadata| metadata.len());
            ensure_local_write_allowed(save_path, &conflict_action)?;
            let mut remote_file = sftp
                .open(remote_path, OpenFlags::READ_ONLY, 0)
                .map_err(|error| format!("failed to open remote file: {error}"))?;
            let mut local_file = File::create(save_path)
                .map_err(|error| format!("failed to write {}: {error}", save_path.display()))?;
            let mut transferred = 0u64;
            let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];

            loop {
                stop_if_transfer_cancelled(&transfer_id)?;
                let read = remote_file
                    .read(&mut buffer)
                    .map_err(|error| format!("failed to read remote file: {error}"))?;
                if read == 0 {
                    break;
                }

                local_file
                    .write_all(&buffer[..read])
                    .map_err(|error| format!("failed to write {}: {error}", save_path.display()))?;
                transferred += read as u64;
                emit_transfer(
                    app,
                    &transfer_id,
                    &file_name,
                    remote_path,
                    "download",
                    purpose,
                    "running",
                    transferred,
                    total_bytes,
                    if purpose == "drag-export" {
                        "Preparing local drag copy"
                    } else {
                        "Downloading from remote host"
                    },
                    Some(local_path.clone()),
                );
            }
            Ok(total_bytes.unwrap_or(transferred))
        }
        "ftp" => {
            stop_if_transfer_cancelled(&transfer_id)?;
            ensure_local_write_allowed(save_path, &conflict_action)?;
            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                remote_path,
                "download",
                purpose,
                "running",
                0,
                None,
                if purpose == "drag-export" {
                    "Preparing local drag copy"
                } else {
                    "Downloading from remote host"
                },
                Some(local_path.clone()),
            );
            run_ftp_download(session, remote_path, save_path)?;
            stop_if_transfer_cancelled(&transfer_id)?;
            let bytes = fs::metadata(save_path)
                .ok()
                .map(|meta| meta.len())
                .unwrap_or(0);
            Ok(bytes)
        }
        _ => Err(format!("{} does not support download", session.kind)),
    };

    match result {
        Ok(total_bytes) => {
            clear_transfer_retry(&transfer_id);
            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                remote_path,
                "download",
                purpose,
                "completed",
                total_bytes,
                Some(total_bytes),
                if purpose == "drag-export" {
                    "Drag copy ready"
                } else {
                    "Download complete"
                },
                Some(local_path.clone()),
            );
            clear_transfer_cancel(&transfer_id);
            Ok(FileDownloadResult {
                file_name: file_name.to_string(),
                saved_to: local_path,
            })
        }
        Err(error) => {
            let _ = fs::remove_file(save_path);
            emit_transfer(
                app,
                &transfer_id,
                &file_name,
                remote_path,
                "download",
                purpose,
                "error",
                0,
                None,
                &error,
                Some(local_path),
            );
            clear_transfer_cancel(&transfer_id);
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn download_sftp_directory_recursive(
    app: &AppHandle,
    sftp: &Sftp,
    remote_dir: &str,
    local_dir: &Path,
    transfer_id: &str,
    display_name: &str,
    root_remote_path: &str,
    purpose: &str,
    total_bytes: u64,
    transferred: &mut u64,
) -> Result<(), String> {
    stop_if_transfer_cancelled(transfer_id)?;
    let entries = sftp
        .read_dir(remote_dir)
        .map_err(|error| format!("failed to list remote directory {remote_dir}: {error}"))?;

    for entry in entries {
        stop_if_transfer_cancelled(transfer_id)?;
        let Some(name) = entry.name() else {
            continue;
        };

        if name == "." || name == ".." {
            continue;
        }

        let remote_path = join_remote_path(remote_dir, name);
        let local_path = local_dir.join(name);

        if is_directory(entry.file_type()) {
            fs::create_dir_all(&local_path)
                .map_err(|error| format!("failed to create {}: {error}", local_path.display()))?;
            download_sftp_directory_recursive(
                app,
                sftp,
                &remote_path,
                &local_path,
                transfer_id,
                display_name,
                root_remote_path,
                purpose,
                total_bytes,
                transferred,
            )?;
            continue;
        }

        if let Some(parent) = local_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }

        let mut remote_file = sftp
            .open(&remote_path, OpenFlags::READ_ONLY, 0)
            .map_err(|error| format!("failed to open remote file {remote_path}: {error}"))?;
        let mut local_file = File::create(&local_path)
            .map_err(|error| format!("failed to write {}: {error}", local_path.display()))?;
        let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];

        loop {
            stop_if_transfer_cancelled(transfer_id)?;
            let read = remote_file
                .read(&mut buffer)
                .map_err(|error| format!("failed to read remote file {remote_path}: {error}"))?;
            if read == 0 {
                break;
            }

            local_file
                .write_all(&buffer[..read])
                .map_err(|error| format!("failed to write {}: {error}", local_path.display()))?;
            *transferred += read as u64;
            emit_transfer(
                app,
                transfer_id,
                display_name,
                root_remote_path,
                "download",
                purpose,
                "running",
                *transferred,
                Some(total_bytes),
                if purpose == "drag-export" {
                    "Preparing local drag folder"
                } else {
                    "Downloading folder from remote host"
                },
                Some(local_path.display().to_string()),
            );
        }
    }

    Ok(())
}

fn emit_transfer(
    app: &AppHandle,
    transfer_id: &str,
    file_name: &str,
    remote_path: &str,
    direction: &str,
    purpose: &str,
    state: &str,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
    message: &str,
    local_path: Option<String>,
) {
    progress::emit_transfer(
        app,
        TransferProgressEvent {
            transfer_id,
            file_name,
            remote_path,
            direction,
            purpose,
            state,
            transferred_bytes,
            total_bytes,
            message,
            local_path,
            retryable: (state == "error").then(|| transfer_retryable(transfer_id)),
        },
    );
}
