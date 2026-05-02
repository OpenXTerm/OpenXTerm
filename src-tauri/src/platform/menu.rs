#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

const MENU_ACTION_EVENT: &str = "openxterm://menu-action";

pub fn install_macos_menu<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let app = _app;
        let app_menu = SubmenuBuilder::new(app, "OpenXTerm")
            .about(Some(AboutMetadata {
                name: Some("OpenXTerm".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                ..Default::default()
            }))
            .separator()
            .text("open-settings", "Settings...")
            .separator()
            .text("lock-app", "Lock OpenXTerm")
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .separator()
            .quit()
            .build()?;

        let terminal_menu = SubmenuBuilder::new(app, "Terminal")
            .text("new-session", "New Session")
            .text("new-macro", "New Macro")
            .separator()
            .text("search-terminal", "Search in Terminal")
            .text("clear-terminal", "Clear Terminal")
            .text("reset-terminal", "Reset Terminal")
            .separator()
            .text("lock-app", "Lock OpenXTerm")
            .build()?;

        let sessions_menu = SubmenuBuilder::new(app, "Sessions")
            .text("show-sessions", "Show Sessions")
            .text("show-sftp", "Show SFTP")
            .build()?;

        let view_menu = SubmenuBuilder::new(app, "View")
            .text("show-sessions", "Show Sessions")
            .text("show-sftp", "Show SFTP")
            .text("show-tools", "Show Tools")
            .text("show-macros", "Show Macros")
            .separator()
            .fullscreen()
            .build()?;

        let tools_menu = SubmenuBuilder::new(app, "Tools")
            .text("show-tools", "Open Tools")
            .build()?;

        let macros_menu = SubmenuBuilder::new(app, "Macros")
            .text("new-macro", "New Macro")
            .text("show-macros", "Show Macros")
            .build()?;

        let window_menu = SubmenuBuilder::new(app, "Window")
            .minimize()
            .separator()
            .close_window()
            .build()?;

        let help_menu = SubmenuBuilder::new(app, "Help")
            .text("show-sessions", "Open Sessions")
            .build()?;

        let menu = MenuBuilder::new(app)
            .item(&app_menu)
            .item(&terminal_menu)
            .item(&sessions_menu)
            .item(&view_menu)
            .item(&tools_menu)
            .item(&macros_menu)
            .item(&window_menu)
            .item(&help_menu)
            .build()?;

        app.set_menu(menu)?;
    }

    Ok(())
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let action = match id {
        "open-settings" | "new-session" | "new-macro" | "show-sessions" | "show-sftp"
        | "show-tools" | "show-macros" | "lock-app" | "search-terminal" | "clear-terminal"
        | "reset-terminal" => Some(id),
        _ => None,
    };

    if let Some(action) = action {
        let _ = app.emit(
            MENU_ACTION_EVENT,
            serde_json::json!({
              "action": action,
            }),
        );
    }
}
