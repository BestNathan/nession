//! tmux control mode 消息解析器

/// tmux control mode 消息类型
#[derive(Debug, Clone, PartialEq)]
pub enum ControlMessage {
    /// 终端输出: `%output %<pane_id> <data>`
    Output { pane_id: String, data: Vec<u8> },
    /// 命令开始: `%begin <timestamp> <id> <flags>`
    Begin { timestamp: u64, id: u64, flags: u64 },
    /// 命令结束: `%end <timestamp> <id> <flags>`
    End { timestamp: u64, id: u64, flags: u64 },
    /// 命令错误: `%error <timestamp> <id> <flags>`
    Error { timestamp: u64, id: u64, flags: u64 },
    /// Session 切换: `%session-changed $<id> <name>`
    SessionChanged { session_id: String, name: String },
    /// 布局变化: `%layout-change <window_id> <layout> <flags> <active_pane>`
    LayoutChange { window_id: String, layout: String },
    /// 窗口尺寸变化: `%window-resize @<window_id> <cols> <rows>`
    ///
    /// **Parsed for a tmux that emits it; the pinned 3.6b does not.**
    /// `grep -c '%window-resize'` on the 3.6b binary is 0 and a live control
    /// client resized underneath receives no such line — the size arrives in
    /// [`ControlMessage::LayoutChange`] instead, which is why the router reads
    /// both. Kept rather than deleted so a newer tmux costs nothing.
    WindowResize {
        window_id: String,
        cols: u16,
        rows: u16,
    },
    /// tmux 退出: %exit
    Exit,
}

/// 解析 tmux control mode 的一行输出
pub fn parse_control_line(line: &str) -> Option<ControlMessage> {
    parse_control_line_bytes(line.as_bytes())
}

/// Parse a Control Mode record without interpreting the pane's bytes as UTF-8.
///
/// tmux escapes control characters and backslash in %output, but the remaining
/// bytes are not required to be UTF-8. A String-based reader can terminate the
/// entire terminal stream on a legal non-UTF-8 pane output (#2300).
pub fn parse_control_line_bytes(line: &[u8]) -> Option<ControlMessage> {
    // Only strip the record delimiter. A trailing CR inside a pane's data is
    // meaningful (and normally escaped as octal by tmux).
    let line = line
        .strip_suffix(b"\r\n")
        .or_else(|| line.strip_suffix(b"\n"))
        .unwrap_or(line);

    if line.starts_with(b"%output ") {
        return parse_output(line);
    }
    // Other protocol fields are textual: never use lossy conversion, because
    // invented tokens could be mistaken for %begin/%end response markers.
    let line = std::str::from_utf8(line).ok()?;
    if line.starts_with("%begin ") {
        parse_command_response(line, "begin")
    } else if line.starts_with("%end ") {
        parse_command_response(line, "end")
    } else if line.starts_with("%error ") {
        parse_command_response(line, "error")
    } else if line.starts_with("%session-changed ") {
        parse_session_changed(line)
    } else if line.starts_with("%layout-change ") {
        parse_layout_change(line)
    } else if line.starts_with("%window-resize ") {
        parse_window_resize(line)
    } else if line == "%exit" || line.starts_with("%exit ") {
        Some(ControlMessage::Exit)
    } else {
        None
    }
}

fn parse_output(line: &[u8]) -> Option<ControlMessage> {
    let mut parts = line.splitn(3, |byte| *byte == b' ');
    let _tag = parts.next()?;
    let pane_id = std::str::from_utf8(parts.next()?).ok()?;
    let data = parts.next()?;
    Some(ControlMessage::Output {
        pane_id: pane_id.to_string(),
        data: data.to_vec(),
    })
}

fn parse_command_response(line: &str, msg_type: &str) -> Option<ControlMessage> {
    let mut parts = line.split_whitespace();
    let _tag = parts.next()?;
    let timestamp: u64 = parts.next()?.parse().ok()?;
    let id: u64 = parts.next()?.parse().ok()?;
    let flags: u64 = parts.next()?.parse().ok()?;

    match msg_type {
        "begin" => Some(ControlMessage::Begin {
            timestamp,
            id,
            flags,
        }),
        "end" => Some(ControlMessage::End {
            timestamp,
            id,
            flags,
        }),
        "error" => Some(ControlMessage::Error {
            timestamp,
            id,
            flags,
        }),
        _ => None,
    }
}

fn parse_session_changed(line: &str) -> Option<ControlMessage> {
    let mut parts = line.split_whitespace();
    let _tag = parts.next()?;
    let session_id = parts.next()?;
    let name = parts.next()?;
    Some(ControlMessage::SessionChanged {
        session_id: session_id.to_string(),
        name: name.to_string(),
    })
}

