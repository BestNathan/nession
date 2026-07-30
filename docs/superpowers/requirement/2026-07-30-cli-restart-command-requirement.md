# Requirements: CLI `restart` Command

## Background

升级 nession agent/server 后，需要手动 stop + start 才能加载新版本。直接在 CLI 加 `restart` 子命令，内部就是 stop → start，一次命令完成。

## Goals

1. `nession agent restart` — 重启本地 agent 进程（stop → start）
2. `nession server restart` — 重启本地 server 进程（stop → start）

## Non-Goals

- 不是远程操作（不通过 WebSocket 发指令）
- 不改协议（protocol.rs 无需变更）
- 不加新依赖

## Scope

### 改动文件（3 个）

| 文件 | 改动 |
|------|------|
| `crates/nession-cli/src/main.rs` | `AgentAction` 和 `ServerAction` 各加 `Restart` variant；dispatch 到 `restart()` |
| `crates/nession-cli/src/commands/agent.rs` | 新增 `pub async fn restart(config_path, foreground, pid_file)` |
| `crates/nession-cli/src/commands/server.rs` | 新增 `pub async fn restart(config_path, foreground, pid_file)` |

### CLI 接口

```
nession agent restart  [--config <path>] [--foreground] [--pid-file <path>]
nession server restart [--config <path>] [--foreground] [--pid-file <path>]
```

参数同现有 `start` 命令。`--pid-file` 同时用于 stop（找 PID）和 start（写 PID）。

### 实现逻辑

```
restart(config, foreground, pid_file):
    1. stop(pid_file)        // 复用现有 stop 逻辑：SIGTERM → 等5s → SIGKILL
    2. start(config, foreground, pid_file)  // 复用现有 start 逻辑
```

## Constraints

- 纯本地操作，复用现有 PID 文件 + Unix 信号机制
- `--foreground` 模式下 restart 后进程继续在前台运行
- stop 失败（进程不存在/已被杀）不阻塞 start（因为 stop 对"已停止"返回 Ok）

## Success Criteria

- `nession agent restart` 能成功停止旧 agent 进程并启动新 agent 进程
- `nession server restart` 同理
- 无新增 clippy warning
- 现有 start/stop/status 测试不受影响

## Edge Cases

- **进程已停止**: stop 返回 Ok（"not running"），start 正常启动
- **stop 成功但 start 失败**: stop 完成、start 报错，由用户手动排查
- **PID 文件不存在**: stop 返回 Ok，start 正常启动（写新 PID 文件）
