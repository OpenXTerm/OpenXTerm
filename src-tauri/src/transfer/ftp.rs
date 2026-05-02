use std::{path::Path, path::PathBuf, process::Command};

use crate::{
    models::{RemoteDirectorySnapshot, RemoteFileEntry, SessionDefinition},
    proxy::configure_curl_proxy_args,
};

use super::{
    metadata::{format_size, parse_access_permissions},
    paths::join_remote_path,
};

pub(super) fn list_ftp_directory(
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

pub(super) fn run_ftp_quote(session: &SessionDefinition, quote: &str) -> Result<(), String> {
    run_ftp_command(session, &["/"], Some(quote.to_string()), None, None).map(|_| ())
}

pub(super) fn run_ftp_rename(
    session: &SessionDefinition,
    from: &str,
    to: &str,
) -> Result<(), String> {
    run_ftp_command(session, &["/"], Some(format!("RNFR {from}")), None, None)?;
    run_ftp_command(session, &["/"], Some(format!("RNTO {to}")), None, None).map(|_| ())
}

pub(super) fn run_ftp_upload(
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

pub(super) fn run_ftp_download(
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

fn run_ftp_list(session: &SessionDefinition, path: &str) -> Result<Vec<u8>, String> {
    run_ftp_command(session, &[path], Some(format!("LIST {path}")), None, None)
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
    configure_curl_proxy_args(&mut command, session)?;
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
        created_label: None,
        owner_label: Some(parts[2].to_string()),
        group_label: Some(parts[3].to_string()),
        access_label: Some(parts[0].to_string()),
        permissions: parse_access_permissions(parts[0]),
    })
}