fn parse_layout_change(line: &str) -> Option<ControlMessage> {
    let mut parts = line.split_whitespace();
    let _tag = parts.next()?;
    let window_id = parts.next()?;
    let layout = parts.next()?;
    Some(ControlMessage::LayoutChange {
        window_id: window_id.to_string(),
        layout: layout.to_string(),
    })
}

/// The window's size, read out of a `%layout-change` layout string (#1349).
///
/// A layout is `<checksum>,<WxH>,<X>,<Y>` for a leaf, and
/// `<checksum>,<WxH>,<X>,<Y>{<child>,<child>}` for a container — so the
/// **first** `WxH` in the string is the window's own, and the children's (inside
/// the braces) come after it. Scanning in order and taking the first match is
/// therefore the whole parse, and it is the same answer for one pane and for
/// twenty.
///
/// This exists because `%window-resize` is not a signal tmux 3.6b produces at
/// all — measured, see `docs/`/the issue — while `%layout-change` *is* emitted
/// for a size change and carries this string. Parsing it costs nothing; the
/// alternative the issue considered, querying the pane on every layout change,
/// is a tmux round trip per event.
///
/// `None` when nothing in the string looks like a size, which is the honest
/// answer for a layout this function does not recognise: the caller emits no
/// resize rather than inventing one.
pub fn layout_size(layout: &str) -> Option<(u16, u16)> {
    for field in layout.split(',') {
        // `WxH`, and nothing else: a checksum is hex and has no `x`, and the
        // `,X,Y` fields are bare numbers. `{`/`}` are stripped rather than
        // matched around, because a container's first child shares the field
        // with its parent's offset (`0{40x24` and the like) — and that child is
        // a *pane* size, which must not be mistaken for the window's. It cannot
        // be: the window's own `WxH` always precedes it.
        let field = field.split(['{', '}']).next().unwrap_or(field);
        let Some((w, h)) = field.split_once('x') else {
            continue;
        };
        if let (Ok(w), Ok(h)) = (w.parse::<u16>(), h.parse::<u16>()) {
            return Some((w, h));
        }
    }
    None
}

fn parse_window_resize(line: &str) -> Option<ControlMessage> {
    let mut parts = line.split_whitespace();
    let _tag = parts.next()?;
    let window_id = parts.next()?.to_string();
    let cols: u16 = parts.next()?.parse().ok()?;
    let rows: u16 = parts.next()?.parse().ok()?;
    Some(ControlMessage::WindowResize {
        window_id,
        cols,
        rows,
    })
}

/// Decode the octal-quoted bytes that tmux places in %output.
///
/// Unlike the legacy permissive helper, malformed protocol escapes are a
/// fault, never literal bytes: forwarding them would make a corrupt record
/// look like a healthy contiguous Agent output event (#2300).
pub fn decode_tmux_output(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut offset = 0;
    while let Some(&value) = bytes.get(offset) {
        if value != b'\\' {
            out.push(value);
            offset += 1;
            continue;
        }
        let &next = bytes.get(offset + 1)?;
        if next == b'\\' {
            out.push(b'\\');
            offset += 2;
            continue;
        }
        let digits = (
            bytes.get(offset + 1),
            bytes.get(offset + 2),
            bytes.get(offset + 3),
        );
        let (Some(&a), Some(&b), Some(&c)) = digits else {
            return None;
        };
        if !(b'0'..=b'7').contains(&a) || !(b'0'..=b'7').contains(&b) || !(b'0'..=b'7').contains(&c)
        {
            return None;
        }
        let decoded = (u16::from(a - b'0') << 6) | (u16::from(b - b'0') << 3) | u16::from(c - b'0');
        out.push(u8::try_from(decoded).ok()?);
        offset += 4;
    }
    Some(out)
}

/// 反转义 tmux control mode 的数据
///
/// tmux 使用八进制转义特殊字符:
/// - \033 → ESC (0x1B)
/// - \015 → CR (0x0D)
/// - \012 → LF (0x0A)
/// - \010 → BS (0x08)
/// - \\ → \
///
/// Non-escape characters are passed through verbatim. Malformed escapes
/// (e.g. lone `\` at end of string, incomplete octal) are preserved literally.
pub fn unescape_tmux_data(data: &str) -> Vec<u8> {
    unescape_tmux_bytes(data.as_bytes())
}

