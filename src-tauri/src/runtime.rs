use std::{
    collections::{HashMap, VecDeque},
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    io::{self, BufReader, Read, Write},
    net::{Shutdown, TcpStream, ToSocketAddrs},
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    thread,
    time::Duration,
};

use libssh_rs::{
    Channel as LibsshChannel, Error as LibsshError, Session as LibsshSession, Sftp as LibsshSftp,
    SshOption,
};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serialport::{DataBits, Parity, StopBits};
use tauri::{AppHandle, Emitter};

use crate::models::{
    SessionDefinition, SessionStatusPayload, SessionStatusSnapshot, TerminalExitPayload,
    TerminalOutputPayload,
};
use crate::x11_support::resolve_local_x11_display;

#[cfg(unix)]
use std::os::unix::net::UnixStream;

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
const SSH_RUNTIME_METADATA_DIR: &str = "oxt-ssh-runtime";

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type ResizeHandler = Box<dyn Fn(u16, u16) -> Result<(), String> + Send + Sync>;
type StopHandler = Box<dyn Fn() + Send + Sync>;

const SSH_LOOP_IDLE_SLEEP: Duration = Duration::from_millis(20);
const X11_ACCEPT_TIMEOUT: Duration = Duration::from_millis(1);
const X11_PROXY_IDLE_SLEEP: Duration = Duration::from_millis(5);
const X11_COMMAND_TIMEOUT: Duration = Duration::from_millis(700);
const X11_PROXY_PENDING_LIMIT: usize = 4 * 1024 * 1024;
const RECENT_TERMINAL_OUTPUT_CHAR_LIMIT: usize = 2048;
const TELNET_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone)]
struct X11ForwardConfig {
    display: String,
    auth_protocol: Option<String>,
    auth_cookie: Option<String>,
    screen_number: i32,
}

#[derive(Clone, Default)]
struct SshRuntimeAuthState {
    username: Option<String>,
    password: Option<String>,
}

enum EmbeddedSshState {
    AwaitingUsername { buffer: String },
    AwaitingPassword { username: String, buffer: String },
    Connecting,
    Running { channel: Arc<Mutex<LibsshChannel>> },
    Closed,
}

struct EmbeddedSshController {
    app: AppHandle,
    terminals: Arc<Mutex<HashMap<String, ActiveTerminal>>>,
    tab_id: String,
    session: SessionDefinition,
    stop_flag: Arc<AtomicBool>,
    state: Arc<Mutex<EmbeddedSshState>>,
    terminal_size: Arc<Mutex<(u16, u16)>>,
}

struct EmbeddedSshWriter {
    controller: Arc<EmbeddedSshController>,
}

pub struct AppRuntime {
    terminals: Arc<Mutex<HashMap<String, ActiveTerminal>>>,
}

struct ActiveTerminal {
    writer: SharedWriter,
    resize: ResizeHandler,
    stop: StopHandler,
    stop_flag: Arc<AtomicBool>,
}

#[derive(Default)]
struct SshRuntimeGuidanceState {
    host_key_prompt: bool,
    host_key_changed: bool,
    auth_failed: bool,
    key_permission_error: bool,
    connection_refused: bool,
    timeout: bool,
    host_unreachable: bool,
    dns_error: bool,
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

