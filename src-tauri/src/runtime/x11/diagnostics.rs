use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};

use tauri::AppHandle;

use crate::models::SessionDefinition;

use super::super::{emit_output, run_remote_ssh_script_with_label};

const X11_GLX_FAILURE_PATTERNS: &[&str] = &[
    "no matching fbconfigs",
    "glxcreatecontext failed",
    "glxbadcontext",
    "could not create gl context",
    "failed to load driver: swrast",
    "glx without the glx_arb_create_context extension",
    "apple-dri",
];
const X11_DISPLAY_FAILURE_PATTERNS: &[&str] = &[
    "missing x server or $display",
    "cannot open display",
    "can't open display",
    "unable to open display",
];
const X11_FORWARD_REQUEST_FAILURE_PATTERNS: &[&str] = &["x11 forwarding request failed on channel"];

pub(in crate::runtime) fn maybe_report_x11_forwarding_failure(
    app: &AppHandle,
    tab_id: &str,
    session: &SessionDefinition,
    chunk: &str,
    x11_failure_diagnosed: &Arc<AtomicBool>,
) {
    if session.kind != "ssh" || !session.x11_forwarding {
        return;
    }

    if x11_failure_diagnosed.load(Ordering::Relaxed) {
        return;
    }

    let normalized = chunk.to_ascii_lowercase();
    if contains_any_x11_failure_pattern(&normalized, X11_GLX_FAILURE_PATTERNS) {
        if x11_failure_diagnosed
            .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            emit_output(
                app,
                tab_id,
                "\r\n[information] X11 forwarding is active, but this remote app needs GLX/OpenGL support from the local X server. On macOS/XQuartz, indirect GLX is limited and GLX apps such as `glxgears` may still fail even after enabling `+iglx`. Prefer 2D X11 apps for forwarding, or launch Chromium with `--disable-gpu --use-gl=swiftshader`.\r\n",
            );
        }
        return;
    }

    let reason = if contains_any_x11_failure_pattern(
        &normalized,
        X11_FORWARD_REQUEST_FAILURE_PATTERNS,
    ) {
        "The SSH server rejected the X11 forwarding request for this interactive session."
    } else if contains_any_x11_failure_pattern(&normalized, X11_DISPLAY_FAILURE_PATTERNS) {
        "A remote GUI command could not find a usable DISPLAY. X11 forwarding is not active in this shell."
    } else {
        return;
    };

    if x11_failure_diagnosed
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }

    report_x11_forwarding_failure(app, tab_id, session, reason);
}

fn contains_any_x11_failure_pattern(normalized_output: &str, patterns: &[&str]) -> bool {
    patterns
        .iter()
        .any(|pattern| normalized_output.contains(pattern))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_display_failure_patterns() {
        assert!(contains_any_x11_failure_pattern(
            "error: cannot open display localhost:10.0",
            X11_DISPLAY_FAILURE_PATTERNS
        ));
        assert!(contains_any_x11_failure_pattern(
            "missing x server or $display",
            X11_DISPLAY_FAILURE_PATTERNS
        ));
        assert!(!contains_any_x11_failure_pattern(
            "x11 forwarding is active",
            X11_DISPLAY_FAILURE_PATTERNS
        ));
    }

    #[test]
    fn detects_glx_failure_patterns() {
        assert!(contains_any_x11_failure_pattern(
            "libgl error: no matching fbconfigs or visuals found",
            X11_GLX_FAILURE_PATTERNS
        ));
        assert!(contains_any_x11_failure_pattern(
            "x error of failed request: glxbadcontext",
            X11_GLX_FAILURE_PATTERNS
        ));
        assert!(!contains_any_x11_failure_pattern(
            "chromium opened successfully",
            X11_GLX_FAILURE_PATTERNS
        ));
    }
}

pub(in crate::runtime) fn report_x11_forwarding_failure(
    app: &AppHandle,
    tab_id: &str,
    session: &SessionDefinition,
    reason: &str,
) {
    if session.kind != "ssh" || !session.x11_forwarding {
        return;
    }

    emit_output(app, tab_id, &format!("\r\n[warning] {reason}\r\n"));

    let app = app.clone();
    let tab_id = tab_id.to_string();
    let session = session.clone();
    thread::spawn(move || {
        match diagnose_ssh_x11_failure(&session, &tab_id) {
            Ok(diagnostic) => emit_output(&app, &tab_id, &diagnostic),
            Err(error) => emit_output(
                &app,
                &tab_id,
                &format!(
                    "\r\n[information] OpenXTerm could not collect extra X11 diagnostics yet: {error}\r\n"
                ),
            ),
        }
    });
}

