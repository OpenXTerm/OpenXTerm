use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use tauri::{AppHandle, Emitter};

use crate::models::{SessionDefinition, SessionStatusPayload, SessionStatusSnapshot};

use super::{run_remote_ssh_script_with_label, status_scripts::remote_status_script};

#[cfg(windows)]
use super::status_scripts::windows_status_script;

const SESSION_STATUS_EVENT: &str = "openxterm://session-status";
const STATUS_POLL_INTERVAL: Duration = Duration::from_secs(1);
const STATUS_ERROR_AFTER_FAILURES: u32 = 5;

pub(super) fn spawn_status_poller(
    app: AppHandle,
    tab_id: String,
    session: SessionDefinition,
    stop_flag: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut failed_polls = 0_u32;

        while !stop_flag.load(Ordering::Relaxed) {
            match fetch_session_status(&session, &tab_id) {
                Ok(snapshot) => {
                    failed_polls = 0;
                    emit_status(&app, &tab_id, snapshot);
                }
                Err(error) => {
                    if error.contains("waiting for SSH login")
                        || error.contains("waiting for SSH username")
                    {
                        thread::sleep(STATUS_POLL_INTERVAL);
                        continue;
                    }

                    failed_polls += 1;
                    if failed_polls >= STATUS_ERROR_AFTER_FAILURES {
                        emit_status(
                            &app,
                            &tab_id,
                            SessionStatusSnapshot {
                                mode: "error".into(),
                                host: status_error_host(&session),
                                user: status_error_user(&session),
                                remote_os: error,
                                uptime: "--".into(),
                                cpu_load: "--".into(),
                                memory_usage: "--".into(),
                                disk_usage: "--".into(),
                                network: "--".into(),
                                latency: "--".into(),
                            },
                        );
                    }
                }
            }

            if stop_flag.load(Ordering::Relaxed) {
                return;
            }
            thread::sleep(STATUS_POLL_INTERVAL);
        }
    });
}

pub(super) fn ssh_status_poller_supported(session: &SessionDefinition) -> bool {
    session.kind == "ssh"
}

fn fetch_session_status(
    session: &SessionDefinition,
    tab_id: &str,
) -> Result<SessionStatusSnapshot, String> {
    match session.kind.as_str() {
        "local" => fetch_local_status(session),
        "ssh" => fetch_ssh_status(session, tab_id),
        _ => Err(format!("{} does not expose live status", session.kind)),
    }
}

fn fetch_ssh_status(
    session: &SessionDefinition,
    tab_id: &str,
) -> Result<SessionStatusSnapshot, String> {
    let stdout = run_remote_ssh_script(session, tab_id)?;
    let mut parsed = parse_status_output(&stdout, session);
    parsed.mode = "live".into();
    parsed.latency = measure_latency(&session.host).unwrap_or_else(|_| "--".into());
    Ok(parsed)
}

fn run_remote_ssh_script(session: &SessionDefinition, tab_id: &str) -> Result<String, String> {
    run_remote_ssh_script_with_label(session, tab_id, remote_status_script(), "status probe")
}

fn fetch_local_status(session: &SessionDefinition) -> Result<SessionStatusSnapshot, String> {
    let output = local_status_command()
        .output()
        .map_err(|error| format!("failed to run local status probe: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "local status probe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parsed = parse_status_output(&stdout, session);
    parsed.mode = "live".into();
    parsed.latency = "local".into();
    Ok(parsed)
}

#[cfg(not(windows))]
fn local_status_command() -> std::process::Command {
    let mut command = std::process::Command::new("sh");
    command.args(["-lc", remote_status_script()]);
    command
}

#[cfg(windows)]
fn local_status_command() -> std::process::Command {
    let mut command = std::process::Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windows_status_script(),
    ]);
    command
}

fn parse_status_output(stdout: &str, session: &SessionDefinition) -> SessionStatusSnapshot {
    let mut snapshot = SessionStatusSnapshot {
        mode: "live".into(),
        host: status_error_host(session),
        user: status_error_user(session),
        remote_os: "unknown".into(),
        uptime: "unknown".into(),
        cpu_load: "unknown".into(),
        memory_usage: "unknown".into(),
        disk_usage: "unknown".into(),
        network: "unknown".into(),
        latency: "--".into(),
    };

    for line in stdout.lines() {
        let Some(payload) = line.strip_prefix("__OXT__") else {
            continue;
        };

        let mut parts = payload.splitn(2, '=');
        let key = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default().trim();

        match key {
            "hostname" => snapshot.host = value.to_string(),
            "user" => snapshot.user = value.to_string(),
            "remote_os" => snapshot.remote_os = value.to_string(),
            "uptime" => snapshot.uptime = value.to_string(),
            "cpu_load" => snapshot.cpu_load = value.to_string(),
            "memory_usage" => snapshot.memory_usage = value.to_string(),
            "disk_usage" => snapshot.disk_usage = value.to_string(),
            "network" => snapshot.network = value.to_string(),
            _ => {}
        }
    }

    snapshot
}

fn status_error_host(session: &SessionDefinition) -> String {
    if session.kind == "local" {
        std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("COMPUTERNAME"))
            .unwrap_or_else(|_| "local".into())
    } else {
        session.host.clone()
    }
}

fn status_error_user(session: &SessionDefinition) -> String {
    if session.kind == "local" {
        std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_else(|_| "local".into())
    } else {
        let username = session.username.trim();
        if username.is_empty() {
            "--".into()
        } else {
            username.into()
        }
    }
}

fn measure_latency(host: &str) -> Result<String, String> {
    let output = ping_command(host)
        .output()
        .map_err(|error| format!("failed to launch ping: {error}"))?;

    if !output.status.success() {
        return Err("ping failed".into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(time_index) = stdout.find("time=") else {
        return Err("ping time not found".into());
    };

    let latency = stdout[time_index + 5..]
        .split_whitespace()
        .next()
        .ok_or_else(|| "ping output malformed".to_string())?;

    Ok(format!("{latency} ms"))
}

#[cfg(windows)]
fn ping_command(host: &str) -> std::process::Command {
    let mut command = std::process::Command::new("ping");
    command.args(["-n", "1", host]);
    command
}

#[cfg(not(windows))]
fn ping_command(host: &str) -> std::process::Command {
    let mut command = std::process::Command::new("ping");
    command.args(["-c", "1", "-n", host]);
    command
}

fn emit_status(app: &AppHandle, tab_id: &str, snapshot: SessionStatusSnapshot) {
    let _ = app.emit(
        SESSION_STATUS_EVENT,
        SessionStatusPayload {
            tab_id: tab_id.to_string(),
            snapshot,
        },
    );
}
