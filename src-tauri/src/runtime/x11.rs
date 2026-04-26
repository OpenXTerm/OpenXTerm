use std::{
    collections::{HashMap, VecDeque},
    io::{self, Read, Write},
    net::{Shutdown, TcpStream},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use libssh_rs::{Channel as LibsshChannel, Error as LibsshError};
use tauri::AppHandle;

use crate::{models::SessionDefinition, platform::x11::resolve_local_x11_display};

use super::{emit_output, lock_embedded_ssh_channel, run_remote_ssh_script_with_label};

#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

const X11_ACCEPT_TIMEOUT: Duration = Duration::from_millis(1);
const X11_PROXY_IDLE_SLEEP: Duration = Duration::from_millis(5);
const X11_COMMAND_TIMEOUT: Duration = Duration::from_millis(700);
const X11_PROXY_PENDING_LIMIT: usize = 4 * 1024 * 1024;
const SSH_LOOP_IDLE_SLEEP: Duration = Duration::from_millis(20);

#[derive(Clone)]
pub(super) struct X11ForwardConfig {
    pub(super) display: String,
    pub(super) auth_protocol: Option<String>,
    pub(super) auth_cookie: Option<String>,
    pub(super) screen_number: i32,
}

pub(super) fn prepare_x11_forwarding(
    session: &SessionDefinition,
    stop_flag: &Arc<AtomicBool>,
) -> Result<Option<X11ForwardConfig>, String> {
    if !session.x11_forwarding {
        return Ok(None);
    }

    let display = resolve_local_x11_display(session.x11_display.as_deref())?;
    let screen_number = parse_x11_screen_number(&display);
    let auth = resolve_x11_auth(&display, stop_flag).unwrap_or_else(|error| {
        log::debug!("X11 auth lookup failed for {display}: {error}");
        None
    });

    Ok(Some(X11ForwardConfig {
        display,
        auth_protocol: auth.as_ref().map(|value| value.0.clone()),
        auth_cookie: auth.as_ref().map(|value| value.1.clone()),
        screen_number,
    }))
}

pub(super) fn spawn_x11_accept_loop(
    app: AppHandle,
    tab_id: String,
    session_channel: Arc<Mutex<LibsshChannel>>,
    config: X11ForwardConfig,
    stop_flag: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        while !stop_flag.load(Ordering::Relaxed) {
            let accepted = {
                let channel = lock_embedded_ssh_channel(&session_channel);
                channel.accept_x11(X11_ACCEPT_TIMEOUT)
            };

            let Some(x11_channel) = accepted else {
                thread::sleep(SSH_LOOP_IDLE_SLEEP);
                continue;
            };

            let app = app.clone();
            let tab_id = tab_id.clone();
            let config = config.clone();
            let stop_flag = stop_flag.clone();
            thread::spawn(move || {
                if let Err(error) = proxy_x11_channel(x11_channel, &config, &stop_flag) {
                    emit_output(
                        &app,
                        &tab_id,
                        &format!("\r\n[warning] X11 channel closed: {error}\r\n"),
                    );
                }
            });
        }
    });
}

pub(super) fn maybe_report_x11_forwarding_failure(
    app: &AppHandle,
    tab_id: &str,
    session: &SessionDefinition,
    chunk: &str,
    x11_failure_diagnosed: &Arc<AtomicBool>,
) {
    if session.kind != "ssh" || !session.x11_forwarding {
        return;
    }

    if x11_failure_diagnosed.load(Ordering::Relaxed) {
        return;
    }

    let normalized = chunk.to_ascii_lowercase();
    if normalized.contains("no matching fbconfigs")
        || normalized.contains("glxcreatecontext failed")
        || normalized.contains("glxbadcontext")
        || normalized.contains("could not create gl context")
        || normalized.contains("failed to load driver: swrast")
        || normalized.contains("glx without the glx_arb_create_context extension")
        || normalized.contains("apple-dri")
    {
        if x11_failure_diagnosed
            .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            emit_output(
                app,
                tab_id,
                "\r\n[information] X11 forwarding is active, but this remote app needs GLX/OpenGL support from the local X server. On macOS/XQuartz, indirect GLX is limited and GLX apps such as `glxgears` may still fail even after enabling `+iglx`. Prefer 2D X11 apps for forwarding, or launch Chromium with `--disable-gpu --use-gl=swiftshader`.\r\n",
            );
        }
        return;
    }

    let reason = if normalized.contains("x11 forwarding request failed on channel") {
        "The SSH server rejected the X11 forwarding request for this interactive session."
    } else if normalized.contains("missing x server or $display")
        || normalized.contains("cannot open display")
        || normalized.contains("can't open display")
        || normalized.contains("unable to open display")
    {
        "A remote GUI command could not find a usable DISPLAY. X11 forwarding is not active in this shell."
    } else {
        return;
    };

    if x11_failure_diagnosed
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }

    report_x11_forwarding_failure(app, tab_id, session, reason);
}

