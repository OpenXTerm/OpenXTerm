use libssh_rs::{Metadata, Sftp};

use crate::{
    models::{RemoteDirectorySnapshot, RemoteFileEntry, SessionDefinition},
    runtime::open_embedded_sftp,
};

use super::{
    errors::{
        describe_remote_error, is_remote_already_exists_error, is_remote_ambiguous_failure_error,
        is_remote_not_found_error,
    },
    metadata::{format_access_label, format_size, format_system_time, is_directory},
    paths::{join_remote_path, parent_remote_path, remote_file_name},
};

pub(super) fn open_sftp(session: &SessionDefinition) -> Result<Sftp, String> {
    open_embedded_sftp(session, None, "SFTP helper")
}

pub(super) fn delete_sftp_directory_recursive(sftp: &Sftp, path: &str) -> Result<(), String> {
    let entries = sftp.read_dir(path).map_err(|error| {
        describe_remote_error("list remote directory before delete", path, error)
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
                .map_err(|error| describe_remote_error("remove remote file", &child_path, error))?;
        }
    }

    sftp.remove_dir(path)
        .map_err(|error| describe_remote_error("remove remote directory", path, error))
}

pub(super) fn ensure_sftp_write_allowed(
    sftp: &Sftp,
    remote_path: &str,
    conflict_action: &str,
) -> Result<(), String> {
    if inspect_sftp_metadata(sftp, remote_path, "check remote path")?.is_none() {
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
    match inspect_sftp_metadata(sftp, remote_path, "check remote directory")? {
        Some(metadata) if is_directory(metadata.file_type()) && conflict_action == "overwrite" => {
            Ok(())
        }
        Some(metadata) if is_directory(metadata.file_type()) => Err(format!(
            "{} already exists. Choose overwrite, skip, or rename.",
            remote_file_name(remote_path)
        )),
        Some(_) if conflict_action == "overwrite" => Err(format!(
            "{} already exists and is not a folder.",
            remote_file_name(remote_path)
        )),
        Some(_) => Err(format!(
            "{} already exists. Choose overwrite, skip, or rename.",
            remote_file_name(remote_path)
        )),
        None => Ok(()),
    }
}

pub(super) fn create_sftp_directory_if_needed(
    sftp: &Sftp,
    remote_path: &str,
) -> Result<(), String> {
    match sftp.create_dir(remote_path, 0o755) {
        Ok(()) => Ok(()),
        Err(error) if is_remote_already_exists_error(&error) => match sftp.metadata(remote_path) {
            Ok(metadata) if is_directory(metadata.file_type()) => Ok(()),
            Ok(_) => Err(format!(
                "{} already exists and is not a folder.",
                remote_file_name(remote_path)
            )),
            Err(metadata_error) => Err(describe_remote_error(
                "check existing remote directory",
                remote_path,
                metadata_error,
            )),
        },
        Err(error) => match sftp.metadata(remote_path) {
            Ok(metadata) if is_directory(metadata.file_type()) => Ok(()),
            _ => Err(describe_remote_error(
                "create remote directory",
                remote_path,
                error,
            )),
        },
    }
}

fn inspect_sftp_metadata(
    sftp: &Sftp,
    remote_path: &str,
    action: &str,
) -> Result<Option<Metadata>, String> {
    match sftp.metadata(remote_path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if is_remote_not_found_error(&error) => Ok(None),
        Err(error) if is_remote_ambiguous_failure_error(&error) => {
            if parent_listing_confirms_missing(sftp, remote_path)? {
                Ok(None)
            } else {
                Err(describe_remote_error(action, remote_path, error))
            }
        }
        Err(error) => Err(describe_remote_error(action, remote_path, error)),
    }
}

fn parent_listing_confirms_missing(sftp: &Sftp, remote_path: &str) -> Result<bool, String> {
    let parent_path = parent_remote_path(remote_path);
    let file_name = remote_file_name(remote_path);
    let entries = sftp.read_dir(&parent_path).map_err(|error| {
        describe_remote_error("list parent remote directory", &parent_path, error)
    })?;

    Ok(entries
        .iter()
        .filter_map(Metadata::name)
        .all(|name| name != file_name))
}

pub(super) fn sftp_directory_total_size(sftp: &Sftp, path: &str) -> Result<u64, String> {
    let mut total = 0u64;
    let entries = sftp
        .read_dir(path)
        .map_err(|error| describe_remote_error("list remote directory", path, error))?;

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
        .map_err(|error| describe_remote_error("list remote directory", &path, error))?;

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
