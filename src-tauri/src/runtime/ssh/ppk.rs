use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use libssh_rs::SshKey;
use ssh_key::{LineEnding, PrivateKey};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

pub(super) fn private_key_file_looks_like_putty(key_path: &str) -> bool {
    let path = Path::new(key_path);
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ppk"))
    {
        return true;
    }

    fs::read_to_string(path)
        .map(|contents| ppk_text_looks_like_putty(&contents))
        .unwrap_or(false)
}

pub(super) fn load_private_key_for_libssh(
    key_path: &str,
    passphrase: Option<&str>,
) -> Result<SshKey, String> {
    if private_key_file_looks_like_putty(key_path) {
        return load_putty_private_key_for_libssh(key_path, passphrase);
    }

    SshKey::from_privkey_file(key_path, passphrase)
        .map_err(|error| format!("failed to load private key: {error}"))
}

fn load_putty_private_key_for_libssh(
    key_path: &str,
    passphrase: Option<&str>,
) -> Result<SshKey, String> {
    let ppk = fs::read_to_string(key_path)
        .map_err(|error| format!("failed to read PuTTY PPK private key: {error}"))?;
    let openssh = convert_putty_ppk_to_openssh(&ppk, passphrase)?;
    let temp_path = write_temp_private_key(&openssh)?;
    let load_result = SshKey::from_privkey_file(path_to_str(&temp_path)?, None)
        .map_err(|error| format!("failed to load converted PuTTY PPK key: {error}"));
    let cleanup_result = fs::remove_file(&temp_path);

    match (load_result, cleanup_result) {
        (Ok(key), Ok(())) => Ok(key),
        (Ok(key), Err(error)) => {
            log::warn!(
                "failed to remove temporary converted PuTTY PPK key {}: {error}",
                temp_path.display()
            );
            Ok(key)
        }
        (Err(error), _) => Err(error),
    }
}

fn convert_putty_ppk_to_openssh(ppk: &str, passphrase: Option<&str>) -> Result<String, String> {
    let key = PrivateKey::from_ppk(
        ppk,
        passphrase
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    )
    .map_err(|error| putty_parse_error_message(&error.to_string()))?;

    key.to_openssh(LineEnding::LF)
        .map(|value| value.to_string())
        .map_err(|error| format!("failed to serialize PuTTY PPK as OpenSSH key: {error}"))
}

fn putty_parse_error_message(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("password")
        || lower.contains("passphrase")
        || lower.contains("decrypt")
        || lower.contains("mac")
        || lower.contains("encrypted")
    {
        return "failed to parse PuTTY PPK private key. If it is encrypted, save its passphrase in the key passphrase field and retry.".into();
    }

    format!("failed to parse PuTTY PPK private key: {error}")
}

fn write_temp_private_key(contents: &str) -> Result<PathBuf, String> {
    let mut last_error = None;
    for attempt in 0..16 {
        let path = temp_private_key_path(attempt)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);

        match options.open(&path) {
            Ok(mut file) => {
                file.write_all(contents.as_bytes()).map_err(|error| {
                    let _ = fs::remove_file(&path);
                    format!("failed to write converted PuTTY PPK key: {error}")
                })?;
                file.flush().map_err(|error| {
                    let _ = fs::remove_file(&path);
                    format!("failed to flush converted PuTTY PPK key: {error}")
                })?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => {
                return Err(format!(
                    "failed to create temporary converted PuTTY PPK key: {error}"
                ));
            }
        }
    }

    Err(format!(
        "failed to create temporary converted PuTTY PPK key: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "temporary filename collision".into())
    ))
}

fn temp_private_key_path(attempt: u32) -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock is before UNIX epoch: {error}"))?
        .as_nanos();
    Ok(std::env::temp_dir().join(format!(
        "openxterm-ppk-{}-{nonce}-{attempt}.key",
        std::process::id()
    )))
}

fn path_to_str(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("temporary key path is not valid UTF-8: {}", path.display()))
}

fn ppk_text_looks_like_putty(contents: &str) -> bool {
    contents.trim_start().starts_with("PuTTY-User-Key-File-")
}

#[cfg(test)]
mod tests {
    use super::{
        convert_putty_ppk_to_openssh, load_private_key_for_libssh, ppk_text_looks_like_putty,
        private_key_file_looks_like_putty,
    };
    use std::{env, fs};

    const ED25519_PPK: &str = r#"PuTTY-User-Key-File-3: ssh-ed25519
Encryption: none
Comment: user@example.com
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XF
Sqti
Private-Lines: 1
AAAAILYGwiLRDBba4WxwpNRRc0cuxhfgXGVpINJuVsCPtZHt
Private-MAC: 94140d0344fad6aa1bf7b71e9c93db11ccac8a232f8a51e11c024869d608c82d
"#;

    #[test]
    fn ppk_text_header_is_detected() {
        assert!(ppk_text_looks_like_putty(ED25519_PPK));
        assert!(!ppk_text_looks_like_putty(
            "-----BEGIN OPENSSH PRIVATE KEY-----"
        ));
    }

    #[test]
    fn ppk_extension_is_detected_as_putty_key() {
        let path = env::temp_dir().join("oxt-ppk-extension-test.ppk");
        fs::write(&path, "not a real key").expect("temp write");
        assert!(private_key_file_looks_like_putty(path.to_str().unwrap()));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ppk_header_is_detected_as_putty_key() {
        let path = env::temp_dir().join("oxt-ppk-header-test.key");
        fs::write(&path, ED25519_PPK).expect("temp write");
        assert!(private_key_file_looks_like_putty(path.to_str().unwrap()));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn unencrypted_ed25519_ppk_converts_to_openssh() {
        let openssh = convert_putty_ppk_to_openssh(ED25519_PPK, None).expect("convert ppk");
        assert!(openssh.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(openssh.ends_with("-----END OPENSSH PRIVATE KEY-----\n"));
    }

    #[test]
    fn unencrypted_ed25519_ppk_loads_into_libssh() {
        let path = env::temp_dir().join("oxt-ppk-libssh-test.ppk");
        fs::write(&path, ED25519_PPK).expect("temp write");
        let key = load_private_key_for_libssh(path.to_str().unwrap(), None);
        let _ = fs::remove_file(path);
        assert!(key.is_ok());
    }
}
