use std::path::PathBuf;

use portable_pty::CommandBuilder;

use crate::models::SessionDefinition;

use super::expand_tilde;

pub(super) fn build_local_shell_command(
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

pub(super) fn local_home_dir() -> Option<String> {
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
