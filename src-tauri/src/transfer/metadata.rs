use std::time::{SystemTime, UNIX_EPOCH};

use libssh_rs::FileType;
use time::{format_description::parse, OffsetDateTime};

pub(super) fn format_size(size_bytes: Option<u64>) -> String {
    let Some(bytes) = size_bytes else {
        return "--".into();
    };

    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit_index = 0usize;
    while value >= 1024.0 && unit_index < UNITS.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }

    if unit_index == 0 {
        format!("{bytes} {}", UNITS[unit_index])
    } else {
        format!("{value:.1} {}", UNITS[unit_index])
    }
}

pub(super) fn format_system_time(timestamp: Option<SystemTime>) -> String {
    let Some(timestamp) = timestamp else {
        return "--".into();
    };

    let Ok(timestamp) = timestamp.duration_since(UNIX_EPOCH) else {
        return "--".into();
    };
    let timestamp = timestamp.as_secs() as i64;

    let Ok(format) = parse("[year]-[month]-[day] [hour]:[minute]") else {
        return timestamp.to_string();
    };
    let Ok(datetime) = OffsetDateTime::from_unix_timestamp(timestamp) else {
        return timestamp.to_string();
    };

    datetime
        .format(&format)
        .unwrap_or_else(|_| timestamp.to_string())
}

pub(super) fn is_directory(file_type: Option<FileType>) -> bool {
    matches!(file_type, Some(FileType::Directory))
}

pub(super) fn format_access_label(
    file_type: Option<FileType>,
    permissions: Option<u32>,
) -> Option<String> {
    let permissions = permissions?;
    let kind = if is_directory(file_type) { 'd' } else { '-' };
    Some(format!(
        "{}{}{}{}",
        kind,
        format_permission_triplet((permissions >> 6) & 0o7),
        format_permission_triplet((permissions >> 3) & 0o7),
        format_permission_triplet(permissions & 0o7),
    ))
}

pub(super) fn parse_access_permissions(access: &str) -> Option<u32> {
    let chars = access.chars().collect::<Vec<_>>();
    if chars.len() < 10 {
        return None;
    }

    let mut permissions = 0_u32;
    for (offset, ch) in chars[1..10].iter().enumerate() {
        let bit = match offset % 3 {
            0 => 0o4,
            1 => 0o2,
            _ => 0o1,
        };
        if *ch != '-' {
            let shift = 6 - ((offset / 3) as u32 * 3);
            permissions |= bit << shift;
        }
    }

    Some(permissions)
}

fn format_permission_triplet(bits: u32) -> String {
    let read = if bits & 0o4 != 0 { 'r' } else { '-' };
    let write = if bits & 0o2 != 0 { 'w' } else { '-' };
    let execute = if bits & 0o1 != 0 { 'x' } else { '-' };
    format!("{read}{write}{execute}")
}
