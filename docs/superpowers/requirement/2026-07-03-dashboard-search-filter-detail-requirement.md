# Requirements: Dashboard Search, Filter & Agent Detail

**Issue:** [#21](https://github.com/BestNathan/nession/issues/21)
**Status:** Approved
**Created:** 2026-07-03

## Background

Dashboard 无搜索/筛选机制，Agent 卡片仅显示基本信息，无详情面板。随着系统规模增长不可用。

## Goals

1. **搜索栏** — 顶部搜索框，实时过滤（debounce 200ms），匹配 Agent 名称/主机名/会话名称
2. **状态筛选 Toggle** — All | Online | Offline 按钮组，筛选 Agent 及其关联会话
3. **Agent 详情面板** — 点击卡片 → Sheet 滑出，显示版本/OS/uptime/心跳历史/会话数
4. **会话列表排序** — 点击表头按名称/`last_activity` 切换升序/降序
5. **空状态** — 搜索无结果时显示友好提示

## Key Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | 资源使用（CPU/内存） | 不包含，后续扩展 |
| 2 | 搜索模式 | 仅纯文本包含匹配（无正则） |
| 3 | 点击 Agent 卡片 | 打开详情面板（不再过滤会话） |
| 4 | 心跳历史 | 客户端追踪（Map<string, string[]>），保留最近 10 条 |
| 5 | 会话排序字段 | 用 `last_activity` 代替 created_at（后端不提供创建时间） |
| 6 | 状态管理 | 扩展 `useDashboardHandlers` hook |

## Scope

### In
- `Dashboard.tsx` — 搜索栏 + 筛选 Toggle + 空状态
- `AgentCard.tsx` — 点击改为打开详情面板
- `SessionList.tsx` — 表头排序、空状态
- 新组件 `AgentDetailPanel.tsx` — Sheet 展示 Agent 详情
- 新组件 `SearchBar.tsx` — 搜索输入 + 筛选 Toggle
- `useDashboardHandlers.ts` — 搜索/筛选/排序/心跳追踪逻辑
- `types.ts` — 补充心跳历史类型（如需要）

### Out
- Dashboard 布局重构
- 会话批量操作
- Agent 分组/标签
- 正则搜索
- CPU/内存资源展示

## Constraints

- 使用已有 shadcn/ui 组件（需 `npx shadcn add sheet`）
- 不引入新 npm 依赖
- 搜索 debounce 200ms
- 保持现有 Dashboard 布局结构
- ESLint `--max-warnings 0`

## Success Criteria

1. 搜索 "prod" → 仅显示名称/主机名/会话名包含 "prod" 的结果
2. 点击 "离线" Toggle → 仅显示离线 Agent
3. 点击 Agent 卡片 → 右侧 Sheet 显示完整元数据，可关闭
4. 会话表头排序 → 点击切换升序/降序
5. 搜索无结果 → 显示空状态而非空白

## Edge Cases

- Agent 列表为空 → 搜索栏可见但不可交互
- 所有 Agent 离线 → 筛选 Toggle 显示 "0 在线 / N 离线"
- 心跳历史为空（新 Agent） → 面板显示 "No heartbeat data yet"
- 搜索/筛选结果为空 → 空状态提示，会话列表隐藏
- 快速连续输入 → debounce 确保仅最后一次触发
- 面板打开时状态变化 → WebSocket 事件实时更新

## Implementation Plan

See brainstorming output.
