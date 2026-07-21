# just 统一构建入口 — 设计文档

**日期**: 2026-07-21
**分支**: feat/just-unified-tooling

## 1. 目标

引入 `just` 作为 hook 和 CI 的统一命令入口，实现"本地快速反馈 + CI 全量兜底"的分层质量门禁。

## 2. 分层策略

```
git commit → pre-commit (<10s)     → just quick + just web-lint
git push   → pre-push  (30s-60s)   → just test + just coverage + just web-test
CI         → cicd.yml              → just check (全量)
```

## 3. justfile 命令

### Rust
| 命令 | 实际执行 | 用途 |
|------|---------|------|
| `just fmt` | `cargo fmt --all -- --check` | 格式检查 |
| `just lint` | `cargo clippy --workspace -- -D warnings` | Clippy 严格模式 |
| `just test` | `cargo test --workspace` | 全量测试 |
| `just coverage` | `./scripts/check-coverage.sh` | 按 crate 阈值 |
| `just quick` | fmt + lint | pre-commit |
| `just check` | fmt + lint + test + coverage | CI 全量 |

### Web
| 命令 | 实际执行 | 用途 |
|------|---------|------|
| `just web-lint` | eslint + tsc --noEmit | pre-commit |
| `just web-test` | vitest run | pre-push |
| `just web-coverage` | vitest run --coverage | pre-push |

## 4. Hook 变化

### pre-commit（`.githooks/pre-commit`）
- **保留**: 增量检测（仅变更文件触发对应检查）
- **改为调用 just**: `just quick`（替换裸 cargo 命令）、`just web-lint`（替换裸 npm 命令）
- **移除**: test、coverage、web-test、web-coverage

### pre-push（`.githooks/pre-push`，新建）
- 全量运行（不区分变更文件）
- `just test`、`just coverage`、`just web-test`

## 5. CI 变化

`cicd.yml` 和 `release.yml` 的 check job：
- 裸 `cargo fmt/clippy/test` → `just check`
- 裸 `npm run lint / npx tsc / npm test` → `just web-lint` + `just web-test`

## 6. 不变的部分

- `scripts/check-coverage.sh` — 保持独立脚本，`just coverage` 调用它
- `Cargo.toml` workspace lints — 不动
- CI 的 Docker build / release 流程 — 不动
- `just` 已安装（`/opt/homebrew/bin/just`），无需额外安装