        let (command, shell_label) = build_local_shell_command(&session)?;
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
        if session.host.trim().is_empty() {
            return Err("SSH session requires a host or IP address.".into());
        }
        if session.port == 0 {
            return Err("SSH session requires a non-zero port.".into());
        }
        self.start_embedded_ssh_session(app, tab_id, session)
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

        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(PendingTelnetWriter)));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let shutdown_stream: Arc<Mutex<Option<TcpStream>>> = Arc::new(Mutex::new(None));

        self.terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_string())?
            .insert(
                tab_id.clone(),
                ActiveTerminal {
                    writer: writer.clone(),
                    resize: Box::new(|_, _| Ok(())),
                    stop: {
                        let shutdown_stream = shutdown_stream.clone();
                        Box::new(move || {
                            if let Ok(mut stream) = shutdown_stream.lock() {
                                if let Some(stream) = stream.take() {
                                    let _ = stream.shutdown(Shutdown::Both);
                                }
                            }
                        })
                    },
                    stop_flag: stop_flag.clone(),
                },
            );

        spawn_telnet_connector(
            app.clone(),
            self.terminals.clone(),
            tab_id,
            session,
            writer,
            shutdown_stream,
            stop_flag,
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

        clear_ssh_runtime_auth(tab_id);
        cleanup_ssh_runtime_metadata(tab_id);
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

    fn start_embedded_ssh_session(
        &self,
        app: &AppHandle,
        tab_id: String,
        session: SessionDefinition,
    ) -> Result<bool, String> {
        self.stop_terminal(&tab_id)?;
        prepare_ssh_runtime_metadata(&tab_id)?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(if session.username.trim().is_empty() {
            EmbeddedSshState::AwaitingUsername {
                buffer: String::new(),
            }
        } else if session.auth_type == "password"
            && session
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .is_none()
        {
            EmbeddedSshState::AwaitingPassword {
                username: session.username.trim().to_string(),
                buffer: String::new(),
            }
        } else {
            EmbeddedSshState::Connecting
        }));
        let terminal_size = Arc::new(Mutex::new((DEFAULT_COLS, DEFAULT_ROWS)));
        let controller = Arc::new(EmbeddedSshController {
            app: app.clone(),
            terminals: self.terminals.clone(),
            tab_id: tab_id.clone(),
            session: session.clone(),
            stop_flag: stop_flag.clone(),
            state: state.clone(),
            terminal_size: terminal_size.clone(),
        });
        let resize_controller = controller.clone();
        let stop_controller = controller.clone();
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(EmbeddedSshWriter {
            controller: controller.clone(),
        })));

        self.terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_string())?
            .insert(
                tab_id.clone(),
                ActiveTerminal {
                    writer,
                    resize: Box::new(move |cols, rows| resize_controller.resize(cols, rows)),
                    stop: Box::new(move || stop_controller.request_stop()),
                    stop_flag,
                },
            );

        if session.username.trim().is_empty() {
            emit_output(app, &tab_id, "login as: ");
        } else if session.auth_type == "password"
            && session
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .is_none()
        {
            controller.prompt_for_password(session.username.trim().to_string());
        } else {
            set_ssh_runtime_auth(
                &tab_id,
                Some(session.username.trim().to_string()),
                session.password.clone(),
            );
            controller.begin_connect(
                session.username.trim().to_string(),
                session.password.clone(),
            );
        }

        Ok(true)
    }
}

impl EmbeddedSshController {
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let cols = cols.max(2);
        let rows = rows.max(2);
        if let Ok(mut terminal_size) = self.terminal_size.lock() {
            *terminal_size = (cols, rows);
        }

