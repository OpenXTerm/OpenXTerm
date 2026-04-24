use std::io::Read;

use libssh_rs::{FileType, Session, SshOption};

use crate::models::{LibsshProbePayload, RemoteFileEntry, SessionDefinition};

const DEFAULT_PROBE_COMMAND: &str =
    "printf 'user='; id -un; printf '\\nhost='; hostname; printf '\\npwd='; pwd";
const DEFAULT_PTY_TERM: &str = "xterm-256color";

pub fn run_probe(
    session: &SessionDefinition,
    remote_command: Option<&str>,
    remote_path: Option<&str>,
) -> Result<LibsshProbePayload, String> {
    if session.kind != "ssh" && session.kind != "sftp" {
        return Err("libssh-rs spike currently supports SSH/SFTP-shaped sessions only.".into());
    }

    let username = effective_username(session)?;
    let remote_command = remote_command
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_PROBE_COMMAND)
        .to_string();
    let remote_path = normalize_remote_path(remote_path);

    let mut notes = vec![
        "Spike only: live terminal SSH tabs already run on the embedded libssh-rs runtime.".to_string(),
        "This probe now serves as a backend comparison and helper-migration test path while status/SFTP are still finishing their move off older helper code.".to_string(),
    ];

    let mut probe = connect(session, &username)?;
    let known_hosts = inspect_known_hosts(&mut probe)?;
    let (pty_supported, exec_stdout, exec_stderr, exec_exit_status) =
        exec_probe_command(&mut probe, &remote_command, &mut notes)?;
    let sftp_entries = list_sftp_entries(&mut probe, &remote_path)?;

    Ok(LibsshProbePayload {
        backend: "libssh-rs".into(),
        authenticated_user: username,
        known_hosts,
        pty_supported,
        pty_term: DEFAULT_PTY_TERM.into(),
        remote_command,
        exec_stdout,
        exec_stderr,
        exec_exit_status,
        remote_path,
        sftp_entries,
        notes,
    })
}

fn connect(session: &SessionDefinition, username: &str) -> Result<Session, String> {
    let ssh =
        Session::new().map_err(|error| format!("failed to create libssh session: {error}"))?;
    ssh.set_option(SshOption::Hostname(session.host.clone()))
        .map_err(|error| format!("failed to configure libssh host: {error}"))?;
    ssh.set_option(SshOption::Port(session.port))
        .map_err(|error| format!("failed to configure libssh port: {error}"))?;
    ssh.set_option(SshOption::User(Some(username.to_string())))
        .map_err(|error| format!("failed to configure libssh username: {error}"))?;
    ssh.connect()
        .map_err(|error| format!("libssh connect failed: {error}"))?;

    match session.auth_type.as_str() {
        "password" => {
            let password = session
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    "libssh-rs spike needs a saved password for password auth.".to_string()
                })?;
            ssh.userauth_password(None, Some(password))
                .map_err(|error| format!("libssh password authentication failed: {error}"))?;
        }
        "key" => {
            let key_path = session
                .key_path
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "libssh-rs spike needs a key path for key auth.".to_string())?;
            let passphrase = session
                .password
                .as_deref()
                .filter(|value| !value.is_empty());
            ssh.userauth_public_key_auto(Some(key_path), passphrase)
                .map_err(|error| format!("libssh key authentication failed: {error}"))?;
        }
        _ => {
            ssh.userauth_agent(Some(username))
                .map_err(|error| format!("libssh agent authentication failed: {error}"))?;
        }
    }

    Ok(ssh)
}

fn inspect_known_hosts(ssh: &mut Session) -> Result<String, String> {
    ssh.set_option(SshOption::KnownHosts(None))
        .map_err(|error| format!("failed to configure libssh user known_hosts path: {error}"))?;
    ssh.set_option(SshOption::GlobalKnownHosts(None))
        .map_err(|error| format!("failed to configure libssh global known_hosts path: {error}"))?;
    let status = ssh
        .is_known_server()
        .map_err(|error| format!("failed to evaluate libssh known_hosts state: {error}"))?;
    Ok(format!("{status:?}"))
}

fn exec_probe_command(
    ssh: &mut Session,
    remote_command: &str,
    notes: &mut Vec<String>,
) -> Result<(bool, String, String, Option<i32>), String> {
    let channel = ssh
        .new_channel()
        .map_err(|error| format!("failed to create libssh exec channel: {error}"))?;
    channel
        .open_session()
        .map_err(|error| format!("failed to open libssh exec session: {error}"))?;

    let mut pty_supported = true;
    if let Err(error) = channel.request_pty(DEFAULT_PTY_TERM, 160, 48) {
        pty_supported = false;
        notes.push(format!("PTY request failed in spike path: {error}"));
    }

    channel
        .request_exec(remote_command)
        .map_err(|error| format!("failed to execute libssh probe command: {error}"))?;
    let mut stdout = String::new();
    channel
        .stdout()
        .read_to_string(&mut stdout)
        .map_err(|error| format!("failed to read libssh stdout: {error}"))?;
    let mut stderr = String::new();
    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(|error| format!("failed to read libssh stderr: {error}"))?;
    channel
        .send_eof()
        .map_err(|error| format!("failed to finish libssh probe command: {error}"))?;
    let exit_status = channel.get_exit_status();

    Ok((pty_supported, stdout, stderr, exit_status))
}

fn list_sftp_entries(ssh: &mut Session, remote_path: &str) -> Result<Vec<RemoteFileEntry>, String> {
    let sftp = ssh
        .sftp()
        .map_err(|error| format!("failed to open libssh SFTP subsystem: {error}"))?;
    let mut entries = Vec::new();
    for entry in sftp
        .read_dir(remote_path)
        .map_err(|error| format!("failed to list {remote_path} via libssh SFTP: {error}"))?
    {
        let name = entry.name().unwrap_or("").to_string();
        if name == "." || name == ".." {
            continue;
        }
        let kind = match entry.file_type() {
            Some(FileType::Directory) => "folder",
            _ => "file",
        };
        let full_path = if remote_path == "/" {
            format!("/{name}")
        } else {
            format!("{}/{}", remote_path.trim_end_matches('/'), name)
        };
        let size = entry.len();
        entries.push(RemoteFileEntry {
            name,
            path: full_path,
            kind: kind.into(),
            size_bytes: size,
            size_label: format_size(size.unwrap_or(0)),
            modified_label: entry.long_name().unwrap_or("--").to_string(),
        });
    }
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(entries)
}

fn effective_username(session: &SessionDefinition) -> Result<String, String> {
    let username = session.username.trim();
    if username.is_empty() {
        return Err("libssh-rs spike currently expects a resolved username in the session.".into());
    }
    Ok(username.to_string())
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

fn format_size(size_bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = size_bytes as f64;
    let mut unit_index = 0usize;
    while value >= 1024.0 && unit_index < UNITS.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }

    if unit_index == 0 {
        format!("{size_bytes} {}", UNITS[unit_index])
    } else {
        format!("{value:.1} {}", UNITS[unit_index])
    }
}
