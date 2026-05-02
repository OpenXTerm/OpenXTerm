use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    hash::{DefaultHasher, Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const SSH_RUNTIME_METADATA_DIR: &str = "oxt-ssh-runtime";

#[derive(Clone, Default)]
struct SshRuntimeAuthState {
    username: Option<String>,
    password: Option<String>,
}

fn ssh_runtime_auth_store() -> &'static Mutex<HashMap<String, SshRuntimeAuthState>> {
    static SSH_RUNTIME_AUTH: OnceLock<Mutex<HashMap<String, SshRuntimeAuthState>>> =
        OnceLock::new();
    SSH_RUNTIME_AUTH.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(in crate::runtime) fn set_ssh_runtime_auth(
    tab_id: &str,
    username: Option<String>,
    password: Option<String>,
) {
    if let Ok(mut store) = ssh_runtime_auth_store().lock() {
        let entry = store.entry(tab_id.to_string()).or_default();
        if let Some(username) = username {
            entry.username = Some(username.clone());
            let _ = write_ssh_runtime_username(tab_id, &username);
        }
        if let Some(password) = password {
            entry.password = Some(password);
        }
    }
}

pub(crate) fn ssh_runtime_username(tab_id: &str) -> Option<String> {
    ssh_runtime_auth_store()
        .lock()
        .ok()
        .and_then(|store| store.get(tab_id).and_then(|entry| entry.username.clone()))
}

pub(crate) fn ssh_runtime_password(tab_id: &str) -> Option<String> {
    ssh_runtime_auth_store()
        .lock()
        .ok()
        .and_then(|store| store.get(tab_id).and_then(|entry| entry.password.clone()))
}

pub(in crate::runtime) fn clear_ssh_runtime_auth(tab_id: &str) {
    if let Ok(mut store) = ssh_runtime_auth_store().lock() {
        store.remove(tab_id);
    }
}

fn ssh_runtime_metadata_stem_for_tab(tab_id: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    tab_id.hash(&mut hasher);
    ssh_runtime_metadata_dir().join(format!("{:016x}", hasher.finish()))
}

pub(in crate::runtime) fn ssh_runtime_username_path_for_tab(tab_id: &str) -> PathBuf {
    ssh_runtime_metadata_stem_for_tab(tab_id).with_extension("user")
}

fn ssh_runtime_metadata_dir() -> PathBuf {
    std::env::temp_dir().join(SSH_RUNTIME_METADATA_DIR)
}

fn prepare_ssh_runtime_metadata_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| {
        format!(
            "failed to prepare SSH runtime metadata directory {}: {error}",
            path.display()
        )
    })
}

fn remove_ssh_runtime_username_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove stale SSH login metadata {}: {error}",
            path.display()
        )),
    }
}

fn write_ssh_runtime_username(tab_id: &str, username: &str) -> Result<(), String> {
    let username_path = ssh_runtime_username_path_for_tab(tab_id);
    if let Some(parent) = username_path.parent() {
        prepare_ssh_runtime_metadata_dir(parent)?;
    }

    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options
        .open(&username_path)
        .map_err(|error| format!("failed to write SSH login metadata: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to protect SSH login metadata: {error}"))?;
    }
    file.write_all(format!("{username}\n").as_bytes())
        .map_err(|error| format!("failed to write SSH login metadata: {error}"))
}

pub(in crate::runtime) fn prepare_ssh_runtime_metadata(tab_id: &str) -> Result<(), String> {
    let username_path = ssh_runtime_username_path_for_tab(tab_id);
    if let Some(parent) = username_path.parent() {
        prepare_ssh_runtime_metadata_dir(parent)?;
    }
    remove_ssh_runtime_username_file(&username_path)?;

    Ok(())
}

pub(in crate::runtime) fn cleanup_ssh_runtime_metadata(tab_id: &str) {
    let _ = remove_ssh_runtime_username_file(&ssh_runtime_username_path_for_tab(tab_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_username_path_uses_process_temp_dir() {
        let path = ssh_runtime_username_path_for_tab("tab-runtime-auth-path-test");

        assert!(path.starts_with(std::env::temp_dir()));
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("user")
        );
    }

    #[cfg(unix)]
    #[test]
    fn written_username_metadata_is_user_only() {
        use std::os::unix::fs::PermissionsExt;

        let tab_id = "tab-runtime-auth-permissions-test";
        prepare_ssh_runtime_metadata(tab_id).expect("metadata cleanup should work");
        write_ssh_runtime_username(tab_id, "alice").expect("metadata write should work");

        let path = ssh_runtime_username_path_for_tab(tab_id);
        let mode = fs::metadata(&path)
            .expect("metadata should exist")
            .permissions()
            .mode()
            & 0o777;

        cleanup_ssh_runtime_metadata(tab_id);

        assert_eq!(mode, 0o600);
    }
}
