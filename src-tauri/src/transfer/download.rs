use std::{
    fs,
    fs::File,
    io::{Read, Write},
    path::Path,
};

use libssh_rs::{OpenFlags, Sftp};
use tauri::AppHandle;

use crate::models::{FileDownloadResult, SessionDefinition};

use super::{
    emit_transfer,
    errors::{describe_local_io_error, describe_remote_error},
    ftp::run_ftp_download,
    generate_transfer_id,
    lifecycle::{init_transfer, TransferInit},
    metadata::is_directory,
    paths::{
        download_target_path, drag_cache_path, join_remote_path, remote_file_name,
        sanitize_transfer_name,
    },
    sftp::{open_sftp, sftp_directory_total_size},
    state::{remember_transfer_retry, stop_if_transfer_cancelled, TransferRetryOperation},
    TRANSFER_CHUNK_SIZE,
};

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
            .map_err(|error| describe_local_io_error("create local directory", parent, &error))?;
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

    let local_path = save_path.display().to_string();
    let conflict_action = conflict_action.unwrap_or_else(|| "error".into());
    let queued_message = if purpose == "drag-export" {
        "Preparing local drag folder"
    } else {
        "Queued folder download"
    };
    let (transfer_id, lifecycle) = init_transfer(TransferInit {
        app,
        transfer_id,
        id_prefix: "download",
        file_name,
        remote_path,
        direction: "download",
        purpose,
        local_path: Some(local_path.as_str()),
        total_bytes: None,
        queued_message,
    });

    let target_existed_before = save_path.exists();
    let result = match session.kind.as_str() {
        "sftp" => {
            lifecycle.check_cancel()?;
            let sftp = open_sftp(session)?;
            let total_bytes = sftp_directory_total_size(&sftp, remote_path)?;
            lifecycle.check_cancel()?;
            ensure_local_write_allowed(save_path, &conflict_action)?;
            fs::create_dir_all(save_path).map_err(|error| {
                describe_local_io_error("create local directory", save_path, &error)
            })?;

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
            lifecycle.completed(
                total_bytes,
                Some(total_bytes),
                if purpose == "drag-export" {
                    "Drag folder ready"
                } else {
                    "Folder download complete"
                },
            );
            Ok(FileDownloadResult {
                file_name: file_name.to_string(),
                saved_to: local_path,
            })
        }
        Err(error) => {
            if !target_existed_before {
                let _ = fs::remove_dir_all(save_path);
            }
            lifecycle.failed(0, None, &error);
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
    let local_path = save_path.display().to_string();
    let conflict_action = conflict_action.unwrap_or_else(|| "error".into());
    let queued_message = if purpose == "drag-export" {
        "Preparing local drag copy"
    } else {
        "Queued for download"
    };
    let (_, lifecycle) = init_transfer(TransferInit {
        app,
        transfer_id,
        id_prefix: "download",
        file_name,
        remote_path,
        direction: "download",
        purpose,
        local_path: Some(local_path.as_str()),
        total_bytes: None,
        queued_message,
    });

    let target_existed_before = save_path.exists();
    let result = match session.kind.as_str() {
        "sftp" => {
            lifecycle.check_cancel()?;
            let sftp = open_sftp(session)?;
            let total_bytes = sftp
                .metadata(remote_path)
                .ok()
                .and_then(|metadata| metadata.len());
            ensure_local_write_allowed(save_path, &conflict_action)?;
            let mut remote_file = sftp
                .open(remote_path, OpenFlags::READ_ONLY, 0)
                .map_err(|error| describe_remote_error("open remote file", remote_path, error))?;
            let mut local_file = File::create(save_path)
                .map_err(|error| describe_local_io_error("create local file", save_path, &error))?;
            let mut transferred = 0u64;
            let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];

            loop {
                lifecycle.check_cancel()?;
                let read = remote_file.read(&mut buffer).map_err(|error| {
                    describe_remote_error("read remote file", remote_path, error)
                })?;
                if read == 0 {
                    break;
                }

                local_file.write_all(&buffer[..read]).map_err(|error| {
                    describe_local_io_error("write local file", save_path, &error)
                })?;
                transferred += read as u64;
                lifecycle.running(
                    transferred,
                    total_bytes,
                    if purpose == "drag-export" {
                        "Preparing local drag copy"
                    } else {
                        "Downloading from remote host"
                    },
                );
            }
            Ok(total_bytes.unwrap_or(transferred))
        }
        "ftp" => {
            lifecycle.check_cancel()?;
            ensure_local_write_allowed(save_path, &conflict_action)?;
            lifecycle.running(
                0,
                None,
                if purpose == "drag-export" {
                    "Preparing local drag copy"
                } else {
                    "Downloading from remote host"
                },
            );
            run_ftp_download(session, remote_path, save_path)?;
            lifecycle.check_cancel()?;
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
            lifecycle.completed(
                total_bytes,
                Some(total_bytes),
                if purpose == "drag-export" {
                    "Drag copy ready"
                } else {
                    "Download complete"
                },
            );
            Ok(FileDownloadResult {
                file_name: file_name.to_string(),
                saved_to: local_path,
            })
        }
        Err(error) => {
            if !target_existed_before {
                let _ = fs::remove_file(save_path);
            }
            lifecycle.failed(0, None, &error);
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
        .map_err(|error| describe_remote_error("list remote directory", remote_dir, error))?;

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
            fs::create_dir_all(&local_path).map_err(|error| {
                describe_local_io_error("create local directory", &local_path, &error)
            })?;
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
            fs::create_dir_all(parent).map_err(|error| {
                describe_local_io_error("create local directory", parent, &error)
            })?;
        }

        let mut remote_file = sftp
            .open(&remote_path, OpenFlags::READ_ONLY, 0)
            .map_err(|error| describe_remote_error("open remote file", &remote_path, error))?;
        let mut local_file = File::create(&local_path)
            .map_err(|error| describe_local_io_error("create local file", &local_path, &error))?;
        let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];
        let local_path_label = local_path.display().to_string();

        loop {
            stop_if_transfer_cancelled(transfer_id)?;
            let read = remote_file
                .read(&mut buffer)
                .map_err(|error| describe_remote_error("read remote file", &remote_path, error))?;
            if read == 0 {
                break;
            }

            local_file.write_all(&buffer[..read]).map_err(|error| {
                describe_local_io_error("write local file", &local_path, &error)
            })?;
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
                Some(&local_path_label),
            );
        }
    }

    Ok(())
}
