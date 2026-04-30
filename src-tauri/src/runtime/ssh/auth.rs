use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    hash::{DefaultHasher, Hash, Hasher},
    io::Write,
    path::PathBuf,
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
    std::env::temp_dir()
        .join(SSH_RUNTIME_METADATA_DIR)
        .join(format!("{:016x}", hasher.finish()))
}

pub(in crate::runtime) fn ssh_runtime_username_path_for_tab(tab_id: &str) -> PathBuf {
    ssh_runtime_metadata_stem_for_tab(tab_id).with_extension("user")
}

fn write_ssh_runtime_username(tab_id: &str, username: &str) -> Result<(), String> {
    let username_path = ssh_runtime_username_path_for_tab(tab_id);
    if let Some(parent) = username_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to prepare SSH runtime metadata directory {}: {error}",
                parent.display()
            )
        })?;
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
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to prepare SSH runtime metadata directory {}: {error}",
                parent.display()
            )
        })?;
    }

    if username_path.exists() {
        fs::remove_file(&username_path).map_err(|error| {
            format!(
                "failed to remove stale SSH login metadata {}: {error}",
                username_path.display()
            )
        })?;
    }

    Ok(())
}

pub(in crate::runtime) fn cleanup_ssh_runtime_metadata(tab_id: &str) {
    let _ = fs::remove_file(ssh_runtime_username_path_for_tab(tab_id));
}
