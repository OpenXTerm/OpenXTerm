use std::{
    fs,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use libssh_rs::{FileType, OpenFlags, Sftp};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use time::{format_description::parse, OffsetDateTime};

use crate::models::{
    FileDownloadResult, RemoteDirectorySnapshot, RemoteFileEntry, SessionDefinition,
    TransferProgressPayload,
};
use crate::runtime::open_embedded_sftp;

const TRANSFER_PROGRESS_EVENT: &str = "openxterm://transfer-progress";
const TRANSFER_CHUNK_SIZE: usize = 256 * 1024;

fn open_sftp(session: &SessionDefinition) -> Result<Sftp, String> {
    open_embedded_sftp(session, None, "SFTP helper")
}
pub fn list_remote_directory(
    session: &SessionDefinition,
    path: Option<String>,
) -> Result<RemoteDirectorySnapshot, String> {
    match session.kind.as_str() {
        "sftp" => list_sftp_directory(session, normalize_remote_path(path.as_deref())),
        "ftp" => list_ftp_directory(session, normalize_remote_path(path.as_deref())),
        _ => Err(format!("{} does not expose a file browser", session.kind)),
    }
}

pub fn create_remote_directory(
    session: &SessionDefinition,
    parent_path: &str,
    name: &str,
) -> Result<(), String> {
    let remote_path = join_remote_path(parent_path, name);

    match session.kind.as_str() {
        "sftp" => {
            let sftp = open_sftp(session)?;
            sftp.create_dir(&remote_path, 0o755)
                .map_err(|error| format!("failed to create remote directory: {error}"))?;
            Ok(())
        }
        "ftp" => run_ftp_quote(session, &format!("MKD {remote_path}")),
        _ => Err(format!(
            "{} does not support remote directories",
            session.kind
        )),
    }
}

pub fn delete_remote_entry(
    session: &SessionDefinition,
    path: &str,
    kind: &str,
) -> Result<(), String> {
    match session.kind.as_str() {
        "sftp" => {
            let sftp = open_sftp(session)?;
            if kind == "folder" {
                delete_sftp_directory_recursive(&sftp, path)?;
            } else {
                sftp.remove_file(path)
                    .map_err(|error| format!("failed to remove remote file: {error}"))?;
            }
            Ok(())
        }
        "ftp" => {
            if kind == "folder" {
                run_ftp_quote(session, &format!("RMD {path}"))
            } else {
                run_ftp_quote(session, &format!("DELE {path}"))
            }
        }
        _ => Err(format!("{} does not support remote delete", session.kind)),
    }
}

fn delete_sftp_directory_recursive(sftp: &Sftp, path: &str) -> Result<(), String> {
    let entries = sftp.read_dir(path).map_err(|error| {
        format!("failed to list remote directory {path} before delete: {error}")
    })?;

    for entry in entries {
        let Some(name) = entry.name() else {
            continue;
        };

        if name == "." || name == ".." {
            continue;
        }

        let child_path = join_remote_path(path, name);
        if is_directory(entry.file_type()) {
            delete_sftp_directory_recursive(sftp, &child_path)?;
        } else {
            sftp.remove_file(&child_path)
                .map_err(|error| format!("failed to remove remote file {child_path}: {error}"))?;
        }
    }

    sftp.remove_dir(path)
        .map_err(|error| format!("failed to remove remote directory {path}: {error}"))
}

pub fn upload_remote_file(
    app: &AppHandle,
    session: &SessionDefinition,
    remote_dir: &str,
    file_name: &str,
    bytes: Vec<u8>,
    transfer_id: Option<String>,
) -> Result<(), String> {
    let remote_path = join_remote_path(remote_dir, file_name);
    let total_bytes = bytes.len() as u64;
    let transfer_id = transfer_id.unwrap_or_else(|| {
        format!(
            "upload-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0)
        )
    });

    emit_transfer(
        app,
        &transfer_id,
        file_name,
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
            let sftp = open_sftp(session)?;
            let mut file = sftp
                .open(
                    &remote_path,
                    OpenFlags::CREATE | OpenFlags::WRITE_ONLY | OpenFlags::TRUNCATE,
                    0o644,
                )
                .map_err(|error| format!("failed to create remote file: {error}"))?;
            let mut transferred = 0u64;
            for chunk in bytes.chunks(TRANSFER_CHUNK_SIZE) {
                file.write_all(chunk)
                    .map_err(|error| format!("failed to upload remote file: {error}"))?;
                transferred += chunk.len() as u64;
                emit_transfer(
                    app,
                    &transfer_id,
                    file_name,
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
            let temp_path = temp_upload_path(file_name);
            fs::write(&temp_path, bytes).map_err(|error| {
                format!("failed to stage upload {}: {error}", temp_path.display())
            })?;
            emit_transfer(
                app,
                &transfer_id,
                file_name,
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
            result
        }
        _ => Err(format!("{} does not support upload", session.kind)),
    };

    match result {
        Ok(()) => {
            emit_transfer(
                app,
                &transfer_id,
                file_name,
                &remote_path,
                "upload",
                "upload",
                "completed",
                total_bytes,
                Some(total_bytes),
                "Upload complete",
                None,
            );
            Ok(())
        }
        Err(error) => {
            emit_transfer(
                app,
                &transfer_id,
                file_name,
                &remote_path,
                "upload",
                "upload",
                "error",
                0,
                Some(total_bytes),
                &error,
                None,
            );
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
) -> Result<(), String> {
    let local_path = PathBuf::from(local_path);
    let file_name = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("invalid local file path: {}", local_path.display()))?
        .to_string();
    let metadata = fs::metadata(&local_path)
        .map_err(|error| format!("failed to read {}: {error}", local_path.display()))?;
    let total_bytes = if metadata.is_dir() {
        local_directory_total_size(&local_path)?
    } else {
        metadata.len()
    };
    let remote_path = join_remote_path(remote_dir, &file_name);
    let transfer_id = transfer_id.unwrap_or_else(|| {
        format!(
            "upload-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0)
        )
    });

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
                )?;
            }
            Ok(())
        }
        "ftp" => {
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
            run_ftp_upload(session, &remote_path, &local_path)
        }
        _ => Err(format!("{} does not support upload", session.kind)),
    };

    match result {
        Ok(()) => {
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
) -> Result<(), String> {
    let _ = sftp.create_dir(remote_dir, 0o755);

    let entries = fs::read_dir(local_dir)
        .map_err(|error| format!("failed to read {}: {error}", local_dir.display()))?;
    for entry in entries {
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
) -> Result<(), String> {
    let mut source = File::open(local_path)
        .map_err(|error| format!("failed to open {}: {error}", local_path.display()))?;
    let mut target = sftp
        .open(
            remote_path,
            OpenFlags::CREATE | OpenFlags::WRITE_ONLY | OpenFlags::TRUNCATE,
            0o644,
        )
        .map_err(|error| format!("failed to create remote file {remote_path}: {error}"))?;
    let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];

    loop {
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
) -> Result<FileDownloadResult, String> {
    let file_name = remote_file_name(remote_path);
    let save_path = download_target_path(app, &file_name)?;
    download_remote_entry_to_path(
        app,
        session,
        remote_path,
        &file_name,
        &save_path,
        kind,
        "download",
        transfer_id,
    )
}

pub fn download_remote_file(
    app: &AppHandle,
    session: &SessionDefinition,
    remote_path: &str,
    transfer_id: Option<String>,
) -> Result<FileDownloadResult, String> {
    download_remote_entry(app, session, remote_path, "file", transfer_id)
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
        );
    }

    let transfer_id = transfer_id.unwrap_or_else(|| {
        format!(
            "download-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0)
        )
    });
    let local_path = save_path.display().to_string();

    emit_transfer(
        app,
        &transfer_id,
        file_name,
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
            let sftp = open_sftp(session)?;
            let total_bytes = sftp_directory_total_size(&sftp, remote_path)?;
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
            emit_transfer(
                app,
                &transfer_id,
                file_name,
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
                file_name,
                remote_path,
                "download",
                purpose,
                "error",
                0,
                None,
                &error,
                Some(local_path),
            );
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
) -> Result<FileDownloadResult, String> {
    let transfer_id = transfer_id.unwrap_or_else(|| {
        format!(
            "download-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0)
        )
    });
    let local_path = save_path.display().to_string();

    emit_transfer(
        app,
        &transfer_id,
        file_name,
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
            let sftp = open_sftp(session)?;
            let total_bytes = sftp
                .metadata(remote_path)
                .ok()
                .and_then(|metadata| metadata.len());
            let mut remote_file = sftp
                .open(remote_path, OpenFlags::READ_ONLY, 0)
                .map_err(|error| format!("failed to open remote file: {error}"))?;
            let mut local_file = File::create(save_path)
                .map_err(|error| format!("failed to write {}: {error}", save_path.display()))?;
            let mut transferred = 0u64;
            let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];

            loop {
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
                    file_name,
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
            emit_transfer(
                app,
                &transfer_id,
                file_name,
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
            emit_transfer(
                app,
                &transfer_id,
                file_name,
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
                file_name,
                remote_path,
                "download",
                purpose,
                "error",
                0,
                None,
                &error,
                Some(local_path),
            );
            Err(error)
        }
    }
}

fn sftp_directory_total_size(sftp: &Sftp, path: &str) -> Result<u64, String> {
    let mut total = 0u64;
    let entries = sftp
        .read_dir(path)
        .map_err(|error| format!("failed to list remote directory {path}: {error}"))?;

    for entry in entries {
        let Some(name) = entry.name() else {
            continue;
        };

        if name == "." || name == ".." {
            continue;
        }

        let child_path = join_remote_path(path, name);
        if is_directory(entry.file_type()) {
            total += sftp_directory_total_size(sftp, &child_path)?;
        } else {
            total += entry.len().unwrap_or(0);
        }
    }

    Ok(total)
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
    let entries = sftp
        .read_dir(remote_dir)
        .map_err(|error| format!("failed to list remote directory {remote_dir}: {error}"))?;

    for entry in entries {
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

fn list_sftp_directory(
    session: &SessionDefinition,
    path: String,
) -> Result<RemoteDirectorySnapshot, String> {
    let sftp = open_sftp(session)?;
    let entries = sftp
        .read_dir(&path)
        .map_err(|error| format!("failed to list remote directory {path}: {error}"))?;

    let entries = entries
        .into_iter()
        .filter_map(|entry| {
            let name = entry.name()?.to_string();
            if name == "." || name == ".." {
                return None;
            }

            let kind = if is_directory(entry.file_type()) {
                "folder"
            } else {
                "file"
            };
            Some(RemoteFileEntry {
                name: name.clone(),
                path: join_remote_path(&path, &name),
                kind: kind.into(),
                size_bytes: entry.len(),
                size_label: format_size(entry.len()),
                modified_label: format_system_time(entry.modified()),
            })
        })
        .collect();

    Ok(RemoteDirectorySnapshot { path, entries })
}

fn list_ftp_directory(
    session: &SessionDefinition,
    path: String,
) -> Result<RemoteDirectorySnapshot, String> {
    let output = run_ftp_list(session, &path)?;
    let listing = String::from_utf8_lossy(&output);
    let mut entries = Vec::new();

    for line in listing.lines() {
        if let Some(entry) = parse_ftp_list_line(line, &path) {
            entries.push(entry);
        }
    }

    Ok(RemoteDirectorySnapshot { path, entries })
}

fn run_ftp_list(session: &SessionDefinition, path: &str) -> Result<Vec<u8>, String> {
    run_ftp_command(session, &[path], Some(format!("LIST {path}")), None, None)
}

fn run_ftp_quote(session: &SessionDefinition, quote: &str) -> Result<(), String> {
    run_ftp_command(session, &["/"], Some(quote.to_string()), None, None).map(|_| ())
}

fn run_ftp_upload(
    session: &SessionDefinition,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), String> {
    run_ftp_command(
        session,
        &[remote_path],
        None,
        Some(local_path.to_path_buf()),
        None,
    )
    .map(|_| ())
}

fn run_ftp_download(
    session: &SessionDefinition,
    remote_path: &str,
    save_path: &Path,
) -> Result<(), String> {
    run_ftp_command(
        session,
        &[remote_path],
        None,
        None,
        Some(save_path.to_path_buf()),
    )
    .map(|_| ())
}

fn run_ftp_command(
    session: &SessionDefinition,
    paths: &[&str],
    quote: Option<String>,
    upload_file: Option<PathBuf>,
    output_file: Option<PathBuf>,
) -> Result<Vec<u8>, String> {
    let mut command = Command::new("curl");
    command.args(["--silent", "--show-error", "--disable-epsv"]);
    if let Some(quote) = quote {
        command.arg("--quote").arg(quote);
    }
    command.arg("--user").arg(format!(
        "{}:{}",
        session.username,
        session.password.clone().unwrap_or_default()
    ));
    if let Some(upload_file) = upload_file {
        command.arg("--upload-file").arg(upload_file);
    }
    if let Some(output_file) = output_file {
        command.arg("--output").arg(output_file);
    }
    for path in paths {
        command.arg(ftp_url(session, path));
    }

    let output = command
        .output()
        .map_err(|error| format!("failed to launch curl: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(format!("FTP command failed: {message}"));
    }

    Ok(output.stdout)
}

fn ftp_url(session: &SessionDefinition, path: &str) -> String {
    let normalized = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    format!("ftp://{}:{}{}", session.host, session.port, normalized)
}

fn parse_ftp_list_line(line: &str, current_path: &str) -> Option<RemoteFileEntry> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let parts = trimmed.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 9 {
        return None;
    }

    let kind = if parts[0].starts_with('d') {
        "folder"
    } else {
        "file"
    };
    let name = parts[8..].join(" ");
    let size_bytes = parts[4].parse::<u64>().ok();
    Some(RemoteFileEntry {
        name: name.clone(),
        path: join_remote_path(current_path, &name),
        kind: kind.into(),
        size_bytes,
        size_label: format_size(size_bytes),
        modified_label: parts[5..8].join(" "),
    })
}

fn normalize_remote_path(path: Option<&str>) -> String {
    match path {
        Some(value) if !value.trim().is_empty() => {
            if value.starts_with('/') {
                value.to_string()
            } else {
                format!("/{value}")
            }
        }
        _ => "/".into(),
    }
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{}", name.trim_start_matches('/'))
    } else {
        format!(
            "{}/{}",
            parent.trim_end_matches('/'),
            name.trim_start_matches('/'),
        )
    }
}

fn remote_file_name(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or("download.bin")
        .to_string()
}

fn download_target_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("failed to resolve downloads directory: {error}"))?
        .join("OpenXTerm");
    fs::create_dir_all(&downloads_dir)
        .map_err(|error| format!("failed to create {}: {error}", downloads_dir.display()))?;
    Ok(downloads_dir.join(file_name))
}

fn drag_cache_path(file_name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    std::env::temp_dir()
        .join("openxterm-drag-cache")
        .join(format!("{stamp}-{}", sanitize_file_name(file_name)))
}

fn temp_upload_path(file_name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("openxterm-upload-{stamp}-{file_name}"))
}

