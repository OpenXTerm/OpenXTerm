use std::{
    collections::HashMap,
    io::{self, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
};

use libssh_rs::Channel as LibsshChannel;
use tauri::AppHandle;

use crate::models::SessionDefinition;

use super::super::{
    emit_output, finalize_terminal, prepare_x11_forwarding, report_x11_forwarding_failure,
    spawn_status_poller, spawn_x11_accept_loop, ssh_status_poller_supported, ActiveTerminal,
    AppRuntime, SharedWriter,
};
use super::{
    auth::{clear_ssh_runtime_auth, prepare_ssh_runtime_metadata, set_ssh_runtime_auth},
    guidance::humanize_ssh_error_message,
    interactive_reader::spawn_embedded_ssh_reader,
    session::{open_embedded_ssh_channel, should_retry_interactive_password},
};

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

impl AppRuntime {
    pub(in crate::runtime) fn start_embedded_ssh_session(
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
        let terminal_size = Arc::new(Mutex::new(self.latest_terminal_size(&tab_id)?));
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
            let password_override = session_secret_override(&session);
            set_ssh_runtime_auth(
                &tab_id,
                Some(session.username.trim().to_string()),
                password_override.clone(),
            );
            emit_connecting_message(app, &tab_id, &session, session.username.trim());
            controller.begin_connect(session.username.trim().to_string(), password_override);
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
                set_ssh_runtime_auth(&self.tab_id, Some(username), password_override);
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
        if bytes.is_empty() {
            return Ok(0);
        }

        let running_channel = {
            let state = self.state.lock().map_err(|_| {
                io::Error::new(io::ErrorKind::Other, "embedded SSH state is poisoned")
            })?;
            match &*state {
                EmbeddedSshState::Running { channel } => Some(channel.clone()),
                _ => None,
            }
        };

        if let Some(channel) = running_channel {
            let channel = lock_embedded_ssh_channel(&channel);
            let mut stdin = channel.stdin();
            stdin.write_all(bytes)?;
            stdin.flush()?;
            return Ok(bytes.len());
        }

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
                            let prompt = format!("{username}@{}'s password: ", self.session.host);
                            set_ssh_runtime_auth(&self.tab_id, Some(username.clone()), None);
                            *state = EmbeddedSshState::AwaitingPassword {
                                username,
                                buffer: String::new(),
                            };
                            emit_output(&self.app, &self.tab_id, &prompt);
                        } else {
                            let password_override = session_secret_override(&self.session);
                            set_ssh_runtime_auth(
                                &self.tab_id,
                                Some(username.clone()),
                                password_override.clone(),
                            );
                            trigger = Some((username, password_override));
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
            emit_connecting_message(&self.app, &self.tab_id, &self.session, &username);
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

pub(in crate::runtime) fn lock_embedded_ssh_channel(
    channel: &Arc<Mutex<LibsshChannel>>,
) -> MutexGuard<'_, LibsshChannel> {
    channel.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn emit_connecting_message(
    app: &AppHandle,
    tab_id: &str,
    session: &SessionDefinition,
    username: &str,
) {
    emit_output(
        app,
        tab_id,
        &format!(
            "\r\n[information] Connecting to {}:{} as {}...\r\n",
            session.host, session.port, username
        ),
    );
}

fn session_secret_override(session: &SessionDefinition) -> Option<String> {
    match session.auth_type.as_str() {
        "password" => non_empty_secret(session.password.as_deref()),
        "key" => non_empty_secret(session.key_passphrase.as_deref())
            .or_else(|| non_empty_secret(session.password.as_deref())),
        _ => None,
    }
}

fn non_empty_secret(value: Option<&str>) -> Option<String> {
    value
        .filter(|secret| !secret.is_empty())
        .map(str::to_string)
}
