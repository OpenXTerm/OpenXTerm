use std::{
    fs,
    fs::File,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use libssh_rs::{OpenFlags, Sftp, SftpFile};
use tauri::AppHandle;

use crate::models::SessionDefinition;

use super::{
    emit_transfer,
    errors::{describe_local_io_error, describe_remote_error},
    ftp::run_ftp_upload,
    lifecycle::{init_transfer, TransferInit},
    paths::{
        join_remote_path, local_directory_total_size, sanitize_transfer_name, temp_upload_path,
    },
    sftp::{
        create_sftp_directory_if_needed, ensure_sftp_directory_allowed, ensure_sftp_write_allowed,
        open_sftp,
    },
    state::{remember_transfer_retry, stop_if_transfer_cancelled, TransferRetryOperation},
    TRANSFER_CHUNK_SIZE,
};

const SFTP_WRITE_STALL_TIMEOUT: Duration = Duration::from_secs(10);
const SFTP_WRITE_RETRY_SLEEP: Duration = Duration::from_millis(50);

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
    let (transfer_id, lifecycle) = init_transfer(TransferInit {
        app,
        transfer_id,
        id_prefix: "upload",
        file_name: &file_name,
        remote_path: &remote_path,
        direction: "upload",
        purpose: "upload",
        local_path: None,
        total_bytes: Some(total_bytes),
        queued_message: "Queued for upload",
    });

    let result = match session.kind.as_str() {
        "sftp" => {
            lifecycle.check_cancel()?;
            let sftp = open_sftp(session)?;
            ensure_sftp_write_allowed(&sftp, &remote_path, &conflict_action)?;
            let mut file = sftp
                .open(
                    &remote_path,
                    OpenFlags::CREATE | OpenFlags::WRITE_ONLY | OpenFlags::TRUNCATE,
                    0o644,
                )
                .map_err(|error| {
                    describe_remote_error("create remote file", &remote_path, error)
                })?;
            let mut transferred = 0u64;
            for chunk in bytes.chunks(TRANSFER_CHUNK_SIZE) {
                lifecycle.check_cancel()?;
                write_sftp_chunk_with_timeout(&mut file, chunk, &remote_path, &transfer_id)?;
                transferred += chunk.len() as u64;
                lifecycle.running(transferred, Some(total_bytes), "Uploading to remote host");
            }
            Ok(())
        }
        "ftp" => {
            lifecycle.check_cancel()?;
            let temp_path = temp_upload_path(&file_name);
            fs::write(&temp_path, &bytes)
                .map_err(|error| describe_local_io_error("stage upload", &temp_path, &error))?;
            lifecycle.running(0, Some(total_bytes), "Uploading to remote host");

            let result = run_ftp_upload(session, &remote_path, &temp_path);
            let _ = fs::remove_file(&temp_path);
            lifecycle.check_cancel()?;
            result
        }
        _ => Err(format!("{} does not support upload", session.kind)),
    };

    match result {
        Ok(()) => {
            lifecycle.completed(total_bytes, Some(total_bytes), "Upload complete");
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
            lifecycle.failed(0, Some(total_bytes), &error);
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
        .map_err(|error| describe_local_io_error("read local path", &local_path, &error))?;
    let total_bytes = if metadata.is_dir() {
        local_directory_total_size(&local_path)?
    } else {
        metadata.len()
    };
    let remote_path = join_remote_path(remote_dir, &file_name);
    let conflict_action = conflict_action.unwrap_or_else(|| "error".into());
    let local_path_label = local_path.display().to_string();
    let (transfer_id, lifecycle) = init_transfer(TransferInit {
        app,
        transfer_id,
        id_prefix: "upload",
        file_name: &file_name,
        remote_path: &remote_path,
        direction: "upload",
        purpose: "upload",
        local_path: Some(&local_path_label),
        total_bytes: Some(total_bytes),
        queued_message: "Queued for upload",
    });
    remember_transfer_retry(
        &transfer_id,
        TransferRetryOperation::UploadLocalFile {
            session: session.clone(),
            remote_dir: remote_dir.to_string(),
            local_path: local_path_label.clone(),
            remote_name: Some(file_name.clone()),
            conflict_action: conflict_action.clone(),
        },
    );
    let result = match session.kind.as_str() {
        "sftp" => {
            lifecycle.check_cancel()?;
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
            lifecycle.check_cancel()?;
            if metadata.is_dir() {
                Err("FTP folder upload is not implemented yet".into())
            } else {
                lifecycle.running(0, Some(total_bytes), "Uploading to remote host");
                let result = run_ftp_upload(session, &remote_path, &local_path);
                lifecycle.check_cancel()?;
                result
            }
        }
        _ => Err(format!("{} does not support upload", session.kind)),
    };

    match result {
        Ok(()) => {
            lifecycle.completed(total_bytes, Some(total_bytes), "Upload complete");
            Ok(())
        }
        Err(error) => {
            lifecycle.failed(0, Some(total_bytes), &error);
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
    create_sftp_directory_if_needed(sftp, remote_dir)?;

    let entries = fs::read_dir(local_dir)
        .map_err(|error| describe_local_io_error("read local directory", local_dir, &error))?;
    for entry in entries {
        stop_if_transfer_cancelled(transfer_id)?;
        let entry = entry
            .map_err(|error| describe_local_io_error("read local directory", local_dir, &error))?;
        let local_path = entry.path();
        let remote_path = join_remote_path(remote_dir, &entry.file_name().to_string_lossy());
        let metadata = entry
            .metadata()
            .map_err(|error| describe_local_io_error("read local path", &local_path, &error))?;

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
        .map_err(|error| describe_local_io_error("open local file", local_path, &error))?;
    ensure_sftp_write_allowed(sftp, remote_path, conflict_action)?;
    let mut target = sftp
        .open(
            remote_path,
            OpenFlags::CREATE | OpenFlags::WRITE_ONLY | OpenFlags::TRUNCATE,
            0o644,
        )
        .map_err(|error| describe_remote_error("create remote file", remote_path, error))?;
    let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];
    let local_path_label = local_path.display().to_string();

    loop {
        stop_if_transfer_cancelled(transfer_id)?;
        let read = source
            .read(&mut buffer)
            .map_err(|error| describe_local_io_error("read local file", local_path, &error))?;
        if read == 0 {
            break;
        }

        write_sftp_chunk_with_timeout(&mut target, &buffer[..read], remote_path, transfer_id)?;
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
            Some(&local_path_label),
        );
    }

    Ok(())
}

fn write_sftp_chunk_with_timeout(
    target: &mut SftpFile,
    chunk: &[u8],
    remote_path: &str,
    transfer_id: &str,
) -> Result<(), String> {
    target.set_blocking(false);

    let mut written = 0usize;
    let mut last_progress = Instant::now();
    while written < chunk.len() {
        stop_if_transfer_cancelled(transfer_id)?;
        match target.write(&chunk[written..]) {
            Ok(0) => {
                if last_progress.elapsed() >= SFTP_WRITE_STALL_TIMEOUT {
                    return Err(format!(
                        "Cannot upload remote file {remote_path}: no write progress for {} seconds. Check the network connection and remote disk/quota, then retry.",
                        SFTP_WRITE_STALL_TIMEOUT.as_secs()
                    ));
                }
                thread::sleep(SFTP_WRITE_RETRY_SLEEP);
            }
            Ok(count) => {
                written += count;
                last_progress = Instant::now();
            }
            Err(error) if is_sftp_write_would_block(&error) => {
                if last_progress.elapsed() >= SFTP_WRITE_STALL_TIMEOUT {
                    return Err(format!(
                        "Cannot upload remote file {remote_path}: no write progress for {} seconds. Check the network connection and remote disk/quota, then retry.",
                        SFTP_WRITE_STALL_TIMEOUT.as_secs()
                    ));
                }
                thread::sleep(SFTP_WRITE_RETRY_SLEEP);
            }
            Err(error) => {
                return Err(describe_remote_error(
                    "upload remote file",
                    remote_path,
                    error,
                ));
            }
        }
    }

    Ok(())
}

fn is_sftp_write_would_block(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
    ) || error.to_string().contains("sftp error code 0")
}
