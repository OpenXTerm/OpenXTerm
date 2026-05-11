use std::{fs, io::Read};

use std::time::Duration;

use libssh_rs::{
    AuthStatus, Channel as LibsshChannel, Session as LibsshSession, Sftp as LibsshSftp, SshOption,
};

use crate::{models::SessionDefinition, proxy::configure_libssh_proxy_socket};

const EMBEDDED_SSH_TIMEOUT: Duration = Duration::from_secs(8);
const LEGACY_RSA_PUBLIC_KEY_ACCEPTED_TYPES: &str =
    "ssh-rsa,rsa-sha2-512,rsa-sha2-256,ssh-ed25519,ecdsa-sha2-nistp521,ecdsa-sha2-nistp384,ecdsa-sha2-nistp256";

use super::super::x11::X11ForwardConfig;
use super::super::{expand_tilde, shell_quote};
use super::{
    auth::{ssh_runtime_password, ssh_runtime_username, ssh_runtime_username_path_for_tab},
    guidance::{humanize_ssh_error_message, windows_credential_reuse_message},
};

enum InteractiveShellRequest {
    Instrumented,
    Plain,
}

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

    match open_interactive_session_channel(
        &ssh,
        terminal_size,
        x11_config,
        InteractiveShellRequest::Instrumented,
    ) {
        Ok(channel) => Ok(channel),
        Err(instrumented_error) => open_interactive_session_channel(
            &ssh,
            terminal_size,
            x11_config,
            InteractiveShellRequest::Plain,
        )
        .map_err(|plain_error| {
            format!("{plain_error}; instrumented shell startup failed first: {instrumented_error}")
        }),
    }
}

