use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use libssh_rs::{Channel as LibsshChannel, Error as LibsshError};
use tauri::AppHandle;

use crate::models::SessionDefinition;

use super::super::{
    emit_cwd, emit_output, finalize_terminal, maybe_report_x11_forwarding_failure, ActiveTerminal,
    SSH_LOOP_IDLE_SLEEP,
};
use super::{
    guidance::{
        maybe_report_ssh_runtime_guidance, push_recent_terminal_output, SshRuntimeGuidanceState,
    },
    interactive::lock_embedded_ssh_channel,
    interactive_text::{normalize_embedded_terminal_newlines, CwdOutputFilter},
};

pub(super) fn spawn_embedded_ssh_reader(
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
        let mut cwd_filter = CwdOutputFilter::new();

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
                        let (chunk, cwd_updates) = cwd_filter.push(&chunk);
                        for path in cwd_updates {
                            emit_cwd(&app, &tab_id, &path);
                        }
                        if !chunk.is_empty() {
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
                        }
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
