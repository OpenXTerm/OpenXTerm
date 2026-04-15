use std::{
    collections::HashMap,
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    io::{self, BufReader, Read, Write},
    net::{Shutdown, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serialport::{DataBits, Parity, StopBits};
use tauri::{AppHandle, Emitter};

use crate::models::{
    SessionDefinition, SessionStatusPayload, SessionStatusSnapshot, TerminalExitPayload,
    TerminalOutputPayload,
};
use crate::x11_support::resolve_local_x11_display;

const TERMINAL_OUTPUT_EVENT: &str = "openxterm://terminal-output";
const TERMINAL_EXIT_EVENT: &str = "openxterm://terminal-exit";
const SESSION_STATUS_EVENT: &str = "openxterm://session-status";
const DEFAULT_COLS: u16 = 140;
const DEFAULT_ROWS: u16 = 40;
const STATUS_POLL_INTERVAL: Duration = Duration::from_secs(1);
const STATUS_ERROR_AFTER_FAILURES: u32 = 5;
const TELNET_IAC: u8 = 255;
const TELNET_DONT: u8 = 254;
const TELNET_DO: u8 = 253;
const TELNET_WONT: u8 = 252;
const TELNET_WILL: u8 = 251;
const TELNET_SB: u8 = 250;
const TELNET_SE: u8 = 240;
const SSH_CONTROL_DIR: &str = "oxt-ssh";

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type ResizeHandler = Box<dyn Fn(u16, u16) -> Result<(), String> + Send + Sync>;
type StopHandler = Box<dyn Fn() + Send + Sync>;

pub struct AppRuntime {
    terminals: Arc<Mutex<HashMap<String, ActiveTerminal>>>,
}

struct ActiveTerminal {
    writer: SharedWriter,
    resize: ResizeHandler,
    stop: StopHandler,
    stop_flag: Arc<AtomicBool>,
}

impl Default for AppRuntime {
    fn default() -> Self {
        Self {
            terminals: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl AppRuntime {
    pub fn start_local_session(
        &self,
        app: &AppHandle,
        tab_id: String,
        session: SessionDefinition,
    ) -> Result<bool, String> {
        if session.kind != "local" {
            return Ok(false);
        }

        let (command, shell_label) = build_local_shell_command();
        self.start_pty_session(
            app,
            tab_id,
            session,
            command,
            true,
            format!("\r\n[information] Launching local shell: {shell_label}\r\n"),
            Some("\r\n[information] Native local terminal backend is active.\r\n"),
            "Local terminal closed.".into(),
        )
    }

    pub fn start_ssh_session(
        &self,
        app: &AppHandle,
        tab_id: String,
        session: SessionDefinition,
    ) -> Result<bool, String> {
        if session.kind != "ssh" {
            return Ok(false);
        }

        prepare_ssh_control_socket(&tab_id)?;
        let control_path = ssh_control_path_for_tab(&tab_id);
        let username_missing = session.username.trim().is_empty();
        let password_handler_enabled = session.auth_type == "password" && !username_missing;
        let (command, x11_display) = build_interactive_ssh_command(&session, &control_path)?;
        let x11_notice = x11_display.as_ref().map(|display| {
            format!(
                "\r\n[information] SSH launch plan: X11 {} requested via DISPLAY={display} ({})\r\n",
                if session.x11_trusted { "-Y" } else { "-X" },
                if session.x11_trusted {
                    "trusted"
                } else {
                    "untrusted"
                }
            )
        });
        let x11_disabled_notice = if !session.x11_forwarding {
            Some(
                "\r\n[information] SSH launch plan: X11 forwarding is disabled in this profile. Enable it in the session editor before launching GUI apps.\r\n"
                    .to_string(),
            )
        } else {
            None
        };
        let notice_message = match (
            x11_notice.or(x11_disabled_notice),
            if password_handler_enabled {
                Some("\r\n[information] Password prompt handler armed. Waiting for remote auth challenge...\r\n".to_string())
            } else if username_missing {
                Some("\r\n[information] Interactive login mode is active. Username and password will be entered in the terminal.\r\n".to_string())
            } else {
                None
            },
        ) {
            (Some(x11), Some(auth)) => Some(format!("{x11}{auth}")),
            (Some(x11), None) => Some(x11),
            (None, Some(auth)) => Some(auth),
            (None, None) => None,
        };

        self.start_pty_session(
      app,
      tab_id,
      session.clone(),
      command,
      true,
      if username_missing {
        format!(
          "\r\n[information] Launching SSH transport to {}:{}\r\n[information] No username is saved in this profile. Enter the remote login in the terminal.\r\n",
          session.host, session.port
        )
      } else {
        "\r\n[information] Launching SSH transport".into()
      },
      notice_message.as_deref(),
      "SSH session closed.".into(),
    )
    }

    pub fn start_telnet_session(
        &self,
        app: &AppHandle,
        tab_id: String,
        session: SessionDefinition,
    ) -> Result<bool, String> {
        if session.kind != "telnet" {
            return Ok(false);
        }
        if session.host.trim().is_empty() {
            return Err("telnet session requires a host".into());
        }

        self.stop_terminal(&tab_id)?;

        let stream =
            TcpStream::connect((session.host.as_str(), session.port)).map_err(|error| {
                format!(
                    "failed to connect to {}:{}: {error}",
                    session.host, session.port
                )
            })?;
        stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .map_err(|error| format!("failed to configure TELNET read timeout: {error}"))?;
        let writer_stream = stream
            .try_clone()
            .map_err(|error| format!("failed to clone TELNET stream: {error}"))?;
        let shutdown_stream = writer_stream
            .try_clone()
            .map_err(|error| format!("failed to clone TELNET shutdown stream: {error}"))?;

        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(TelnetWriter::new(writer_stream))));
        let stop_flag = Arc::new(AtomicBool::new(false));

        spawn_telnet_reader(
            app.clone(),
            self.terminals.clone(),
            tab_id.clone(),
            stream,
            writer.clone(),
            session.clone(),
            stop_flag.clone(),
        );

        self.terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_string())?
            .insert(
                tab_id.clone(),
                ActiveTerminal {
                    writer,
                    resize: Box::new(|_, _| Ok(())),
                    stop: Box::new(move || {
                        let _ = shutdown_stream.shutdown(Shutdown::Both);
                    }),
                    stop_flag,
                },
            );

        emit_output(
            app,
            &tab_id,
            &format!(
                "\r\n[information] Launching TELNET transport to {}:{}\r\n",
                session.host, session.port
            ),
        );
        emit_output(
            app,
            &tab_id,
            "\r\n[information] Native TELNET negotiation is active.\r\n",
        );

        Ok(true)
    }

    pub fn start_serial_session(
        &self,
        app: &AppHandle,
        tab_id: String,
        session: SessionDefinition,
    ) -> Result<bool, String> {
        if session.kind != "serial" {
            return Ok(false);
        }

        let serial_port = session
            .serial_port
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "serial session requires a serial port path".to_string())?;
        let baud_rate = session.baud_rate.unwrap_or(115200);

        self.stop_terminal(&tab_id)?;

        let port = serialport::new(&serial_port, baud_rate)
            .parity(map_parity(&session.parity))
            .stop_bits(map_stop_bits(session.stop_bits))
            .data_bits(map_data_bits(session.data_bits))
            .timeout(Duration::from_millis(200))
            .open()
            .map_err(|error| format!("failed to open serial port {serial_port}: {error}"))?;
        let reader = port
            .try_clone()
            .map_err(|error| format!("failed to clone serial port {serial_port}: {error}"))?;

        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(port)));
        let stop_flag = Arc::new(AtomicBool::new(false));

        spawn_serial_reader(
            app.clone(),
            self.terminals.clone(),
            tab_id.clone(),
            reader,
            stop_flag.clone(),
        );

        self.terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_string())?
            .insert(
                tab_id.clone(),
                ActiveTerminal {
                    writer,
                    resize: Box::new(|_, _| Ok(())),
                    stop: Box::new(|| {}),
                    stop_flag,
                },
            );

        emit_output(
            app,
            &tab_id,
            &format!(
                "\r\n[information] Launching SERIAL transport on {} at {} baud\r\n",
                serial_port, baud_rate
            ),
        );
        emit_output(
            app,
            &tab_id,
            "\r\n[information] Native serial backend is active.\r\n",
        );

        Ok(true)
    }

    pub fn send_input(&self, tab_id: &str, data: &str) -> Result<(), String> {
        let writer = {
            let terminals = self
                .terminals
                .lock()
                .map_err(|_| "terminal registry is poisoned".to_string())?;

            let terminal = terminals
                .get(tab_id)
                .ok_or_else(|| "terminal is not running".to_string())?;

            terminal.writer.clone()
        };

        let mut writer = writer
            .lock()
            .map_err(|_| "terminal writer is poisoned".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("failed to write terminal input: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("failed to flush terminal input: {error}"))
    }

    pub fn resize_terminal(&self, tab_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let terminals = self
            .terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_string())?;

        let terminal = terminals
            .get(tab_id)
            .ok_or_else(|| "terminal is not running".to_string())?;

        (terminal.resize)(cols, rows)
    }

    pub fn stop_terminal(&self, tab_id: &str) -> Result<(), String> {
        let terminal = self
            .terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_string())?
            .remove(tab_id);

        if let Some(terminal) = terminal {
            terminal.stop_flag.store(true, Ordering::Relaxed);
            (terminal.stop)();
        }

        cleanup_ssh_control_socket(tab_id);
        Ok(())
    }

    fn start_pty_session(
        &self,
        app: &AppHandle,
        tab_id: String,
        session: SessionDefinition,
        command: CommandBuilder,
        with_status_poller: bool,
        launch_message: String,
        notice_message: Option<&str>,
        exit_reason: String,
    ) -> Result<bool, String> {
        self.stop_terminal(&tab_id)?;

        let pty_system = NativePtySystem::default();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("failed to create PTY: {error}"))?;

        let child = pty_pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("failed to launch transport: {error}"))?;

        let reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("failed to create PTY reader: {error}"))?;
        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|error| format!("failed to create PTY writer: {error}"))?;

        let writer: SharedWriter = Arc::new(Mutex::new(writer));
        let master = Arc::new(Mutex::new(pty_pair.master));
        let child = Arc::new(Mutex::new(child));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let password_sent = Arc::new(AtomicBool::new(false));
        let x11_failure_diagnosed = Arc::new(AtomicBool::new(false));

        spawn_pty_reader(
            app.clone(),
            tab_id.clone(),
            reader,
            writer.clone(),
            session.clone(),
            password_sent,
            x11_failure_diagnosed,
            stop_flag.clone(),
        );

        if with_status_poller {
            spawn_status_poller(
                app.clone(),
                tab_id.clone(),
                session.clone(),
                stop_flag.clone(),
            );
        }

        spawn_pty_exit_watcher(
            app.clone(),
            self.terminals.clone(),
            tab_id.clone(),
            child.clone(),
            stop_flag.clone(),
            exit_reason,
        );

        self.terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_string())?
            .insert(
                tab_id.clone(),
                ActiveTerminal {
                    writer,
                    resize: Box::new(move |cols, rows| {
                        let master = master
                            .lock()
                            .map_err(|_| "terminal master is poisoned".to_string())?;
                        master
                            .resize(PtySize {
                                rows: rows.max(2),
                                cols: cols.max(2),
                                pixel_width: 0,
                                pixel_height: 0,
                            })
                            .map_err(|error| format!("failed to resize PTY: {error}"))
                    }),
                    stop: Box::new(move || {
                        if let Ok(mut child) = child.lock() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }),
                    stop_flag,
                },
            );

        emit_output(app, &tab_id, &launch_message);
        if let Some(notice_message) = notice_message {
            emit_output(app, &tab_id, notice_message);
        }

        Ok(true)
    }
}

