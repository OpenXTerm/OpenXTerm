mod local_shell;
mod serial;
mod ssh;
mod status;
mod status_scripts;
mod telnet;
mod x11;

use std::{
    collections::HashMap,
    io::{BufReader, Read, Write},
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
use tauri::{AppHandle, Emitter};

use crate::models::{SessionDefinition, TerminalExitPayload, TerminalOutputPayload};
use local_shell::{build_local_shell_command, local_home_dir};
use serial::{map_data_bits, map_parity, map_stop_bits, spawn_serial_reader};
pub(in crate::runtime) use ssh::guidance::{
    handle_password_prompt, maybe_report_ssh_runtime_guidance, push_recent_terminal_output,
    SshRuntimeGuidanceState,
};
pub(crate) use ssh::open_embedded_sftp;
pub(in crate::runtime) use ssh::{
    cleanup_ssh_runtime_metadata, clear_ssh_runtime_auth, lock_embedded_ssh_channel,
    run_remote_ssh_script_with_label,
};
use status::{spawn_status_poller, ssh_status_poller_supported};
use telnet::{spawn_telnet_connector, PendingTelnetWriter};
use x11::{
    maybe_report_x11_forwarding_failure, prepare_x11_forwarding, report_x11_forwarding_failure,
    spawn_x11_accept_loop,
};

const TERMINAL_OUTPUT_EVENT: &str = "openxterm://terminal-output";
const TERMINAL_EXIT_EVENT: &str = "openxterm://terminal-exit";
const DEFAULT_COLS: u16 = 140;
const DEFAULT_ROWS: u16 = 40;
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type ResizeHandler = Box<dyn Fn(u16, u16) -> Result<(), String> + Send + Sync>;
type StopHandler = Box<dyn Fn() + Send + Sync>;

const SSH_LOOP_IDLE_SLEEP: Duration = Duration::from_millis(20);
const RECENT_TERMINAL_OUTPUT_CHAR_LIMIT: usize = 2048;

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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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

fn emit_exit(app: &AppHandle, _tab_id: &str, payload: TerminalExitPayload) {
    let _ = app.emit(TERMINAL_EXIT_EVENT, payload);
}
