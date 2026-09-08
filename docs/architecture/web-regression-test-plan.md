# Web 架构重构 — 回归测试计划

**日期**: 2026-09-08  
**Issue**: #650 (Phase 0)  
**目标**: 在架构迁移期间保护关键流程不被破坏  
**Status**: 迁移已收官 (#655) — legacy 目录/`check-legacy-frozen` 门禁已删除;
回归面现在是 session-first 单 shell + e2e(见 [`web.md`](web.md))。

## 测试策略

### 测试分层

| 层级 | 覆盖范围 | 工具 | 运行时机 |
|------|----------|------|----------|
| **单元测试** | 纯函数、工具、状态管理 | Vitest | 每次提交 |
| **组件测试** | React 组件渲染、交互 | Vitest + Testing Library | 每次提交 |
| **集成测试** | 关键用户流程 | Vitest + MSW (Mock Service Worker) | 每次提交 |
| **E2E 测试** | 完整流程(需要 server/agent) | Playwright | CI only |

### 关键流程清单

以下流程在架构迁移期间必须有测试保护:

#### P0 — 必须在 Phase 0 补充测试

1. **Session 生命周期**
   - 创建 session → attach → 输入命令 → 输出渲染 → detach
   - Session 切换 → 状态保留
   - Session kill → 确认对话框 → 列表更新

2. **Terminal 核心流程**
   - Terminal attach (relay / P2P)
   - Terminal resize → PTY 同步
   - Terminal input → output 渲染
   - Terminal reconnect after disconnect

3. **File Browser**
   - 展开目录 → 读取文件列表
   - 点击文件 → 打开 FileViewer
   - 文件上传/下载
   - 文件重命名/删除

4. **WebSocket 连接**
   - 连接建立 → 认证成功
   - 断连 → 自动重连 → 状态恢复
   - 心跳检测

#### P1 — Phase 1-2 补充测试

5. **Agent 管理**
   - Agent 注册 → heartbeat
   - Agent 列表刷新
   - Agent 详情面板

6. **Workspace 工具**
   - Workspace 切换
   - 工具注册/卸载
   - 工具状态同步

#### P2 — Phase 3-5 补充测试

7. **Explorer 扩展**
   - Decoration provider 注册
   - Context menu 扩展
   - Git status 渲染

8. **Layout 切换**
   - Web ↔ App layout 切换
   - 状态保留
   - Runtime 不重建

## 当前测试覆盖

### 已有测试

```
web/src/
├── __tests__/integration/
│   └── App.sessionFirst.test.tsx          ✅ App 渲染切换
├── atoms/__tests__/unit/
│   ├── connection.test.ts                 ✅ 连接状态
│   ├── probe.test.ts                      ✅ Agent 探测
│   └── session.test.ts                    ✅ Session 状态
├── components/__tests__/integration/
│   ├── AddressSelector.test.tsx           ✅ 地址选择
│   ├── DeleteAgentConfirmDialog.test.tsx  ✅ 删除确认
│   └── quickCommands.test.ts              ✅ 快速命令
├── hooks/__tests__/
│   └── (various hook tests)
├── services/__tests__/
│   └── (WebSocket service tests)
└── terminal/__tests__/
    └── (Terminal controller tests)
```

### 测试覆盖缺口

| 流程 | 当前覆盖 | 需要补充 |
|------|----------|----------|
| Session 创建/attach/detach | ❌ 无 | 集成测试 |
| Terminal input/output | ❌ 无 | 集成测试 + E2E |
| Terminal resize | ❌ 无 | 集成测试 |
| File browser 操作 | ❌ 无 | 集成测试 |
| WebSocket 重连 | ❌ 无 | 集成测试 |
| Agent heartbeat | ❌ 无 | 单元测试 |

## Phase 0 测试任务

### 1. 添加 Import Boundary 测试

验证 ESLint 规则 `no-reverse-imports` 正确检测违规:

```typescript
// web/src/__tests__/unit/importBoundaries.test.ts
describe('Import Boundaries', () => {
  it('prevents app from importing internal feature modules', () => {
    // Test that @app/* cannot import from @features/*/internal/*
  });

  it('prevents core from importing React/Jotai', () => {
    // Test that @core/* cannot import react or jotai
  });

  it('prevents shared from importing business concepts', () => {
    // Test that @shared/* cannot import Session/Terminal/etc
  });
});
```

### 2. 添加 Legacy Freeze 测试

验证 CI 脚本 `check-legacy-frozen.sh` 正确检测新增文件:

```bash
# scripts/check-legacy-frozen.sh selftest
# 1. Create a test file in components/
# 2. Run the check → should fail
# 3. Remove the test file
# 4. Run the check → should pass
```

### 3. 添加关键 Hook 单元测试

为以下 hooks 添加单元测试:

- `useAppConnection` — 连接状态管理
- `useDashboard` — Dashboard 数据加载
- `useTerminal` — Terminal 生命周期
- `useFileTabs` — 文件标签管理

### 4. 添加组件集成测试

为以下组件添加集成测试:

- `Dashboard` — 完整渲染流程
- `TerminalWorkspace` — Terminal 挂载/卸载
- `FileBrowser` — 文件列表渲染
- `SessionList` — Session 列表交互

### 5. 添加 Mock Service Worker (MSW) 设置

为集成测试添加 WebSocket 和 HTTP mock:

```typescript
// web/src/__tests__/setup/msw.ts
import { setupServer } from 'msw/node';
import { wsHandlers } from './handlers/ws';
import { httpHandlers } from './handlers/http';

export const server = setupServer(...httpHandlers);
export const wsServer = setupWebSocketServer(...wsHandlers);
```

## E2E 测试 (Playwright)

E2E 测试在 `e2e/` 目录,需要完整的 server/agent/web 栈:

```bash
# 启动本地栈
HOME=/tmp/nession-demo cargo run -p nession-server
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml
cd web && npm run dev

# 运行 E2E 测试
npx playwright test
```

E2E 测试覆盖:
- Login flow
- Session lifecycle (create → attach → interact → detach)
- Terminal I/O
- File browser operations
- WebSocket reconnect

## 测试门禁

### Pre-commit (fast checks)

```bash
just quick  # fmt + clippy + eslint + tsc
```

### Pre-push (full checks)

```bash
just test          # Rust tests
just coverage      # Rust coverage
just web-test      # Web unit + component tests
just web-coverage  # Web coverage thresholds
```

### CI (quality gate)

```yaml
# .github/workflows/quality.yml
- just check          # Rust lint
- just web-lint       # Web lint
- just web-test       # Web tests
# (removed in #655 — no legacy directories remain)
```

## 测试覆盖率阈值

| 目标 | 阈值 |
|------|------|
| Rust (per crate) | 80% line |
| Web lines | 78% |
| Web functions | 72% |
| Web statements | 76% |
| Web branches | 65% |

## 下一步

1. ✅ 依赖图分析完成
2. ✅ Import boundaries 建立
3. ✅ Legacy 目录冻结
4. ⏳ 添加 import boundary 单元测试
5. ⏳ 添加 legacy freeze selftest
6. ⏳ 补充关键 hooks 单元测试
7. ⏳ 补充关键组件集成测试
8. ⏳ 设置 MSW for WebSocket mock
9. ⏳ 更新 CI workflow 添加 legacy check

## 参考

- #650 — Phase 0: 建立边界与基线
- #649 — Parent issue: Web 分层架构重构
- `docs/architecture/web-dependency-analysis.md` — 依赖图分析