fn spawn_pty_reader<R>(
    app: AppHandle,
    tab_id: String,
    reader: R,
    writer: SharedWriter,
    session: SessionDefinition,
    password_sent: Arc<AtomicBool>,
    x11_failure_diagnosed: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buffer = [0_u8; 4096];
        let mut recent_output = String::new();

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let chunk = String::from_utf8_lossy(&buffer[..size]).to_string();
                    emit_output(&app, &tab_id, &chunk);
                    handle_password_prompt(
                        &app,
                        &tab_id,
                        &writer,
                        &session,
                        &password_sent,
                        &mut recent_output,
                        &chunk,
                    );
                    maybe_report_x11_forwarding_failure(
                        &app,
                        &tab_id,
                        &session,
                        &chunk,
                        &x11_failure_diagnosed,
                    );
                }
                Err(error) => {
                    emit_output(
                        &app,
                        &tab_id,
                        &format!("\r\n[error] terminal stream failure: {error}\r\n"),
                    );
                    break;
                }
            }

            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
        }
    });
}

fn spawn_telnet_reader(
    app: AppHandle,
    terminals: Arc<Mutex<HashMap<String, ActiveTerminal>>>,
    tab_id: String,
    mut stream: TcpStream,
    writer: SharedWriter,
    session: SessionDefinition,
    stop_flag: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        let mut leftover = Vec::new();
        let mut recent_output = String::new();
        let password_sent = Arc::new(AtomicBool::new(false));

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            match stream.read(&mut buffer) {
                Ok(0) => {
                    finalize_terminal(
                        &app,
                        &terminals,
                        &tab_id,
                        &stop_flag,
                        None,
                        "TELNET session closed.".into(),
                    );
                    break;
                }
                Ok(size) => {
                    let mut raw = std::mem::take(&mut leftover);
                    raw.extend_from_slice(&buffer[..size]);
                    let (display, replies, rest) = process_telnet_bytes(&raw);
                    leftover = rest;

                    if !replies.is_empty() {
                        if let Ok(mut writer) = writer.lock() {
                            let _ = writer.write_all(&replies);
                            let _ = writer.flush();
                        }
                    }

                    if !display.is_empty() {
                        let chunk = String::from_utf8_lossy(&display).to_string();
                        emit_output(&app, &tab_id, &chunk);
                        handle_password_prompt(
                            &app,
                            &tab_id,
                            &writer,
                            &session,
                            &password_sent,
                            &mut recent_output,
                            &chunk,
                        );
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(error) => {
                    emit_output(
                        &app,
                        &tab_id,
                        &format!("\r\n[error] TELNET stream failure: {error}\r\n"),
                    );
                    finalize_terminal(
                        &app,
                        &terminals,
                        &tab_id,
                        &stop_flag,
                        None,
                        error.to_string(),
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_serial_reader(
    app: AppHandle,
    terminals: Arc<Mutex<HashMap<String, ActiveTerminal>>>,
    tab_id: String,
    mut reader: Box<dyn serialport::SerialPort>,
    stop_flag: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            match reader.read(&mut buffer) {
                Ok(size) if size > 0 => {
                    let chunk = String::from_utf8_lossy(&buffer[..size]).to_string();
                    emit_output(&app, &tab_id, &chunk);
                }
                Ok(_) => continue,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(error) => {
                    emit_output(
                        &app,
                        &tab_id,
                        &format!("\r\n[error] SERIAL stream failure: {error}\r\n"),
                    );
                    finalize_terminal(
                        &app,
                        &terminals,
                        &tab_id,
                        &stop_flag,
                        None,
                        error.to_string(),
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_pty_exit_watcher(
    app: AppHandle,
    terminals: Arc<Mutex<HashMap<String, ActiveTerminal>>>,
    tab_id: String,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    stop_flag: Arc<AtomicBool>,
    exit_reason: String,
) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));

        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        let status = {
            let mut child = match child.lock() {
                Ok(child) => child,
                Err(_) => break,
            };

            match child.try_wait() {
                Ok(Some(status)) => Some(Ok(status.exit_code())),
                Ok(None) => None,
                Err(error) => Some(Err(error.to_string())),
            }
        };

        match status {
            None => continue,
            Some(Ok(code)) => {
                finalize_terminal(
                    &app,
                    &terminals,
                    &tab_id,
                    &stop_flag,
                    Some(code as i32),
                    exit_reason.clone(),
                );
                break;
            }
            Some(Err(reason)) => {
                finalize_terminal(&app, &terminals, &tab_id, &stop_flag, None, reason);
                break;
            }
        }
    });
}

fn spawn_status_poller(
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
    let output = run_ssh_control_command(session, tab_id, remote_status_script())
        .map_err(|error| format!("failed to launch SSH status probe: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "SSH status probe failed".into()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parsed = parse_status_output(&stdout, session);
    parsed.mode = "live".into();
    parsed.latency = measure_latency(&session.host).unwrap_or_else(|_| "--".into());
    Ok(parsed)
}

fn run_ssh_control_command(
    session: &SessionDefinition,
    tab_id: &str,
    remote_script: &str,
) -> Result<std::process::Output, String> {
    let control_path = ssh_control_path_for_tab(tab_id);
    if !control_path.exists() {
        return Err("waiting for SSH login".into());
    }

    let target = ssh_status_target(session, tab_id)?;
    std::process::Command::new("ssh")
        .arg("-S")
        .arg(&control_path)
        .arg("-x")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ControlMaster=no")
        .arg("-o")
        .arg("NumberOfPasswordPrompts=0")
        .arg("-o")
        .arg("LogLevel=ERROR")
        .arg("-p")
        .arg(session.port.to_string())
        .arg(target)
        .arg("sh")
        .arg("-lc")
        .arg(shell_quote(remote_script))
        .output()
        .map_err(|error| format!("failed to execute SSH control command: {error}"))
}

fn ssh_status_target(session: &SessionDefinition, tab_id: &str) -> Result<String, String> {
    let username = if session.username.trim().is_empty() {
        fs::read_to_string(ssh_control_user_path_for_tab(tab_id))
            .map_err(|_| "waiting for SSH username".to_string())?
            .trim()
            .to_string()
    } else {
        session.username.trim().to_string()
    };

    if username.is_empty() {
        return Err("waiting for SSH username".into());
    }

    Ok(format!("{}@{}", username, session.host))
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

fn handle_password_prompt(
    app: &AppHandle,
    tab_id: &str,
    writer: &SharedWriter,
    session: &SessionDefinition,
    password_sent: &Arc<AtomicBool>,
    recent_output: &mut String,
    chunk: &str,
) {
    if session.auth_type != "password"
        || !matches!(session.kind.as_str(), "ssh" | "telnet")
        || session.username.trim().is_empty()
        || password_sent.load(Ordering::Relaxed)
    {
        return;
    }

    recent_output.push_str(&chunk.to_ascii_lowercase());
    if recent_output.len() > 512 {
        let drain_len = recent_output.len() - 512;
        recent_output.drain(..drain_len);
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

fn maybe_report_x11_forwarding_failure(
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

    if !chunk
        .to_ascii_lowercase()
        .contains("x11 forwarding request failed on channel")
    {
        return;
    }

    if x11_failure_diagnosed
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }

    emit_output(
        app,
        tab_id,
        "\r\n[warning] The SSH server rejected the X11 forwarding request for this interactive session.\r\n",
    );

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
    let output = run_ssh_control_command(session, tab_id, remote_script)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "diagnostic SSH command failed".into()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
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

fn finalize_terminal(
    app: &AppHandle,
    terminals: &Arc<Mutex<HashMap<String, ActiveTerminal>>>,
    tab_id: &str,
    stop_flag: &Arc<AtomicBool>,
    code: Option<i32>,
    reason: String,
) {
    let should_emit = !stop_flag.swap(true, Ordering::Relaxed);
    if let Ok(mut registry) = terminals.lock() {
        registry.remove(tab_id);
    }
    cleanup_ssh_control_socket(tab_id);

    if should_emit {
        emit_exit(
            app,
            tab_id,
            TerminalExitPayload {
                tab_id: tab_id.to_string(),
                code,
                reason,
            },
        );
    }
}

fn measure_latency(host: &str) -> Result<String, String> {
    let output = std::process::Command::new("ping")
        .args(["-c", "1", "-n", host])
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

fn build_local_shell_command() -> (CommandBuilder, String) {
    let shell = configured_local_shell();
    let mut command = CommandBuilder::new(&shell);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    if let Some(home_dir) = local_home_dir() {
        command.cwd(home_dir);
    }

    (command, shell)
}

fn configured_local_shell() -> String {
    if let Ok(shell) = std::env::var("OPENXTERM_LOCAL_SHELL") {
        if !shell.trim().is_empty() {
            return shell;
        }
    }

    #[cfg(windows)]
    {
        if executable_in_path("pwsh.exe") {
            return "pwsh.exe".into();
        }
        if executable_in_path("powershell.exe") {
            return "powershell.exe".into();
        }
        return std::env::var("COMSPEC")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "cmd.exe".into());
    }

    #[cfg(target_os = "macos")]
    {
        return std::env::var("SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "/bin/zsh".into());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".into())
    }
}

#[cfg(windows)]
fn executable_in_path(program: &str) -> bool {
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };

    std::env::split_paths(&path_var).any(|path| path.join(program).is_file())
}

fn local_home_dir() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .ok()
            .filter(|value| !value.trim().is_empty())
    }

    #[cfg(not(windows))]
    {
        std::env::var("HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
    }
}

pub fn ssh_control_path_for_tab(tab_id: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    tab_id.hash(&mut hasher);
    PathBuf::from("/tmp")
        .join(SSH_CONTROL_DIR)
        .join(format!("{:016x}.sock", hasher.finish()))
}

pub fn ssh_control_user_path_for_tab(tab_id: &str) -> PathBuf {
    ssh_control_path_for_tab(tab_id).with_extension("user")
}

fn prepare_ssh_control_socket(tab_id: &str) -> Result<(), String> {
    let control_path = ssh_control_path_for_tab(tab_id);
    if let Some(parent) = control_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to prepare SSH control directory {}: {error}",
                parent.display()
            )
        })?;
    }

    if control_path.exists() {
        fs::remove_file(&control_path).map_err(|error| {
            format!(
                "failed to remove stale SSH control socket {}: {error}",
                control_path.display()
            )
        })?;
    }
    let user_path = ssh_control_user_path_for_tab(tab_id);
    if user_path.exists() {
        fs::remove_file(&user_path).map_err(|error| {
            format!(
                "failed to remove stale SSH login metadata {}: {error}",
                user_path.display()
            )
        })?;
    }

    Ok(())
}

fn cleanup_ssh_control_socket(tab_id: &str) {
    let control_path = ssh_control_path_for_tab(tab_id);
    let _ = fs::remove_file(control_path);
    let _ = fs::remove_file(ssh_control_user_path_for_tab(tab_id));
}

fn build_interactive_ssh_command(
    session: &SessionDefinition,
    control_path: &PathBuf,
) -> Result<(CommandBuilder, Option<String>), String> {
    if session.username.trim().is_empty() {
        return build_prompted_ssh_command(session, control_path);
    }

    let mut command = CommandBuilder::new("ssh");
    apply_common_ssh_args(&mut command, session, false, Some(control_path));
    command.env("TERM", "xterm-256color");
    let x11_display = apply_local_x11_environment(&mut command, session)?;
    Ok((command, x11_display))
}

fn build_prompted_ssh_command(
    session: &SessionDefinition,
    control_path: &PathBuf,
) -> Result<(CommandBuilder, Option<String>), String> {
    let mut command = CommandBuilder::new("sh");
    command.args([
        "-lc",
        r#"printf 'login as: '
IFS= read -r OPENXTERM_SSH_LOGIN
if [ -z "$OPENXTERM_SSH_LOGIN" ]; then
  printf '\r\n[error] Username is required.\r\n'
  exit 1
fi
printf '%s\n' "$OPENXTERM_SSH_LOGIN" > "$OPENXTERM_SSH_LOGIN_PATH"
set -- \
  -o BatchMode=no \
  -o NumberOfPasswordPrompts=1 \
  -o PreferredAuthentications=publickey,keyboard-interactive,password \
  -o PubkeyAuthentication=yes \
  -o KbdInteractiveAuthentication=yes \
  -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=5 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ControlMaster=yes \
  -o ControlPersist=no \
  -o ControlPath="$OPENXTERM_SSH_CONTROL_PATH" \
  -o LogLevel=ERROR
if [ "$OPENXTERM_SSH_X11" = "1" ]; then
  if [ "$OPENXTERM_SSH_X11_TRUSTED" = "1" ]; then
    set -- "$@" -Y -o ForwardX11=yes -o ForwardX11Trusted=yes
  else
    set -- "$@" -X -o ForwardX11=yes -o ForwardX11Trusted=no -o ForwardX11Timeout=0
  fi
  if [ -n "$OPENXTERM_SSH_XAUTH_LOCATION" ]; then
    set -- "$@" -o "XAuthLocation=$OPENXTERM_SSH_XAUTH_LOCATION"
  fi
fi
if [ -n "$OPENXTERM_SSH_KEY" ]; then
  set -- "$@" -i "$OPENXTERM_SSH_KEY"
fi
set -- "$@" -p "$OPENXTERM_SSH_PORT" "$OPENXTERM_SSH_LOGIN@$OPENXTERM_SSH_HOST"
exec ssh "$@"
"#,
    ]);
    command.env("TERM", "xterm-256color");
    command.env("OPENXTERM_SSH_HOST", &session.host);
    command.env("OPENXTERM_SSH_PORT", &session.port.to_string());
    command.env(
        "OPENXTERM_SSH_CONTROL_PATH",
        control_path.to_string_lossy().to_string(),
    );
    command.env(
        "OPENXTERM_SSH_LOGIN_PATH",
        control_path
            .with_extension("user")
            .to_string_lossy()
            .to_string(),
    );
    command.env(
        "OPENXTERM_SSH_KEY",
        &session
            .key_path
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| expand_tilde(value))
            .unwrap_or_default(),
    );
    command.env(
        "OPENXTERM_SSH_X11",
        if session.x11_forwarding { "1" } else { "0" },
    );
    command.env(
        "OPENXTERM_SSH_X11_TRUSTED",
        if session.x11_trusted { "1" } else { "0" },
    );
    command.env(
        "OPENXTERM_SSH_XAUTH_LOCATION",
        resolve_local_xauth_location().unwrap_or_default(),
    );
    let x11_display = apply_local_x11_environment(&mut command, session)?;
    Ok((command, x11_display))
}

fn apply_common_ssh_args(
    command: &mut CommandBuilder,
    session: &SessionDefinition,
    batch_mode: bool,
    control_path: Option<&PathBuf>,
) {
    command.args([
        "-o",
        if batch_mode {
            "BatchMode=yes"
        } else {
            "BatchMode=no"
        },
        "-o",
        if batch_mode {
            "NumberOfPasswordPrompts=0"
        } else {
            "NumberOfPasswordPrompts=1"
        },
        "-o",
        "PreferredAuthentications=publickey,keyboard-interactive,password",
        "-o",
        "PubkeyAuthentication=yes",
        "-o",
        "KbdInteractiveAuthentication=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "LogLevel=ERROR",
        "-p",
        &session.port.to_string(),
    ]);

    if let Some(control_path) = control_path {
        command.args(["-o", "ControlMaster=yes", "-o", "ControlPersist=no", "-o"]);
        command.arg(format!("ControlPath={}", control_path.display()));
    }

    if session.x11_forwarding {
        if session.x11_trusted {
            command.arg("-Y");
            command.args(["-o", "ForwardX11=yes", "-o", "ForwardX11Trusted=yes"]);
        } else {
            command.arg("-X");
            command.args([
                "-o",
                "ForwardX11=yes",
                "-o",
                "ForwardX11Trusted=no",
                "-o",
                "ForwardX11Timeout=0",
            ]);
        }
        if let Some(xauth_location) = resolve_local_xauth_location() {
            command.args(["-o", &format!("XAuthLocation={xauth_location}")]);
        }
    }

    if let Some(key_path) = session
        .key_path
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        command.args(["-i", &expand_tilde(key_path)]);
    }

    command.arg(build_target(session));
}

fn build_target(session: &SessionDefinition) -> String {
    if session.username.trim().is_empty() {
        session.host.clone()
    } else {
        format!("{}@{}", session.username, session.host)
    }
}

fn expand_tilde(value: &str) -> String {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home_dir) = std::env::var_os("HOME") {
            return format!("{}/{}", home_dir.to_string_lossy(), stripped);
        }
    }

    value.to_string()
}

