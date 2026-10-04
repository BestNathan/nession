# Context Capsule 列表重做 + Signal 移除

> owner 在 2026-10-04 的两条反馈：
>
> 1. 「**为什么还有 signal 不要这个东西了 很奇怪**」
> 2. 「使用设计语言的尺寸 比如 title 等等，现在这个列表的样式明显和设计语言不一致」
>
> 承接已合并的 #1443 / #1444 / #1445（堆叠 Context Capsule + 高度上限 + 点开即详情）。

## Context

### 上游约束

- `VISION.md` / `PRINCIPLE.md` —— #4 prefer progressive disclosure；#2/#6 默认安静、靠精确而非堆砌。
- `docs/design/design-system/patterns/context-capsule.md` —— 本 pattern 的规则归属。
- `docs/design/visual-language.md` 与 `design/tokens/*` —— 排版角色的唯一来源。
- `docs/design/capability-emergence.md` —— 本改动要修订的是它的深度阶梯。

### 现状（全部自行核实，不是推测）

**1. Signal 只剩一个还能被人看见的来源。**

- `resolveCapabilityProjection` 有两条产生 Signal 的分支：`chosen && !opened`（选中的能力尚未深化），以及 `running`（观测到 session 正在跑某能力）。
- `running` 分支要求 `snapshot.state === 'active'` **且** 不在 `working` 集合里。
- 全树**只有一个**能力能返回 `'active'`：`claude-code/contribution.tsx:68`，条件是 `facts.sessionForegroundCommand` 是 Claude Code 命令。
- 而 `claudeCodeWork.sense`（`claude-code/contribution.tsx:131`）在**完全相同的条件**下返回 `status: 'working'`，于是该能力必然进入 `working` 集合。
- ⇒ `running` 分支 **不可能命中**。Signal 的实际来源只有 `chosen && !opened`，也就是「关掉详情后退回的那一级」—— 正是 owner 看到并觉得奇怪的那个。

**1b. Signal 是第二份死词表：`CapsuleProjectionBinding.entry`。**

`entry: 'peek' | 'signal'` 里的 `'signal'` 表示「有 Signal、没有 Peek，因此不进入口列表」。全树三个 binding —— `claude-code`、`git`、`terminalKeys` —— **全部是 `entry: 'peek'`**。于是：

- `CAPSULE_ENTRY_IDS`（`filter(b => b.entry !== 'signal')`）与 `CAPSULE_PROJECTION_IDS` 现在是**同一个列表**，那个 filter 排除不掉任何东西；
- 该字段的注释描述的正是那条不可达的观测路径（"it still emerges by observation when Nession resolves it as relevant"）。

**1c. `DisclosureDepth` 整个类型没有消费者。**

`git grep` 全树只有它的定义与 `product/capability/index.ts` 的再导出。`'signal'` 从它里面删掉之后，这个类型本身是否还该存在，是同一个问题。

**2. 列表没有任何排版层级（像素实测，staging `88bbf38` App 390×844）。**

四行首字母的 cap height **全部是 12px**（即 16px 字号）：

| 行 | min x | cap height |
|---|---|---|
| `Terminal Keys`（感知行标题） | 44 | 12 |
| `Touch controls for Terminal`（说明行） | — | 12 |
| `Claude Code`（普通行） | 50 | 12 |
| `Git`（普通行） | 50 | 12 |

- 标题与说明行**同尺寸**，只靠颜色区分。原因是两个 class 分别 ref `terminalCapsule.fontSize` 与 `terminalCapsule.captionFontSize`，**两者都 ref 到 `primitive.typography.size` = 1rem**。
- 16px 在设计语言里是 **`primary`** 的尺寸（"Session name, active file, focused input"），而列表行该用的 `body` 在 App 是 14px（其说明原文即 "button labels, **menu items**, filters"）。
- 设计语言完整的 App 字阶：**17 / 16 / 14 / 13 / 12 / 11.5 / 13**（title / primary / body / secondary / metadata / caption / code），列表一档都没用。

**3. 三个真 bug。**

- **左边缘不齐 6px**：`ContextRowButton` 只对 `row.kind === 'ordinary'` 渲染 `contextCapsuleMarkerSlotClass`（宽 = `markerSize` 5px），加上 `controlGap` 1px = **6px**，与实测 44 vs 50 完全吻合。感知行与普通行的图标列、标题列都不共边。
- **图标列一直是空的**：`CapsuleCapabilityEntry` 与 `SensedCapabilityItem` 都声明了 `icon?: LucideIcon`，但 `capsulePresence.ts` 组装 entries 时只取 `{ id, title, state }`，从未 copy `icon`；`CapabilitySnapshot` 本身也没有 icon 字段。真正的图标在 `WorkspaceViewBinding.icon` 上（`git` = `GitBranch`、`claude-code` = `Bot`）。于是每行保留了一个 16px 的空列。这正是 `model.ts` 自己在两段之外警告过的「an unused axis is worse than a missing one」。
- **`available` 被画成灰色**：`row.kind === 'ordinary' && !perceived` → `text-muted-foreground`。由于绝大多数能力是 `available`（只有 `relevant` / `active` 才有资格画点），整个普通目录看起来像禁用，与 SC-35「every non-sensed capability remains reachable」的意图相反。