        let state = self
            .state
            .lock()
            .map_err(|_| "embedded SSH state is poisoned".to_string())?;
        if let EmbeddedSshState::Running { channel } = &*state {
            let channel = lock_embedded_ssh_channel(channel);
            channel
                .change_pty_size(cols as u32, rows as u32)
                .map_err(|error| format!("failed to resize embedded SSH PTY: {error}"))?;
        }
        Ok(())
    }

    fn request_stop(&self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        clear_ssh_runtime_auth(&self.tab_id);
        if let Ok(mut state) = self.state.lock() {
            if let EmbeddedSshState::Running { channel } = &*state {
                let channel = lock_embedded_ssh_channel(channel);
                let _ = channel.close();
            }
            *state = EmbeddedSshState::Closed;
        }
    }

    fn prompt_for_password(&self, username: String) {
        if let Ok(mut state) = self.state.lock() {
            *state = EmbeddedSshState::AwaitingPassword {
                username: username.clone(),
                buffer: String::new(),
            };
        }
        emit_output(
            &self.app,
            &self.tab_id,
            &format!("{username}@{}'s password: ", self.session.host),
        );
    }

    fn begin_connect(&self, username: String, password_override: Option<String>) {
        if self.stop_flag.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            *state = EmbeddedSshState::Connecting;
        }

        let controller = Arc::new(self.clone_for_thread());
        thread::spawn(move || {
            controller.connect_and_run(username, password_override);
        });
    }

    fn clone_for_thread(&self) -> Self {
        Self {
            app: self.app.clone(),
            terminals: self.terminals.clone(),
            tab_id: self.tab_id.clone(),
            session: self.session.clone(),
            stop_flag: self.stop_flag.clone(),
            state: self.state.clone(),
            terminal_size: self.terminal_size.clone(),
        }
    }

    fn connect_and_run(self: Arc<Self>, username: String, password_override: Option<String>) {
        if self.stop_flag.load(Ordering::Relaxed) {
            return;
        }

        let x11_config = match prepare_x11_forwarding(&self.session, &self.stop_flag) {
            Ok(config) => config,
            Err(error) => {
                if self.session.x11_forwarding {
                    emit_output(
                        &self.app,
                        &self.tab_id,
                        &format!(
                            "\r\n[warning] X11 forwarding was requested, but local X11 is not ready: {error}\r\n"
                        ),
                    );
                }
                None
            }
        };

        match open_embedded_ssh_channel(
            &self.session,
            &username,
            password_override.as_deref(),
            *self
                .terminal_size
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()),
            x11_config.as_ref(),
        ) {
            Ok((channel, x11_warning)) => {
                let shared_channel = Arc::new(Mutex::new(channel));
                set_ssh_runtime_auth(
                    &self.tab_id,
                    Some(username.clone()),
                    password_override.clone(),
                );
                if let Ok(mut state) = self.state.lock() {
                    *state = EmbeddedSshState::Running {
                        channel: shared_channel.clone(),
                    };
                }
                if let Some(warning) = x11_warning {
                    report_x11_forwarding_failure(&self.app, &self.tab_id, &self.session, &warning);
                } else if let Some(config) = x11_config {
                    spawn_x11_accept_loop(
                        self.app.clone(),
                        self.tab_id.clone(),
                        shared_channel.clone(),
                        config,
                        self.stop_flag.clone(),
                    );
                }
                spawn_embedded_ssh_reader(
                    self.app.clone(),
                    self.terminals.clone(),
                    self.tab_id.clone(),
                    self.session.clone(),
                    shared_channel,
                    self.stop_flag.clone(),
                );
                if ssh_status_poller_supported(&self.session) {
                    spawn_status_poller(
                        self.app.clone(),
                        self.tab_id.clone(),
                        self.session.clone(),
                        self.stop_flag.clone(),
                    );
                }
            }
            Err(error) => {
                emit_output(
                    &self.app,
                    &self.tab_id,
                    &format!(
                        "\r\n[error] {}\r\n",
                        humanize_ssh_error_message(&error, &self.session)
                    ),
                );
                if should_retry_interactive_password(&error, &self.session) {
                    self.prompt_for_password(username);
                } else {
                    finalize_terminal(
                        &self.app,
                        &self.terminals,
                        &self.tab_id,
                        &self.stop_flag,
                        None,
                        "SSH session closed.".into(),
                    );
                }
            }
        }
    }

    fn handle_input_bytes(&self, bytes: &[u8]) -> io::Result<usize> {
        for &byte in bytes {
            self.handle_input_byte(byte)?;
        }
        Ok(bytes.len())
    }

    fn handle_input_byte(&self, byte: u8) -> io::Result<()> {
        let mut trigger: Option<(String, Option<String>)> = None;
        {
            let mut state = self.state.lock().map_err(|_| {
                io::Error::new(io::ErrorKind::Other, "embedded SSH state is poisoned")
            })?;
            match &mut *state {
                EmbeddedSshState::AwaitingUsername { buffer } => match byte {
                    b'\r' | b'\n' => {
                        let username = buffer.trim().to_string();
                        emit_output(&self.app, &self.tab_id, "\r\n");
                        if username.is_empty() {
                            emit_output(
                                &self.app,
                                &self.tab_id,
                                "[error] Username is required.\r\nlogin as: ",
                            );
                            buffer.clear();
                        } else if self.session.auth_type == "password"
                            && self
                                .session
                                .password
                                .as_deref()
                                .filter(|value| !value.is_empty())
                                .is_none()
                        {
                            set_ssh_runtime_auth(&self.tab_id, Some(username.clone()), None);
                            *state = EmbeddedSshState::AwaitingPassword {
                                username: username.clone(),
                                buffer: String::new(),
                            };
                            emit_output(
                                &self.app,
                                &self.tab_id,
                                &format!("{username}@{}'s password: ", self.session.host),
                            );
                        } else {
                            set_ssh_runtime_auth(
                                &self.tab_id,
                                Some(username.clone()),
                                self.session.password.clone(),
                            );
                            trigger = Some((username, self.session.password.clone()));
                        }
                    }
                    8 | 127 => {
                        if !buffer.is_empty() {
                            buffer.pop();
                            emit_output(&self.app, &self.tab_id, "\u{8} \u{8}");
                        }
                    }
                    _ if byte.is_ascii_control() => {}
                    _ => {
                        buffer.push(byte as char);
                        emit_output(&self.app, &self.tab_id, &(byte as char).to_string());
                    }
                },
                EmbeddedSshState::AwaitingPassword { username, buffer } => match byte {
                    b'\r' | b'\n' => {
                        let password = buffer.clone();
                        emit_output(&self.app, &self.tab_id, "\r\n");
                        set_ssh_runtime_auth(
                            &self.tab_id,
                            Some(username.clone()),
                            Some(password.clone()),
                        );
                        trigger = Some((username.clone(), Some(password)));
                    }
                    8 | 127 => {
                        if !buffer.is_empty() {
                            buffer.pop();
                        }
                    }
                    _ if byte.is_ascii_control() => {}
                    _ => buffer.push(byte as char),
                },
                EmbeddedSshState::Connecting => {}
                EmbeddedSshState::Running { channel } => {
                    let channel = lock_embedded_ssh_channel(channel);
                    let mut stdin = channel.stdin();
                    stdin.write_all(&[byte])?;
                    stdin.flush()?;
                }
                EmbeddedSshState::Closed => {}
            }
        }

        if let Some((username, password_override)) = trigger {
            self.begin_connect(username, password_override);
        }

        Ok(())
    }
}