fn apply_local_x11_environment(
    command: &mut CommandBuilder,
    session: &SessionDefinition,
) -> Result<Option<String>, String> {
    if !session.x11_forwarding {
        return Ok(None);
    }

    let display = resolve_local_x11_display(session.x11_display.as_deref())?;
    command.env("DISPLAY", &display);

    if let Ok(xauthority) = std::env::var("XAUTHORITY") {
        if !xauthority.trim().is_empty() {
            command.env("XAUTHORITY", xauthority);
        }
    }

    Ok(Some(display))
}

fn resolve_local_xauth_location() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let candidate = "/opt/X11/bin/xauth";
        if PathBuf::from(candidate).exists() {
            return Some(candidate.into());
        }
    }

    None
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn map_parity(parity: &str) -> Parity {
    match parity {
        "even" => Parity::Even,
        "odd" => Parity::Odd,
        _ => Parity::None,
    }
}

fn map_stop_bits(stop_bits: u8) -> StopBits {
    if stop_bits == 2 {
        StopBits::Two
    } else {
        StopBits::One
    }
}

fn map_data_bits(data_bits: u8) -> DataBits {
    match data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    }
}

fn process_telnet_bytes(buffer: &[u8]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut display = Vec::new();
    let mut replies = Vec::new();
    let mut index = 0;

    while index < buffer.len() {
        if buffer[index] != TELNET_IAC {
            display.push(buffer[index]);
            index += 1;
            continue;
        }

        if index + 1 >= buffer.len() {
            return (display, replies, buffer[index..].to_vec());
        }

        match buffer[index + 1] {
            TELNET_IAC => {
                display.push(TELNET_IAC);
                index += 2;
            }
            TELNET_DO | TELNET_DONT | TELNET_WILL | TELNET_WONT => {
                if index + 2 >= buffer.len() {
                    return (display, replies, buffer[index..].to_vec());
                }

                let option = buffer[index + 2];
                replies.extend(match buffer[index + 1] {
                    TELNET_DO => [TELNET_IAC, TELNET_WONT, option],
                    TELNET_DONT => [TELNET_IAC, TELNET_WONT, option],
                    TELNET_WILL => [TELNET_IAC, TELNET_DONT, option],
                    TELNET_WONT => [TELNET_IAC, TELNET_DONT, option],
                    _ => unreachable!(),
                });
                index += 3;
            }
            TELNET_SB => {
                let mut cursor = index + 2;
                let mut found_end = false;
                while cursor + 1 < buffer.len() {
                    if buffer[cursor] == TELNET_IAC && buffer[cursor + 1] == TELNET_SE {
                        cursor += 2;
                        found_end = true;
                        break;
                    }
                    cursor += 1;
                }

                if !found_end {
                    return (display, replies, buffer[index..].to_vec());
                }

                index = cursor;
            }
            _ => {
                index += 2;
            }
        }
    }

    (display, replies, Vec::new())
}

