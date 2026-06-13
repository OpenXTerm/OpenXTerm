use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use libssh_rs::{KnownHosts, PublicKeyHashType, Session as LibsshSession};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const HOST_KEY_PROMPT_EVENT: &str = "openxterm://ssh-host-key-prompt";
const DECISION_TIMEOUT: Duration = Duration::from_secs(300);
const DECISION_POLL: Duration = Duration::from_millis(150);
const REQUEST_PREFIX: &str = "hk-";

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static KNOWN_HOSTS_PATH: OnceLock<PathBuf> = OnceLock::new();
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// What the user chose when asked to trust a host key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostKeyDecision {
    /// Store the key in the known_hosts file (and replace a changed one).
    Store,
    /// Connect this time only, without persisting the key.
    Once,
    /// Abort the connection.
    Reject,
}

impl HostKeyDecision {
    pub(crate) fn from_wire(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "store" | "overwrite" | "accept" => Some(Self::Store),
            "once" => Some(Self::Once),
            "reject" | "cancel" => Some(Self::Reject),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostKeyKind {
    Unknown,
    Changed,
}

impl HostKeyKind {
    fn as_str(self) -> &'static str {
        match self {
            HostKeyKind::Unknown => "unknown",
            HostKeyKind::Changed => "changed",
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HostKeyPromptPayload {
    request_id: String,
    host: String,
    port: u16,
    fingerprint: String,
    kind: &'static str,
    session_label: String,
}

fn pending() -> &'static Mutex<HashMap<u64, mpsc::Sender<HostKeyDecision>>> {
    static PENDING: OnceLock<Mutex<HashMap<u64, mpsc::Sender<HostKeyDecision>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn accepted_once() -> &'static Mutex<HashSet<String>> {
    static ACCEPTED_ONCE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACCEPTED_ONCE.get_or_init(|| Mutex::new(HashSet::new()))
}

fn host_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static HOST_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    HOST_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Wire up the app handle and resolve where known hosts are persisted.
/// Called once during Tauri setup.
pub(crate) fn init(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = KNOWN_HOSTS_PATH.set(dir.join("known_hosts"));
    }
}

/// The known_hosts file path, if it could be resolved.
pub(crate) fn known_hosts_path() -> Option<&'static Path> {
    KNOWN_HOSTS_PATH.get().map(PathBuf::as_path)
}

/// Deliver a decision made in the UI back to the blocked connection thread.
pub(crate) fn resolve(request_id: &str, decision: HostKeyDecision) {
    let Some(sequence) = request_id
        .strip_prefix(REQUEST_PREFIX)
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return;
    };

    let sender = pending()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&sequence));
    if let Some(sender) = sender {
        let _ = sender.send(decision);
    }
}

/// Verify the public key of the already-connected server against our
/// known_hosts file. Unknown or changed keys raise a UI prompt and block
/// until the user decides. Must be called after `connect()` but before
/// any credentials are sent.
pub(crate) fn verify_connected_server(
    ssh: &LibsshSession,
    host: &str,
    port: u16,
    session_label: &str,
    abort: Option<&Arc<AtomicBool>>,
) -> Result<(), String> {
    if known_hosts_path().is_none() {
        // Without a writable store we cannot pin or compare keys; skip rather
        // than silently fall back to the user's ~/.ssh/known_hosts.
        return Ok(());
    }

    if current_status(ssh)? == KnownHosts::Ok {
        return Ok(());
    }

    let endpoint = format!("{host}:{port}");
    let lock = host_lock(&endpoint);
    let _guard = lock.lock().unwrap_or_else(|poison| poison.into_inner());

    // Re-check under the per-host lock: a concurrent connection to the same
    // host may have just stored the key while we waited for the lock.
    let kind = match current_status(ssh)? {
        KnownHosts::Ok => return Ok(()),
        KnownHosts::NotFound | KnownHosts::Unknown => HostKeyKind::Unknown,
        KnownHosts::Changed | KnownHosts::Other => HostKeyKind::Changed,
    };

    let fingerprint = server_fingerprint(ssh)?;
    let once_key = format!("{endpoint}|{fingerprint}");
    if accepted_once()
        .lock()
        .map(|set| set.contains(&once_key))
        .unwrap_or(false)
    {
        return Ok(());
    }

    match prompt_decision(host, port, &fingerprint, kind, session_label, abort)? {
        HostKeyDecision::Store => store_known_host(ssh, host, port, kind),
        HostKeyDecision::Once => {
            if let Ok(mut set) = accepted_once().lock() {
                set.insert(once_key);
            }
            Ok(())
        }
        HostKeyDecision::Reject => Err(rejection_message(kind)),
    }
}

fn current_status(ssh: &LibsshSession) -> Result<KnownHosts, String> {
    ssh.is_known_server()
        .map_err(|error| format!("failed to verify the server host key: {error}"))
}

fn server_fingerprint(ssh: &LibsshSession) -> Result<String, String> {
    let key = ssh
        .get_server_public_key()
        .map_err(|error| format!("failed to read the server host key: {error}"))?;
    key.get_public_key_hash_hexa(PublicKeyHashType::Sha256)
        .map_err(|error| format!("failed to fingerprint the server host key: {error}"))
}