pub(super) fn report_x11_forwarding_failure(
    app: &AppHandle,
    tab_id: &str,
    session: &SessionDefinition,
    reason: &str,
) {
    if session.kind != "ssh" || !session.x11_forwarding {
        return;
    }

    emit_output(app, tab_id, &format!("\r\n[warning] {reason}\r\n"));

    let app = app.clone();
    let tab_id = tab_id.to_string();
    let session = session.clone();
    thread::spawn(move || {
        match diagnose_ssh_x11_failure(&session, &tab_id) {
            Ok(diagnostic) => emit_output(&app, &tab_id, &diagnostic),
            Err(error) => emit_output(
                &app,
                &tab_id,
                &format!(
                    "\r\n[information] OpenXTerm could not collect extra X11 diagnostics yet: {error}\r\n"
                ),
            ),
        }
    });
}

fn parse_x11_screen_number(display: &str) -> i32 {
    display
        .rsplit_once('.')
        .and_then(|(_, screen)| screen.parse::<i32>().ok())
        .unwrap_or(0)
}

fn resolve_x11_auth(
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

fn proxy_x11_channel(
    x11_channel: LibsshChannel,
    config: &X11ForwardConfig,
    stop_flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut local = connect_local_x11_display(&config.display)?;
    local.set_nonblocking(true)?;
    let mut remote_buffer = [0_u8; 16 * 1024];
    let mut local_buffer = [0_u8; 16 * 1024];
    let mut remote_to_local = VecDeque::<u8>::new();
    let mut local_to_remote = VecDeque::<u8>::new();

    while !stop_flag.load(Ordering::Relaxed) && !x11_channel.is_closed() && !x11_channel.is_eof() {
        let mut made_progress = false;

        made_progress |= write_pending_to_local_x11(&mut local, &mut remote_to_local)?;
        made_progress |= write_pending_to_ssh_x11(&x11_channel, &mut local_to_remote)?;

        if remote_to_local.len() < X11_PROXY_PENDING_LIMIT {
            match x11_channel.read_nonblocking(&mut remote_buffer, false) {
                Ok(0) => {
                    if x11_channel.is_closed() || x11_channel.is_eof() {
                        break;
                    }
                }
                Ok(size) => {
                    remote_to_local.extend(&remote_buffer[..size]);
                    made_progress = true;
                }
                Err(LibsshError::TryAgain) => {}
                Err(error) => return Err(format!("failed to read SSH X11 channel: {error}")),
            }
        }

        if local_to_remote.len() < X11_PROXY_PENDING_LIMIT {
            match local.read(&mut local_buffer) {
                Ok(0) => break,
                Ok(size) => {
                    local_to_remote.extend(&local_buffer[..size]);
                    made_progress = true;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(format!("failed to read local X11 display: {error}")),
            }
        }

        if !made_progress {
            thread::sleep(X11_PROXY_IDLE_SLEEP);
        }
    }

    let _ = x11_channel.close();
    local.shutdown();
    Ok(())
}

fn write_pending_to_local_x11(
    local: &mut LocalX11Stream,
    pending: &mut VecDeque<u8>,
) -> Result<bool, String> {
    let mut made_progress = false;

    while !pending.is_empty() {
        let (front, _) = pending.as_slices();
        if front.is_empty() {
            break;
        }

        match local.write(front) {
            Ok(0) => return Err("local X11 display stopped accepting data".into()),
            Ok(size) => {
                pending.drain(..size);
                made_progress = true;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                break;
            }
            Err(error) => return Err(format!("failed to write to local X11 display: {error}")),
        }
    }

    Ok(made_progress)
}

fn write_pending_to_ssh_x11(
    x11_channel: &LibsshChannel,
    pending: &mut VecDeque<u8>,
) -> Result<bool, String> {
    let mut made_progress = false;

    while !pending.is_empty() {
        let (front, _) = pending.as_slices();
        if front.is_empty() {
            break;
        }

        let write_result = {
            let mut stdin = x11_channel.stdin();
            stdin.write(front)
        };

        match write_result {
            Ok(0) => return Err("SSH X11 channel stopped accepting data".into()),
            Ok(size) => {
                pending.drain(..size);
                made_progress = true;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                break;
            }
            Err(error) => return Err(format!("failed to write to SSH X11 channel: {error}")),
        }
    }

    Ok(made_progress)
}

enum LocalX11Stream {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(UnixStream),
}

impl LocalX11Stream {
    fn set_nonblocking(&self, nonblocking: bool) -> Result<(), String> {
        match self {
            LocalX11Stream::Tcp(stream) => stream
                .set_nonblocking(nonblocking)
                .map_err(|error| format!("failed to configure local X11 TCP stream: {error}")),
            #[cfg(unix)]
            LocalX11Stream::Unix(stream) => stream
                .set_nonblocking(nonblocking)
                .map_err(|error| format!("failed to configure local X11 Unix stream: {error}")),
        }
    }

    fn shutdown(&self) {
        match self {
            LocalX11Stream::Tcp(stream) => {
                let _ = stream.shutdown(Shutdown::Both);
            }
            #[cfg(unix)]
            LocalX11Stream::Unix(stream) => {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
    }
}

impl Read for LocalX11Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            LocalX11Stream::Tcp(stream) => stream.read(buf),
            #[cfg(unix)]
            LocalX11Stream::Unix(stream) => stream.read(buf),
        }
    }
}

impl Write for LocalX11Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            LocalX11Stream::Tcp(stream) => stream.write(buf),
            #[cfg(unix)]
            LocalX11Stream::Unix(stream) => stream.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            LocalX11Stream::Tcp(stream) => stream.flush(),
            #[cfg(unix)]
            LocalX11Stream::Unix(stream) => stream.flush(),
        }
    }
}