fn looks_like_password_prompt(recent_output: &str) -> bool {
    let trimmed = recent_output.trim_end_matches(['\r', '\n']);
    trimmed.ends_with("password:")
        || trimmed.ends_with("password: ")
        || trimmed.ends_with("'s password:")
        || trimmed.contains("password for ")
}

fn remote_status_script() -> &'static str {
    r#"cpu_from_proc_stat() {
  sample() {
    awk '/^cpu / { total=0; for (i=2; i<=NF; i++) total+=$i; idle=$5; if (NF >= 6) idle+=$6; print total, idle; exit }' /proc/stat 2>/dev/null
  }

  set -- $(sample)
  total_a=$1
  idle_a=$2
  if [ -z "$total_a" ] || [ -z "$idle_a" ]; then
    return 1
  fi

  sleep 0.2

  set -- $(sample)
  total_b=$1
  idle_b=$2
  if [ -z "$total_b" ] || [ -z "$idle_b" ]; then
    return 1
  fi

  delta_total=$((total_b - total_a))
  delta_idle=$((idle_b - idle_a))
  if [ "$delta_total" -le 0 ]; then
    return 1
  fi

  usage=$(( (100 * (delta_total - delta_idle) + (delta_total / 2)) / delta_total ))
  printf '%s%%' "$usage"
}

