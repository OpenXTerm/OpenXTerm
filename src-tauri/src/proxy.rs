use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::Duration,
};

#[cfg(unix)]
use std::os::fd::IntoRawFd;
#[cfg(windows)]
use std::os::windows::io::IntoRawSocket;

use libssh_rs::{Session as LibsshSession, SshOption};

use crate::models::SessionDefinition;

const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const PROXY_IO_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProxyKind {
    None,
    HttpConnect,
    Socks5,
}

pub fn connect_tcp_stream(session: &SessionDefinition) -> Result<TcpStream, String> {
    connect_tcp_stream_to(session, session.host.trim(), session.port)
}

pub fn configure_libssh_proxy_socket(
    ssh: &LibsshSession,
    session: &SessionDefinition,
) -> Result<(), String> {
    let proxy_kind = proxy_kind(session)?;
    match proxy_kind {
        ProxyKind::None => Ok(()),
        ProxyKind::HttpConnect | ProxyKind::Socks5 => {
            let stream =
                connect_tcp_stream_to_kind(session, session.host.trim(), session.port, proxy_kind)?;
            #[cfg(unix)]
            let socket = stream.into_raw_fd();
            #[cfg(windows)]
            let socket = stream.into_raw_socket();
            ssh.set_option(SshOption::Socket(socket))
                .map_err(|error| format!("failed to configure embedded SSH proxy socket: {error}"))
        }
    }
}

pub fn connect_tcp_stream_to(
    session: &SessionDefinition,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, String> {
    connect_tcp_stream_to_kind(session, target_host, target_port, proxy_kind(session)?)
}

fn connect_tcp_stream_to_kind(
    session: &SessionDefinition,
    target_host: &str,
    target_port: u16,
    proxy_kind: ProxyKind,
) -> Result<TcpStream, String> {
    match proxy_kind {
        ProxyKind::None => connect_direct(target_host, target_port),
        ProxyKind::HttpConnect => connect_http_proxy(session, target_host, target_port),
        ProxyKind::Socks5 => connect_socks5_proxy(session, target_host, target_port),
    }
}

pub fn configure_curl_proxy_args(
    command: &mut std::process::Command,
    session: &SessionDefinition,
) -> Result<(), String> {
    let proxy_kind = proxy_kind(session)?;

    match proxy_kind {
        ProxyKind::None => return Ok(()),
        ProxyKind::HttpConnect => {
            let (proxy_host, proxy_port) = proxy_endpoint(session)?;
            command
                .arg("--proxy")
                .arg(format!("http://{proxy_host}:{proxy_port}"));
        }
        ProxyKind::Socks5 => {
            let (proxy_host, proxy_port) = proxy_endpoint(session)?;
            command
                .arg("--proxy")
                .arg(format!("socks5h://{proxy_host}:{proxy_port}"));
        }
    }

    if let Some(credentials) = proxy_credentials(session) {
        command.arg("--proxy-user").arg(credentials);
    }
    Ok(())
}

fn connect_http_proxy(
    session: &SessionDefinition,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, String> {
    let mut stream = connect_proxy_server(session)?;
    let authority = format!("{target_host}:{target_port}");
    let mut request = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: Keep-Alive\r\n"
    );
    if let Some(credentials) = proxy_credentials(session) {
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(&base64_encode(credentials.as_bytes()));
        request.push_str("\r\n");
    }
    request.push_str("\r\n");

    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("failed to write HTTP proxy CONNECT request: {error}"))?;

    let mut response = Vec::new();
    let mut buffer = [0u8; 512];
    loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| format!("failed to read HTTP proxy CONNECT response: {error}"))?;
        if read == 0 {
            break;
        }
        response.extend_from_slice(&buffer[..read]);
        if response.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if response.len() > 16 * 1024 {
            return Err("HTTP proxy CONNECT response is too large".into());
        }
    }

    let response_text = String::from_utf8_lossy(&response);
    let status_line = response_text.lines().next().unwrap_or_default();
    if status_line.contains(" 200 ") || status_line.ends_with(" 200") {
        Ok(stream)
    } else {
        Err(format!("HTTP proxy CONNECT failed: {status_line}"))
    }
}

