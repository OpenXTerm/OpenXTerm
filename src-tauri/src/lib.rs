mod commands;
mod drag;
mod models;
mod platform;
mod probe;
mod proxy;
mod runtime;
mod storage;
mod transfer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(runtime::AppRuntime::default())
        .setup(|app| {
            platform::menu::install_macos_menu(&app.handle())?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap_state,
            commands::save_session,
            commands::save_session_folder,
            commands::delete_session,
            commands::delete_session_folder,
            commands::save_macro,
            commands::delete_macro,
            commands::save_preferences,
            commands::get_system_auth_support,
            commands::request_system_unlock,
            commands::inspect_local_x11_support,
            commands::open_external_target,
            commands::list_system_font_families,
            commands::run_libssh_probe,
            commands::start_local_session,
            commands::start_ssh_session,
            commands::start_telnet_session,
            commands::start_serial_session,
            commands::send_terminal_input,
            commands::stop_terminal_session,
            commands::resize_terminal_session,
            commands::list_remote_directory,
            commands::create_remote_directory,
            commands::delete_remote_entry,
            commands::rename_remote_entry,
            commands::update_remote_entry_permissions,
            commands::inspect_download_target,
            commands::cancel_transfer,
            commands::retry_transfer,
            commands::upload_remote_file,
            commands::upload_local_file,
            commands::download_remote_file,
            commands::download_remote_entry,
            commands::prepare_remote_drag_file,
            commands::start_native_file_drag,
            commands::start_native_entries_drag
        ])
        .on_menu_event(|app, event| {
            platform::menu::handle_menu_event(app, event.id().as_ref());
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
