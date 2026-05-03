use tauri::AppHandle;

use crate::models::{DownloadTargetInspection, RemoteDirectorySnapshot, SessionDefinition};

use super::{
    errors::describe_remote_error,
    ftp::{list_ftp_directory, run_ftp_quote, run_ftp_rename},
    paths::{
        download_target_path, join_remote_path, normalize_remote_path, parent_remote_path,
        sanitize_transfer_name, unique_local_file_name,
    },
    sftp::{delete_sftp_directory_recursive, list_sftp_directory, open_sftp},
};

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
            sftp.create_dir(&remote_path, 0o755).map_err(|error| {
                describe_remote_error("create remote directory", &remote_path, error)
            })?;
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
                    .map_err(|error| describe_remote_error("remove remote file", path, error))?;
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

pub fn rename_remote_entry(
    session: &SessionDefinition,
    path: &str,
    new_name: &str,
) -> Result<(), String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("remote name cannot be empty".into());
    }
    if new_name.contains('/') || new_name.contains('\\') {
        return Err("remote name cannot contain path separators".into());
    }

    let parent_path = parent_remote_path(path);
    let next_path = join_remote_path(&parent_path, new_name);
    if next_path == path {
        return Ok(());
    }

    match session.kind.as_str() {
        "sftp" => {
            let sftp = open_sftp(session)?;
            sftp.rename(path, &next_path)
                .map_err(|error| describe_remote_error("rename remote entry", path, error))
        }
        "ftp" => run_ftp_rename(session, path, &next_path),
        _ => Err(format!("{} does not support remote rename", session.kind)),
    }
}

pub fn update_remote_entry_permissions(
    session: &SessionDefinition,
    path: &str,
    permissions: u32,
) -> Result<(), String> {
    if permissions > 0o777 {
        return Err("remote permissions must be between 000 and 777".into());
    }

    match session.kind.as_str() {
        "sftp" => {
            let sftp = open_sftp(session)?;
            sftp.chmod(path, permissions)
                .map_err(|error| describe_remote_error("update remote permissions", path, error))
        }
        "ftp" => Err("FTP permissions editing is not supported yet".into()),
        _ => Err(format!(
            "{} does not support remote permissions",
            session.kind
        )),
    }
}

pub fn inspect_download_target(
    app: &AppHandle,
    file_name: &str,
) -> Result<DownloadTargetInspection, String> {
    let file_name = sanitize_transfer_name(file_name);
    let path = download_target_path(app, &file_name)?;
    let suggested_file_name = unique_local_file_name(path.parent(), &file_name);
    let suggested_path = download_target_path(app, &suggested_file_name)?;

    Ok(DownloadTargetInspection {
        file_name,
        path: path.display().to_string(),
        exists: path.exists(),
        suggested_file_name,
        suggested_path: suggested_path.display().to_string(),
    })
}
