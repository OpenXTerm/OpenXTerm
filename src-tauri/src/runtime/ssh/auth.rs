use std::{
    collections::HashMap,
    fs,
    hash::{DefaultHasher, Hash, Hasher},
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
            let _ = fs::write(
                ssh_runtime_username_path_for_tab(tab_id),
                format!("{username}\n"),
            );
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

#[cfg(not(windows))]
fn ssh_runtime_metadata_base_path_for_tab(tab_id: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    tab_id.hash(&mut hasher);
    PathBuf::from("/tmp")
        .join(SSH_RUNTIME_METADATA_DIR)
        .join(format!("{:016x}.runtime", hasher.finish()))
}

#[cfg(windows)]
fn ssh_runtime_metadata_base_path_for_tab(tab_id: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    tab_id.hash(&mut hasher);
    std::env::temp_dir()
        .join(SSH_RUNTIME_METADATA_DIR)
        .join(format!("{:016x}.runtime", hasher.finish()))
}

pub(in crate::runtime) fn ssh_runtime_username_path_for_tab(tab_id: &str) -> PathBuf {
    ssh_runtime_metadata_base_path_for_tab(tab_id).with_extension("user")
}

pub(in crate::runtime) fn prepare_ssh_runtime_metadata(tab_id: &str) -> Result<(), String> {
    let metadata_path = ssh_runtime_metadata_base_path_for_tab(tab_id);
    if let Some(parent) = metadata_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to prepare SSH runtime metadata directory {}: {error}",
                parent.display()
            )
        })?;
    }

    if metadata_path.exists() {
        fs::remove_file(&metadata_path).map_err(|error| {
            format!(
                "failed to remove stale SSH runtime metadata {}: {error}",
                metadata_path.display()
            )
        })?;
    }
    let username_path = ssh_runtime_username_path_for_tab(tab_id);
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
    let metadata_path = ssh_runtime_metadata_base_path_for_tab(tab_id);
    let _ = fs::remove_file(metadata_path);
    let _ = fs::remove_file(ssh_runtime_username_path_for_tab(tab_id));
}
