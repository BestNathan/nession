# 设计文档：tmux Control Mode 终端自适应窗口

**日期:** 2026-07-16  
**状态:** Draft  
**关联需求:** Issue #72

## 1. 概述

将 Nession agent 的终端 I/O 从 PTY 模式改为 tmux control mode，实现每个 web 客户端独立 viewport，互不影响。

## 2. 架构

### 2.1 整体架构

```
Web Client (xterm.js)
    ↕ WebSocket
Agent Server (websocket.rs)
    ↕ ControlModeSession
tmux -C attach (子进程)
    ↕ stdin/stdout
tmux session (200×60 固定)
    ↕
bash / vim / top
```

### 2.2 核心变化

**当前架构（PTY 模式）：**
- `PtySession` 使用 `portable_pty` 创建 PTY
- spawn `tmux attach-session` 子进程
- PTY master reader 读取原始 ANSI 字节流
- base64 编码后通过 WebSocket 发送

**目标架构（Control Mode）：**
- `ControlModeSession` spawn `tmux -C attach`
- 解析 `%output` 消息获取 ANSI 数据
- 反转义特殊字符后通过 WebSocket 发送
- 每个客户端通过 `refresh-client -C` 设置独立 viewport

## 3. 核心组件

### 3.1 ControlModeSession

**文件:** `crates/nession-agent/src/tmux/control.rs`

```rust
pub struct ControlModeSession {
    session_name: String,
    child: Child,           // tmux -C attach 进程
    stdin: ChildStdin,      // 发送命令到 tmux
    stdout: BufReader,      // 接收 %output 消息
    viewport: (u16, u16),   // 当前 viewport 大小
    output_tx: mpsc::Sender<Vec<u8>>, // 发送解析后的输出
}
```

**关键方法：**

```rust
impl ControlModeSession {
    /// Attach 到 tmux session
    pub async fn attach(
        session_name: &str,
        width: u16,
        height: u16,
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>)>;
    
    /// 发送输入到 tmux
    pub async fn write_input(&self, data: &[u8]) -> Result<()>;
    
    /// 调整 viewport 大小
    pub async fn resize(&self, width: u16, height: u16) -> Result<()>;
    
    /// 关闭 session
    pub async fn close(&mut self) -> Result<()>;
}
```

### 3.2 消息解析器

**控制消息类型：**

```rust
enum ControlMessage {
    Output { pane_id: String, data: String },
    SessionChanged { session_id: String, name: String },
    LayoutChange { window_id: String, layout: String },
    Begin { timestamp: u64, id: u64, flags: u64 },
    End { timestamp: u64, id: u64, flags: u64 },
    Exit,
}
```

**解析逻辑：**

```rust
fn parse_control_line(line: &str) -> Option<ControlMessage> {
    if line.starts_with("%output ") {
        // %output %0 <data>
        let parts: Vec<&str> = line.splitn(3, ' ').collect();
        if parts.len() == 3 {
            return Some(ControlMessage::Output {
                pane_id: parts[1].to_string(),
                data: parts[2].to_string(),
            });
        }
    } else if line.starts_with("%begin ") {
        // %begin <timestamp> <id> <flags>
        // ...
    } else if line.starts_with("%end ") {
        // ...
    } else if line.starts_with("%exit") {
        return Some(ControlMessage::Exit);
    }
    None
}
```

### 3.3 反转义逻辑

tmux control mode 使用八进制转义特殊字符：

```rust
fn unescape_tmux_data(data: &str) -> Vec<u8> {
    let mut result = Vec::new();
    let mut chars = data.chars().peekable();
    
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('0') => {
                    chars.next(); // consume '0'
                    let octal: String = chars.by_ref().take(2).collect();
                    if let Ok(code) = u8::from_str_radix(&octal, 8) {
                        result.push(code);
                    }
                }
                Some('\\') => {
                    chars.next();
                    result.push(b'\\');
                }
                _ => {}
            }
        } else {
            result.extend_from_slice(c.to_string().as_bytes());
        }
    }
    result
}
```

**常见转义：**
- `\033` → ESC (0x1B)
- `\015` → CR (0x0D)
- `\012` → LF (0x0A)
- `\010` → BS (0x08)

## 4. 数据流

### 4.1 Attach 流程

```
1. Client → agent: client.attach { session_name, width, height }
2. Agent: spawn tmux -C attach -t <session_name>
3. Agent: send "refresh-client -C <width>,<height>"
4. Agent: 启动后台 task 读取 stdout
5. Agent: 解析 %output，反转义，通过 channel 发送
6. Agent → Client: terminal.output { session_name, data: base64(ansi) }
```

### 4.2 Resize 流程

```
1. Client → agent: terminal.resize { session_name, width, height }
2. Agent: send "refresh-client -C <width>,<height>"
3. tmux: 调整该 client 的 viewport
4. tmux: 发送新的 %output（基于新 viewport 的 ANSI 序列）
5. Agent: 解析并转发到 Client
```

### 4.3 Input 流程

