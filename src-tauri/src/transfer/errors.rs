use std::{fmt::Display, io, path::Path};

pub(super) fn describe_remote_error(
    action: &str,
    remote_path: &str,
    error: impl Display,
) -> String {
    let raw = error.to_string();
    format!(
        "Cannot {action} {}: {}",
        display_remote_path(remote_path),
        classify_remote_error(&raw)
    )
}

pub(super) fn describe_local_io_error(
    action: &str,
    local_path: &Path,
    error: &io::Error,
) -> String {
    format!(
        "Cannot {action} {}: {}",
        local_path.display(),
        classify_local_io_error(error)
    )
}

pub(super) fn is_remote_not_found_error(error: impl Display) -> bool {
    let raw = error.to_string();
    let lower = raw.to_ascii_lowercase();
    contains_any(&lower, REMOTE_NOT_FOUND_MARKERS)
}

pub(super) fn is_remote_already_exists_error(error: impl Display) -> bool {
    let raw = error.to_string();
    let lower = raw.to_ascii_lowercase();
    contains_any(&lower, REMOTE_ALREADY_EXISTS_MARKERS)
}

pub(super) fn is_remote_ambiguous_failure_error(error: impl Display) -> bool {
    let raw = error.to_string();
    let lower = raw.to_ascii_lowercase();
    lower.contains("sftp error code 4") || (lower.contains("sftp") && lower.contains("failure"))
}

fn classify_remote_error(raw: &str) -> String {
    classify_error_message(raw, ErrorSide::Remote)
}

fn classify_local_io_error(error: &io::Error) -> String {
    if error.kind() == io::ErrorKind::PermissionDenied {
        return with_raw(
            "permission denied locally. Check the folder permissions or choose another target.",
            error,
        );
    }

    if is_local_no_space(error) {
        return with_raw(
            "the local disk or quota is full. Free space or choose another target, then retry.",
            error,
        );
    }

    if error.kind() == io::ErrorKind::NotFound {
        return with_raw(
            "the local path does not exist anymore. Refresh the directory and retry.",
            error,
        );
    }

    classify_error_message(&error.to_string(), ErrorSide::Local)
}

#[derive(Clone, Copy)]
enum ErrorSide {
    Local,
    Remote,
}

fn classify_error_message(raw: &str, side: ErrorSide) -> String {
    let lower = raw.to_ascii_lowercase();

    if contains_any(&lower, NO_SPACE_MARKERS) {
        return with_raw(
            match side {
                ErrorSide::Local => {
                    "the local disk or quota is full. Free space or choose another target, then retry."
                }
                ErrorSide::Remote => {
                    "the remote disk or quota is full. Free space on the server or choose another target, then retry."
                }
            },
            raw,
        );
    }

    if contains_any(&lower, PERMISSION_MARKERS) {
        return with_raw(
            match side {
                ErrorSide::Local => {
                    "permission denied locally. Check the folder permissions or choose another target."
                }
                ErrorSide::Remote => {
                    "permission denied by the remote host. Check ownership, permissions, or use a directory you can write to."
                }
            },
            raw,
        );
    }

    if contains_any(&lower, CONNECTION_MARKERS) {
        return with_raw(
            "the SFTP connection was interrupted. Reconnect or retry when the network is stable.",
            raw,
        );
    }

    if contains_any(&lower, REMOTE_NOT_FOUND_MARKERS) {
        return with_raw(
            "the path does not exist anymore. Refresh the directory and retry.",
            raw,
        );
    }

    if contains_any(&lower, REMOTE_ALREADY_EXISTS_MARKERS) {
        return with_raw(
            "the path already exists. Choose overwrite, skip, or rename.",
            raw,
        );
    }

    if contains_any(&lower, UNSUPPORTED_MARKERS) {
        return with_raw("the remote server does not support this operation.", raw);
    }

    if lower.contains("sftp error code 0") {
        return with_raw(
            "the SFTP server returned a temporary unavailable status. The transfer may have stalled; retry after checking the connection.",
            raw,
        );
    }

    raw.to_string()
}

fn is_local_no_space(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(28) | Some(112))
        || contains_any(&error.to_string().to_ascii_lowercase(), NO_SPACE_MARKERS)
}

fn display_remote_path(remote_path: &str) -> &str {
    if remote_path.trim().is_empty() {
        "remote path"
    } else {
        remote_path
    }
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn with_raw(message: &str, raw: impl Display) -> String {
    format!("{message} ({raw})")
}

const PERMISSION_MARKERS: &[&str] = &[
    "permission denied",
    "access denied",
    "operation not permitted",
    "not permitted",
    "write protect",
    "write-protect",
    "sftp error code 3",
    "sftp error code 12",
    "eacces",
    "eperm",
];

const NO_SPACE_MARKERS: &[&str] = &[
    "no space left",
    "not enough space",
    "disk full",
    "quota exceeded",
    "no_space",
    "enospc",
    "sftp error code 14",
    "sftp error code 15",
];

const CONNECTION_MARKERS: &[&str] = &[
    "connection lost",
    "connection reset",
    "broken pipe",
    "timed out",
    "timeout",
    "eof",
    "channel is closed",
    "channel closed",
    "socket",
    "network",
    "sftp error code 6",
    "sftp error code 7",
];

const REMOTE_NOT_FOUND_MARKERS: &[&str] = &[
    "no such file",
    "no such path",
    "not found",
    "does not exist",
    "sftp error code 2",
    "sftp error code 10",
];

const REMOTE_ALREADY_EXISTS_MARKERS: &[&str] =
    &["already exists", "file exists", "sftp error code 11"];

const UNSUPPORTED_MARKERS: &[&str] = &[
    "operation unsupported",
    "unsupported",
    "not supported",
    "sftp error code 8",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_remote_permission_errors() {
        let message =
            describe_remote_error("upload remote file", "/root/a.bin", "SFTP error code 3");
        assert!(message.contains("permission denied"));
        assert!(message.contains("/root/a.bin"));
    }

    #[test]
    fn classifies_remote_no_space_errors() {
        let message =
            describe_remote_error("upload remote file", "/tmp/a.bin", "SFTP error code 14");
        assert!(message.contains("remote disk or quota is full"));
    }

    #[test]
    fn classifies_ambiguous_sftp_zero_errors() {
        let message =
            describe_remote_error("upload remote file", "/tmp/a.bin", "sftp error code 0");
        assert!(message.contains("temporary unavailable"));
    }

    #[test]
    fn detects_remote_not_found_without_swallowing_every_error() {
        assert!(is_remote_not_found_error("SFTP error code 2"));
        assert!(!is_remote_not_found_error("SFTP error code 3"));
    }

    #[test]
    fn detects_generic_sftp_failures_as_ambiguous() {
        assert!(is_remote_ambiguous_failure_error("SFTP error code 4"));
        assert!(!is_remote_ambiguous_failure_error("SFTP error code 3"));
    }
}