cpu_from_top() {
  LC_ALL=C top -l 2 -n 0 2>/dev/null | awk -F'[:,%]' '
    /CPU usage:/ {
      idle=$(NF-1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", idle)
      if (idle != "") { usage = 100 - idle }
    }
    END {
      if (usage != "") printf "%.0f%%", usage
    }'
}

hostname_val=$(hostname 2>/dev/null || uname -n 2>/dev/null || printf unknown)
user_val=$(id -un 2>/dev/null || whoami 2>/dev/null || printf unknown)
os_val=$(uname -srmo 2>/dev/null || uname -a 2>/dev/null || printf unknown)

uptime_val=$(uptime -p 2>/dev/null || uptime 2>/dev/null | sed 's/^ *//')
if [ -z "$uptime_val" ]; then uptime_val="unavailable"; fi

cpu_val=""
if [ -r /proc/stat ]; then
  cpu_val=$(cpu_from_proc_stat)
fi
if [ -z "$cpu_val" ]; then
  cpu_val=$(cpu_from_top)
fi
if [ -z "$cpu_val" ]; then cpu_val="unavailable"; fi

memory_val=$(free -h 2>/dev/null | awk '/^Mem:/ {print $3 " / " $2}')
if [ -z "$memory_val" ]; then
  memory_val=$(awk '
    /^MemTotal:/ {total=$2}
    /^MemAvailable:/ {avail=$2}
    END {
      if (total > 0 && avail >= 0) {
        used=(total-avail)/1048576;
        total_gb=total/1048576;
        printf "%.1f GiB / %.1f GiB", used, total_gb;
      }
    }' /proc/meminfo 2>/dev/null)
fi
if [ -z "$memory_val" ]; then
  memory_val=$(vm_stat 2>/dev/null | awk 'BEGIN{page=4096} /page size of/ {page=$8} /Pages active/ {gsub("\\.","",$3); active=$3} /Pages wired down/ {gsub("\\.","",$4); wired=$4} /Pages occupied by compressor/ {gsub("\\.","",$5); comp=$5} /Pages free/ {gsub("\\.","",$3); freep=$3} END {used=(active+wired+comp)*page/1073741824; total=(active+wired+comp+freep)*page/1073741824; if (total>0) printf "%.1f GiB / %.1f GiB", used, total}')
fi
if [ -z "$memory_val" ]; then memory_val="unavailable"; fi

disk_val=$(df -hP / 2>/dev/null | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}')
if [ -z "$disk_val" ]; then disk_val="unavailable"; fi

net_val=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$net_val" ]; then
  net_val=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for (i=1; i<=NF; i++) if ($i=="src") {print $(i+1); exit}}')
fi
if [ -z "$net_val" ]; then
  net_val=$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}')