fn connect_local_x11_display(display: &str) -> Result<LocalX11Stream, String> {
    #[cfg(unix)]
    {
        if display.starts_with('/') {
            return UnixStream::connect(display)
                .map(LocalX11Stream::Unix)
                .map_err(|error| format!("failed to connect to X11 display {display}: {error}"));
        }

        if let Some(display_number) = parse_x11_display_number(display) {
            if display.starts_with(':') || display.starts_with("unix:") {
                let path = format!("/tmp/.X11-unix/X{display_number}");
                return UnixStream::connect(&path)
                    .map(LocalX11Stream::Unix)
                    .map_err(|error| {
                        format!("failed to connect to local X11 socket {path}: {error}")
                    });
            }
        }
    }

    let (host, display_number) = parse_tcp_x11_display(display)?;
    let port = 6000 + display_number;
    TcpStream::connect((host.as_str(), port))
        .map(LocalX11Stream::Tcp)
        .map_err(|error| format!("failed to connect to local X11 display {host}:{port}: {error}"))
}

fn parse_tcp_x11_display(display: &str) -> Result<(String, u16), String> {
    if display.starts_with(':') {
        return Ok((
            "127.0.0.1".into(),
            parse_x11_display_number(display).unwrap_or(0),
        ));
    }

    let Some((host, rest)) = display.rsplit_once(':') else {
        return Err(format!("unsupported X11 DISPLAY value: {display}"));
    };
    let display_number = rest
        .split('.')
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| format!("unsupported X11 DISPLAY value: {display}"))?;
    let host = if host.trim().is_empty() {
        "127.0.0.1"
    } else {
        host.trim()
    };
    Ok((host.to_string(), display_number))
}