impl Write for EmbeddedSshWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.controller.handle_input_bytes(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn lock_embedded_ssh_channel(channel: &Arc<Mutex<LibsshChannel>>) -> MutexGuard<'_, LibsshChannel> {
    channel.lock().unwrap_or_else(|poison| poison.into_inner())
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
        let mut ssh_guidance_state = SshRuntimeGuidanceState::default();

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let chunk = String::from_utf8_lossy(&buffer[..size]).to_string();
                    emit_output(&app, &tab_id, &chunk);
                    push_recent_terminal_output(&mut recent_output, &chunk);
                    handle_password_prompt(
                        &app,
                        &tab_id,
                        &writer,
                        &session,
                        &password_sent,
                        &recent_output,
                    );
                    maybe_report_ssh_runtime_guidance(
                        &app,
                        &tab_id,
                        &session,
                        &recent_output,
                        &mut ssh_guidance_state,
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

fn spawn_embedded_ssh_reader(
    app: AppHandle,
    terminals: Arc<Mutex<HashMap<String, ActiveTerminal>>>,
    tab_id: String,
    session: SessionDefinition,
    channel: Arc<Mutex<LibsshChannel>>,
    stop_flag: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut stdout_buffer = [0_u8; 4096];
        let mut stderr_buffer = [0_u8; 4096];
        let mut recent_output = String::new();
        let mut ssh_guidance_state = SshRuntimeGuidanceState::default();
        let x11_failure_diagnosed = Arc::new(AtomicBool::new(false));
        let mut stdout_previous_was_cr = false;
        let mut stderr_previous_was_cr = false;

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            let mut made_progress = false;
            let mut should_close = false;
            let mut close_code = None;
            let mut close_reason = "SSH session closed.".to_string();

            {
                let channel = lock_embedded_ssh_channel(&channel);

                match channel.read_nonblocking(&mut stdout_buffer, false) {
                    Ok(size) if size > 0 => {
                        let chunk = normalize_embedded_terminal_newlines(
                            &stdout_buffer[..size],
                            &mut stdout_previous_was_cr,
                        );
                        emit_output(&app, &tab_id, &chunk);
                        push_recent_terminal_output(&mut recent_output, &chunk);
                        maybe_report_ssh_runtime_guidance(
                            &app,
                            &tab_id,
                            &session,
                            &recent_output,
                            &mut ssh_guidance_state,
                        );
                        maybe_report_x11_forwarding_failure(
                            &app,
                            &tab_id,
                            &session,
                            &chunk,
                            &x11_failure_diagnosed,
                        );
                        made_progress = true;
                    }
                    Ok(_) => {}
                    Err(LibsshError::TryAgain) => {}
                    Err(error) => {
                        emit_output(
                            &app,
                            &tab_id,
                            &format!("\r\n[error] embedded SSH stdout failure: {error}\r\n"),
                        );
                        should_close = true;
                        close_reason = error.to_string();
                    }
                }

                if !should_close {
                    match channel.read_nonblocking(&mut stderr_buffer, true) {
                        Ok(size) if size > 0 => {
                            let chunk = normalize_embedded_terminal_newlines(
                                &stderr_buffer[..size],
                                &mut stderr_previous_was_cr,
                            );
                            emit_output(&app, &tab_id, &chunk);
                            push_recent_terminal_output(&mut recent_output, &chunk);
                            maybe_report_ssh_runtime_guidance(
                                &app,
                                &tab_id,
                                &session,
                                &recent_output,
                                &mut ssh_guidance_state,
                            );
                            maybe_report_x11_forwarding_failure(
                                &app,
                                &tab_id,
                                &session,
                                &chunk,
                                &x11_failure_diagnosed,
                            );
                            made_progress = true;
                        }
                        Ok(_) => {}
                        Err(LibsshError::TryAgain) => {}
                        Err(error) => {
                            emit_output(
                                &app,
                                &tab_id,
                                &format!("\r\n[error] embedded SSH stderr failure: {error}\r\n"),
                            );
                            should_close = true;
                            close_reason = error.to_string();
                        }
                    }
                }

                if !should_close && (channel.is_eof() || channel.is_closed()) {
                    should_close = true;
                    close_code = channel.get_exit_status().map(|value| value as i32);
                }
            }

            if should_close {
                finalize_terminal(
                    &app,
                    &terminals,
                    &tab_id,
                    &stop_flag,
                    close_code,
                    close_reason,
                );
                break;
            }

            if !made_progress {
                thread::sleep(SSH_LOOP_IDLE_SLEEP);
            }
        }
    });
}