fn prompt_decision(
    host: &str,
    port: u16,
    fingerprint: &str,
    kind: HostKeyKind,
    session_label: &str,
    abort: Option<&Arc<AtomicBool>>,
) -> Result<HostKeyDecision, String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "cannot prompt for host key trust: app handle is unavailable".to_string())?;

    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let request_id = format!("{REQUEST_PREFIX}{sequence}");
    let (sender, receiver) = mpsc::channel();
    if let Ok(mut map) = pending().lock() {
        map.insert(sequence, sender);
    }

    let _ = app.emit(
        HOST_KEY_PROMPT_EVENT,
        HostKeyPromptPayload {
            request_id,
            host: host.to_string(),
            port,
            fingerprint: fingerprint.to_string(),
            kind: kind.as_str(),
            session_label: session_label.to_string(),
        },
    );

    let started = Instant::now();
    let decision = loop {
        if abort.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            break HostKeyDecision::Reject;
        }
        match receiver.recv_timeout(DECISION_POLL) {
            Ok(decision) => break decision,
            Err(RecvTimeoutError::Timeout) => {
                if started.elapsed() >= DECISION_TIMEOUT {
                    break HostKeyDecision::Reject;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break HostKeyDecision::Reject,
        }
    };

    if let Ok(mut map) = pending().lock() {
        map.remove(&sequence);
    }

    Ok(decision)
}

fn store_known_host(
    ssh: &LibsshSession,
    host: &str,
    port: u16,
    kind: HostKeyKind,
) -> Result<(), String> {
    if kind == HostKeyKind::Changed {
        if let Some(path) = known_hosts_path() {
            remove_host_lines(path, host, port)?;
        }
    }

    ssh.update_known_hosts_file()
        .map_err(|error| format!("failed to store the server host key: {error}"))?;

    if let Some(path) = known_hosts_path() {
        harden_permissions(path);
    }

    Ok(())
}

/// The token libssh writes for a host: the bare hostname on port 22,
/// otherwise the bracketed `[host]:port` form.
fn host_token(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Drop every existing known_hosts line that matches this host so an
/// "overwrite" really replaces a changed key instead of leaving a stale one.
fn remove_host_lines(path: &Path, host: &str, port: u16) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("failed to read known_hosts: {error}"))?;
    let token = host_token(host, port);

    let kept = content
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return true;
            }
            let patterns = trimmed.split_whitespace().next().unwrap_or_default();
            !patterns
                .split(',')
                .any(|pattern| pattern == token || pattern == host)
        })
        .collect::<Vec<_>>();

    let mut rewritten = kept.join("\n");
    if !rewritten.is_empty() {
        rewritten.push('\n');
    }
    fs::write(path, rewritten)
        .map_err(|error| format!("failed to rewrite known_hosts: {error}"))
}

fn harden_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn host_lock(endpoint: &str) -> Arc<Mutex<()>> {
    let mut map = host_locks()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    map.entry(endpoint.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn rejection_message(kind: HostKeyKind) -> String {
    match kind {
        HostKeyKind::Unknown => {
            "Connection cancelled: the server host key was not trusted.".to_string()
        }
        HostKeyKind::Changed => {
            "Connection cancelled: the server host key has changed and was not trusted.".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_token_uses_bracket_form_for_non_default_ports() {
        assert_eq!(host_token("example.com", 22), "example.com");
        assert_eq!(host_token("example.com", 2222), "[example.com]:2222");
    }

    #[test]
    fn decision_parses_known_wire_values() {
        assert_eq!(HostKeyDecision::from_wire("store"), Some(HostKeyDecision::Store));
        assert_eq!(
            HostKeyDecision::from_wire("overwrite"),
            Some(HostKeyDecision::Store)
        );
        assert_eq!(HostKeyDecision::from_wire("ONCE"), Some(HostKeyDecision::Once));
        assert_eq!(
            HostKeyDecision::from_wire("cancel"),
            Some(HostKeyDecision::Reject)
        );
        assert_eq!(HostKeyDecision::from_wire("nonsense"), None);
    }

    #[test]
    fn remove_host_lines_drops_matching_host_and_keeps_others() {
        let dir = std::env::temp_dir().join(format!(
            "openxterm-known-hosts-test-{}",
            REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("known_hosts");
        fs::write(
            &path,
            "example.com ssh-ed25519 AAAAOLD\n\
             [example.com]:2222 ssh-ed25519 AAAAPORTED\n\
             other.test ssh-ed25519 AAAAKEEP\n\
             # comment line\n",
        )
        .expect("seed known_hosts");

        remove_host_lines(&path, "example.com", 22).expect("rewrite known_hosts");

        let result = fs::read_to_string(&path).expect("read known_hosts");
        assert!(!result.contains("AAAAOLD"), "stale port-22 line should be gone");
        assert!(
            result.contains("AAAAPORTED"),
            "the [host]:2222 entry should survive a port-22 removal"
        );
        assert!(result.contains("AAAAKEEP"), "unrelated host should survive");
        assert!(result.contains("# comment line"), "comments should survive");

        fs::remove_dir_all(&dir).expect("cleanup temp dir");
    }
}