## Owner 已拍板（2026-10-04）

1. **Signal 移除** —— 不是只删残留那一步，是这个词表整个不要。
2. **排版用设计语言的角色**：标题 `body`，说明 `caption`。
3. **图标列接上真实图标**，不是删掉。
4. **删掉每行右边的 `›`**。

## 设计

### A. Signal 移除

Signal 之所以能删得干净，是因为上面第 1 条：删它**不丢任何现在能发生的行为**。

- `CapabilityProjection.depth` 收成 `'peek'`（Signal 没了，深度只有一个值）。
- `resolveCapabilityProjection` 删 `running` 分支与 `working` 入参；函数随之从「选中优先、否则看观测」简化成「被选中就显示，深度是 Peek」。`canEmerge` 保留 —— 「registry 说这个能力在这里是 hidden 就不显示」仍然是真规则。
- `useCapsuleCapability`：`EmergenceState.opened` 字段消失（选中即 Peek，不存在「选中但未深化」的状态）；`onDismiss` 把 Peek 直接送回 `DORMANT`，并记入 `dismissed` —— 这一条必须保留，否则被关掉的能力会立刻被下一个 render 重新选中（#1165 的教训）。
- `working` 的计算（`collectWorkSignals(...).filter(status==='working')`）失去唯一消费者（`working` 入参），一并删除。
- `product/capability/emergence.ts`：`DisclosureDepth` 删 `'signal'`；由于它全树无消费者（见 1c），**连同类型一起删除**，`index.ts` 的再导出同步去掉。
- **`CapsuleProjectionBinding.entry` 字段删除**（见 1b）：它三个实例全是 `'peek'`，`'signal'` 一旦删掉这个字段就恒为同一个值 —— 单值 union 正是本仓库说的「unused axis」。随之 `CAPSULE_ENTRY_IDS` 与 `CAPSULE_PROJECTION_IDS` 合并成**一个** `CAPSULE_PROJECTION_IDS`，`capsulePresence.ts` 的那句 `filter(b => b.entry !== 'signal')` 与它引用的那道 #1046 区分一并消失（已经没有能区分出来的成员）。三个 `contribution.tsx` 各删一行。
  - ⚠ 这是本改动里唯一一处**扩大范围**的决定：`entry` 是 #1046 引入的、文档写明「provisional by design, #826 Q6 才冻结」。它今天不含信息，但删掉意味着将来「只有 Signal 的能力」在类型上不再可能 —— 而那正是本轮要消灭的东西，所以是收敛而非能力损失。**若 owner 认为该字段应保留作为一种声明位，说一声，我改成保留 `entry: 'peek'` 单值。**

**行为结果**：点行 → 详情 → ✕ → 干净的空胶囊。全程没有用户没要过的中间态。

**连带收敛**（不收敛就是留假话）：

- `docs/design/capability-emergence.md`：深度阶梯 `Dormant → Signal → Peek → Workspace` 改为 `Dormant → Peek → Workspace`；Signal 从词汇表移除；文中「Signal/Peek」并称处逐一核。
- `#1347` 的 SC-34（引用了「Work Ring 是 working 的 ambient 表达，所以观测路径要让位」——`working` 入参没了，这条要么删要么改写成「不自动涌现」）、SC-36、SC-38（「rather than Signal」措辞）。
- e2e：`fixture-visual.spec.ts` 的 `Capability Signal on the Terminal` 用例与 `app-capability-signal` 基线、`ui-contract-matrix.spec.ts` 里所有 `data-depth="signal"` 断言、`fixture-app.spec.ts` 的 `#826` 两下 ✕ 用例（现在一下就该回到 dormant）。
- 注释：`app/capsuleProjections.ts`、`product/terminal/terminalKeys.ts`、`useCapsuleCapability.ts`。

### B. 排版改用设计语言的角色

用 `@/shared/typography/chromeRoles` 的 `chromeSansRole(role)`（它同时给出 size + weight + leading + family）。

