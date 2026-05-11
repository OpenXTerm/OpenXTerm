#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

const MENU_ACTION_EVENT: &str = "openxterm://menu-action";

pub fn install_macos_menu<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let app = _app;
        let app_menu = SubmenuBuilder::new(app, "OpenXTerm")
            .text("open-about", "About OpenXTerm")
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

        let file_menu = SubmenuBuilder::new(app, "File")
            .text("new-session", "New Session")
            .text("new-macro", "New Macro")
            .build()?;

        let terminal_menu = SubmenuBuilder::new(app, "Terminal")
            .text("search-terminal", "Search in Terminal")
            .text("clear-terminal", "Clear Terminal")
            .text("reset-terminal", "Reset Terminal")
            .build()?;

        let edit_menu = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let view_menu = SubmenuBuilder::new(app, "View")
            .text("show-sessions", "Show Sessions")
            .text("show-sftp", "Show SFTP")
            .text("show-tools", "Show Tools")
            .text("show-macros", "Show Macros")
            .separator()
            .fullscreen()
            .build()?;

        let window_menu = SubmenuBuilder::new(app, "Window")
            .minimize()
            .separator()
            .close_window()
            .build()?;

        let menu = MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file_menu)
            .item(&terminal_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .build()?;

        app.set_menu(menu)?;
    }

    Ok(())
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let action = match id {
        "open-settings" | "open-about" | "new-session" | "new-macro" | "show-sessions"
        | "show-sftp" | "show-tools" | "show-macros" | "lock-app" | "search-terminal"
        | "clear-terminal" | "reset-terminal" => Some(id),
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