fn normalize_embedded_terminal_newlines(bytes: &[u8], previous_was_cr: &mut bool) -> String {
    let extra_capacity = bytes.iter().filter(|byte| **byte == b'\n').count();
    let mut normalized = Vec::with_capacity(bytes.len() + extra_capacity);

    for byte in bytes {
        if *byte == b'\n' {
            if !*previous_was_cr {
                normalized.push(b'\r');
            }
            normalized.push(b'\n');
            *previous_was_cr = false;
        } else {
            normalized.push(*byte);
            *previous_was_cr = *byte == b'\r';
        }
    }

    String::from_utf8_lossy(&normalized).to_string()
}

fn prepare_x11_forwarding(
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

fn spawn_x11_accept_loop(
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
                        push_recent_terminal_output(&mut recent_output, &chunk);
                        handle_password_prompt(
                            &app,
                            &tab_id,
                            &writer,
                            &session,
                            &password_sent,
                            &recent_output,
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

fn spawn_telnet_connector(
    app: AppHandle,
    terminals: Arc<Mutex<HashMap<String, ActiveTerminal>>>,
    tab_id: String,
    session: SessionDefinition,
    writer: SharedWriter,
    shutdown_stream: Arc<Mutex<Option<TcpStream>>>,
    stop_flag: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let stream = match connect_telnet_stream(&session) {
            Ok(stream) => stream,
            Err(error) => {
                if !stop_flag.load(Ordering::Relaxed) {
                    emit_output(&app, &tab_id, &format!("\r\n[error] {error}\r\n"));
                }
                finalize_terminal(&app, &terminals, &tab_id, &stop_flag, None, error);
                return;
            }
        };

        if stop_flag.load(Ordering::Relaxed) {
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }

        if let Err(error) = stream.set_read_timeout(Some(Duration::from_millis(250))) {
            let message = format!("failed to configure TELNET read timeout: {error}");
            emit_output(&app, &tab_id, &format!("\r\n[error] {message}\r\n"));
            finalize_terminal(&app, &terminals, &tab_id, &stop_flag, None, message);
            return;
        }

        let writer_stream = match stream.try_clone() {
            Ok(stream) => stream,
            Err(error) => {
                let message = format!("failed to clone TELNET stream: {error}");
                emit_output(&app, &tab_id, &format!("\r\n[error] {message}\r\n"));
                finalize_terminal(&app, &terminals, &tab_id, &stop_flag, None, message);
                return;
            }
        };

        let stream_for_shutdown = match writer_stream.try_clone() {
            Ok(stream) => stream,
            Err(error) => {
                let message = format!("failed to clone TELNET shutdown stream: {error}");
                emit_output(&app, &tab_id, &format!("\r\n[error] {message}\r\n"));
                finalize_terminal(&app, &terminals, &tab_id, &stop_flag, None, message);
                return;
            }
        };

        if let Ok(mut stream) = shutdown_stream.lock() {
            *stream = Some(stream_for_shutdown);
        }

        if let Ok(mut writer) = writer.lock() {
            *writer = Box::new(TelnetWriter::new(writer_stream));
        }

        spawn_telnet_reader(app, terminals, tab_id, stream, writer, session, stop_flag);
    });
}

fn connect_telnet_stream(session: &SessionDefinition) -> Result<TcpStream, String> {
    let endpoint = (session.host.as_str(), session.port);
    let addresses = endpoint.to_socket_addrs().map_err(|error| {
        format!(
            "failed to resolve {}:{}: {error}",
            session.host, session.port
        )
    })?;

    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, TELNET_CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }

    Err(format!(
        "failed to connect to {}:{}: {}",
        session.host,
        session.port,
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no resolved addresses".into())
    ))
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

fn run_remote_ssh_script_with_label(
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

fn open_embedded_ssh_channel(
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
        .request_shell()
        .map_err(|error| format!("failed to start embedded SSH shell: {error}"))?;

    Ok((channel, x11_warning))
}

fn should_retry_interactive_password(error: &str, session: &SessionDefinition) -> bool {
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
    ssh.set_option(SshOption::Hostname(session.host.clone()))
        .map_err(|error| format!("failed to configure embedded SSH host: {error}"))?;
    ssh.set_option(SshOption::Port(session.port))
        .map_err(|error| format!("failed to configure embedded SSH port: {error}"))?;
    ssh.set_option(SshOption::User(Some(username.to_string())))
        .map_err(|error| format!("failed to configure embedded SSH username: {error}"))?;
    ssh.set_option(SshOption::KnownHosts(None))
        .map_err(|error| format!("failed to configure embedded SSH known_hosts path: {error}"))?;
    ssh.set_option(SshOption::GlobalKnownHosts(None))
        .map_err(|error| {
            format!("failed to configure embedded SSH global known_hosts path: {error}")
        })?;
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

fn push_recent_terminal_output(recent_output: &mut String, chunk: &str) {
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

fn maybe_report_ssh_runtime_guidance(
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

fn looks_like_ssh_auth_failure(recent_output: &str) -> bool {
    recent_output.contains("permission denied (")
        || recent_output.contains("permission denied, please try again")
        || recent_output.contains("authentication failed")
        || recent_output.contains("access denied")
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

fn report_x11_forwarding_failure(
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
    clear_ssh_runtime_auth(tab_id);
    cleanup_ssh_runtime_metadata(tab_id);

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

fn build_local_shell_command(
    session: &SessionDefinition,
) -> Result<(CommandBuilder, String), String> {
    let shell = configured_local_shell();
    let mut command = CommandBuilder::new(&shell);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    if let Some(working_dir) = resolve_local_working_directory(session)? {
        command.cwd(working_dir);
    } else if let Some(home_dir) = local_home_dir() {
        command.cwd(home_dir);
    }

    Ok((command, shell))
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

fn resolve_local_working_directory(session: &SessionDefinition) -> Result<Option<String>, String> {
    let Some(value) = session
        .local_working_directory
        .as_ref()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    else {
        return Ok(None);
    };

    let resolved = expand_tilde(value);
    let path = PathBuf::from(&resolved);
    if !path.exists() {
        return Err(format!(
            "Local working directory does not exist: {}",
            path.display()
        ));
    }
    if !path.is_dir() {
        return Err(format!(
            "Local working directory is not a folder: {}",
            path.display()
        ));
    }

    Ok(Some(path.to_string_lossy().to_string()))
}

fn ssh_runtime_auth_store() -> &'static Mutex<HashMap<String, SshRuntimeAuthState>> {
    static SSH_RUNTIME_AUTH: OnceLock<Mutex<HashMap<String, SshRuntimeAuthState>>> =
        OnceLock::new();
    SSH_RUNTIME_AUTH.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_ssh_runtime_auth(tab_id: &str, username: Option<String>, password: Option<String>) {
    if let Ok(mut store) = ssh_runtime_auth_store().lock() {
        let entry = store.entry(tab_id.to_string()).or_default();
        if let Some(username) = username {
            entry.username = Some(username.clone());
            let _ = fs::write(
                ssh_runtime_username_path_for_tab(tab_id),
                format!("{username}\n"),
            );
        }
        if let Some(password) = password {
            entry.password = Some(password);
        }
    }
}

pub(crate) fn ssh_runtime_username(tab_id: &str) -> Option<String> {
    ssh_runtime_auth_store()
        .lock()
        .ok()
        .and_then(|store| store.get(tab_id).and_then(|entry| entry.username.clone()))
}

pub(crate) fn ssh_runtime_password(tab_id: &str) -> Option<String> {
    ssh_runtime_auth_store()
        .lock()
        .ok()
        .and_then(|store| store.get(tab_id).and_then(|entry| entry.password.clone()))
}

fn clear_ssh_runtime_auth(tab_id: &str) {
    if let Ok(mut store) = ssh_runtime_auth_store().lock() {
        store.remove(tab_id);
    }
}

#[cfg(not(windows))]
fn ssh_runtime_metadata_base_path_for_tab(tab_id: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    tab_id.hash(&mut hasher);
    PathBuf::from("/tmp")
        .join(SSH_RUNTIME_METADATA_DIR)
        .join(format!("{:016x}.runtime", hasher.finish()))
}

#[cfg(windows)]
fn ssh_runtime_metadata_base_path_for_tab(tab_id: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    tab_id.hash(&mut hasher);
    std::env::temp_dir()
        .join(SSH_RUNTIME_METADATA_DIR)
        .join(format!("{:016x}.runtime", hasher.finish()))
}

fn ssh_runtime_username_path_for_tab(tab_id: &str) -> PathBuf {
    ssh_runtime_metadata_base_path_for_tab(tab_id).with_extension("user")
}

fn prepare_ssh_runtime_metadata(tab_id: &str) -> Result<(), String> {
    let metadata_path = ssh_runtime_metadata_base_path_for_tab(tab_id);
    if let Some(parent) = metadata_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to prepare SSH runtime metadata directory {}: {error}",
                parent.display()
            )
        })?;
    }

    if metadata_path.exists() {
        fs::remove_file(&metadata_path).map_err(|error| {
            format!(
                "failed to remove stale SSH runtime metadata {}: {error}",
                metadata_path.display()
            )
        })?;
    }
    let username_path = ssh_runtime_username_path_for_tab(tab_id);
    if username_path.exists() {
        fs::remove_file(&username_path).map_err(|error| {
            format!(
                "failed to remove stale SSH login metadata {}: {error}",
                username_path.display()
            )
        })?;
    }

    Ok(())
}

fn cleanup_ssh_runtime_metadata(tab_id: &str) {
    let metadata_path = ssh_runtime_metadata_base_path_for_tab(tab_id);
    let _ = fs::remove_file(metadata_path);
    let _ = fs::remove_file(ssh_runtime_username_path_for_tab(tab_id));
}

fn ssh_status_poller_supported(session: &SessionDefinition) -> bool {
    session.kind == "ssh"
}

fn expand_tilde(value: &str) -> String {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home_dir) = local_home_dir() {
            return PathBuf::from(home_dir)
                .join(stripped)
                .to_string_lossy()
                .to_string();
        }
    }

    value.to_string()
}

fn windows_credential_reuse_message() -> String {
    "OpenXTerm needs a saved password or a live interactive password from the active SSH tab to reuse this connection for status or linked SFTP. Keep the SSH tab connected, save a password, or use key/agent authentication.".into()
}

fn humanize_ssh_error_message(error: &str, session: &SessionDefinition) -> String {
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

struct PendingTelnetWriter;

impl TelnetWriter {
    fn new(stream: TcpStream) -> Self {
        Self { stream }
    }
}

impl Write for PendingTelnetWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
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
