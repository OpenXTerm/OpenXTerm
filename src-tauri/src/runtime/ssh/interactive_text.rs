pub(super) const CWD_OSC_PREFIX: &str = "\x1b]697;Dir=";
pub(super) const CWD_OSC_TERMINATOR: char = '\x07';

pub(super) struct CwdOutputFilter {
    pending: String,
}

impl CwdOutputFilter {
    pub(super) fn new() -> Self {
        Self {
            pending: String::new(),
        }
    }

    pub(super) fn push(&mut self, chunk: &str) -> (String, Vec<String>) {
        self.pending.push_str(chunk);
        let mut visible = String::new();
        let mut paths = Vec::new();

        loop {
            let Some(start) = self.pending.find(CWD_OSC_PREFIX) else {
                let keep = cwd_marker_partial_suffix_len(&self.pending);
                let emit_len = self.pending.len().saturating_sub(keep);
                visible.push_str(&self.pending[..emit_len]);
                self.pending = self.pending[emit_len..].to_string();
                break;
            };

            visible.push_str(&self.pending[..start]);
            let path_start = start + CWD_OSC_PREFIX.len();
            let Some(relative_end) = self.pending[path_start..].find(CWD_OSC_TERMINATOR) else {
                self.pending = self.pending[start..].to_string();
                break;
            };

            let end = path_start + relative_end;
            let path = self.pending[path_start..end].trim();
            if path.starts_with('/') {
                paths.push(path.to_string());
            }
            self.pending = self.pending[end + CWD_OSC_TERMINATOR.len_utf8()..].to_string();
        }

        (visible, paths)
    }
}

pub(super) fn normalize_embedded_terminal_newlines(
    bytes: &[u8],
    previous_was_cr: &mut bool,
) -> String {
    let extra_capacity = bytes.iter().filter(|byte| **byte == b'\n').count();
    let mut normalized = Vec::with_capacity(bytes.len() + extra_capacity);

    for byte in bytes {
        if *byte == b'\n' {
            if !*previous_was_cr {
                normalized.push(b'\r');
            }
            normalized.push(b'\n');
            *previous_was_cr = false;
        } else {
            normalized.push(*byte);
            *previous_was_cr = *byte == b'\r';
        }
    }

    String::from_utf8_lossy(&normalized).to_string()
}

pub(super) fn cwd_marker_partial_suffix_len(value: &str) -> usize {
    let bytes = value.as_bytes();
    let prefix = CWD_OSC_PREFIX.as_bytes();
    let max = bytes.len().min(prefix.len().saturating_sub(1));
    for len in (1..=max).rev() {
        if bytes[bytes.len() - len..] == prefix[..len] {
            return len;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_lf_without_duplicating_existing_crlf() {
        let mut previous_was_cr = false;

        let first = normalize_embedded_terminal_newlines(b"alpha\nbeta\r", &mut previous_was_cr);
        let second = normalize_embedded_terminal_newlines(b"\ngamma\n", &mut previous_was_cr);

        assert_eq!(first, "alpha\r\nbeta\r");
        assert_eq!(second, "\ngamma\r\n");
    }

    #[test]
    fn preserves_utf8_when_bytes_are_complete() {
        let mut previous_was_cr = false;

        let output = normalize_embedded_terminal_newlines(
            "cwd: /tmp/\u{20ac}\n".as_bytes(),
            &mut previous_was_cr,
        );

        assert_eq!(output, "cwd: /tmp/\u{20ac}\r\n");
        assert!(!previous_was_cr);
    }

    #[test]
    fn keeps_lossy_chunk_boundary_behavior_for_split_multibyte_sequences() {
        let mut previous_was_cr = false;
        let euro = "\u{20ac}".as_bytes();

        let first = normalize_embedded_terminal_newlines(&euro[..1], &mut previous_was_cr);
        let second = normalize_embedded_terminal_newlines(&euro[1..], &mut previous_was_cr);

        assert_eq!(first, "\u{fffd}");
        assert_eq!(second, "\u{fffd}\u{fffd}");
    }

    #[test]
    fn extracts_complete_cwd_marker_and_hides_control_sequence() {
        let mut filter = CwdOutputFilter::new();

        let (visible, paths) = filter.push("prompt \x1b]697;Dir=/home/alice\x07$ ");

        assert_eq!(visible, "prompt $ ");
        assert_eq!(paths, vec!["/home/alice"]);
    }

    #[test]
    fn keeps_partial_cwd_marker_across_chunks() {
        let mut filter = CwdOutputFilter::new();

        let (visible, paths) = filter.push("prompt \x1b]697");
        assert_eq!(visible, "prompt ");
        assert!(paths.is_empty());

        let (visible, paths) = filter.push(";Dir=/srv/app\x07 ready");
        assert_eq!(visible, " ready");
        assert_eq!(paths, vec!["/srv/app"]);
    }

    #[test]
    fn reports_partial_cwd_marker_suffix_len() {
        assert_eq!(cwd_marker_partial_suffix_len("abc\x1b]697;"), 6);
        assert_eq!(cwd_marker_partial_suffix_len("abc"), 0);
    }
}
