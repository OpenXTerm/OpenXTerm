use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub folder_path: Option<String>,
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    #[serde(default = "default_proxy_type")]
    pub proxy_type: String,
    #[serde(default)]
    pub proxy_host: Option<String>,
    #[serde(default)]
    pub proxy_port: Option<u16>,
    #[serde(default)]
    pub proxy_username: Option<String>,
    #[serde(default)]
    pub proxy_password: Option<String>,
    #[serde(default)]
    pub x11_forwarding: bool,
    #[serde(default = "default_x11_trusted")]
    pub x11_trusted: bool,
    #[serde(default)]
    pub x11_display: Option<String>,
    #[serde(default)]
    pub terminal_font_family: Option<String>,
    #[serde(default)]
    pub terminal_font_size: Option<u16>,
    #[serde(default)]
    pub terminal_foreground: Option<String>,
    #[serde(default)]
    pub terminal_background: Option<String>,
    #[serde(default)]
    pub linked_ssh_tab_id: Option<String>,
    #[serde(default)]
    pub local_working_directory: Option<String>,
    pub serial_port: Option<String>,
    pub baud_rate: Option<u32>,
    pub parity: String,
    pub stop_bits: u8,
    pub data_bits: u8,
    pub created_at: String,
    pub updated_at: String,
}

fn default_x11_trusted() -> bool {
    true
}

fn default_proxy_type() -> String {
    "none".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFolderDefinition {
    pub id: String,
    pub path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroDefinition {
    pub id: String,
    pub name: String,
    pub command: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferences {
    pub theme: String,
    pub active_sidebar: String,
    #[serde(default)]
    pub sidebar_width: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageModel {
    pub sessions: Vec<SessionDefinition>,
    #[serde(default)]
    pub session_folders: Vec<SessionFolderDefinition>,
    pub macros: Vec<MacroDefinition>,
    pub preferences: UiPreferences,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputPayload {
    pub tab_id: String,
    pub chunk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCwdPayload {
    pub tab_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitPayload {
    pub tab_id: String,
    pub code: Option<i32>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusSnapshot {
    pub mode: String,
    pub host: String,
    pub user: String,
    pub remote_os: String,
    pub uptime: String,
    pub cpu_load: String,
    pub memory_usage: String,
    pub disk_usage: String,
    pub network: String,
    pub latency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusPayload {
    pub tab_id: String,
    #[serde(flatten)]
    pub snapshot: SessionStatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size_bytes: Option<u64>,
    pub size_label: String,
    pub modified_label: String,
    #[serde(default)]
    pub created_label: Option<String>,
    #[serde(default)]
    pub owner_label: Option<String>,
    #[serde(default)]
    pub group_label: Option<String>,
    #[serde(default)]
    pub access_label: Option<String>,
    #[serde(default)]
    pub permissions: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectorySnapshot {
    pub path: String,
    pub entries: Vec<RemoteFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDownloadResult {
    pub file_name: String,
    pub saved_to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTargetInspection {
    pub file_name: String,
    pub path: String,
    pub exists: bool,
    pub suggested_file_name: String,
    pub suggested_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDragEntry {
    pub remote_path: String,
    pub file_name: String,
    pub kind: String,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    pub transfer_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressPayload {
    pub transfer_id: String,
    pub file_name: String,
    pub remote_path: String,
    pub direction: String,
    pub purpose: String,
    pub state: String,
    pub transferred_bytes: u64,
    pub total_bytes: Option<u64>,
    pub message: String,
    pub local_path: Option<String>,
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalX11SupportPayload {
    pub system_x11_available: bool,
    pub system_display: Option<String>,
    pub message: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibsshProbePayload {
    pub backend: String,
    pub authenticated_user: String,
    pub known_hosts: String,
    pub pty_supported: bool,
    pub pty_term: String,
    pub remote_command: String,
    pub exec_stdout: String,
    pub exec_stderr: String,
    pub exec_exit_status: Option<i32>,
    pub remote_path: String,
    pub sftp_entries: Vec<RemoteFileEntry>,
    pub notes: Vec<String>,
}
