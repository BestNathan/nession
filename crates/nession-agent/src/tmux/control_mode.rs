//! Parse tmux control mode events.
//!
//! When agent connects to tmux with `-C` flag, tmux sends event notifications
//! including window resize events in the format: `%window-resize @window-id width height`

/// Parsed window resize event from tmux control mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowResizeEvent {
    pub window_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Parse a `%window-resize` event line from tmux control mode.
///
/// Format: `%window-resize @window-id width height`
/// Example: `%window-resize @1 120 40`
///
/// Returns `None` if the line is not a window-resize event or is malformed.
pub fn parse_window_resize(line: &str) -> Option<WindowResizeEvent> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() >= 4 && parts.first() == Some(&"%window-resize") {
        let window_id = parts.get(1)?.trim_start_matches('@').to_string();
        let cols: u16 = parts.get(2)?.parse().ok()?;
        let rows: u16 = parts.get(3)?.parse().ok()?;
        Some(WindowResizeEvent {
            window_id,
            cols,
            rows,
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_window_resize_valid() {
        let line = "%window-resize @1 120 40";
        let event = parse_window_resize(line).unwrap();
        assert_eq!(event.window_id, "1");
        assert_eq!(event.cols, 120);
        assert_eq!(event.rows, 40);
    }

    #[test]
    fn test_parse_window_resize_large_dimensions() {
        let line = "%window-resize @5 300 100";
        let event = parse_window_resize(line).unwrap();
        assert_eq!(event.window_id, "5");
        assert_eq!(event.cols, 300);
        assert_eq!(event.rows, 100);
    }

    #[test]
    fn test_parse_window_resize_not_resize_event() {
        let line = "%output %1 hello world";
        assert!(parse_window_resize(line).is_none());
    }

    #[test]
    fn test_parse_window_resize_malformed() {
        let line = "%window-resize @1";
        assert!(parse_window_resize(line).is_none());
    }

    #[test]
    fn test_parse_window_resize_invalid_dimensions() {
        let line = "%window-resize @1 abc def";
        assert!(parse_window_resize(line).is_none());
    }
}
