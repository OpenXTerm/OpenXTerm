use std::{
    collections::HashMap,
    io::{self, Read, Write},
    net::{Shutdown, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use tauri::AppHandle;

use crate::models::SessionDefinition;

use super::{
    emit_output, finalize_terminal, handle_password_prompt, push_recent_terminal_output,
    ActiveTerminal, SharedWriter,
};

const TELNET_IAC: u8 = 255;
const TELNET_DONT: u8 = 254;
const TELNET_DO: u8 = 253;
const TELNET_WONT: u8 = 252;
const TELNET_WILL: u8 = 251;
const TELNET_SB: u8 = 250;
const TELNET_SE: u8 = 240;
const TELNET_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) struct PendingTelnetWriter;

pub(super) fn spawn_telnet_connector(
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

struct TelnetWriter {
    stream: TcpStream,
}

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