fn connect_socks5_proxy(
    session: &SessionDefinition,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, String> {
    let mut stream = connect_proxy_server(session)?;
    let has_auth = proxy_credentials(session).is_some();
    let methods: &[u8] = if has_auth { &[0x00, 0x02] } else { &[0x00] };
    let mut greeting = vec![0x05, methods.len() as u8];
    greeting.extend_from_slice(methods);
    stream
        .write_all(&greeting)
        .map_err(|error| format!("failed to write SOCKS5 greeting: {error}"))?;

    let mut method_response = [0u8; 2];
    stream
        .read_exact(&mut method_response)
        .map_err(|error| format!("failed to read SOCKS5 greeting response: {error}"))?;
    if method_response[0] != 0x05 {
        return Err("SOCKS5 proxy returned an invalid greeting".into());
    }
    match method_response[1] {
        0x00 => {}
        0x02 => authenticate_socks5(session, &mut stream)?,
        0xff => return Err("SOCKS5 proxy does not accept supported auth methods".into()),
        method => {
            return Err(format!(
                "SOCKS5 proxy selected unsupported auth method {method:#04x}"
            ))
        }
    }

    let host_bytes = target_host.as_bytes();
    if host_bytes.len() > u8::MAX as usize {
        return Err("SOCKS5 target hostname is too long".into());
    }
    let mut request = vec![0x05, 0x01, 0x00, 0x03, host_bytes.len() as u8];
    request.extend_from_slice(host_bytes);
    request.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&request)
        .map_err(|error| format!("failed to write SOCKS5 CONNECT request: {error}"))?;

    let mut header = [0u8; 4];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("failed to read SOCKS5 CONNECT response: {error}"))?;
    if header[0] != 0x05 {
        return Err("SOCKS5 proxy returned an invalid CONNECT response".into());
    }
    if header[1] != 0x00 {
        return Err(format!(
            "SOCKS5 proxy CONNECT failed: {}",
            socks5_reply_message(header[1])
        ));
    }

    match header[3] {
        0x01 => read_discard(&mut stream, 4)?,
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .map_err(|error| format!("failed to read SOCKS5 bound host length: {error}"))?;
            read_discard(&mut stream, len[0] as usize)?;
        }
        0x04 => read_discard(&mut stream, 16)?,
        value => {
            return Err(format!(
                "SOCKS5 proxy returned unsupported address type {value:#04x}"
            ))
        }
    }
    read_discard(&mut stream, 2)?;
    Ok(stream)
}

fn authenticate_socks5(session: &SessionDefinition, stream: &mut TcpStream) -> Result<(), String> {
    let username = session
        .proxy_username
        .as_deref()
        .unwrap_or_default()
        .as_bytes();
    let password = session
        .proxy_password
        .as_deref()
        .unwrap_or_default()
        .as_bytes();
    if username.len() > u8::MAX as usize || password.len() > u8::MAX as usize {
        return Err("SOCKS5 proxy username/password is too long".into());
    }

    let mut request = vec![0x01, username.len() as u8];
    request.extend_from_slice(username);
    request.push(password.len() as u8);
    request.extend_from_slice(password);
    stream
        .write_all(&request)
        .map_err(|error| format!("failed to write SOCKS5 auth request: {error}"))?;

    let mut response = [0u8; 2];
    stream
        .read_exact(&mut response)
        .map_err(|error| format!("failed to read SOCKS5 auth response: {error}"))?;
    if response == [0x01, 0x00] {
        Ok(())
    } else {
        Err("SOCKS5 proxy authentication failed".into())
    }
}

fn connect_proxy_server(session: &SessionDefinition) -> Result<TcpStream, String> {
    let (host, port) = proxy_endpoint(session)?;
    connect_direct(&host, port)
        .map_err(|error| format!("failed to connect to proxy {host}:{port}: {error}"))
}

fn connect_direct(host: &str, port: u16) -> Result<TcpStream, String> {
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve {host}:{port}: {error}"))?;
    connect_first(addresses).map_err(|error| format!("failed to connect to {host}:{port}: {error}"))
}

fn connect_first(addresses: impl Iterator<Item = SocketAddr>) -> Result<TcpStream, String> {
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, PROXY_CONNECT_TIMEOUT) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(PROXY_IO_TIMEOUT))
                    .map_err(|error| format!("failed to configure proxy read timeout: {error}"))?;
                stream
                    .set_write_timeout(Some(PROXY_IO_TIMEOUT))
                    .map_err(|error| format!("failed to configure proxy write timeout: {error}"))?;
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error
        .map(|error| error.to_string())
        .unwrap_or_else(|| "no resolved addresses".into()))
}

fn read_discard(stream: &mut TcpStream, len: usize) -> Result<(), String> {
    let mut buffer = vec![0u8; len];
    stream
        .read_exact(&mut buffer)
        .map_err(|error| format!("failed to read SOCKS5 response bytes: {error}"))
}