fi
if [ -z "$net_val" ]; then net_val="unavailable"; fi

printf '__OXT__hostname=%s\n' "$hostname_val"
printf '__OXT__user=%s\n' "$user_val"
printf '__OXT__remote_os=%s\n' "$os_val"
printf '__OXT__uptime=%s\n' "$uptime_val"
printf '__OXT__cpu_load=%s\n' "$cpu_val"
printf '__OXT__memory_usage=%s\n' "$memory_val"
printf '__OXT__disk_usage=%s\n' "$disk_val"
printf '__OXT__network=%s\n' "$net_val""#
}

#[cfg(windows)]
fn windows_status_script() -> &'static str {
    r#"$hostname_val = $env:COMPUTERNAME
if ([string]::IsNullOrWhiteSpace($hostname_val)) { $hostname_val = 'local' }
$user_val = $env:USERNAME
if ([string]::IsNullOrWhiteSpace($user_val)) { $user_val = 'local' }
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) {
  $os_val = "$($os.Caption) $($os.Version)"
  $uptime_span = (Get-Date) - $os.LastBootUpTime
  $uptime_val = "{0}d {1}h {2}m" -f [int]$uptime_span.TotalDays, $uptime_span.Hours, $uptime_span.Minutes
  $used = ($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB
  $total = $os.TotalVisibleMemorySize / 1MB
  $memory_val = "{0:N1} GB / {1:N1} GB" -f $used, $total
} else {
  $os_val = 'Windows'
  $uptime_val = 'unavailable'
  $memory_val = 'unavailable'
}
$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cpu -and $null -ne $cpu.LoadPercentage) { $cpu_val = "$($cpu.LoadPercentage)%" } else { $cpu_val = 'unavailable' }
$drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'" -ErrorAction SilentlyContinue
if ($drive -and $drive.Size -gt 0) {
  $usedDisk = ($drive.Size - $drive.FreeSpace) / 1GB
  $totalDisk = $drive.Size / 1GB
  $pct = (($drive.Size - $drive.FreeSpace) / $drive.Size) * 100
  $disk_val = "{0:N1} GB / {1:N1} GB ({2:N0}%)" -f $usedDisk, $totalDisk, $pct
} else {
  $disk_val = 'unavailable'
}
$ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254*' } |
  Select-Object -First 1 -ExpandProperty IPAddress
