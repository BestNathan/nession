# Tmux Parser Control Mode Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `control_mode.rs` into `parser.rs`, removing the `WindowResizeEvent` intermediate layer.

**Architecture:** `control_mode.rs`'s `parse_window_resize` function is only called from `parser.rs`'s `parse_control_line`. The function is inlined into `parser.rs` as a private function that directly returns `ControlMessage::WindowResize` instead of going through `WindowResizeEvent`. The file `control_mode.rs` is deleted and its tests migrated to `parser.rs`.

**Tech Stack:** Rust, anyhow, tokio

**Scope:** 3 files — `parser.rs` (modify), `mod.rs` (modify), `control_mode.rs` (delete)

---

### Task 1: Inline `parse_window_resize` into `parser.rs`

**Files:**
- Modify: `crates/nession-agent/src/tmux/parser.rs`
- Test: `crates/nession-agent/src/tmux/parser.rs` (tests module)

- [ ] **Step 1: Add `parse_window_resize` as a private function in `parser.rs`**

Add this function at the same level as `parse_output`, `parse_session_changed`, etc. (around line 65, before `parse_output`):

```rust
fn parse_window_resize(line: &str) -> Option<ControlMessage> {
    let mut parts = line.split_whitespace();
    let tag = parts.next()?;
    if tag != "%window-resize" {
        return None;
    }
    let window_id = parts.next()?.to_string();
    let cols: u16 = parts.next()?.parse().ok()?;
    let rows: u16 = parts.next()?.parse().ok()?;
    Some(ControlMessage::WindowResize {
        window_id,
        cols,
        rows,
    })
}
```

- [ ] **Step 2: Update `parse_control_line` to call local `parse_window_resize`**

Replace the `super::control_mode::parse_window_resize` call in `parse_control_line` (around line 53):

```rust
    } else if line.starts_with("%window-resize ") {
        parse_window_resize(line)
    }
```

Old code to remove:
```rust
    } else if line.starts_with("%window-resize ") {
        super::control_mode::parse_window_resize(line).map(|ev| ControlMessage::WindowResize {
            window_id: ev.window_id,
            cols: ev.cols,
            rows: ev.rows,
        })
```

- [ ] **Step 3: Remove redundant test from `control_mode.rs` that tests an impossible state**

The test `test_parse_window_resize_not_resize_event` (line 59-62 in control_mode.rs) tests that passing `%output` to `parse_window_resize` returns `None`. This is testing an impossible state since `parse_control_line` dispatches `%output` lines to a different handler. We drop this test.

Do NOT migrate these 4 tests from `control_mode.rs`'s tests module (they remain in the existing file to be deleted):

| Test to drop | Reason |
|---|---|
| `test_parse_window_resize_not_resize_event` | Tests impossible state — `parse_control_line` dispatches `%output` elsewhere |

- [ ] **Step 4: Run tests to verify**

```bash
cargo test -p nession-agent
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/nession-agent/src/tmux/parser.rs
git commit -m "refactor: inline parse_window_resize into parser.rs

Part of Step 1 for issue #93 — removes the dependency on
control_mode::parse_window_resize from parser.rs.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Migrate `control_mode.rs` tests to `parser.rs`

**Files:**
- Modify: `crates/nession-agent/src/tmux/parser.rs`
- Delete: `crates/nession-agent/src/tmux/control_mode.rs`

- [ ] **Step 1: Add migrated tests to `parser.rs` tests module**

Add these 4 tests to the parser.rs `tests` module (before the closing `}` of the module):

```rust
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
```

Note: The existing `test_parse_window_resize` in parser.rs tests the same path via `parse_control_line`. These 4 tests exercise the same code path but validate specific edge cases. They are not redundant — they verify malformed input handling and large dimensions.

- [ ] **Step 2: Run tests to verify**

```bash
cargo test -p nession-agent
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/tmux/parser.rs
git commit -m "refactor: migrate control_mode.rs tests to parser.rs

Part of Step 1 for issue #93 — preserves 4 of 5 tests from
control_mode.rs, dropping the one testing an impossible state.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Delete `control_mode.rs` and update `mod.rs`

**Files:**
- Delete: `crates/nession-agent/src/tmux/control_mode.rs`
- Modify: `crates/nession-agent/src/tmux/mod.rs`

- [ ] **Step 1: Update `mod.rs` to remove `control_mode`**

In `crates/nession-agent/src/tmux/mod.rs`, change from:
```rust
pub mod control;
pub mod control_mode;
pub mod manager;
pub mod parser;
pub mod pty;
```

To:
```rust
pub mod control;
pub mod manager;
pub mod parser;
pub mod pty;
```

- [ ] **Step 2: Verify no remaining references to `control_mode`**

```bash
grep -rn "control_mode" crates/nession-agent/src/ --line-number
```

Expected: No output (zero references).

- [ ] **Step 3: Run full test suite**

```bash
cargo test -p nession-agent
```

Expected: All tests pass.

- [ ] **Step 4: Run clippy and format**

```bash
cargo clippy -- -D warnings
cargo fmt --all -- --check
```

Expected: Zero warnings, formatting clean.

- [ ] **Step 5: Commit and verify**

```bash
git add crates/nession-agent/src/tmux/control_mode.rs crates/nession-agent/src/tmux/mod.rs
git commit -m "refactor: remove control_mode.rs module

Part of Step 1 for issue #93 — file is no longer needed after
its logic was merged into parser.rs.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 6: Final verification**

```bash
cargo test -p nession-agent
```

Expected: All tests pass.

---

### Verification Checklist

- [ ] `control_mode.rs` file deleted from filesystem
- [ ] `mod.rs` no longer has `pub mod control_mode;`
- [ ] `parser.rs` has no `super::control_mode` reference
- [ ] `cargo test -p nession-agent` all pass
- [ ] `cargo clippy -- -D warnings` zero warnings
- [ ] `cargo fmt --all -- --check` clean