```
1. Client → agent: terminal.input { session_name, data: base64(bytes) }
2. Agent: send "send-keys -t <session> <data>"
3. tmux: 执行命令，产生 %output
4. Agent: 解析并转发到 Client
```

## 5. Session 创建

### 5.1 固定大尺寸

```rust
// TmuxManager::create_session
pub async fn create_session(&self, name: &str, working_dir: &Path) -> Result<()> {
    Command::new("tmux")
        .args(&[
            "new-session", "-d",
            "-s", name,
            "-x", "200",  // 固定宽度
            "-y", "60",   // 固定高度
            "-c", working_dir.to_str().unwrap(),
        ])
        .status()
        .await?;
    Ok(())
}
```

### 5.2 配置化（可选）

```rust
// agent-config.toml
[terminal]
session_width = 200
session_height = 60
```

## 6. WebSocket 消息格式

保持现有格式不变，前端无需改动：

```rust
// terminal.output
struct TerminalOutputPayload {
    session_name: String,
    data: String,  // base64 编码的 ANSI 数据
}

// terminal.input
struct TerminalInputPayload {
    session_name: String,
    data: String,  // base64 编码的输入数据
}

// terminal.resize
struct TerminalResizePayload {
    session_name: String,
    width: u16,
    height: u16,
}
```

## 7. 迁移策略

### Phase 1: 实现 ControlModeSession（1-2 天）

- [ ] 新增 `crates/nession-agent/src/tmux/control.rs`
- [ ] 实现 `ControlModeSession::attach`
- [ ] 实现消息解析器 `parse_control_line`
- [ ] 实现反转义 `unescape_tmux_data`
- [ ] 实现 `write_input`, `resize`, `close`
- [ ] 单元测试

### Phase 2: 集成到 WebSocket handler（1 天）

- [ ] 修改 `websocket.rs` 中的 `CLIENT_ATTACH` handler
- [ ] 使用 `ControlModeSession` 替代 `PtySession`
- [ ] 修改 `terminal.resize` handler 调用 `resize()`
- [ ] 修改 `terminal.input` handler 调用 `write_input()`

### Phase 3: 清理旧代码（0.5 天）

- [ ] 删除 `crates/nession-agent/src/tmux/pty.rs`
- [ ] 删除 `PtySession` 相关引用
- [ ] 更新 `tmux/mod.rs` 导出

### Phase 4: 修改 session 创建（0.5 天）

- [ ] 修改 `TmuxManager::create_session` 固定使用 200×60
- [ ] 移除 `ServerSessionCreatePayload` 中的 `width`/`height` 字段
- [ ] 更新相关测试

### Phase 5: 测试验证（1-2 天）

- [ ] 单元测试：消息解析、反转义
- [ ] 集成测试：attach、resize、多客户端
- [ ] 手动测试：vim、htop、top 等全屏应用
- [ ] 多客户端测试：不同 viewport 独立工作

**总计：** 4-6 天

## 8. 风险与缓解

### 8.1 tmux control mode 兼容性

**风险:** tmux control mode 协议可能在不同版本有差异

**缓解:**
- 测试目标 tmux 版本（3.4+）
- 只使用稳定的消息类型（%output, %exit）
- 添加版本检测逻辑（可选）

### 8.2 性能开销

**风险:** 消息解析和反转义增加 CPU 开销

**缓解:**
- 使用高效的字符串解析
- 避免不必要的内存分配
- 性能测试验证

### 8.3 多客户端隔离

**风险:** 多个 control client 可能互相影响

**缓解:**
- tmux 原生支持独立 viewport
- 每个 client 使用独立的 `tmux -C attach` 进程
- 测试多客户端场景

## 9. 测试计划

### 9.1 单元测试

- [ ] `parse_control_line`: 各种消息类型
- [ ] `unescape_tmux_data`: 各种转义序列
- [ ] `ControlModeSession`: attach/detach/resize

### 9.2 集成测试

- [ ] 创建 session → attach → 接收输出
- [ ] attach → resize → 验证 viewport 变化
- [ ] 多客户端 attach → 各自独立 resize
- [ ] 全屏应用（vim）正常工作

### 9.3 手动测试

- [ ] vim 编辑文件，验证光标移动、颜色
- [ ] htop 运行，验证界面刷新
- [ ] 多窗口 resize，验证互不影响
- [ ] 断线重连，验证状态恢复

## 10. 开放问题

### 10.1 tmux session 大小配置

**问题:** 是否需要在 `agent-config.toml` 中配置 session 大小？

**建议:** v1 硬编码 200×60，后续根据需要添加配置。

### 10.2 多 pane 支持

**问题:** 当前设计假设单 pane，是否需要支持 tmux 的多 pane 功能？

**建议:** v1 只支持单 pane，后续可以扩展。

### 10.3 错误处理

**问题:** tmux -C 进程异常退出时如何处理？

**建议:** 检测到 `%exit` 或 EOF 时，关闭 WebSocket 连接，通知客户端。

---

**下一步:** 用户 review 此设计文档，确认后进入实现计划阶段。
