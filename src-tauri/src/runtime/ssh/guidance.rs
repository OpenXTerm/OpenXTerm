use std::{
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use tauri::AppHandle;

use crate::models::SessionDefinition;

use super::super::{emit_output, SharedWriter, RECENT_TERMINAL_OUTPUT_CHAR_LIMIT};

#[derive(Default)]
pub(in crate::runtime) struct SshRuntimeGuidanceState {
    host_key_prompt: bool,
    host_key_changed: bool,
    auth_failed: bool,
    key_permission_error: bool,
    connection_refused: bool,
    timeout: bool,
    host_unreachable: bool,
    dns_error: bool,
}

pub(in crate::runtime) fn handle_password_prompt(
    app: &AppHandle,
    tab_id: &str,
    writer: &SharedWriter,
    session: &SessionDefinition,
    password_sent: &Arc<AtomicBool>,
    recent_output: &str,
) {
    if session.auth_type != "password"
        || !matches!(session.kind.as_str(), "ssh" | "telnet")
        || session.username.trim().is_empty()
        || password_sent.load(Ordering::Relaxed)
    {
        return;
    }

    if !looks_like_password_prompt(recent_output) {
        return;
    }

    if let Some(password) = session.password.as_ref().filter(|value| !value.is_empty()) {
        if let Ok(mut writer) = writer.lock() {
            if writer
                .write_all(format!("{password}\n").as_bytes())
                .and_then(|_| writer.flush())
                .is_ok()
            {
                password_sent.store(true, Ordering::Relaxed);
                emit_output(
                    app,
                    tab_id,
                    "\r\n[information] Password prompt detected, credentials sent.\r\n",
                );
            }
        }
    } else {
        emit_output(
            app,
            tab_id,
            "\r\n[error] Password auth selected but no password is stored in session.\r\n",
        );
    }
}

pub(in crate::runtime) fn push_recent_terminal_output(recent_output: &mut String, chunk: &str) {
    recent_output.push_str(&chunk.to_ascii_lowercase());
    let overflow_chars = recent_output
        .chars()
        .count()
        .saturating_sub(RECENT_TERMINAL_OUTPUT_CHAR_LIMIT);

    if overflow_chars > 0 {
        let drain_len = recent_output
            .char_indices()
            .nth(overflow_chars)
            .map(|(index, _)| index)
            .unwrap_or_else(|| recent_output.len());
        recent_output.drain(..drain_len);
    }
}

pub(in crate::runtime) fn maybe_report_ssh_runtime_guidance(
    app: &AppHandle,
    tab_id: &str,
    session: &SessionDefinition,
    recent_output: &str,
    state: &mut SshRuntimeGuidanceState,
) {
    if session.kind != "ssh" {
        return;
    }

    if !state.host_key_prompt
        && recent_output.contains("are you sure you want to continue connecting (yes/no")
    {
        state.host_key_prompt = true;
        emit_output(
            app,
            tab_id,
            "\r\n[information] SSH is asking to trust a new host key. Review the hostname and fingerprint, then type 'yes' in the terminal to store it in known_hosts. Type 'no' to abort.\r\n",
        );
    }

    if !state.host_key_changed
        && (recent_output.contains("remote host identification has changed")
            || recent_output.contains("host key verification failed"))
    {
        state.host_key_changed = true;
        emit_output(
            app,
            tab_id,
            "\r\n[error] The remote host key does not match your known_hosts entry. Verify the server first, then remove the stale key with ssh-keygen -R <host> before reconnecting.\r\n",
        );
    }

    if !state.auth_failed && looks_like_ssh_auth_failure(recent_output) {
        state.auth_failed = true;
        emit_output(
            app,
            tab_id,
            "\r\n[error] SSH authentication failed. Check the username, password/key selection, SSH agent state, and whether the remote server accepts that auth method.\r\n",
        );
    }

    if !state.key_permission_error
        && (recent_output.contains("unprotected private key file")
            || recent_output.contains("bad permissions"))
    {
        state.key_permission_error = true;
        emit_output(
            app,
            tab_id,
            "\r\n[error] The SSH private key file permissions are too open for OpenSSH. Restrict the key file and its parent .ssh directory, then retry.\r\n",
        );
    }

    if !state.connection_refused && recent_output.contains("connection refused") {
        state.connection_refused = true;
        emit_output(
            app,
            tab_id,
            "\r\n[error] The TCP connection was refused. Verify the SSH port, firewall rules, and that sshd is listening on the remote host.\r\n",
        );
    }

    if !state.timeout
        && (recent_output.contains("connection timed out")
            || recent_output.contains("operation timed out"))
    {
        state.timeout = true;
        emit_output(
            app,
            tab_id,
            "\r\n[error] The SSH connection timed out. Check the host/IP, VPN path, firewall, and whether the port is reachable from this machine.\r\n",
        );
    }

    if !state.host_unreachable
        && (recent_output.contains("no route to host")
            || recent_output.contains("network is unreachable"))
    {
        state.host_unreachable = true;
        emit_output(
            app,
            tab_id,
            "\r\n[error] The remote network is unreachable from this machine. Check routing, VPN state, and the target IP/hostname.\r\n",
        );
    }

    if !state.dns_error
        && (recent_output.contains("could not resolve hostname")
            || recent_output.contains("name or service not known")
            || recent_output.contains("temporary failure in name resolution"))
    {
        state.dns_error = true;
        emit_output(
            app,
            tab_id,
            "\r\n[error] DNS resolution failed for this SSH target. Verify the hostname spelling or switch the session to a direct IP address.\r\n",
        );
    }
}

pub(in crate::runtime) fn windows_credential_reuse_message() -> String {
    "OpenXTerm needs a saved password or a live interactive password from the active SSH tab to reuse this connection for status or linked SFTP. Keep the SSH tab connected, save a password, or use key/agent authentication.".into()
}

pub(in crate::runtime) fn humanize_ssh_error_message(
    error: &str,
    session: &SessionDefinition,
) -> String {
    let normalized = error.trim();
    let lower = normalized.to_ascii_lowercase();

    if lower.contains("could not resolve hostname")
        || lower.contains("name or service not known")
        || lower.contains("temporary failure in name resolution")
    {
        return format!(
            "DNS could not resolve {}. Verify the hostname spelling or use a direct IP address.",
            session.host
        );
    }
    if lower.contains("connection refused") {
        return format!(
            "The SSH connection to {}:{} was refused. Verify the port, firewall, and that sshd is running.",
            session.host, session.port
        );
    }
    if lower.contains("connection timed out") || lower.contains("operation timed out") {
        return format!(
            "The SSH connection to {}:{} timed out. Check reachability, VPN/firewall state, and the target port.",
            session.host, session.port
        );
    }
    if lower.contains("no route to host") || lower.contains("network is unreachable") {
        return format!(
            "The remote host {} is unreachable from this machine. Check routing, VPN state, and the target address.",
            session.host
        );
    }
    if lower.contains("permission denied") {
        return "SSH authentication failed. Check the username and whether the selected password, key, or agent credentials are valid.".into();
    }
    if lower.contains("remote host identification has changed")
        || lower.contains("host key verification failed")
    {
        return format!(
            "The SSH host key for {} no longer matches known_hosts. Verify the server first, then remove the stale key entry before reconnecting.",
            session.host
        );
    }
    if lower.contains("unprotected private key file") || lower.contains("bad permissions") {
        return "The SSH private key permissions are too open for OpenSSH. Restrict the key file and its parent .ssh directory, then retry.".into();
    }
    if lower.contains("agent admitted failure to sign")
        || lower.contains("no such identity")
        || lower.contains("sign_and_send_pubkey")
    {
        return "SSH key or agent authentication failed. Verify the key path, passphrase, and whether your SSH agent is loaded with the correct identity.".into();
    }

    normalized.to_string()
}

fn looks_like_ssh_auth_failure(recent_output: &str) -> bool {
    recent_output.contains("permission denied (")
        || recent_output.contains("permission denied, please try again")
        || recent_output.contains("authentication failed")
        || recent_output.contains("access denied")
}

fn looks_like_password_prompt(recent_output: &str) -> bool {
    let trimmed = recent_output.trim_end_matches(['\r', '\n']);
    trimmed.ends_with("password:")
        || trimmed.ends_with("password: ")
        || trimmed.ends_with("'s password:")
        || trimmed.contains("password for ")
}