/// Undo tmux octal quoting without any intermediate Unicode conversion.
pub fn unescape_tmux_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        if b == b'\\' {
            if let Some(&next) = bytes.get(i + 1) {
                if next == b'\\' {
                    result.push(b'\\');
                    i += 2;
                    continue;
                }
                // Try to parse 3-digit octal starting at bytes[i+1]
                if (b'0'..=b'7').contains(&next) {
                    if let (Some(&d2), Some(&d3)) = (bytes.get(i + 2), bytes.get(i + 3)) {
                        if (b'0'..=b'7').contains(&d2) && (b'0'..=b'7').contains(&d3) {
                            let value = ((next - b'0') << 6) | ((d2 - b'0') << 3) | (d3 - b'0');
                            result.push(value);
                            i += 4;
                            continue;
                        }
                    }
                }
                // Malformed escape - preserve the backslash literally and continue
                result.push(b'\\');
                i += 1;
                continue;
            }
            // Trailing lone backslash - preserve literally
            result.push(b'\\');
            i += 1;
        } else {
            result.push(b);
            i += 1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_output() {
        let msg = parse_control_line("%output %0 hello world");
        assert!(matches!(
            msg,
            Some(ControlMessage::Output { pane_id, data })
            if pane_id == "%0" && data.as_slice() == b"hello world"
        ));
    }

    #[test]
    fn test_parse_output_with_escape() {
        let msg = parse_control_line("%output %0 \\033[31mred\\033[0m");
        assert!(matches!(
            msg,
            Some(ControlMessage::Output { data, .. })
            if data.as_slice() == b"\\033[31mred\\033[0m"
        ));
    }

    #[test]
    fn test_parse_begin() {
        let msg = parse_control_line("%begin 1784202170 278 0");
        assert!(matches!(
            msg,
            Some(ControlMessage::Begin {
                timestamp: 1784202170,
                id: 278,
                flags: 0
            })
        ));
    }

    #[test]
    fn test_parse_end() {
        let msg = parse_control_line("%end 1784202170 278 0");
        assert!(matches!(
            msg,
            Some(ControlMessage::End {
                timestamp: 1784202170,
                id: 278,
                flags: 0
            })
        ));
    }

    #[test]
    fn test_parse_session_changed() {
        let msg = parse_control_line("%session-changed $0 test");
        assert!(matches!(
            msg,
            Some(ControlMessage::SessionChanged { session_id, name })
            if session_id == "$0" && name == "test"
        ));
    }

    #[test]
    fn test_parse_layout_change() {
        let msg = parse_control_line("%layout-change @0 b25d,80x24,0,0,0");
        assert!(matches!(
            msg,
            Some(ControlMessage::LayoutChange { window_id, layout })
            if window_id == "@0" && layout == "b25d,80x24,0,0,0"
        ));
    }

    /// The layout string IS the size signal on tmux 3.6b, which emits no
    /// `%window-resize` at all (#1349). The format, verbatim from a live 3.6b
    /// `resize-window` to 100x30.
    #[test]
    fn layout_size_reads_the_window_out_of_a_layout_string() {
        assert_eq!(layout_size("a87d,100x30,0,0,0"), Some((100, 30)));
        assert_eq!(layout_size("b25d,80x24,0,0,0"), Some((80, 24)));
    }

    /// A container carries its children's sizes too, and a child is a *pane* —
    /// reporting one as the window would size every client to a fragment of the
    /// pane it is looking at. The window's own `WxH` always comes first, which
    /// is what makes "the first match" the right rule rather than a lucky one.
    #[test]
    fn layout_size_prefers_the_window_over_the_panes_inside_it() {
        // Two panes side by side in an 80-wide window.
        assert_eq!(
            layout_size("a87d,80x24,0,0{40x24,0,0,0,39x24,41,0,1}"),
            Some((80, 24))
        );
        // Stacked: the children keep the full width but half the height.
        assert_eq!(
            layout_size("c0de,120x40,0,0[120x20,0,0,0,120x19,0,21,1]"),
            Some((120, 40))
        );
    }

    /// Anything unrecognised answers `None`, so the caller emits no resize
    /// rather than inventing one — the failure that cannot be noticed is the
    /// one that moves a client to a size nobody asked for.
    #[test]
    fn layout_size_is_none_when_there_is_no_size_to_read() {
        assert_eq!(layout_size(""), None);
        assert_eq!(layout_size("a87d"), None);
        assert_eq!(layout_size("a87d,0,0,0"), None);
        assert_eq!(layout_size("not-a-layout"), None);
    }

    #[test]
    fn test_parse_window_resize() {
        let msg = parse_control_line("%window-resize @1 200 60");
        assert!(matches!(
            msg,
            Some(ControlMessage::WindowResize { window_id, cols: 200, rows: 60 })
            if window_id == "@1"
        ));
    }

    #[test]
    fn test_parse_window_resize_valid() {
        let msg = parse_control_line("%window-resize @1 120 40");
        assert!(matches!(
            msg,
            Some(ControlMessage::WindowResize { window_id, cols: 120, rows: 40 })
            if window_id == "@1"
        ));
    }

    #[test]
    fn test_parse_window_resize_large_dimensions() {
        let msg = parse_control_line("%window-resize @5 300 100");
        assert!(matches!(
            msg,
            Some(ControlMessage::WindowResize { window_id, cols: 300, rows: 100 })
            if window_id == "@5"
        ));
    }

    #[test]
    fn test_parse_window_resize_malformed() {
        let msg = parse_control_line("%window-resize @1");
        assert!(msg.is_none());
    }

    #[test]
    fn test_parse_window_resize_invalid_dimensions() {
        let msg = parse_control_line("%window-resize @1 abc def");
        assert!(msg.is_none());
    }

    #[test]
    fn test_parse_exit() {
        let msg = parse_control_line("%exit");
        assert!(matches!(msg, Some(ControlMessage::Exit)));
    }

    #[test]
    fn test_parse_unknown() {
        let msg = parse_control_line("%unknown message");
        assert!(msg.is_none());
    }

    #[test]
    fn test_parse_output_preserves_trailing_whitespace() {
        // %output data may end in whitespace or \r that's meaningful for ANSI cursor control
        let msg = parse_control_line("%output %0 hello \r");
        assert!(matches!(
            msg,
            Some(ControlMessage::Output { data, .. })
            if data.as_slice() == b"hello \r"
        ));
    }

    #[test]
    fn test_parse_output_preserves_trailing_spaces() {
        let msg = parse_control_line("%output %0 line with trailing spaces   ");
        assert!(matches!(
            msg,
            Some(ControlMessage::Output { data, .. })
            if data.as_slice() == b"line with trailing spaces   "
        ));
    }

    #[test]
    fn test_parse_exit_with_reason() {
        let msg = parse_control_line("%exit lost server");
        assert!(matches!(msg, Some(ControlMessage::Exit)));
    }

    #[test]
    fn test_parse_exit_bare() {
        let msg = parse_control_line("%exit");
        assert!(matches!(msg, Some(ControlMessage::Exit)));
    }

    #[test]
    fn test_unescape_esc() {
        let data = unescape_tmux_data("\\033[31m");
        assert_eq!(data, vec![0x1B, b'[', b'3', b'1', b'm']);
    }

    #[test]
    fn test_unescape_cr_lf() {
        let data = unescape_tmux_data("hello\\015\\012");
        assert_eq!(data, b"hello\r\n");
    }

    #[test]
    fn test_unescape_backspace() {
        let data = unescape_tmux_data("test\\010");
        assert_eq!(data, b"test\x08");
    }

    #[test]
    fn test_unescape_backslash() {
        let data = unescape_tmux_data("path\\\\to\\\\file");
        assert_eq!(data, b"path\\to\\file");
    }

    #[test]
    fn test_unescape_mixed() {
        let data = unescape_tmux_data("\\033[1m\\033[7m%\\033[27m\\033[1m\\033[0m");
        assert_eq!(data, b"\x1B[1m\x1B[7m%\x1B[27m\x1B[1m\x1B[0m");
    }

    #[test]
    fn test_unescape_no_escape() {
        let data = unescape_tmux_data("hello world");
        assert_eq!(data, b"hello world");
    }

    #[test]
    fn test_unescape_incomplete_octal() {
        // 不完整的八进制序列,保留反斜杠字面量
        let data = unescape_tmux_data("\\0");
        assert_eq!(data, b"\\0");
    }

    #[test]
    fn strict_output_escape_decoder_rejects_malformed_or_overflowing_records() {
        assert_eq!(
            decode_tmux_output(b"a\\033\\377"),
            Some(b"a\x1b\xff".to_vec())
        );
        for broken in [
            b"hello\\".as_slice(),
            b"hello\\0".as_slice(),
            b"hello\\08x".as_slice(),
            b"hello\\400".as_slice(),
            b"hello\\777".as_slice(),
        ] {
            assert!(decode_tmux_output(broken).is_none(), "{broken:?}");
        }
    }

    #[test]
    fn binary_output_preserves_invalid_utf8_across_the_protocol_layer() {
        let input = b"%output %0 hello\xff\\033\\000\\134\xfe\n";
        let msg = parse_control_line_bytes(input);
        let Some(ControlMessage::Output { pane_id, data }) = msg else {
            panic!("valid byte-oriented pane output must parse");
        };
        assert_eq!(pane_id, "%0");
        assert_eq!(unescape_tmux_bytes(&data), b"hello\xff\x1b\x00\\\xfe");
    }

    #[test]
    fn record_delimiter_never_eats_pane_whitespace() {
        let msg = parse_control_line_bytes(b"%output %0 a  \r\n");
        assert!(matches!(
            msg,
            Some(ControlMessage::Output { data, .. })
            if data == b"a  ".as_slice()
        ));
    }

    #[test]
    fn test_unescape_high_bytes() {
        // \377 = 0xFF (255) - highest octal byte
        let data = unescape_tmux_data("\\377");
        assert_eq!(data, vec![0xFF]);
    }
}