| 元素 | 现在 | 改成 |
|---|---|---|
| 行标题 | `text-[length:var(--terminal-capsule-font-size)]` = 16px，无 weight | `chromeSansRole('body')` → App 14 / Web 13，weight 450 |
| 说明行 | `text-[length:var(--terminal-capsule-caption-font-size)]` = **也是 16px** | `chromeSansRole('caption')` → App 11.5 / Web 11，weight 500 |
| leading | `contextCapsule.rowLineHeight`（20px）两行都套 | 交回角色自身的 leading（body 1.4 / caption 1.3） |

- **`contextCapsule.rowLineHeight` 退场**：它是 #1445 为了补「两个 class 都只设了 font-size、继承了 1.5」才加的，现在没有消费者。删 token，把「两行必须落在一个 44px 行带里」这条**规则**留在 pattern doc 与 e2e 断言里（断言比 token 更能守住它）。
- 行带仍然成立：App 19.6 + 14.95 = **34.6px** ≤ 44；Web 17.55 + 14.3 = **31.9px** ≤ 44。且比现在的 40px 松。
- 只有一行文字的普通行同样居中于 44px 行带，SC-44 的「每行恰好一个行带」不变。

### C. 三个 bug

1. **marker 槽对每一行渲染**（点仍然只在 `relevant` / `active` 出现）。这样图标列与标题列在感知行、普通行上完全共边，左边缘对齐。
2. **接上图标**：把 `WorkspaceViewBinding.icon` 引入 entry。落点选在 `app/capsuleProjections.ts` 一侧（它已经持有 projection registry，且胶囊已经 import 它），由它提供 `iconFor(id)`，`capsulePresence.ts` 组装 entry 时填入。没有图标的能力 `icon` 缺省，槽位保留，对齐不受影响。
3. **只有 `unavailable` 才 muted**：`available` 与 `relevant` 都用正常前景色，两者靠 5px 点区分（这正是 SC-19 的「state is drawn on the entry」）。

### D. 删掉 `›`

`ChevronRight` 从行内移除。理由：它是「这是一个下拉菜单」最强的视觉信号，而 SC-42 明确要求这个面不能读作通用 DropdownMenu/popover；而且它不诚实 —— 点行不是导航到别处，是在**原地**深化成详情。

代价：少一个「可点」的视觉提示。接受，因为这个面的语义就是「从列表里挑一个」，行可点是常识，Web 上还有 hover 反馈。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 删 Signal 后 `dismissed` 逻辑漏掉，被关掉的能力立刻重新选中 | `onDismiss` 必须在 Dormant 分支记入 `dismissed`；保留 #1165 的既有用例，并新增一条「关掉后不自动回来」的断言 |
| 角色 leading 让两行超出 44px 行带 | 用 px 断言（`assertContextCapsule` 已经要求行高**恰好**等于 `rowHeightTokenPx`），不是目测 |
| 删除 `rowLineHeight` 后有人以为行带不再受保护 | pattern doc 写明规则 + e2e 断言保留；spec 里点明「断言比 token 更能守住」 |
| 图标引入把 `app` 层的东西塞进 `product` 层 | `iconFor` 由 `app/capsuleProjections.ts` 提供并注入，`product` 侧只接收 `LucideIcon` 值，不 import app 层 |
| 视觉基线大面积移动 | 同批 `--update-snapshots=all` 重生成，按 Playwright 自己的 YIQ 度量逐张归属，只提交本次真被改动的 |
| 删 `entry` 字段属于扩大范围 | 已在设计里点名并给出退路（保留单值 `entry: 'peek'`）；owner 未反对才执行 |
| 与其它会话并发 | 开 worktree 前已查 `gh pr list`，无 capsule 相关开放 PR |

## 验证

1. `just tokens-gen && just contracts-gen && just design-check full`
2. `just web-test` + `just web-lint`
3. 变异验证：
   - 把标题 class 改回 `--terminal-capsule-font-size` → 排版断言必须红；
   - 把 `dismissed` 记录去掉 → 「关掉后不自动回来」断言必须红；
   - 普通行重新只渲染 marker 槽 → 左边缘对齐断言必须红。
4. 本地完整栈 + Playwright MCP：量四种状态下的行高、左边缘 x、图标是否渲染、点击后的 `data-depth`。
5. 部署 staging 后用真实会话复测（App 390×844 + Web 1280×900），截图进 PR 评论。
6. CI `e2e.yml` 重生成基线 → 逐张归属 → 提交。

## 交付

- worktree base `origin/staging`，分支 `feat/context-capsule-list-redesign`
- PR → `staging`，body 含变更内容 + 测试报告，截图放 PR 评论
- `Closes` 留给 release PR
- `#1347` 的验收报告同步更新（SC-20/34/36/38/42/44）
