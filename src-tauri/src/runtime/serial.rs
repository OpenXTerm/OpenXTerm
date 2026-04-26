use std::{
    collections::HashMap,
    io::{self, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use serialport::{DataBits, Parity, StopBits};
use tauri::AppHandle;

use super::{emit_output, finalize_terminal, ActiveTerminal};

pub(super) fn spawn_serial_reader(
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

pub(super) fn map_parity(parity: &str) -> Parity {
    match parity {
        "even" => Parity::Even,
        "odd" => Parity::Odd,
        _ => Parity::None,
    }
}

pub(super) fn map_stop_bits(stop_bits: u8) -> StopBits {
    if stop_bits == 2 {
        StopBits::Two
    } else {
        StopBits::One
    }
}

pub(super) fn map_data_bits(data_bits: u8) -> DataBits {
    match data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    }
}