fn proxy_kind(session: &SessionDefinition) -> Result<ProxyKind, String> {
    match session.proxy_type.trim().to_ascii_lowercase().as_str() {
        "" | "none" => Ok(ProxyKind::None),
        "http" | "https" | "http-connect" => Ok(ProxyKind::HttpConnect),
        "socks5" | "socks" => Ok(ProxyKind::Socks5),
        other => Err(format!("unsupported proxy type `{other}`")),
    }
}

#[cfg(test)]
fn proxy_enabled(session: &SessionDefinition) -> bool {
    matches!(
        proxy_kind(session),
        Ok(ProxyKind::HttpConnect | ProxyKind::Socks5)
    )
}

fn proxy_endpoint(session: &SessionDefinition) -> Result<(String, u16), String> {
    let host = normalized_proxy_host(session)
        .ok_or_else(|| "proxy host is required when proxy is enabled".to_string())?;
    let port = session
        .proxy_port
        .filter(|port| *port > 0)
        .ok_or_else(|| "proxy port is required when proxy is enabled".to_string())?;
    Ok((host, port))
}

fn normalized_proxy_host(session: &SessionDefinition) -> Option<String> {
    session
        .proxy_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn proxy_credentials(session: &SessionDefinition) -> Option<String> {
    let username = session
        .proxy_username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(format!(
        "{}:{}",
        username,
        session.proxy_password.as_deref().unwrap_or_default()
    ))
}

fn socks5_reply_message(code: u8) -> &'static str {
    match code {
        0x01 => "general SOCKS server failure",
        0x02 => "connection not allowed by ruleset",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown SOCKS5 error",
    }
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_with_proxy_type(proxy_type: &str) -> SessionDefinition {
        SessionDefinition {
            id: "test".into(),
            name: "test".into(),
            folder_path: None,
            kind: "ssh".into(),
            host: "example.com".into(),
            port: 22,
            username: "user".into(),
            auth_type: "password".into(),
            password: None,
            key_path: None,
            proxy_type: proxy_type.into(),
            proxy_host: None,
            proxy_port: None,
            proxy_username: None,
            proxy_password: None,
            x11_forwarding: false,
            x11_trusted: true,
            x11_display: None,
            terminal_font_family: None,
            terminal_font_size: None,
            terminal_foreground: None,
            terminal_background: None,
            linked_ssh_tab_id: None,
            local_working_directory: None,
            serial_port: None,
            baud_rate: None,
            parity: "none".into(),
            stop_bits: 1,
            data_bits: 8,
            created_at: "2026-05-04T00:00:00Z".into(),
            updated_at: "2026-05-04T00:00:00Z".into(),
        }
    }

    #[test]
    fn proxy_kind_maps_supported_aliases() {
        for value in ["", "none", " NONE "] {
            assert_eq!(
                proxy_kind(&session_with_proxy_type(value)),
                Ok(ProxyKind::None)
            );
        }

        for value in ["http", "https", "http-connect", " HTTP "] {
            assert_eq!(
                proxy_kind(&session_with_proxy_type(value)),
                Ok(ProxyKind::HttpConnect)
            );
        }

        for value in ["socks5", "socks", " SOCKS5 "] {
            assert_eq!(
                proxy_kind(&session_with_proxy_type(value)),
                Ok(ProxyKind::Socks5)
            );
        }
    }

    #[test]
    fn proxy_kind_rejects_unknown_values() {
        let error = proxy_kind(&session_with_proxy_type("tor")).expect_err("tor is unsupported");
        assert_eq!(error, "unsupported proxy type `tor`");
    }

    #[test]
    fn proxy_enabled_is_true_only_for_real_proxy_modes() {
        assert!(!proxy_enabled(&session_with_proxy_type("")));
        assert!(!proxy_enabled(&session_with_proxy_type("none")));
        assert!(proxy_enabled(&session_with_proxy_type("http")));
        assert!(proxy_enabled(&session_with_proxy_type("socks5")));
        assert!(!proxy_enabled(&session_with_proxy_type("unknown")));
    }

    #[test]
    fn socks5_reply_message_maps_known_codes() {
        assert_eq!(socks5_reply_message(0x01), "general SOCKS server failure");
        assert_eq!(socks5_reply_message(0x05), "connection refused");
        assert_eq!(socks5_reply_message(0x08), "address type not supported");
        assert_eq!(socks5_reply_message(0xff), "unknown SOCKS5 error");
    }

    #[test]
    fn base64_encode_matches_basic_auth_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64_encode(b"u:p"), "dTpw");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"a"), "YQ==");
    }
}