fn parse_x11_display_number(display: &str) -> Option<u16> {
    let rest = display.rsplit_once(':')?.1;
    rest.split('.').next()?.parse::<u16>().ok()
}

fn diagnose_ssh_x11_failure(session: &SessionDefinition, tab_id: &str) -> Result<String, String> {
    let remote_script = r#"
printf '__OXT__home=%s\n' "${HOME:-}"
printf '__OXT__user=%s\n' "${USER:-}"

if [ -n "${SSH_CONNECTION:-}" ]; then
  set -- $SSH_CONNECTION
  printf '__OXT__client_addr=%s\n' "$1"
fi

if command -v xauth >/dev/null 2>&1; then
  printf '__OXT__xauth=%s\n' "$(command -v xauth)"
else
  printf '__OXT__xauth=missing\n'
fi

if command -v sshd >/dev/null 2>&1; then
  sshd -T 2>/dev/null | awk '
    /^x11forwarding / { print "__OXT__x11forwarding=" $2 }
    /^xauthlocation / { print "__OXT__xauthlocation=" $2 }
    /^x11uselocalhost / { print "__OXT__x11uselocalhost=" $2 }
    /^addressfamily / { print "__OXT__addressfamily=" $2 }
  '
fi

if command -v sshd >/dev/null 2>&1 && [ -n "${USER:-}" ] && [ -n "${SSH_CONNECTION:-}" ]; then
  set -- $SSH_CONNECTION
  client_addr="$1"
  match_host="$(hostname -f 2>/dev/null || hostname 2>/dev/null || printf '%s' unknown)"
  sshd -T -C user="$USER",host="$match_host",addr="$client_addr" 2>/dev/null | awk '
    /^x11forwarding / { print "__OXT__match_x11forwarding=" $2 }
    /^xauthlocation / { print "__OXT__match_xauthlocation=" $2 }
    /^x11uselocalhost / { print "__OXT__match_x11uselocalhost=" $2 }
    /^addressfamily / { print "__OXT__match_addressfamily=" $2 }
  '
fi

if [ -n "${HOME:-}" ]; then
  if [ -d "$HOME" ]; then
    printf '__OXT__home_dir=yes\n'
  else
    printf '__OXT__home_dir=no\n'
  fi

  if [ -w "$HOME" ]; then
    printf '__OXT__home_writable=yes\n'
  else
    printf '__OXT__home_writable=no\n'
  fi

  if [ -e "$HOME/.Xauthority" ]; then
    printf '__OXT__xauthority_exists=yes\n'
    if [ -w "$HOME/.Xauthority" ]; then
      printf '__OXT__xauthority_writable=yes\n'
    else
      printf '__OXT__xauthority_writable=no\n'
    fi
  else
    printf '__OXT__xauthority_exists=no\n'
  fi
fi

if command -v xauth >/dev/null 2>&1 && [ -n "${HOME:-}" ]; then
  probe="$HOME/.Xauthority.openxterm-probe.$$"
  if XAUTHORITY="$probe" xauth add localhost/unix:99 MIT-MAGIC-COOKIE-1 0123456789abcdef0123456789abcdef >/dev/null 2>&1; then
    printf '__OXT__xauth_write_test=ok\n'
  else
    printf '__OXT__xauth_write_test=failed\n'
  fi
  rm -f "$probe" >/dev/null 2>&1
fi

if [ -r /proc/sys/net/ipv6/conf/all/disable_ipv6 ]; then
  printf '__OXT__ipv6_disabled=%s\n' "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null)"
fi
"#;
    let stdout =
        run_remote_ssh_script_with_label(session, tab_id, remote_script, "X11 diagnostic")?;
    let mut facts = HashMap::<String, String>::new();
    for line in stdout.lines() {
        let Some(payload) = line.strip_prefix("__OXT__") else {
            continue;
        };
        let mut parts = payload.splitn(2, '=');
        let key = parts.next().unwrap_or_default().trim();
        let value = parts.next().unwrap_or_default().trim();
        if !key.is_empty() {
            facts.insert(key.to_string(), value.to_string());
        }
    }

    let xauth = facts
        .get("xauth")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let x11forwarding = facts
        .get("x11forwarding")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let xauthlocation = facts
        .get("xauthlocation")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let x11uselocalhost = facts
        .get("x11uselocalhost")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let addressfamily = facts
        .get("addressfamily")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let match_x11forwarding = facts
        .get("match_x11forwarding")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let match_xauthlocation = facts
        .get("match_xauthlocation")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let match_x11uselocalhost = facts
        .get("match_x11uselocalhost")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let match_addressfamily = facts
        .get("match_addressfamily")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let home = facts
        .get("home")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let user = facts
        .get("user")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let client_addr = facts
        .get("client_addr")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let home_dir = facts
        .get("home_dir")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let home_writable = facts
        .get("home_writable")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let xauthority_exists = facts
        .get("xauthority_exists")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let xauthority_writable = facts
        .get("xauthority_writable")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let xauth_write_test = facts
        .get("xauth_write_test")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let ipv6_disabled = facts
        .get("ipv6_disabled")
        .cloned()
        .unwrap_or_else(|| "unknown".into());

    let guidance = if xauth == "missing" {
        "Remote `xauth` is missing from PATH. sshd usually needs a working `xauth` binary to set up X11 forwarding."
            .to_string()
    } else if match_x11forwarding == "no" {
        format!(
            "The effective sshd config for user `{user}` from client `{client_addr}` resolves to `X11Forwarding no`. This usually means a `Match` block is overriding the global setting."
        )
    } else if x11forwarding == "no" {
        "Remote sshd reports `X11Forwarding no`. Enable X11 forwarding in `sshd_config` and reload the SSH service."
            .to_string()
    } else if home_dir == "no" {
        format!(
            "Remote HOME `{home}` does not resolve to a usable directory. sshd often needs a valid HOME to create or update X11 auth data."
        )
    } else if home_writable == "no" {
        format!(
            "Remote HOME `{home}` is not writable for this login. That often prevents sshd/xauth from updating `~/.Xauthority`."
        )
    } else if xauthority_exists == "yes" && xauthority_writable == "no" {
        format!(
            "Remote `~/.Xauthority` exists but is not writable in `{home}`. Fix its ownership/permissions and retry X11 forwarding."
        )
    } else if xauth_write_test == "failed" {
        format!(
            "Remote `xauth` is installed, but a probe write in `{home}` failed. This usually means a permissions, HOME, or xauth runtime problem on the server side."
        )
    } else if (match_x11uselocalhost == "yes" || x11uselocalhost == "yes")
        && (match_addressfamily == "any" || addressfamily == "any")
        && ipv6_disabled == "1"
    {
        "The server keeps X11 on localhost with `AddressFamily any`, but IPv6 is disabled. That combination is known to break X11 forwarding on some OpenSSH setups; try `AddressFamily inet` or `X11UseLocalhost no` on the server, then start a brand-new SSH session."
            .to_string()
    } else {
        format!(
            "Remote sshd reports `X11Forwarding {x11forwarding}`, `XAuthLocation {xauthlocation}`, `X11UseLocalhost {x11uselocalhost}`, `AddressFamily {addressfamily}` and the HOME/xauth probe did not find a simple file-permission problem. The next likely source is an sshd match rule, address-family bind issue, or server-side sshd/PAM logging around X11 setup. Any `sshd_config` change only affects brand-new SSH logins; the current shell will not gain DISPLAY retroactively."
        )
    };

    Ok(format!(
        "\r\n[information] X11 diagnostic: remote xauth={xauth}; sshd x11forwarding={x11forwarding}; sshd xauthlocation={xauthlocation}; sshd x11uselocalhost={x11uselocalhost}; sshd addressfamily={addressfamily}; effective x11forwarding={match_x11forwarding}; effective xauthlocation={match_xauthlocation}; effective x11uselocalhost={match_x11uselocalhost}; effective addressfamily={match_addressfamily}; user={user}; client_addr={client_addr}; home={home}; home_dir={home_dir}; home_writable={home_writable}; xauthority_exists={xauthority_exists}; xauthority_writable={xauthority_writable}; xauth_write_test={xauth_write_test}; ipv6_disabled={ipv6_disabled}.\r\n[information] {guidance}\r\n"
    ))
}
