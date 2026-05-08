use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter};

use crate::models::{SessionDefinition, SessionStatusPayload, SessionStatusSnapshot};

use super::{run_remote_ssh_script_with_label, status_scripts::remote_status_script};

#[cfg(windows)]
use super::status_scripts::windows_status_script;

const SESSION_STATUS_EVENT: &str = "openxterm://session-status";
const STATUS_POLL_INTERVAL: Duration = Duration::from_secs(1);
const STATUS_ERROR_AFTER_FAILURES: u32 = 5;

#[derive(Default)]
struct NetworkRateTracker {
    previous_rx_bytes: Option<f64>,
    previous_tx_bytes: Option<f64>,
    previous_at: Option<Instant>,
}

struct ParsedStatusOutput {
    snapshot: SessionStatusSnapshot,
    network_rx_bytes: Option<f64>,
    network_tx_bytes: Option<f64>,
}

pub(super) fn spawn_status_poller(
    app: AppHandle,
    tab_id: String,
    session: SessionDefinition,
    stop_flag: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut failed_polls = 0_u32;
        let mut network_rate_tracker = NetworkRateTracker::default();

        while !stop_flag.load(Ordering::Relaxed) {
            match fetch_session_status(&session, &tab_id, &mut network_rate_tracker) {
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
                                network_download: "--".into(),
                                network_upload: "--".into(),
                                network_download_bps: 0.0,
                                network_upload_bps: 0.0,
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
    network_rate_tracker: &mut NetworkRateTracker,
) -> Result<SessionStatusSnapshot, String> {
    match session.kind.as_str() {
        "local" => fetch_local_status(session, network_rate_tracker),
        "ssh" => fetch_ssh_status(session, tab_id, network_rate_tracker),
        _ => Err(format!("{} does not expose live status", session.kind)),
    }
}

fn fetch_ssh_status(
    session: &SessionDefinition,
    tab_id: &str,
    network_rate_tracker: &mut NetworkRateTracker,
) -> Result<SessionStatusSnapshot, String> {
    let stdout = run_remote_ssh_script(session, tab_id)?;
    let mut parsed_output = parse_status_output(&stdout, session);
    parsed_output.snapshot.mode = "live".into();
    apply_network_rate(&mut parsed_output, network_rate_tracker);
    Ok(parsed_output.snapshot)
}

fn run_remote_ssh_script(session: &SessionDefinition, tab_id: &str) -> Result<String, String> {
    run_remote_ssh_script_with_label(session, tab_id, remote_status_script(), "status probe")
}

fn fetch_local_status(
    session: &SessionDefinition,
    network_rate_tracker: &mut NetworkRateTracker,
) -> Result<SessionStatusSnapshot, String> {
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
    let mut parsed_output = parse_status_output(&stdout, session);
    parsed_output.snapshot.mode = "live".into();
    apply_network_rate(&mut parsed_output, network_rate_tracker);
    Ok(parsed_output.snapshot)
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

fn parse_status_output(stdout: &str, session: &SessionDefinition) -> ParsedStatusOutput {
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
        network_download: "unknown".into(),
        network_upload: "unknown".into(),
        network_download_bps: 0.0,
        network_upload_bps: 0.0,
        latency: "--".into(),
    };
    let mut network_rx_bytes = None;
    let mut network_tx_bytes = None;

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
            "network_download" => snapshot.network_download = value.to_string(),
            "network_upload" => snapshot.network_upload = value.to_string(),
            "network_download_bps" => {
                snapshot.network_download_bps = value.parse::<f64>().unwrap_or(0.0)
            }
            "network_upload_bps" => {
                snapshot.network_upload_bps = value.parse::<f64>().unwrap_or(0.0)
            }
            "network_rx_bytes" => network_rx_bytes = parse_network_counter(value),
            "network_tx_bytes" => network_tx_bytes = parse_network_counter(value),
            _ => {}
        }
    }

    ParsedStatusOutput {
        snapshot,
        network_rx_bytes,
        network_tx_bytes,
    }
}

fn parse_network_counter(value: &str) -> Option<f64> {
    let parsed = value.parse::<f64>().ok()?;
    if parsed.is_finite() && parsed >= 0.0 {
        Some(parsed)
    } else {
        None
    }
}

fn apply_network_rate(parsed_output: &mut ParsedStatusOutput, tracker: &mut NetworkRateTracker) {
    let now = Instant::now();
    let snapshot = &mut parsed_output.snapshot;
    let (Some(rx_bytes), Some(tx_bytes)) = (
        parsed_output.network_rx_bytes,
        parsed_output.network_tx_bytes,
    ) else {
        normalize_direct_network_rate(snapshot);
        return;
    };

    let mut download_bps = 0.0;
    let mut upload_bps = 0.0;

    if let (Some(previous_rx), Some(previous_tx), Some(previous_at)) = (
        tracker.previous_rx_bytes,
        tracker.previous_tx_bytes,
        tracker.previous_at,
    ) {
        let elapsed = now.duration_since(previous_at).as_secs_f64();
        if elapsed > 0.0 && rx_bytes >= previous_rx && tx_bytes >= previous_tx {
            download_bps = (rx_bytes - previous_rx) / elapsed;
            upload_bps = (tx_bytes - previous_tx) / elapsed;
        }
    }

    tracker.previous_rx_bytes = Some(rx_bytes);
    tracker.previous_tx_bytes = Some(tx_bytes);
    tracker.previous_at = Some(now);

    set_network_rate(snapshot, download_bps, upload_bps);
}

fn normalize_direct_network_rate(snapshot: &mut SessionStatusSnapshot) {
    let download_bps = snapshot.network_download_bps.max(0.0);
    let upload_bps = snapshot.network_upload_bps.max(0.0);
    set_network_rate(snapshot, download_bps, upload_bps);
}

fn set_network_rate(snapshot: &mut SessionStatusSnapshot, download_bps: f64, upload_bps: f64) {
    snapshot.network_download_bps = download_bps;
    snapshot.network_upload_bps = upload_bps;
    snapshot.network_download = format_network_rate(download_bps);
    snapshot.network_upload = format_network_rate(upload_bps);
    snapshot.network = format!(
        "↓ {} ↑ {}",
        snapshot.network_download, snapshot.network_upload
    );
}

fn format_network_rate(bytes_per_second: f64) -> String {
    if bytes_per_second >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1} GiB/s", bytes_per_second / (1024.0 * 1024.0 * 1024.0))
    } else if bytes_per_second >= 1024.0 * 1024.0 {
        format!("{:.1} MiB/s", bytes_per_second / (1024.0 * 1024.0))
    } else if bytes_per_second >= 1024.0 {
        format!("{:.1} KiB/s", bytes_per_second / 1024.0)
    } else {
        format!("{:.0} B/s", bytes_per_second)
    }
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

fn emit_status(app: &AppHandle, tab_id: &str, snapshot: SessionStatusSnapshot) {
    let _ = app.emit(
        SESSION_STATUS_EVENT,
        SessionStatusPayload {
            tab_id: tab_id.to_string(),
            snapshot,
        },
    );
}
