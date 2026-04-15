use std::{env, process::Command};

use crate::models::LocalX11SupportPayload;

pub fn inspect_local_x11_support(display_override: Option<&str>) -> LocalX11SupportPayload {
    let system_display = detect_system_x11_display(display_override);
    let system_x11_available = system_display.is_some();

    let (message, detail) = if let Some(display) = system_display.as_deref() {
        (
            format!("Local X11 display is ready: {display}"),
            "Built-in SSH X11 forwarding can use this display directly.".to_string(),
        )
    } else {
        (
            "No local X11 display was detected.".to_string(),
            if cfg!(target_os = "macos") {
                "Recommended path on macOS: install and start XQuartz, then rerun this check."
                    .to_string()
            } else if cfg!(windows) {
                "Start a local Windows X server such as VcXsrv or X410, then set DISPLAY if it is not detected automatically."
                    .to_string()
            } else {
                "Start Xorg or XWayland, then rerun this check. On desktop Linux this usually means launching OpenXTerm from an environment with DISPLAY set."
                    .to_string()
            },
        )
    };

    LocalX11SupportPayload {
        system_x11_available,
        system_display,
        message,
        detail,
    }
}

pub fn resolve_local_x11_display(display_override: Option<&str>) -> Result<String, String> {
    if let Some(display) = detect_system_x11_display(display_override) {
        return Ok(display);
    }

    #[cfg(target_os = "macos")]
    {
        return Err(
            "X11 forwarding is enabled, but no local DISPLAY was found. Start XQuartz, set a display override, then rerun the X11 check in the session editor."
                .into(),
        );
    }

    #[cfg(windows)]
    {
        return Err(
            "X11 forwarding is enabled, but no local DISPLAY was found. Start a local X server, set a display override, then rerun the X11 check in the session editor."
                .into(),
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Err(
            "X11 forwarding is enabled, but no local DISPLAY was found. Start an X server/XWayland, set a display override, then rerun the X11 check in the session editor."
                .into(),
        )
    }
}

pub fn open_external_target(target: &str) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("no target was provided".into());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|error| format!("failed to open target: {error}"))?;
        return Ok(());
    }

    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", "start", "", target])
            .spawn()
            .map_err(|error| format!("failed to open target: {error}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|error| format!("failed to open target: {error}"))?;
        Ok(())
    }
}

fn detect_system_x11_display(display_override: Option<&str>) -> Option<String> {
    if let Some(override_value) = display_override {
        let trimmed = override_value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Ok(display) = env::var("DISPLAY") {
        let trimmed = display.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("launchctl")
            .args(["getenv", "DISPLAY"])
            .output()
        {
            let display = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !display.is_empty() {
                return Some(display);
            }
        }
    }

    None
}
