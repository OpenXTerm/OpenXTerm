use std::{fs, io::Read};

use std::time::Duration;

use libssh_rs::{
    Channel as LibsshChannel, Session as LibsshSession, Sftp as LibsshSftp, SshOption,
};

use crate::{models::SessionDefinition, proxy::configure_libssh_proxy_socket};

const EMBEDDED_SSH_TIMEOUT: Duration = Duration::from_secs(8);

use super::super::x11::X11ForwardConfig;
use super::super::{expand_tilde, shell_quote};
use super::{
    auth::{ssh_runtime_password, ssh_runtime_username, ssh_runtime_username_path_for_tab},
    guidance::{humanize_ssh_error_message, windows_credential_reuse_message},
};

pub(in crate::runtime) fn run_remote_ssh_script_with_label(
    session: &SessionDefinition,
    tab_id: &str,
    remote_script: &str,
    label: &str,
) -> Result<String, String> {
    let ssh = connect_embedded_ssh_session(session, Some(tab_id), label)?;
    let channel = ssh
        .new_channel()
        .map_err(|error| format!("failed to open SSH {label} channel: {error}"))?;
    channel
        .open_session()
        .map_err(|error| format!("failed to open SSH {label} session: {error}"))?;
    channel
        .request_exec(&format!("sh -lc {}", shell_quote(remote_script)))
        .map_err(|error| format!("failed to execute SSH {label}: {error}"))?;

    let mut stdout = String::new();
    channel
        .stdout()
        .read_to_string(&mut stdout)
        .map_err(|error| format!("failed to read SSH {label} output: {error}"))?;
    let mut stderr = String::new();
    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(|error| format!("failed to read SSH {label} error output: {error}"))?;
    channel
        .close()
        .map_err(|error| format!("failed to close SSH {label} channel: {error}"))?;

    let exit_status = channel
        .get_exit_status()
        .ok_or_else(|| format!("failed to read SSH {label} exit code"))?;
    if exit_status != 0 {
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("SSH {label} failed with exit code {exit_status}")
        } else {
            humanize_ssh_error_message(detail, session)
        });
    }

    Ok(stdout)
}

pub(in crate::runtime) fn open_embedded_ssh_channel(
    session: &SessionDefinition,
    username: &str,
    password_override: Option<&str>,
    terminal_size: (u16, u16),
    x11_config: Option<&X11ForwardConfig>,
) -> Result<(LibsshChannel, Option<String>), String> {
    let ssh = connect_embedded_ssh_session_with_username(
        session,
        username,
        password_override,
        "interactive session",
    )?;

    let channel = ssh
        .new_channel()
        .map_err(|error| format!("failed to create embedded SSH channel: {error}"))?;
    channel
        .open_session()
        .map_err(|error| format!("failed to open embedded SSH session channel: {error}"))?;
    channel
        .request_pty(
            "xterm-256color",
            terminal_size.0.max(2) as u32,
            terminal_size.1.max(2) as u32,
        )
        .map_err(|error| format!("failed to allocate embedded SSH PTY: {error}"))?;
    let _ = channel.request_env("TERM", "xterm-256color");
    let _ = channel.request_env("COLORTERM", "truecolor");
    let _ = channel.request_env("LANG", "C.UTF-8");
    let _ = channel.request_env("LC_CTYPE", "C.UTF-8");
    let x11_warning = if let Some(config) = x11_config {
        let request_result = channel.request_x11(
            false,
            config.auth_protocol.as_deref(),
            config.auth_cookie.as_deref(),
            config.screen_number,
        );

        match request_result {
            Ok(()) => None,
            Err(error) => Some(format!(
                "The SSH server rejected X11 forwarding for this session: {error}"
            )),
        }
    } else {
        None
    };
    channel
        .request_exec(&embedded_ssh_shell_command())
        .or_else(|_| channel.request_shell())
        .map_err(|error| format!("failed to start embedded SSH shell: {error}"))?;

    Ok((channel, x11_warning))
}

fn embedded_ssh_shell_command() -> String {
    let script = r#"
shell_base=$(basename "${SHELL:-sh}")
case "$shell_base" in
  bash)
    __oxt_cwd_probe='printf "\033]697;Dir=%s\a" "$PWD"'
    if [ -n "${PROMPT_COMMAND:-}" ]; then
      PROMPT_COMMAND="$__oxt_cwd_probe; $PROMPT_COMMAND"
    else
      PROMPT_COMMAND="$__oxt_cwd_probe"
    fi
    export PROMPT_COMMAND
    exec "${SHELL:-/bin/bash}" -i
    ;;
  sh|dash|ash|ksh)
    PS1='$(printf "\033]697;Dir=%s\a" "$PWD")'"${PS1:-$ }"
    export PS1
    exec "${SHELL:-/bin/sh}" -i
    ;;
  *)
    exec "${SHELL:-/bin/sh}" -i
    ;;
esac
"#;
    format!("sh -lc {}", shell_quote(script))
}

pub(in crate::runtime) fn should_retry_interactive_password(
    error: &str,
    session: &SessionDefinition,
) -> bool {
    if session.auth_type != "password"
        || session
            .password
            .as_deref()
            .filter(|value| !value.is_empty())
            .is_some()
    {
        return false;
    }

    let normalized = error.to_ascii_lowercase();
    normalized.contains("password authentication failed")
        || normalized.contains("authentication failed")
        || normalized.contains("access denied")
}

