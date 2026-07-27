//! tmux control mode 消息解析器

/// tmux control mode 消息类型
#[derive(Debug, Clone, PartialEq)]
pub enum ControlMessage {
    /// 终端输出: %output %<pane_id> <data>
    Output { pane_id: String, data: String },
    /// 命令开始: %begin <timestamp> <id> <flags>
    Begin { timestamp: u64, id: u64, flags: u64 },
    /// 命令结束: %end <timestamp> <id> <flags>
    End { timestamp: u64, id: u64, flags: u64 },
    /// 命令错误: %error <timestamp> <id> <flags>
    Error { timestamp: u64, id: u64, flags: u64 },
    /// Session 切换: %session-changed $<id> <name>
    SessionChanged { session_id: String, name: String },
    /// 布局变化: %layout-change <window_id> <layout> <flags> <active_pane>
    LayoutChange { window_id: String, layout: String },
    /// 窗口尺寸变化: %window-resize @<window_id> <cols> <rows>
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
    // Strip only line terminator (\n or \r\n), preserving trailing whitespace
    // that may be meaningful in %output ANSI data (e.g., trailing \r for cursor control).
    let line = if let Some(stripped) = line.strip_suffix("\r\n") {
        stripped
    } else if let Some(stripped) = line.strip_suffix('\n') {
        stripped
    } else {
        line
    };

    if line.starts_with("%output ") {
        parse_output(line)
    } else if line.starts_with("%begin ") {
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

fn parse_output(line: &str) -> Option<ControlMessage> {
    let mut parts = line.splitn(3, ' ');
    let _tag = parts.next()?;
    let pane_id = parts.next()?;
    let data = parts.next()?;
    Some(ControlMessage::Output {
        pane_id: pane_id.to_string(),
        data: data.to_string(),
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
    let mut result = Vec::with_capacity(data.len());
    let bytes = data.as_bytes();
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
            if pane_id == "%0" && data == "hello world"
        ));
    }

    #[test]
    fn test_parse_output_with_escape() {
        let msg = parse_control_line("%output %0 \\033[31mred\\033[0m");
        assert!(matches!(
            msg,
            Some(ControlMessage::Output { data, .. })
            if data == "\\033[31mred\\033[0m"
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
            if data == "hello \r"
        ));
    }

    #[test]
    fn test_parse_output_preserves_trailing_spaces() {
        let msg = parse_control_line("%output %0 line with trailing spaces   ");
        assert!(matches!(
            msg,
            Some(ControlMessage::Output { data, .. })
            if data == "line with trailing spaces   "
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
    fn test_unescape_high_bytes() {
        // \377 = 0xFF (255) - highest octal byte
        let data = unescape_tmux_data("\\377");
        assert_eq!(data, vec![0xFF]);
    }
}
