# Tmux Parser 合并 Control Mode 设计

**Issue:** #93 — Agent Tmux Manager 架构重整与固化（Step 1 of 3）
**Status:** Approved
**Created:** 2026-07-24
**Author:** Nathan + Claude

## 背景

Issue #93 是对 `nession-agent` 的 `tmux/` 模块（6 文件，~1407 行）的架构重整，
推荐按 3 个 PR 递进合并以降低风险：

1. **Step 1（本 spec）：** 消除重复 + 合并 `control_mode.rs` — 最安全，纯删除
2. Step 2: 引入 `TmuxSession` trait
3. Step 3: 职责分离 + 路径配置

本 spec 只覆盖 **Step 1**，对应 Issue 中的 S5 + S6。

## 问题陈述

`tmux/control_mode.rs`（75 行）定义了 `WindowResizeEvent` 结构体和
`parse_window_resize` 函数，用于解析 `%window-resize` 事件。而
`tmux/parser.rs`（349 行）已经有功能重叠的 `ControlMessage::WindowResize`
variant，并且 `parse_control_line` 反向调用 `control_mode::parse_window_resize`：

```rust
// parser.rs 现状
} else if line.starts_with("%window-resize ") {
    super::control_mode::parse_window_resize(line).map(|ev| ControlMessage::WindowResize {
        window_id: ev.window_id,
        cols: ev.cols,
        rows: ev.rows,
    })
}
```

这形成了不必要的循环依赖：`parser.rs` → `control_mode.rs` → (仅被 parser 使用)。
`WindowResizeEvent` 是一个多余的中间层——解析结果立即被转换成
`ControlMessage::WindowResize` 后丢弃。

## 目标

- 删除 `WindowResizeEvent` 中间层，`%window-resize` 直接解析为
  `ControlMessage::WindowResize`
- 合并 `control_mode.rs` 的解析逻辑到 `parser.rs`
- 删除 `control_mode.rs` 文件
- 消除 `parser.rs` → `control_mode.rs` 的反向依赖

## Non-Goals

- 不改变任何解析行为或对外接口（纯内部重构）
- 不触及 `manager.rs` / `control.rs` / `pty.rs` / `websocket.rs`
- 不引入 `TmuxSession` trait（那是 Step 2）
- 不精简 `ControlMessage` 的 variant 数量（Issue S11，属可选深度优化，不在本步）

## 设计

### 改动范围（3 个文件）

| 文件 | 操作 | 说明 |
|------|------|------|
| `tmux/parser.rs` | 修改 | 新增私有 `parse_window_resize` 内联到本文件；`parse_control_line` 改为调用本地函数，直接构造 `ControlMessage::WindowResize` |
| `tmux/control_mode.rs` | 删除 | 整个文件删除，其 5 个测试迁移到 `parser.rs` 的 `tests` 模块 |
| `tmux/mod.rs` | 修改 | 删除 `pub mod control_mode;` 声明 |

### parser.rs 改动细节

将 `parse_control_line` 中的 `%window-resize` 分支改为直接调用本地私有函数：

```rust
} else if line.starts_with("%window-resize ") {
    parse_window_resize(line)
}
```

新增私有函数（与 `parse_output` / `parse_session_changed` 等同级），直接返回
`Option<ControlMessage>`，不再经过 `WindowResizeEvent`：

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

### 数据流

改动前：
```
parse_control_line("%window-resize ...")
  → control_mode::parse_window_resize → WindowResizeEvent
  → .map() 转换 → ControlMessage::WindowResize
```

改动后：
```
parse_control_line("%window-resize ...")
  → parser::parse_window_resize → ControlMessage::WindowResize
```

## 测试

`control_mode.rs` 的 5 个测试全部迁移到 `parser.rs` 的 `tests` 模块，调整为
测试新的返回类型 `Option<ControlMessage>`：

| 原测试 | 迁移后断言 |
|--------|-----------|
| `test_parse_window_resize_valid` | `ControlMessage::WindowResize { window_id: "@1", cols: 120, rows: 40 }` |
| `test_parse_window_resize_large_dimensions` | `... "@5", cols: 300, rows: 100` |
| `test_parse_window_resize_not_resize_event` | `%output` 行 → `parse_window_resize` 返回 `None`（改为直接测私有函数或 `parse_control_line` 走 Output 分支） |
| `test_parse_window_resize_malformed` | `%window-resize @1` → `None` |
| `test_parse_window_resize_invalid_dimensions` | `%window-resize @1 abc def` → `None` |

`parser.rs` 现有的 `test_parse_window_resize`（通过 `parse_control_line`）保持不变，
已覆盖端到端路径。

## 成功标准

1. ✅ `control_mode.rs` 文件已删除
2. ✅ `parser.rs` 无 `super::control_mode` 引用
3. ✅ `WindowResizeEvent` 类型不再存在
4. ✅ `cargo test -p nession-agent` 全绿
5. ✅ `cargo clippy -- -D warnings` 零警告
6. ✅ `cargo fmt --all -- --check` 通过
7. ✅ 覆盖率不低于阈值（agent crate 80%）

## 风险与回滚

- **风险：极低。** 纯删除 + 内联，无行为变更，无消费方受影响。
- **回滚：** 单个 PR，`git revert` 即可。

## 后续步骤

本 PR 合并后，Step 2（`TmuxSession` trait）从最新 main 创建新 worktree 开始。