fn diagnose_ssh_x11_failure(session: &SessionDefinition, tab_id: &str) -> Result<String, String> {
    let remote_script = r#"
printf '__OXT__home=%s\n' "${HOME:-}"
printf '__OXT__user=%s\n' "${USER:-}"

if [ -n "${SSH_CONNECTION:-}" ]; then
  set -- $SSH_CONNECTION
  printf '__OXT__client_addr=%s\n' "$1"
fi

if command -v xauth >/dev/null 2>&1; then
  printf '__OXT__xauth=%s\n' "$(command -v xauth)"
else
  printf '__OXT__xauth=missing\n'
fi

if command -v sshd >/dev/null 2>&1; then
  sshd -T 2>/dev/null | awk '
    /^x11forwarding / { print "__OXT__x11forwarding=" $2 }
    /^xauthlocation / { print "__OXT__xauthlocation=" $2 }
    /^x11uselocalhost / { print "__OXT__x11uselocalhost=" $2 }
    /^addressfamily / { print "__OXT__addressfamily=" $2 }
  '
fi

if command -v sshd >/dev/null 2>&1 && [ -n "${USER:-}" ] && [ -n "${SSH_CONNECTION:-}" ]; then
  set -- $SSH_CONNECTION
  client_addr="$1"
  match_host="$(hostname -f 2>/dev/null || hostname 2>/dev/null || printf '%s' unknown)"
  sshd -T -C user="$USER",host="$match_host",addr="$client_addr" 2>/dev/null | awk '
    /^x11forwarding / { print "__OXT__match_x11forwarding=" $2 }
    /^xauthlocation / { print "__OXT__match_xauthlocation=" $2 }
    /^x11uselocalhost / { print "__OXT__match_x11uselocalhost=" $2 }
    /^addressfamily / { print "__OXT__match_addressfamily=" $2 }
  '
fi

if [ -n "${HOME:-}" ]; then
  if [ -d "$HOME" ]; then
    printf '__OXT__home_dir=yes\n'
  else
    printf '__OXT__home_dir=no\n'
  fi

  if [ -w "$HOME" ]; then
    printf '__OXT__home_writable=yes\n'
  else
    printf '__OXT__home_writable=no\n'
  fi

  if [ -e "$HOME/.Xauthority" ]; then
    printf '__OXT__xauthority_exists=yes\n'
    if [ -w "$HOME/.Xauthority" ]; then
      printf '__OXT__xauthority_writable=yes\n'
    else
      printf '__OXT__xauthority_writable=no\n'
    fi
  else
    printf '__OXT__xauthority_exists=no\n'
  fi
fi

if command -v xauth >/dev/null 2>&1 && [ -n "${HOME:-}" ]; then
  probe="$HOME/.Xauthority.openxterm-probe.$$"
  if XAUTHORITY="$probe" xauth add localhost/unix:99 MIT-MAGIC-COOKIE-1 0123456789abcdef0123456789abcdef >/dev/null 2>&1; then
    printf '__OXT__xauth_write_test=ok\n'
  else
    printf '__OXT__xauth_write_test=failed\n'
  fi
  rm -f "$probe" >/dev/null 2>&1
fi

if [ -r /proc/sys/net/ipv6/conf/all/disable_ipv6 ]; then
  printf '__OXT__ipv6_disabled=%s\n' "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null)"
fi
"#;
    let stdout =
        run_remote_ssh_script_with_label(session, tab_id, remote_script, "X11 diagnostic")?;
    let mut facts = HashMap::<String, String>::new();
    for line in stdout.lines() {
        let Some(payload) = line.strip_prefix("__OXT__") else {
            continue;
        };
        let mut parts = payload.splitn(2, '=');
        let key = parts.next().unwrap_or_default().trim();
        let value = parts.next().unwrap_or_default().trim();
        if !key.is_empty() {
            facts.insert(key.to_string(), value.to_string());
        }
    }

    let xauth = facts
        .get("xauth")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let x11forwarding = facts
        .get("x11forwarding")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let xauthlocation = facts
        .get("xauthlocation")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let x11uselocalhost = facts
        .get("x11uselocalhost")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let addressfamily = facts
        .get("addressfamily")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let match_x11forwarding = facts
        .get("match_x11forwarding")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let match_xauthlocation = facts
        .get("match_xauthlocation")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let match_x11uselocalhost = facts
        .get("match_x11uselocalhost")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let match_addressfamily = facts
        .get("match_addressfamily")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let home = facts
        .get("home")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let user = facts
        .get("user")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let client_addr = facts
        .get("client_addr")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let home_dir = facts
        .get("home_dir")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let home_writable = facts
        .get("home_writable")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let xauthority_exists = facts
        .get("xauthority_exists")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let xauthority_writable = facts
        .get("xauthority_writable")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let xauth_write_test = facts
        .get("xauth_write_test")
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let ipv6_disabled = facts
        .get("ipv6_disabled")
        .cloned()
        .unwrap_or_else(|| "unknown".into());

    let guidance = if xauth == "missing" {
        "Remote `xauth` is missing from PATH. sshd usually needs a working `xauth` binary to set up X11 forwarding."
            .to_string()
    } else if match_x11forwarding == "no" {
        format!(
            "The effective sshd config for user `{user}` from client `{client_addr}` resolves to `X11Forwarding no`. This usually means a `Match` block is overriding the global setting."
        )
    } else if x11forwarding == "no" {
        "Remote sshd reports `X11Forwarding no`. Enable X11 forwarding in `sshd_config` and reload the SSH service."
            .to_string()
    } else if home_dir == "no" {
        format!(
            "Remote HOME `{home}` does not resolve to a usable directory. sshd often needs a valid HOME to create or update X11 auth data."
        )
    } else if home_writable == "no" {
        format!(
            "Remote HOME `{home}` is not writable for this login. That often prevents sshd/xauth from updating `~/.Xauthority`."
        )
    } else if xauthority_exists == "yes" && xauthority_writable == "no" {
        format!(
            "Remote `~/.Xauthority` exists but is not writable in `{home}`. Fix its ownership/permissions and retry X11 forwarding."
        )
    } else if xauth_write_test == "failed" {
        format!(
            "Remote `xauth` is installed, but a probe write in `{home}` failed. This usually means a permissions, HOME, or xauth runtime problem on the server side."
        )
    } else if (match_x11uselocalhost == "yes" || x11uselocalhost == "yes")
        && (match_addressfamily == "any" || addressfamily == "any")
        && ipv6_disabled == "1"
    {
        "The server keeps X11 on localhost with `AddressFamily any`, but IPv6 is disabled. That combination is known to break X11 forwarding on some OpenSSH setups; try `AddressFamily inet` or `X11UseLocalhost no` on the server, then start a brand-new SSH session."
            .to_string()
    } else {
        format!(
            "Remote sshd reports `X11Forwarding {x11forwarding}`, `XAuthLocation {xauthlocation}`, `X11UseLocalhost {x11uselocalhost}`, `AddressFamily {addressfamily}` and the HOME/xauth probe did not find a simple file-permission problem. The next likely source is an sshd match rule, address-family bind issue, or server-side sshd/PAM logging around X11 setup. Any `sshd_config` change only affects brand-new SSH logins; the current shell will not gain DISPLAY retroactively."
        )
    };

    Ok(format!(
        "\r\n[information] X11 diagnostic: remote xauth={xauth}; sshd x11forwarding={x11forwarding}; sshd xauthlocation={xauthlocation}; sshd x11uselocalhost={x11uselocalhost}; sshd addressfamily={addressfamily}; effective x11forwarding={match_x11forwarding}; effective xauthlocation={match_xauthlocation}; effective x11uselocalhost={match_x11uselocalhost}; effective addressfamily={match_addressfamily}; user={user}; client_addr={client_addr}; home={home}; home_dir={home_dir}; home_writable={home_writable}; xauthority_exists={xauthority_exists}; xauthority_writable={xauthority_writable}; xauth_write_test={xauth_write_test}; ipv6_disabled={ipv6_disabled}.\r\n[information] {guidance}\r\n"
    ))
}
