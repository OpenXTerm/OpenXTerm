use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    net::{Shutdown, TcpStream},
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

use super::{
    super::{emit_output, lock_embedded_ssh_channel},
    auth::{parse_x11_screen_number, resolve_x11_auth},
};

#[cfg(unix)]
use std::os::unix::net::UnixStream;
const X11_ACCEPT_TIMEOUT: Duration = Duration::from_millis(1);
const X11_PROXY_IDLE_SLEEP: Duration = Duration::from_millis(5);
const X11_PROXY_PENDING_LIMIT: usize = 4 * 1024 * 1024;
const SSH_LOOP_IDLE_SLEEP: Duration = Duration::from_millis(20);

#[derive(Clone)]
pub(in crate::runtime) struct X11ForwardConfig {
    pub(in crate::runtime) display: String,
    pub(in crate::runtime) auth_protocol: Option<String>,
    pub(in crate::runtime) auth_cookie: Option<String>,
    pub(in crate::runtime) screen_number: i32,
}

pub(in crate::runtime) fn prepare_x11_forwarding(
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

pub(in crate::runtime) fn spawn_x11_accept_loop(
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
