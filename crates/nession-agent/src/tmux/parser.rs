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
    /// tmux 退出: %exit
    Exit,
}

/// 解析 tmux control mode 的一行输出
pub fn parse_control_line(line: &str) -> Option<ControlMessage> {
    let line = line.trim();

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
    } else if line == "%exit" {
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
    fn test_parse_exit() {
        let msg = parse_control_line("%exit");
        assert!(matches!(msg, Some(ControlMessage::Exit)));
    }

    #[test]
    fn test_parse_unknown() {
        let msg = parse_control_line("%unknown message");
        assert!(msg.is_none());
    }
}
