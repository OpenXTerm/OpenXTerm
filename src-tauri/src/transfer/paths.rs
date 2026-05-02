use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager};

pub(super) fn parent_remote_path(path: &str) -> String {
    let mut parts = path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let _ = parts.pop();

    if parts.is_empty() {
        "/".into()
    } else {
        format!("/{}", parts.join("/"))
    }
}

pub(super) fn normalize_remote_path(path: Option<&str>) -> String {
    match path {
        Some(value) if !value.trim().is_empty() => {
            if value.starts_with('/') {
                value.to_string()
            } else {
                format!("/{value}")
            }
        }
        _ => "/".into(),
    }
}

pub(super) fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{}", name.trim_start_matches('/'))
    } else {
        format!(
            "{}/{}",
            parent.trim_end_matches('/'),
            name.trim_start_matches('/'),
        )
    }
}

pub(super) fn remote_file_name(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or("download.bin")
        .to_string()
}

pub(super) fn download_target_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("failed to resolve downloads directory: {error}"))?
        .join("OpenXTerm");
    fs::create_dir_all(&downloads_dir)
        .map_err(|error| format!("failed to create {}: {error}", downloads_dir.display()))?;
    Ok(downloads_dir.join(file_name))
}

pub(super) fn unique_local_file_name(parent: Option<&Path>, file_name: &str) -> String {
    let Some(parent) = parent else {
        return file_name.to_string();
    };

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(file_name);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    for index in 1..10_000 {
        let suffix = if index == 1 {
            " copy".to_string()
        } else {
            format!(" copy {index}")
        };
        let candidate = format!("{stem}{suffix}{extension}");
        if !parent.join(&candidate).exists() {
            return candidate;
        }
    }

    format!(
        "{stem} copy {}{extension}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    )
}

pub(super) fn sanitize_transfer_name(file_name: &str) -> String {
    let sanitized = sanitize_file_name(file_name.trim());
    if sanitized.is_empty() {
        "transfer.bin".into()
    } else {
        sanitized
    }
}

pub(super) fn drag_cache_path(file_name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    std::env::temp_dir()
        .join("openxterm-drag-cache")
        .join(format!("{stamp}-{}", sanitize_file_name(file_name)))
}

pub(super) fn temp_upload_path(file_name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("openxterm-upload-{stamp}-{file_name}"))
}

pub(super) fn local_directory_total_size(path: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    let entries = fs::read_dir(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to read {}: {error}", entry.path().display()))?;

        if metadata.is_dir() {
            total += local_directory_total_size(&entry.path())?;
        } else {
            total += metadata.len();
        }
    }

    Ok(total)
}

fn sanitize_file_name(file_name: &str) -> String {
    file_name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect()
}
