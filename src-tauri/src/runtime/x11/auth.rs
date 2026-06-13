use std::{
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

#[cfg(target_os = "macos")]
use std::path::PathBuf;

const X11_COMMAND_TIMEOUT: Duration = Duration::from_millis(700);

pub(super) fn parse_x11_screen_number(display: &str) -> i32 {
    display
        .rsplit_once('.')
        .and_then(|(_, screen)| screen.parse::<i32>().ok())
        .unwrap_or(0)
}

pub(super) fn resolve_x11_auth(
    display: &str,
    stop_flag: &Arc<AtomicBool>,
) -> Result<Option<(String, String)>, String> {
    let Some(xauth) = resolve_xauth_binary() else {
        return Ok(None);
    };

    let mut candidates = Vec::new();
    if let Ok(output) = run_short_command(Command::new(&xauth).args(["list", display]), stop_flag) {
        if output.status.success() {
            candidates.extend(parse_xauth_lines(&String::from_utf8_lossy(&output.stdout)));
        }
    }

    if candidates.is_empty() {
        if let Ok(output) = run_short_command(Command::new(&xauth).arg("list"), stop_flag) {
            if output.status.success() {
                candidates.extend(parse_xauth_lines(&String::from_utf8_lossy(&output.stdout)));
            }
        }
    }

    Ok(candidates.into_iter().next())
}

fn run_short_command(
    command: &mut Command,
    stop_flag: &Arc<AtomicBool>,
) -> Result<std::process::Output, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start helper command: {error}"))?;
    let started = std::time::Instant::now();

    loop {
        if stop_flag.load(Ordering::Relaxed) || started.elapsed() >= X11_COMMAND_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("helper command timed out".into());
        }

        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("failed to collect helper command output: {error}"));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed while waiting for helper command: {error}"));
            }
        }
    }
}

fn parse_xauth_lines(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let parts = line.split_whitespace().collect::<Vec<_>>();
            if parts.len() < 3 {
                return None;
            }
            let protocol = parts[parts.len() - 2].trim();
            let cookie = parts[parts.len() - 1].trim();
            if protocol.is_empty() || cookie.is_empty() {
                None
            } else {
                Some((protocol.to_string(), cookie.to_string()))
            }
        })
        .collect()
}

fn resolve_xauth_binary() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let candidate = "/opt/X11/bin/xauth";
        if PathBuf::from(candidate).exists() {
            return Some(candidate.into());
        }
    }

    Some("xauth".into())
}
