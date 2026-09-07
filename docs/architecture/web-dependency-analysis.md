# Web 模块依赖图分析

**日期**: 2026-09-08  
**基线**: staging 分支 (commit b01ca17c)  
**工具**: madge + TypeScript AST 分析

## 当前目录结构

```
web/src/
├── App.tsx                    # 应用入口
├── main.tsx                   # React 挂载点
├── index.css                  # 全局样式
├── types.ts                   # 全局类型定义
├── atoms/                     # Jotai atoms (状态管理)
├── components/                # React 组件 (legacy 全局目录)
│   ├── ui/                    # shadcn/ui primitives
│   └── env/                   # Environment 管理组件
├── hooks/                     # React hooks (legacy 全局目录)
├── services/                  # 服务层 (WebSocket, 文件操作等)
│   └── websocket/             # WebSocket 服务 + 插件
├── terminal/                  # Terminal 相关 (部分迁移)
│   ├── components/            # Terminal UI 组件
│   ├── controller/            # Terminal 控制器
│   ├── hooks/                 # Terminal hooks
│   ├── input/                 # 输入处理
│   ├── instance/              # Terminal 实例管理
│   ├── state/                 # Terminal 状态 (atoms)
│   └── transport/             # Terminal 传输层
├── explorer/                  # Explorer/文件浏览器 (新增)
├── features/                  # Feature 模块 (新增)
├── runtime/                   # Runtime 层 (新增)
├── session-first/             # Session-first 布局 (legacy)
├── extensions/                # 扩展系统
├── markdown/                  # Markdown 渲染
├── lib/                       # 工具函数
└── test/                      # 测试工具
```

## 循环依赖 (Circular Dependencies)

### 🔴 严重: Atoms 三层循环

```
atoms/probe.ts
    ↓
atoms/session.ts
    ↓
atoms/connection.ts
    ↓ (回到 probe.ts)
```

**影响**: 状态初始化顺序不确定,可能导致 undefined 或 stale state  
**根因**: atoms 之间的相互依赖没有通过明确的 port 或 event 解耦

**修复方向**:
1. 提取共享的状态读取逻辑到独立的 selector
2. 使用 Jotai 的 `atomFamily` 或 `waitForAll` 替代直接导入
3. 将 cross-cutting 状态提升到一个明确的 store

### 🔴 严重: Terminal State 跨层依赖

```
atoms/connection.ts → terminal/state/session.ts
atoms/session.ts → terminal/state/session.ts
```

**影响**: 全局 atoms 直接依赖 terminal 内部状态,违反依赖方向  
**根因**: terminal 的状态没有通过 public API 暴露

**修复方向**:
1. `terminal/state/session.ts` 提供 public selectors
2. `atoms/` 通过 selectors 读取 terminal 状态,不直接导入内部模块

### 🟡 中等: Explorer 内部循环

```
explorer/types.ts
    ↓
explorer/commands/types.ts
    ↓
explorer/decorations/types.ts
    ↓ (回到 types.ts)
```

**影响**: Explorer 模块内部类型定义循环  
**根因**: 类型定义没有分层

**修复方向**:
1. 将基础类型提取到 `explorer/types/base.ts`
2. commands 和 decorations 的类型依赖基础类型,不互相依赖

### 🟡 中等: Explorer Providers 依赖

```
explorer/providers/types.ts → explorer/types.ts
```

**影响**: providers 依赖顶层 types,但 types 可能依赖 providers  
**根因**: 类型定义和实现混合

**修复方向**:
1. 将 provider 接口提取到 `explorer/providers/types.ts`
2. 顶层 types 不导入 providers

## 依赖方向违规

### ❌ app → core 反向依赖

**现状**: `components/` 和 `hooks/` 直接导入 `terminal/`, `explorer/`, `services/`  
**应然**: `components/` 只通过 public API 或 port 访问 feature

**违规示例**:
- `components/Dashboard.tsx` → `hooks/useDashboard.ts` → `services/websocket.ts`
- `components/FileBrowser.tsx` → `hooks/useExplorerFileBrowser.ts` → `explorer/*`

**修复方向**:
1. 为每个 feature 创建 `public.ts` 作为唯一跨模块入口
2. `components/` 和 `hooks/` 只导入 `@features/*` 或 `@core/*`

### ❌ core → React 依赖

**现状**: `terminal/state/*.ts` 使用 Jotai atoms  
**应然**: core runtime 不依赖 React/Jotai

**修复方向**:
1. 将 terminal runtime 的状态管理迁移到 framework-agnostic store
2. React adapter 在 feature 层订阅 runtime 状态

### ❌ shared → 业务概念

**现状**: `lib/` 中可能存在业务特定逻辑  
**应然**: shared 不理解 Session, Terminal, Git, Explorer

**待验证**: 需要逐个检查 `lib/` 文件的职责

## 模块边界建议

### 目标依赖方向

```
app/  →  features/  →  core/  →  shared/
```

### 当前状态映射

| 目标层 | 当前目录 | 迁移状态 |
|--------|----------|----------|
| app/ | `App.tsx`, `main.tsx`, `session-first/` | ❌ 未迁移 |
| features/ | `features/`, `components/`, `hooks/`, `terminal/`, `explorer/` | 🟡 部分迁移 |
| core/ | `runtime/`, `services/websocket/` | 🟡 部分迁移 |
| shared/ | `lib/`, `components/ui/` | 🟢 接近目标 |

## 关键问题清单

### P0 — 必须在 Phase 0 解决

1. **Atoms 循环依赖** — 影响状态初始化,必须立即修复
2. **Terminal State 跨层依赖** — 违反依赖方向,阻塞 core runtime 提取
3. **建立 public API 入口** — 为所有 feature 创建 `public.ts`

### P1 — Phase 1-2 解决

4. **Explorer 内部循环** — 在 Phase 4 收敛时修复
5. **app → core 反向依赖** — 在 Phase 1 建立 workbench 时逐步修复
6. **core → React 依赖** — 在 Phase 2 统一 runtime 时修复

### P2 — Phase 3-5 解决

7. **Legacy 目录冻结** — Phase 0 建立规则,Phase 5 删除
8. **shared 业务逻辑清理** — 逐步迁移到对应 feature

## 自动化检查建议

### ESLint Import Boundary Rules

```javascript
// 禁止 app/core/shared 之间的反向依赖
'no-restricted-imports': ['error', {
  patterns: [
    { group: ['@/atoms/*'], message: 'Use @core/atoms instead' },
    { group: ['@/terminal/*'], message: 'Use @features/terminal/public' },
  ]
}]

// 禁止跨 feature deep import
'no-restricted-imports': ['error', {
  patterns: [
    { group: ['@features/*/internal/*'], message: 'Use public API' },
  ]
}]
```

### CI 循环依赖检查

```bash
npx madge src --extensions ts,tsx --circular --json > circular-deps.json
# 如果 circular-deps.json 非空,CI 失败
```

## 下一步

1. ✅ 依赖图分析完成
2. ⏳ 建立 tsconfig path aliases (延迟到 Phase 1,待目录结构建立后)
3. ✅ 配置 ESLint import boundary rules
4. ⏳ 为关键 feature 创建 public.ts
5. ⏳ 添加 CI 循环依赖检查
6. ⏳ 补充关键流程回归测试

## 备注

Phase 0 暂不添加 tsconfig path aliases,因为目标目录结构(`@app/*`, `@core/*`, `@features/*`, `@shared/*`)尚未建立。这些别名将在 Phase 1 建立 Workbench 时添加,以确保映射到实际存在的目录。