fn open_interactive_session_channel(
    ssh: &LibsshSession,
    terminal_size: (u16, u16),
    x11_config: Option<&X11ForwardConfig>,
    shell_request: InteractiveShellRequest,
) -> Result<(LibsshChannel, Option<String>), String> {
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
    match shell_request {
        InteractiveShellRequest::Instrumented => {
            channel.request_exec(&embedded_ssh_shell_command())
        }
        InteractiveShellRequest::Plain => channel.request_shell(),
    }
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

fn should_retry_key_auth_with_legacy_rsa(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("publickey")
        && (normalized.contains("access denied")
            || normalized.contains("authentication failed")
            || normalized.contains("requestdenied")
            || normalized.contains("request denied"))
}

fn auth_status_error(method: &str, context: &str, status: AuthStatus) -> String {
    match status {
        AuthStatus::Denied => {
            format!("embedded SSH {context} {method} authentication was denied by the server")
        }
        AuthStatus::Partial => format!(
            "embedded SSH {context} {method} authentication only partially succeeded; the server requires another authentication step"
        ),
        AuthStatus::Info => format!(
            "embedded SSH {context} {method} authentication requires additional interactive information"
        ),
        AuthStatus::Again => format!(
            "embedded SSH {context} {method} authentication did not complete yet; retry is required"
        ),
        AuthStatus::Success => format!("embedded SSH {context} {method} authentication succeeded"),
    }
}

fn ensure_auth_success(
    status: AuthStatus,
    method: &str,
    context: &str,
    session: &SessionDefinition,
) -> Result<(), String> {
    if status == AuthStatus::Success {
        return Ok(());
    }

    Err(humanize_ssh_error_message(
        &auth_status_error(method, context, status),
        session,
    ))
}

fn userauth_public_key_auto_with_legacy_rsa_fallback(
    ssh: &LibsshSession,
    key_path: &str,
    passphrase: Option<&str>,
    context: &str,
    session: &SessionDefinition,
) -> Result<(), String> {
    match ssh.userauth_public_key_auto(Some(key_path), passphrase) {
        Ok(AuthStatus::Success) => Ok(()),
        Ok(status) => {
            if status != AuthStatus::Denied {
                return ensure_auth_success(status, "key", context, session);
            }

            ssh.set_option(SshOption::PublicKeyAcceptedTypes(
                LEGACY_RSA_PUBLIC_KEY_ACCEPTED_TYPES.into(),
            ))
            .map_err(|error| {
                humanize_ssh_error_message(
                    &format!(
                        "embedded SSH {context} failed to enable legacy ssh-rsa key signatures: {error}"
                    ),
                    session,
                )
            })?;

            ssh.userauth_public_key_auto(Some(key_path), passphrase)
                .map_err(|legacy_error| {
                    humanize_ssh_error_message(
                        &format!(
                            "embedded SSH {context} key authentication failed after enabling legacy ssh-rsa signatures: {legacy_error}. Initial status: {status:?}"
                        ),
                        session,
                    )
                })
                .and_then(|legacy_status| {
                    ensure_auth_success(legacy_status, "key", context, session)
                })
        }
        Err(initial_error) => {
            let initial_message = initial_error.to_string();
            if !should_retry_key_auth_with_legacy_rsa(&initial_message) {
                return Err(humanize_ssh_error_message(
                    &format!("embedded SSH {context} key authentication failed: {initial_message}"),
                    session,
                ));
            }

            ssh.set_option(SshOption::PublicKeyAcceptedTypes(
                LEGACY_RSA_PUBLIC_KEY_ACCEPTED_TYPES.into(),
            ))
            .map_err(|error| {
                humanize_ssh_error_message(
                    &format!(
                        "embedded SSH {context} failed to enable legacy ssh-rsa key signatures: {error}"
                    ),
                    session,
                )
            })?;

            ssh.userauth_public_key_auto(Some(key_path), passphrase)
                .map_err(|legacy_error| {
                    humanize_ssh_error_message(
                        &format!(
                            "embedded SSH {context} key authentication failed after enabling legacy ssh-rsa signatures: {legacy_error}. Initial failure: {initial_message}"
                        ),
                        session,
                    )
                })
                .and_then(|legacy_status| {
                    ensure_auth_success(legacy_status, "key", context, session)
                })
        }
    }
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
            let status = ssh
                .userauth_password(None, Some(&password))
                .map_err(|error| {
                    humanize_ssh_error_message(
                        &format!("embedded SSH {context} password authentication failed: {error}"),
                        session,
                    )
                })?;
            ensure_auth_success(status, "password", context, session)?;
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
            userauth_public_key_auto_with_legacy_rsa_fallback(
                &ssh, &expanded, passphrase, context, session,
            )?;
        }
        _ => {
            let status = ssh.userauth_agent(Some(username)).map_err(|error| {
                humanize_ssh_error_message(
                    &format!("embedded SSH {context} agent authentication failed: {error}"),
                    session,
                )
            })?;
            ensure_auth_success(status, "agent", context, session)?;
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

#[cfg(test)]
mod tests {
    use libssh_rs::AuthStatus;

    use super::{auth_status_error, should_retry_key_auth_with_legacy_rsa};

    #[test]
    fn retries_publickey_access_denied_with_legacy_rsa() {
        assert!(should_retry_key_auth_with_legacy_rsa(
            "RequestDenied: Access denied for 'publickey'. Authentication that can continue: publickey,password",
        ));
        assert!(should_retry_key_auth_with_legacy_rsa(
            "embedded SSH interactive session key authentication failed: authentication failed for publickey",
        ));
    }

    #[test]
    fn does_not_retry_unrelated_key_errors_with_legacy_rsa() {
        assert!(!should_retry_key_auth_with_legacy_rsa(
            "failed to read private key file: permission denied",
        ));
        assert!(!should_retry_key_auth_with_legacy_rsa(
            "password authentication failed",
        ));
    }

    #[test]
    fn auth_status_errors_explain_denied_and_partial_auth() {
        assert!(
            auth_status_error("key", "interactive session", AuthStatus::Denied)
                .contains("key authentication was denied")
        );
        assert!(
            auth_status_error("agent", "status probe", AuthStatus::Partial)
                .contains("requires another authentication step")
        );
    }
}