fn connect_embedded_ssh_session_with_username(
    session: &SessionDefinition,
    username: &str,
    password_override: Option<&str>,
    context: &str,
) -> Result<LibsshSession, String> {
    let ssh = LibsshSession::new()
        .map_err(|error| format!("failed to create embedded SSH {context}: {error}"))?;
    let host = session.host.trim();
    if host.is_empty() {
        return Err("SSH session requires a host or IP address.".into());
    }
    ssh.set_option(SshOption::Hostname(host.to_string()))
        .map_err(|error| format!("failed to configure embedded SSH host: {error}"))?;
    ssh.set_option(SshOption::Port(session.port))
        .map_err(|error| format!("failed to configure embedded SSH port: {error}"))?;
    ssh.set_option(SshOption::User(Some(username.to_string())))
        .map_err(|error| format!("failed to configure embedded SSH username: {error}"))?;
    ssh.set_option(SshOption::Timeout(EMBEDDED_SSH_TIMEOUT))
        .map_err(|error| format!("failed to configure embedded SSH timeout: {error}"))?;
    ssh.set_option(SshOption::KnownHosts(None))
        .map_err(|error| format!("failed to configure embedded SSH known_hosts path: {error}"))?;
    ssh.set_option(SshOption::GlobalKnownHosts(None))
        .map_err(|error| {
            format!("failed to configure embedded SSH global known_hosts path: {error}")
        })?;
    configure_libssh_proxy_socket(&ssh, session)?;
    ssh.connect().map_err(|error| {
        humanize_ssh_error_message(
            &format!("embedded SSH {context} connect failed: {error}"),
            session,
        )
    })?;

    match session.auth_type.as_str() {
        "password" => {
            let password = password_override
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    session
                        .password
                        .as_deref()
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                })
                .ok_or_else(windows_credential_reuse_message)?;
            ssh.userauth_password(None, Some(&password))
                .map_err(|error| {
                    humanize_ssh_error_message(
                        &format!("embedded SSH {context} password authentication failed: {error}"),
                        session,
                    )
                })?;
        }
        "key" => {
            let key_path = session
                .key_path
                .as_ref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!("embedded SSH {context} key authentication requires a key path")
                })?;
            let expanded = expand_tilde(key_path);
            let passphrase = password_override
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    session
                        .password
                        .as_deref()
                        .filter(|value| !value.is_empty())
                });
            ssh.userauth_public_key_auto(Some(&expanded), passphrase)
                .map_err(|error| {
                    humanize_ssh_error_message(
                        &format!("embedded SSH {context} key authentication failed: {error}"),
                        session,
                    )
                })?;
        }
        _ => {
            ssh.userauth_agent(Some(username)).map_err(|error| {
                humanize_ssh_error_message(
                    &format!("embedded SSH {context} agent authentication failed: {error}"),
                    session,
                )
            })?;
        }
    }

    Ok(ssh)
}

pub(crate) fn ssh_helper_tab_id<'a>(
    session: &'a SessionDefinition,
    runtime_tab_id: Option<&'a str>,
) -> Option<&'a str> {
    runtime_tab_id
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            session
                .linked_ssh_tab_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        })
}

pub(crate) fn ssh_helper_username(
    session: &SessionDefinition,
    runtime_tab_id: Option<&str>,
) -> Result<String, String> {
    let username = if session.username.trim().is_empty() {
        ssh_helper_tab_id(session, runtime_tab_id)
            .and_then(ssh_runtime_username)
            .or_else(|| {
                ssh_helper_tab_id(session, runtime_tab_id).and_then(|tab_id| {
                    fs::read_to_string(ssh_runtime_username_path_for_tab(tab_id))
                        .ok()
                        .map(|value| value.trim().to_string())
                })
            })
            .unwrap_or_default()
    } else {
        session.username.trim().to_string()
    };

    if username.is_empty() {
        return Err("waiting for SSH username".into());
    }

    Ok(username)
}

fn ssh_helper_password(
    session: &SessionDefinition,
    runtime_tab_id: Option<&str>,
) -> Option<String> {
    session
        .password
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| ssh_helper_tab_id(session, runtime_tab_id).and_then(ssh_runtime_password))
}

pub(crate) fn connect_embedded_ssh_session(
    session: &SessionDefinition,
    runtime_tab_id: Option<&str>,
    context: &str,
) -> Result<LibsshSession, String> {
    let username = ssh_helper_username(session, runtime_tab_id)?;
    let password = ssh_helper_password(session, runtime_tab_id);
    connect_embedded_ssh_session_with_username(session, &username, password.as_deref(), context)
}

pub(crate) fn open_embedded_sftp(
    session: &SessionDefinition,
    runtime_tab_id: Option<&str>,
    context: &str,
) -> Result<LibsshSftp, String> {
    let ssh = connect_embedded_ssh_session(session, runtime_tab_id, context)?;
    ssh.sftp()
        .map_err(|error| format!("failed to open embedded SSH SFTP subsystem: {error}"))
}