if ([string]::IsNullOrWhiteSpace($ip)) { $ip = 'local' }
Write-Output "__OXT__hostname=$hostname_val"
Write-Output "__OXT__user=$user_val"
Write-Output "__OXT__remote_os=$os_val"
Write-Output "__OXT__uptime=$uptime_val"
Write-Output "__OXT__cpu_load=$cpu_val"
Write-Output "__OXT__memory_usage=$memory_val"
Write-Output "__OXT__disk_usage=$disk_val"
Write-Output "__OXT__network=$ip""#
}

fn emit_output(app: &AppHandle, tab_id: &str, chunk: &str) {
    let _ = app.emit(
        TERMINAL_OUTPUT_EVENT,
        TerminalOutputPayload {
            tab_id: tab_id.to_string(),
            chunk: chunk.to_string(),
        },
    );
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

fn emit_exit(app: &AppHandle, _tab_id: &str, payload: TerminalExitPayload) {
    let _ = app.emit(TERMINAL_EXIT_EVENT, payload);
}

struct TelnetWriter {
    stream: TcpStream,
}

impl TelnetWriter {
    fn new(stream: TcpStream) -> Self {
        Self { stream }
    }
}

impl Write for TelnetWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut escaped = Vec::with_capacity(buf.len());
        for byte in buf {
            escaped.push(*byte);
            if *byte == TELNET_IAC {
                escaped.push(TELNET_IAC);
            }
        }
        self.stream.write_all(&escaped)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}
