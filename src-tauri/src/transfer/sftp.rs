use libssh_rs::{Metadata, Sftp};

use crate::{
    models::{RemoteDirectorySnapshot, RemoteFileEntry, SessionDefinition},
    runtime::open_embedded_sftp,
};

use super::{
    metadata::{format_access_label, format_size, format_system_time, is_directory},
    paths::{join_remote_path, remote_file_name},
};

pub(super) fn open_sftp(session: &SessionDefinition) -> Result<Sftp, String> {
    open_embedded_sftp(session, None, "SFTP helper")
}

pub(super) fn delete_sftp_directory_recursive(sftp: &Sftp, path: &str) -> Result<(), String> {
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

pub(super) fn ensure_sftp_write_allowed(
    sftp: &Sftp,
    remote_path: &str,
    conflict_action: &str,
) -> Result<(), String> {
    if sftp.metadata(remote_path).is_err() {
        return Ok(());
    }

    if conflict_action == "overwrite" {
        return Ok(());
    }

    Err(format!(
        "{} already exists. Choose overwrite, skip, or rename.",
        remote_file_name(remote_path)
    ))
}

pub(super) fn ensure_sftp_directory_allowed(
    sftp: &Sftp,
    remote_path: &str,
    conflict_action: &str,
) -> Result<(), String> {
    match sftp.metadata(remote_path) {
        Ok(metadata) if is_directory(metadata.file_type()) && conflict_action == "overwrite" => {
            Ok(())
        }
        Ok(metadata) if is_directory(metadata.file_type()) => Err(format!(
            "{} already exists. Choose overwrite, skip, or rename.",
            remote_file_name(remote_path)
        )),
        Ok(_) if conflict_action == "overwrite" => Err(format!(
            "{} already exists and is not a folder.",
            remote_file_name(remote_path)
        )),
        Ok(_) => Err(format!(
            "{} already exists. Choose overwrite, skip, or rename.",
            remote_file_name(remote_path)
        )),
        Err(_) => Ok(()),
    }
}

pub(super) fn sftp_directory_total_size(sftp: &Sftp, path: &str) -> Result<u64, String> {
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

pub(super) fn list_sftp_directory(
    session: &SessionDefinition,
    path: String,
) -> Result<RemoteDirectorySnapshot, String> {
    let sftp = open_sftp(session)?;
    let entries = sftp
        .read_dir(&path)
        .map_err(|error| format!("failed to list remote directory {path}: {error}"))?;

    let entries = entries
        .into_iter()
        .filter_map(|entry| remote_file_entry_from_sftp(entry, &path))
        .collect();

    Ok(RemoteDirectorySnapshot { path, entries })
}

fn remote_file_entry_from_sftp(entry: Metadata, path: &str) -> Option<RemoteFileEntry> {
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
        path: join_remote_path(path, &name),
        kind: kind.into(),
        size_bytes: entry.len(),
        size_label: format_size(entry.len()),
        modified_label: format_system_time(entry.modified()),
        created_label: None,
        owner_label: entry.uid().map(|uid| uid.to_string()),
        group_label: entry.gid().map(|gid| gid.to_string()),
        access_label: format_access_label(entry.file_type(), entry.permissions()),
        permissions: entry.permissions().map(|permissions| permissions & 0o777),
    })
}