fn local_directory_total_size(path: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    let entries = fs::read_dir(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to read {}: {error}", entry.path().display()))?;

        if metadata.is_dir() {
            total += local_directory_total_size(&entry.path())?;
        } else {
            total += metadata.len();
        }
    }

    Ok(total)
}

fn format_size(size_bytes: Option<u64>) -> String {
    let Some(bytes) = size_bytes else {
        return "--".into();
    };

    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit_index = 0usize;
    while value >= 1024.0 && unit_index < UNITS.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }

    if unit_index == 0 {
        format!("{bytes} {}", UNITS[unit_index])
    } else {
        format!("{value:.1} {}", UNITS[unit_index])
    }
}

fn format_system_time(timestamp: Option<SystemTime>) -> String {
    let Some(timestamp) = timestamp else {
        return "--".into();
    };

    let Ok(timestamp) = timestamp.duration_since(UNIX_EPOCH) else {
        return "--".into();
    };
    let timestamp = timestamp.as_secs() as i64;

    let Ok(format) = parse("[year]-[month]-[day] [hour]:[minute]") else {
        return timestamp.to_string();
    };
    let Ok(datetime) = OffsetDateTime::from_unix_timestamp(timestamp) else {
        return timestamp.to_string();
    };

    datetime
        .format(&format)
        .unwrap_or_else(|_| timestamp.to_string())
}

fn is_directory(file_type: Option<FileType>) -> bool {
    matches!(file_type, Some(FileType::Directory))
}

fn sanitize_file_name(file_name: &str) -> String {
    file_name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect()
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
    if state == "queued" && !is_batch_child_transfer_id(transfer_id) {
        reveal_transfer_window(app, transfer_id, file_name);
    }

    let _ = app.emit(
        TRANSFER_PROGRESS_EVENT,
        TransferProgressPayload {
            transfer_id: transfer_id.to_string(),
            file_name: file_name.to_string(),
            remote_path: remote_path.to_string(),
            direction: direction.to_string(),
            purpose: purpose.to_string(),
            state: state.to_string(),
            transferred_bytes,
            total_bytes,
            message: message.to_string(),
            local_path,
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
