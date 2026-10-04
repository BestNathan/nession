# Context Capsule 列表重做 + Signal 移除 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把能力投影从「两种深度、两套内容」收敛成唯一一种形态，并把 Context Capsule 的行改用设计语言的排版角色。

**Architecture:** Signal 深度在设计上仍是两条分支，但其中「观测到 session 正在跑某能力」那条**不可能命中**（全树只有 `claude-code` 能 `active`，而它必然同时是 `working`，被该分支排除）。因此 Signal 的唯一来源是「关掉 Peek 后退回的那一级」。删掉这个深度后，`depth` 成为单值、`opened` / `dismissed` / `working` / `projectable` / `onDeeper` / `entry` 全部失去消费者，一并删除 —— 收敛是级联的，不是并列的六件事。

**Tech Stack:** React 19 + TypeScript、Tailwind v4 + `design/tokens/*`、Vitest（`unit` / `integration` 两个 project）、Playwright（e2e 仅在 CI 跑）、`just` 任务。

**Spec:** `docs/superpowers/specs/2026-10-04-context-capsule-list-redesign-design.md`

---

## 执行前置

```bash
cd /Users/admin/workspace/learn/nession/.claude/worktrees/feat-context-capsule-list-redesign
git branch --show-current    # 必须是 feat/context-capsule-list-redesign
cd web && npm ci && cd ..    # 新 worktree 没有 node_modules
```

本计划**不跑本地 e2e**（仓库禁止）。`npx playwright test --list` 只用于校验 spec 语法。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `web/src/product/capability/emergence.ts` | 「哪个能力在 Termimal 上显示」的唯一决定 | 重写（大幅缩小） |
| `web/src/product/capability/index.ts` | 该层的导出面 | 去掉 `DisclosureDepth` |
| `web/src/app/useCapsuleCapability.ts` | 组装 disclosure + projection 给胶囊 | 收缩 emergence state |
| `web/src/product/terminal/capsule/types.ts` | 胶囊的公开类型 | `CapsuleCapabilityProjection` 去 `depth` / `onDeeper` |
| `web/src/product/terminal/capsule/components/PeekHost.tsx` | 投影的宿主：表面、标题、Workspace 入口 | 去 `data-depth` / `isPeek` / `hasDeeper` |
| `web/src/app/capsuleProjections.ts` | 胶囊投影 binding 注册表 | 去 `entry`；合并两个 id 列表；新增 `iconFor` |
| `web/src/app/capsulePresence.ts` | 从 snapshots 组装入口列表 | 换 id 列表来源；填入 `icon` |
| `web/src/capabilities/{git,claude-code}/…` | 能力的投影体与 binding | 去 `depth` 分支、去 `entry`、加 `icon` |
| `web/src/product/terminal/capsule/components/ContextCapsule.tsx` | 上层列表 | 行重排（去 chevron、marker 槽全行） |
| `web/src/product/terminal/capsule/capsuleStyles.ts` | 行的 class 词表 | 换角色、去 marker 偏移 |
| `design/tokens/experience/{app,web}.json` | `contextCapsule` 组 | 删 `rowLineHeight` |
| `e2e/specs/*` | 结构化断言 | 去 signal、加行断言 |
| `docs/design/**` | 上游文档 | 阶梯与措辞收敛 |

---

## Task 1: 能力层删掉 Signal 深度

**Files:**
- Modify: `web/src/product/capability/emergence.ts`（整个重写）
- Modify: `web/src/product/capability/index.ts:33`
- Test: `web/src/product/capability/__tests__/unit/emergence.test.ts`

- [ ] **Step 1: 改写测试（先写会失败的那部分）**

把 `emergence.test.ts` 整个替换为下面内容。它删掉了所有描述观测路径、`working` 抑制、`dismissed` 的用例 —— 那些规则随分支一起消失 —— 只留下仍然成立的四条。

```ts
import { describe, expect, it } from 'vitest';
import { resolveCapabilityProjection } from '../../emergence';
import type { CapabilityPresence } from '../../presence';
import type { CapabilityId } from '../../model';

const shown = (...ids: CapabilityId[]): CapabilityPresence[] =>
  ids.map((capabilityId) => ({ capabilityId, level: 'listed' }) as CapabilityPresence);

describe('the projection is the chosen capability, at one depth', () => {
  it('is dormant when nothing was chosen', () => {
    expect(resolveCapabilityProjection({ presences: shown('git'), chosen: null })).toBeUndefined();
  });

  it('shows the chosen capability', () => {
    expect(resolveCapabilityProjection({ presences: shown('git'), chosen: 'git' })).toBe('git');
  });

  it('ignores a choice the registry does not show here', () => {
    expect(resolveCapabilityProjection({ presences: shown('git'), chosen: 'files' })).toBeUndefined();
  });

  it('ignores a hidden capability', () => {
    const hidden = [{ capabilityId: 'git', level: 'hidden' } as CapabilityPresence];
    expect(resolveCapabilityProjection({ presences: hidden, chosen: 'git' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run --project unit src/product/capability/__tests__/unit/emergence.test.ts`
Expected: FAIL —— 旧的 `resolveCapabilityProjection` 要求 `snapshots` / `projectable`，且返回对象而不是 id。

- [ ] **Step 3: 重写 emergence.ts**

```ts
import type { CapabilityId } from './model';
import type { CapabilityPresence } from './presence';

export interface EmergenceInput {
  presences: readonly CapabilityPresence[];
  /** The capability the user chose in the Context Capsule, if any. */
  chosen?: CapabilityId | null;
}

/**
 * Which capability is showing beside the capsule, if any.
 *
 * **There is one depth and one source.** A capability appears when the user
 * chose it in the Context Capsule, and it appears as its Peek — the detail.
 * Nothing emerges on its own.
 *
 * This replaced a two-input resolver that also emerged a capability the Session
 * was *observed running*. That branch was removed as unreachable rather than as
 * unwanted: it required `state === 'active'` and not work-sensed, and
 * `claude-code` is the only capability in the tree that can return `'active'`
 * (`capabilities/claude-code/contribution.tsx`) while being the only work
 * binding — and its `sense` reports `working` under exactly the condition that
 * makes it `active`. So the branch could never fire, and the Signal depth it
 * produced had exactly one reachable source left: stepping back out of a Peek,
 * which is the residue the owner asked to remove.
 *
 * Replaced rather than guarded, for the reason the module already states
 * elsewhere: an input kept "just in case" is one that re-creates the decision
 * for reasons the decision does not have.
 *
 * The presence check stays. "The registry says this capability is hidden here"
 * is still a real answer, and the capsule must not show what it was told to
 * hide. Order, priority and thresholds are still absent on purpose — there is
 * now nothing to order.
 */
export function resolveCapabilityProjection({
  presences,
  chosen,
}: EmergenceInput): CapabilityId | undefined {
  if (!chosen) {
    return undefined;
  }
  const shown = presences.some(
    (presence) => presence.capabilityId === chosen && presence.level !== 'hidden',
  );
  return shown ? chosen : undefined;
}
```

- [ ] **Step 4: 去掉 `DisclosureDepth` 的导出**

`web/src/product/capability/index.ts` 删掉 `type DisclosureDepth,` 这一行（该类型全树无消费者，且它描述的阶梯已不存在）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd web && npx vitest run --project unit src/product/capability`
Expected: PASS，且没有其它文件引用 `DisclosureDepth`（若 TS 报错，说明还有读者，按报错逐个改）。

- [ ] **Step 6: Commit**

```bash
git add web/src/product/capability
git commit -F - <<'MSG'
refactor(capability): the projection has one depth and one source

The observed-command branch could not fire — `claude-code` is the only
capability that can be `active`, and it is the only work binding, reporting
`working` under exactly the condition that makes it active — so the Signal
depth it produced had one reachable source left: stepping back out of a Peek.

Removing the branch takes `snapshots`, `projectable`, `opened`, `dismissed`
and `working` with it, and the resolver becomes the presence check it always
also was: show what the user chose, unless the registry calls it hidden.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## Task 2: `useCapsuleCapability` 的 emergence state 塌成一个 id

`EmergenceState` 三个字段随 Task 1 失去意义：`opened` 决定 signal/peek（深度没了）、`dismissed` 只被观测路径读（分支没了）、`chosen` 留下。

**Files:**
- Modify: `web/src/app/useCapsuleCapability.ts`
- Test: `web/src/app/__tests__/integration/useCapsuleCapability.test.tsx`

- [ ] **Step 1: 改测试**

在 `setup()` 的返回里加一个 dismiss helper（与既有的 `choose` 并列）：

```tsx
  const dismiss = () =>
    act(() => {
      view.result.current.projection?.onDismiss();
    });

  return { ...view, initialProps, choose, dismiss, onToolChange, onSurfaceChange, onOpenWorkspace };
```

替换三条描述 Signal 的用例：

```tsx
  it('shows the capability the user chose', () => {
    const { result, choose } = setup();

    choose('git');

    expect(result.current.projection?.id).toBe('git');
  });

  it('dismissing closes the projection', () => {
    // One dismissal, not two. Stepping Peek -> Signal -> Dormant was the walk
    // a two-depth model produced, and the Signal it landed on was a state the
    // user never asked for.
    const { result, choose, dismiss } = setup();

    choose('git');
    expect(result.current.projection?.id).toBe('git');

    dismiss();
    expect(result.current.projection).toBeUndefined();
  });

  it('does not re-show what was dismissed', () => {
    // #1165 recorded a ✕ that fired and was undone in the same frame. The
    // observed-command path that caused it is gone, so the guard is the
    // simpler one now: dismissing clears the choice and nothing puts it back.
    // Mutation: leave `chosen` set in `onDismiss` — this must fail.
    const { result, choose, dismiss } = setup();

    choose('git');
    dismiss();

    expect(result.current.projection).toBeUndefined();
  });
```

并删除 `'keeps the Signal a step away, reached by stepping back out of the Peek'` 整条（那个中间态不存在了）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run --project integration src/app/__tests__/integration/useCapsuleCapability.test.tsx`
Expected: FAIL（`projection.depth` 不再存在 / 两次 dismiss 的假设）

- [ ] **Step 3: 收缩 hook**

在 `web/src/app/useCapsuleCapability.ts` 中：

1. 删掉 `EmergenceState` 接口与 `DORMANT` 常量，改成一个 state：

```ts
  // Which capability is showing, and nothing else. It used to be a record
  // because depth was a second axis (`opened`) and the observed-command path
  // needed a dismissal memory (`dismissed`); with one depth and one source,
  // "which one" is the whole of the state.
  const [chosen, setChosen] = useState<CapabilityId | null>(null);
```

2. session 变更时重置：

```ts
  useEffect(() => {
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId;
      // Q1's decay: a projection belongs to the Session that produced it.
      setChosen(null);
    }
  }, [sessionId]);
```

3. 删掉 `working` 的计算（`collectWorkSignals(...).filter(...)`）与 `collectWorkSignals` 的 import，以及 `resolveCapabilityProjection` 的 `snapshots` / `projectable` / `opened` / `dismissed` / `working` 实参：

```ts
  const active = resolveCapabilityProjection({ presences, chosen });
```

4. `choose` / `onDismiss` / `onDeeper` 三个回调收敛成两个：

```ts
  const choose = useCallback((id: CapabilityId) => setChosen(id), []);

  /**
   * Dismissal closes the projection. There is no level to step back to — the
   * Signal that used to receive it is gone — and no `dismissed` list to
   * record it in, because the only path that could re-emerge something was
   * the observed-command path, which is also gone (#1165).
   */
  const onDismiss = useCallback(() => setChosen(null), []);
```

5. 返回值里的 `projection` 去掉 `depth` 与 `onDeeper`，整块替换为：

```ts
    projection:
      active && binding
        ? {
            id: active,
            title: resolution.titleFor(active),
            // The capability's own answer to "does this take the keyboard while
            // it is up", copied through untouched.
            ownsInputFocus: binding.ownsInputFocus,
            onDismiss,
            // The Workspace destination's presence is Nession's answer
            // (#1347 SC-21), read from the Workspace view registry rather than
            // left for the body to decide: a capability with no Workspace view
            // (Terminal Keys) gets no routing at all.
            onOpenWorkspace: WORKSPACE_VIEW_BINDINGS.some((view) => view.id === active)
              ? (resourceId) => input.onOpenWorkspace(active, resourceId)
              : undefined,
            // The body reports what the user picked; the frame holds it and
            // hands it to `onOpenWorkspace`.
            body: (_focus, setFocus, actions) =>
              binding.body({
                ...actions,
                agentId: input.agent?.agent_id,
                sessionId: input.session?.session_id,
                // The state the registry resolved, read back rather than
                // re-derived — one decision, one place.
                state: stateOf(active),
                onFocusChange: setFocus,
              }),
          }
        : undefined,
```

（`depth: active.depth` 与 `onDeeper: …` 两行删除；`active` 现在是 `CapabilityId` 而不是对象，所以 `active.capabilityId` 全部写成 `active`。）

- [ ] **Step 4: 跑测试**

Run: `cd web && npx vitest run --project integration src/app/__tests__/integration/useCapsuleCapability.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/app/useCapsuleCapability.ts web/src/app/__tests__/integration/useCapsuleCapability.test.tsx
git commit -F - <<'MSG'
refactor(capsule): one depth makes the emergence state one id

`opened` decided signal vs peek, and `dismissed` existed so the
observed-command path would not re-emerge what the user closed. With one
depth and one source both are gone, so the hook holds the chosen id and
nothing else — and `onDismiss` is the one line that clears it.

Kept the #1165 shape as a test rather than deleting it: "a ✕ that fires and
is undone in the same frame" is still a bug worth failing on, even though the
path that once caused it no longer exists.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## Task 3: 投影类型与 `PeekHost` 去掉深度

**Files:**
- Modify: `web/src/product/terminal/capsule/types.ts:109-135`
- Modify: `web/src/product/terminal/capsule/components/PeekHost.tsx`
- Test: `web/src/product/terminal/capsule/components/__tests__/integration/PeekHost.test.tsx`

- [ ] **Step 1: 改 `CapsuleCapabilityProjection`**

在 `types.ts` 里删掉 `depth: 'signal' | 'peek';` 与 `onDeeper?: …`（连同它「the frame reads that as an inert title」的注释），并把接口的文档注释里描述两个深度的段落删掉。

- [ ] **Step 2: 改 `PeekHost`**

1. 解构去掉 `depth` / `onDeeper`：`const { title, onDismiss, onOpenWorkspace } = projection;`
2. 删掉 `const isPeek = depth === 'peek';` 与 `const hasDeeper = Boolean(onDeeper);`
3. 根节点删掉 `data-depth={projection.depth}`。
4. 标题从 `<button>` 换成不可交互的 `<h2>`：

```tsx
      {/* The title names the projection. It is not a control: there is only
          one depth, so there is nothing behind it to open — it used to be the
          Signal's way in. */}
      <h2
        data-testid="capsule-capability-title"
        className="min-w-0 flex-1 truncate text-left font-semibold text-foreground"
      >
        {title}
      </h2>
```

5. Workspace 入口的条件从 `isPeek && onOpenWorkspace` 收成 `onOpenWorkspace`。
6. 删掉 `onClick` / `disabled` / `onDeeper` 相关的注释块（「At Signal depth the title is the way in」整段）。

- [ ] **Step 3: 改 `PeekHost.test.tsx`**

删掉断言 `data-depth` 与「标题在 Signal 上可点」的用例；新增一条标题不可交互的断言：

```tsx
    expect(screen.getByTestId('capsule-capability-title').tagName).toBe('H2');
    expect(screen.getByTestId('capsule-capability-title')).not.toHaveAttribute('role', 'button');
```

- [ ] **Step 4: 跑测试**

Run: `cd web && npx vitest run --project integration src/product/terminal/capsule/components/__tests__/integration/PeekHost.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/product/terminal/capsule/types.ts web/src/product/terminal/capsule/components/PeekHost.tsx web/src/product/terminal/capsule/components/__tests__/integration/PeekHost.test.tsx
git commit -F - <<'MSG'
refactor(capsule): the projection host draws one form

With one depth the title stops being a control — there is nothing behind it
to open — and the Workspace entry stops being conditional on being deep
enough. `data-depth` goes with them: an attribute that is always the same
value is not a state, it is a lie with good intentions.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## Task 4: 删掉 `entry`，合并两个 id 列表

**Files:**
- Modify: `web/src/app/capsuleProjections.ts`
- Modify: `web/src/app/capsulePresence.ts:101`
- Test: `web/src/app/__tests__/unit/capsulePresence.test.ts`

- [ ] **Step 1: 删字段并合并列表**

`capsuleProjections.ts`：

1. 删 `CapsuleProjectionBinding` 的 `entry` 字段与它从「What this binding contributes…」到 `'accessory'` 的整段注释。
2. 删 `CAPSULE_ENTRY_IDS` 导出与它的注释，`capsulePresence.ts` 改读 `CAPSULE_PROJECTION_IDS`。
3. 在 `CAPSULE_PROJECTION_IDS` 的注释里写清合并原因：

```ts
/**
 * Every capability that can be drawn beside the capsule.
 *
 * This was two lists. `#1046` split "can be drawn" from "is worth offering"
 * so a Signal-only binding could emerge on its own without being offered for
 * explicit selection — and with Signal gone, every binding declares a Peek,
 * so the filter that expressed the difference excluded nothing. One list,
 * because there is one answer.
 */
```

- [ ] **Step 2: 更新三个 binding**

`claude-code/contribution.tsx`、`git/contribution.tsx`、`product/terminal/terminalKeys.ts` 各删掉 `entry: 'peek',` 一行。

- [ ] **Step 3: 跑测试**

Run: `cd web && npx vitest run --project unit src/app/__tests__/unit/capsulePresence.test.ts`
Expected: PASS（该文件本来就用 `CAPSULE_PROJECTION_IDS` 遍历）

- [ ] **Step 4: Commit**

```bash
git add web/src/app/capsuleProjections.ts web/src/app/capsulePresence.ts web/src/capabilities web/src/product/terminal/terminalKeys.ts web/src/app/__tests__/unit/capsulePresence.test.ts
git commit -F - <<'MSG'
refactor(capsule): a binding declares Peek, so `entry` stops being a choice

All three bindings were `entry: 'peek'`, which made `CAPSULE_ENTRY_IDS` and
`CAPSULE_PROJECTION_IDS` the same list and the #1046 filter exclude nothing.
A field whose every instance holds one value is not a declaration.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## Task 5: 能力体不再按深度分叉

**Files:**
- Modify: `web/src/capabilities/git/components/GitProjection.tsx:33,52,66-82`
- Modify: `web/src/capabilities/claude-code/components/ClaudeCodeProjection.tsx:54,71`
- Modify: `web/src/capabilities/{git,claude-code}/contribution.tsx`
- Test: 同目录下的 `__tests__`

- [ ] **Step 1: Git —— 删 `GitSignalBody`**

`GitProjection.tsx`：

1. props 里删 `depth: 'signal' | 'peek';`
2. `return depth === 'signal' ? (<GitSignalBody …/>) : (<GitPeekBody …/>);` 改成 `<GitPeekBody status={status.status} root={status.root} onFocusChange={onFocusChange} />`
3. 删掉 `GitSignalBody` 函数整体及其 JSDoc（「L1 — the smallest identifying state」那段）。
4. 文件头注释里「Both depths read the same `useGitStatus`」改成陈述单一形态。
5. `contribution.tsx` 的 `body` 里删掉传给 `GitProjection` 的 `depth={depth}`，`gitProjection.binding` 的 `entry` 已在 Task 4 删除。

- [ ] **Step 2: Claude Code —— 取直**

`ClaudeCodeProjection.tsx` 删掉这 20 行（props 的 `depth` 声明另删）：

```tsx
  if (depth === 'peek') {
    return (
      <ClaudeCodePeek
        agentId={agentId}
        sessionId={sessionId}
        conversation={conversation}
        state={state}
        onOpenWorkspace={onOpenWorkspace}
        openDetail={openDetail}
      />
    );
  }

  return (
    <div data-testid="claude-code-signal-body" className="flex flex-col gap-1">
      <p className={cn('truncate text-foreground', chromeSansRole('metadata'))}>{stateLine(state)}</p>
      <p className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>{detailLine(conversation, summary)}</p>
    </div>
  );
}
```

替换为：

```tsx
  return (
    <ClaudeCodePeek
      agentId={agentId}
      sessionId={sessionId}
      conversation={conversation}
      state={state}
      onOpenWorkspace={onOpenWorkspace}
      openDetail={openDetail}
    />
  );
}
```

随之删除：

1. `detailLine` 函数整体 —— 它**只**被 signal body 读过（`stateLine` 留着，`ClaudeCodePeek` 也在用）。
2. `summary` 的读取：删掉 `const { summary } = useProjectConfigCount({ agentId, sessionId });`（`ClaudeCodePeek` 自己取需要的），及 `useProjectConfigCount` 的 import。
3. 不再使用的 `cn` / `chromeSansRole` import（若 `tsc` 或 eslint 报未使用）。
4. `contribution.tsx` 的 `body` 里删掉 `depth={depth}`。

- [ ] **Step 3: 把测试重指到 Peek**

- `ClaudeCodeProjection.test.tsx`：9 处 `findByTestId('claude-code-signal-body')` 全部改指 `claude-code-peek`（或 `ClaudeCodePeek` 实际使用的 testid），断言的内容按 Peek 的形态调整；第 217 行那条 `queryByTestId('claude-code-signal-body')` 负断言整条删除（那个元素不存在了）。
- Git 侧若有 `git-signal-body` 断言，改指 `git-peek-body`。

- [ ] **Step 4: 跑测试**

Run: `cd web && npx vitest run --project integration src/capabilities/git src/capabilities/claude-code`
Expected: PASS

- [ ] **Step 4: 全量类型检查**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors —— 这一步会抓出所有还在传 `depth` / `entry` 的调用点。

- [ ] **Step 5: Commit**

```bash
git add web/src/capabilities
git commit -F - <<'MSG'
refactor(capabilities): each body draws one form

Git swapped a two-line identity summary for its changed-file list and Claude
Code returned a different tree, in the same slot, moments apart — which is
what made one surface read as two popups. With the Signal depth gone the
bodies have no depth to branch on, so `GitSignalBody` goes and `ClaudeCodePeek`
stops being conditional.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## Task 6: 行文字改用设计语言的排版角色

**Files:**
- Modify: `web/src/product/terminal/capsule/capsuleStyles.ts`（`contextCapsuleTitleClass` / `contextCapsuleReasonClass` / `contextCapsuleRowClass`）
- Modify: `design/tokens/experience/app.json`、`web.json`（删 `contextCapsule.rowLineHeight`）
- Modify: `design/contracts/patterns/context-capsule.json`（若引用该 token）
- Modify: `docs/design/design-system/patterns/context-capsule.md`
- Test: `web/src/product/terminal/capsule/__tests__/unit/capsuleStyles.test.ts:99`

- [ ] **Step 1: 改测试**

把 `'leads both row lines so the pair fits one row band'` 换成：

```ts
  it('sets both row lines in the design language roles, not the capsule font size', () => {
    // Measured on staging 2026-10-04: every line in the row was 16px — the
    // title and the reason were the same size, distinguished only by colour —
    // because both classes refed `terminalCapsule.fontSize` /
    // `captionFontSize`, and both of those resolve to `primitive.typography`.
    // The design language has a ramp for exactly this job; `body`'s own note
    // names "button labels, menu items, filters".
    for (const cls of [contextCapsuleTitleClass, contextCapsuleReasonClass]) {
      expect(cls).toContain('--typography-');
      expect(cls).not.toContain('--terminal-capsule-');
    }
    expect(contextCapsuleTitleClass).toContain('var(--typography-body-size)');
    expect(contextCapsuleTitleClass).toContain('var(--typography-body-weight)');
    expect(contextCapsuleReasonClass).toContain('var(--typography-caption-size)');
    expect(contextCapsuleReasonClass).toContain('var(--typography-caption-weight)');
  });

  it('keeps the two lines inside one row band without a capsule leading token', () => {
    // 14 * 1.4 + 11.5 * 1.3 = 34.55px on App, 13 * 1.35 + 11 * 1.3 = 31.85px on
    // Web, against a 44px band. The role leadings are what make the band hold,
    // so a capsule-local leading would be a second answer to the same question.
    expect(contextCapsuleTitleClass).not.toContain('--context-capsule-row-line-height');
    expect(contextCapsuleReasonClass).not.toContain('--context-capsule-row-line-height');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run --project unit src/product/terminal/capsule/__tests__/unit/capsuleStyles.test.ts`
Expected: FAIL（两个 class 现在都用 `--terminal-capsule-*`）

- [ ] **Step 3: 改 class**

`capsuleStyles.ts`：

```ts
import { chromeSansRole } from '@/shared/typography/chromeRoles';

/**
 * 行的两行文字，用设计语言的排版角色，而不是胶囊自己的字号。
 *
 * 这里曾经是 `text-[length:var(--terminal-capsule-font-size)]` 与
 * `…-caption-font-size`，而那两个叶子**都 ref 到 `primitive.typography`**
 * —— 于是标题与说明同为 16px，只靠颜色区分，整个列表没有任何排版层级
 * （2026-10-04 在 staging 上逐行量过：四行首字母的 cap height 全是 12px）。
 *
 * `body` 是设计语言为「列表项」准备的角色 —— 它自己的说明就写着
 * "button labels, menu items, filters"；说明行用 `caption`。两行的 leading
 * 也由角色给出，所以 `contextCapsule.rowLineHeight` 没有了消费者：
 * 14×1.4 + 11.5×1.3 = 34.55px（Web 31.85px）落在 44px 行带里，比它当初要
 * 解决的 40px 更松。
 */
export const contextCapsuleTitleClass = cn('truncate text-foreground', chromeSansRole('body'));

export const contextCapsuleReasonClass = cn('truncate text-muted-foreground', chromeSansRole('caption'));
```

- [ ] **Step 4: 删 token**

`design/tokens/experience/app.json` 与 `web.json` 的 `contextCapsule` 组各删掉整个 `rowLineHeight` 叶子。`design/contracts/patterns/context-capsule.json` 若引用了它，一并删。

Run: `just tokens-gen && just contracts-gen`

- [ ] **Step 5: 跑测试**

Run: `cd web && npx vitest run --project unit src/product/terminal/capsule/__tests__/unit/capsuleStyles.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/product/terminal/capsule/capsuleStyles.ts web/src/product/terminal/capsule/__tests__/unit/capsuleStyles.test.ts design/
git commit -F - <<'MSG'
fix(capsule): set the row in the design language's roles

Every line in a Context Capsule row measured 16px — the title and the reason
were the same size, separated only by colour — because both classes refed
`terminalCapsule.fontSize` and `terminalCapsule.captionFontSize`, and both of
those leaves resolve to `primitive.typography`. The design language has a
seven-role ramp for this job and the list used none of it.

`body` is the role whose own note names "button labels, menu items, filters";
the reason takes `caption`. Their leadings put the pair at 34.55px (Web
31.85px) inside the 44px band, which retires `contextCapsule.rowLineHeight` —
it existed to supply a leading the roles now supply.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## Task 7: 行重排 —— 对齐、图标、状态

**Files:**
- Modify: `web/src/product/terminal/capsule/components/ContextCapsule.tsx`
- Modify: `web/src/app/capsuleProjections.ts`（新增 `iconFor`）
- Modify: `web/src/app/capsulePresence.ts`（填 `icon`）
- Modify: `web/src/capabilities/{git,claude-code}/contribution.tsx`、`web/src/product/terminal/terminalKeys.ts`（各加 `icon`）
- Test: `web/src/product/terminal/capsule/__tests__/integration/ContextDisclosure.test.tsx`

- [ ] **Step 1: 给 binding 加图标**

`CapsuleProjectionBinding` 增加**必填**字段：

```ts
  /**
   * The capability's glyph in the Terminal.
   *
   * Declared here rather than read from the capability's Workspace view
   * binding, because this is *this* surface's chrome: the capsule lists a
   * capability that has no Workspace view at all (Terminal Keys), and a row
   * that cannot find an icon draws an empty column where the others draw
   * identity. `chrome belongs to the surface` is the rule the Workspace
   * registry already follows one layer over.
   */
  icon: LucideIcon;
```

三个 binding 各加一行：`git` → `GitBranch`、`claude-code` → `Bot`、`terminalKeys` → `Keyboard`（均从 `lucide-react` import）。

- [ ] **Step 2: `iconFor` 与填入**

`capsuleProjections.ts` 新增：

```ts
/** The capability's Terminal glyph, or undefined for one with no projection. */
export function iconFor(id: CapabilityId): LucideIcon | undefined {
  return CAPSULE_PROJECTIONS.find((binding) => binding.id === id)?.icon;
}
```

`capsulePresence.ts` 的 entry 组装里填入 icon，并换用合并后的 id 列表：

```ts
  const entries: CapabilityDisclosureEntry[] = disclosure.discoverable.flatMap((presence) => {
    if (!CAPSULE_PROJECTION_IDS.includes(presence.capabilityId)) {
      return [];
    }
    const snapshot = snapshots.find((candidate) => candidate.id === presence.capabilityId);
    return snapshot
      ? [{ id: snapshot.id, title: snapshot.title, state: snapshot.state, icon: iconFor(snapshot.id) }]
      : [];
  });
```

`CapsuleCapabilityEntry` 已经是 `CapabilityDisclosureEntry & { icon?: LucideIcon }`，无需改类型。

- [ ] **Step 3: 行重排**

`ContextCapsule.tsx` 的 `ContextRowButton`：

1. **marker 槽对每一行渲染**（修 6px 错位）：

```tsx
      {/* The presence mark's column, on every row. It used to be rendered
          only for ordinary rows, which pushed their titles 6px right of a
          sensed row's (measured on staging: x=44 against x=50) — two
          different left edges in one list. */}
      <span aria-hidden className={contextCapsuleMarkerSlotClass}>
        {perceived ? <span className={contextCapsuleMarkerClass} /> : null}
      </span>
```

`perceived` 的定义不变，但**只用于普通行**：`const perceived = row.kind === 'ordinary' && (row.state === 'relevant' || row.state === 'active');`

2. **状态不再画成灰**（修「看起来像禁用」）：

```tsx
        <span className={cn(contextCapsuleTitleClass, row.state === 'unavailable' && 'text-muted-foreground')}>
```

3. **删掉 chevron**：删掉 `<ChevronRight …>` 整个元素与 `lucide-react` 的 import（若 `ChevronRight` 不再被本文件使用）。

- [ ] **Step 4: 给 marker 槽一个可断言的名字**

`ContextCapsule.tsx` 的 marker 槽加 `data-testid="capsule-row-marker"`（每行一个，同名）。这是上面那条对齐 bug 的**因**，而因可以断言，结果（x 坐标）只能靠 e2e 量。

- [ ] **Step 5: 更新测试**

**`web/src/app/__tests__/unit/capsulePresence.test.ts`**（这才是图标 bug 的回归点 —— 它发生在 `capsulePresence` 而不是组件里）：

```ts
  it('gives every entry the capability icon', () => {
    // 组件那一列一直留着 16px 的空位，因为 entries 是 `{ id, title, state }`
    // —— `CapsuleCapabilityEntry` 声明了 `icon?` 却从没人填。
    // Mutation: 去掉 `icon: iconFor(snapshot.id)` —— 必红。
    const { entries } = resolveCapsuleCapabilities(input());

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.icon).toBeDefined();
    }
  });
```

**`ContextDisclosure.test.tsx`** 的 fixture 补上图标（模拟 `capsulePresence` 现在会填的东西），再加两条：

```tsx
    entries: [
      { id: 'claude-code', title: 'Claude Code', state: 'active', icon: Bot },
      { id: 'git', title: 'Git', state: 'available', icon: GitBranch },
    ],
```

```tsx
  it('starts every row at the same column', async () => {
    // jsdom 没有布局，量不出那个 6px —— 那是 e2e `assertContextCapsule` 的活。
    // 这一条钉的是因：marker 列在每一行都渲染，所以图标列与标题列在两种行上
    // 从同一个偏移开始，不管有没有点要画。
    // Mutation: 把槽改回 `row.kind === 'ordinary' ? … : null` —— 必红。
    const caps = disclosure();
    render(<TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} />);
    await userEvent.click(screen.getByTestId('capsule-capability-more'));

    const rows = await screen.findAllByTestId(/^capsule-(context-item|capability-picker)-/);
    expect(rows.length).toBeGreaterThan(1);
    expect(screen.getAllByTestId('capsule-row-marker')).toHaveLength(rows.length);
  });

  it('draws each capability its own glyph', async () => {
    // Mutation: 删掉 `<Icon />` 那个元素 —— 必红。
    const caps = disclosure();
    render(<TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} />);
    await userEvent.click(screen.getByTestId('capsule-capability-more'));

    const rows = await screen.findAllByTestId(/^capsule-(context-item|capability-picker)-/);
    for (const row of rows) {
      expect(row.querySelector('svg')).not.toBeNull();
    }
  });

  it('does not grey out a capability that is merely available', async () => {
    // SC-35: every non-sensed capability remains reachable. A muted title reads
    // as disabled, which is the opposite of reachable.
    // Mutation: 改回 `!perceived && 'text-muted-foreground'` —— 必红。
    const caps = disclosure();
    render(<TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={caps} />);
    await userEvent.click(screen.getByTestId('capsule-capability-more'));

    const git = await screen.findByTestId('capsule-capability-picker-git');
    expect(git).toHaveAttribute('data-capability-state', 'available');
    expect(git.querySelector('.text-muted-foreground')).toBeNull();
  });
```

（`Bot` / `GitBranch` 从 `lucide-react` import。）

- [ ] **Step 6: 跑测试**

Run: `cd web && npx vitest run --project integration src/product/terminal/capsule && npx vitest run --project unit src/app/__tests__/unit/capsulePresence.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/src/product/terminal/capsule web/src/app/capsuleProjections.ts web/src/app/capsulePresence.ts web/src/capabilities web/src/product/terminal/terminalKeys.ts
git commit -F - <<'MSG'
fix(capsule): align the rows, and give them identity and an honest state

Three defects the staging measurements pinned down:

The marker slot rendered only on ordinary rows, so their titles sat 6px right
of a sensed row's (x=50 against x=44) — two left edges in one list. The slot
is now on every row and the dot only where it means something.

The icon column was reserved on every row and filled on none:
`capsulePresence.ts` built entries as `{ id, title, state }` and never copied
an icon, while the column held 16px open for one. Each capsule binding now
declares its Terminal glyph next to its Terminal body.

An `available` capability was drawn in `text-muted-foreground`, which reads
as disabled — the opposite of SC-35's "remains reachable". Only
`unavailable` is muted now; `relevant` keeps its 5px mark.

The drill-in chevron goes too: it is the strongest "this is a dropdown menu"
tell on a surface SC-42 says must not read as one, and it is not even honest —
picking a row deepens it in place rather than navigating anywhere.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## Task 8: 上游文档收敛

**Files:**
- Modify: `docs/design/capability-emergence.md`
- Modify: `docs/design/design-system/patterns/context-capsule.md`
- Modify: `docs/design/design-system/patterns/terminal-capsule.md`
- Modify: `docs/design/interaction/app.md`

- [ ] **Step 1: 逐个改**

- `capability-emergence.md`：深度阶梯 `Dormant → Signal → Peek → Workspace` 改成 `Dormant → Peek → Workspace`；删掉 Signal 的词条与所有「Signal/Peek 并称」的句子；「a Signal is the smallest identifying state needed」这类描述改写成 Peek 是唯一形态。
- `patterns/context-capsule.md`：`Rules` 里补一条「行的两行文字用设计语言的 `body` / `caption` 角色，行标题不用胶囊字号」；删掉任何引用 `rowLineHeight` 的句子。
- `patterns/terminal-capsule.md`：图与文字里 Signal 的痕迹。
- `interaction/app.md`：`Dormant -> Signal -> Peek -> Workspace` 那条链。

- [ ] **Step 2: 校验**

Run: `git grep -n "Signal" -- docs/design | grep -viE "work signal|workSignal|AbortSignal|signals" | head -20`
Expected: 只应剩下描述 WorkSignal / context signal 的用法，不再有深度意义上的 Signal。

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -F - <<'MSG'
docs: converge the emergence ladder on one depth

`Dormant → Signal → Peek → Workspace` described a level that could not be
reached from anywhere, so the design docs named a state users could not see.
The ladder is `Dormant → Peek → Workspace`, and the Context Capsule pattern
records the row's typography roles so the next reader does not re-derive why
the title is `body` and not the capsule's own font size.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## Task 9: e2e 收敛

**Files:**
- Modify: `e2e/specs/fixture-visual.spec.ts`
- Modify: `e2e/specs/fixture-app.spec.ts:122`
- Modify: `e2e/specs/ui-contract-matrix.spec.ts:292` + `assertContextCapsule`
- Delete: `e2e/specs/__snapshots__/fixture-visual.spec.ts/app-capability-signal-linux.png`

- [ ] **Step 1: 删 Signal 用例与基线**

- 删掉 `fixture-visual.spec.ts` 的 `test('Capability Signal on the Terminal')` 整块，并删掉对应基线文件。
- `fixture-app.spec.ts` 的 `#826` 用例：删掉中间那次 `toHaveAttribute('data-depth', 'signal')`，一次 dismiss 后断言 projection 归零（原来是两下）。
- `ui-contract-matrix.spec.ts:292` 与 `fixture-visual.spec.ts` 里 6 处 `toHaveAttribute('data-depth', 'peek')` 改成 `toBeVisible()` —— 「投影在显示」本来就由存在性表达，`data-depth` 已恒为同一值。

- [ ] **Step 2: 加行断言**

`assertContextCapsule` 里新增（紧随现有的行带断言）：

```ts
  // 左边缘必须共边。感知行与普通行曾经差 6px —— marker 槽只给普通行渲染 ——
  // 而那时没有任何断言看左边，只有行高被看着。
  let firstLeft: number | null = null;
  for (let i = 0; i < (await rows.count()); i += 1) {
    const box = await rows.nth(i).boundingBox();
    expect(box).not.toBeNull();
    if (firstLeft === null) {
      firstLeft = box!.x;
    } else {
      expect(Math.abs(box!.x - firstLeft)).toBeLessThanOrEqual(1);
    }
  }
```

- [ ] **Step 3: 校验 spec 语法**

Run: `cd e2e && ./node_modules/.bin/playwright test --list 2>&1 | tail -5`
Expected: 列出用例，无语法错误（本地**不跑**，仓库禁止）。

- [ ] **Step 4: Commit**

```bash
git add e2e/
git commit -F - <<'MSG'
test(e2e): one depth, and a left edge that is asserted

The Signal spec and its baseline go with the depth. The six `data-depth`
assertions become visibility assertions — with one depth the attribute holds
one value, so asserting it measures nothing.

Added the assertion that would have caught the ragged edge: every row's left
must match the first row's, which is the check that was missing while only
row *height* was watched.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## Task 10: 本地完整栈验证（Playwright MCP，必做）

**Files:** 无（只产出证据）

- [ ] **Step 1: 起栈**

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev
```

- [ ] **Step 2: 量这些数**

| 判据 | 期望 |
|---|---|
| 四行文字的 cap height | 标题 ≠ 说明（说明明显更小） |
| 每行 `x` | 全部相等（±1px） |
| 每行高度 | 恰好 44px |
| 图标 | 每行左边都画出来 |
| 点普通行 | 直接是详情、`Open in Workspace →` 可见 |
| 点 ✕ | **一次**回到空胶囊，没有中间态 |
| 下层锚点 | 全程 `capsule-shell` 的 box 不变 |

- [ ] **Step 3: 截图**

`.playwright-mcp/screenshots/` 下留改前（staging `88bbf38` 那张已存在）与改后对照。

---

## Task 11: CI 与视觉基线

- [ ] **Step 1: 推分支，让 e2e 跑出真实差异**

```bash
git push -u origin feat/context-capsule-list-redesign
gh pr create --base staging --title "feat(capsule): one depth, and a row set in the design language" --body-file /tmp/pr-body.md
```

- [ ] **Step 2: 重生成基线**

Run: `gh workflow run e2e.yml --ref feat/context-capsule-list-redesign -f update_visual_snapshots=true`

- [ ] **Step 3: 逐张归属，只提交本次真被改动的**

按 Playwright 自己的 YIQ 度量（threshold 0.2）判定，**不提交** sub-tolerance 的编码噪声 —— 仓库规则是只提交该 PR 的 e2e 真正失败的那些。

- [ ] **Step 4: 提交基线并推**

---

## Task 12: `#1347` 验收报告

**Files:** 无（改 issue body）

- [ ] **Step 1: 修订这几条**

- **SC-20** —— 措辞去限定词：「Selecting any capability from the Context Capsule opens that capability directly at Peek depth — sensed and ordinary rows alike」，证据更新为单深度。
- **SC-34** —— 原文讲「Work Ring 让位给 Signal」，但 `working` 输入已删、观测路径不存在。改写为「一个观测只有一种自发表达：Work Ring」，或按证据建议删除。
- **SC-36** —— 删掉引用 Signal 的部分。
- **SC-38** —— 「rather than Signal」的措辞。
- **SC-42 / SC-44** —— 排版角色与行带的新证据。

- [ ] **Step 2: 用仓库自己的 validator 校验**

```bash
node -e "import('/ABS/scripts/requirement-acceptance.mjs').then(m=>{const b=require('fs').readFileSync('/tmp/1347-body.md','utf8');for(const mode of ['merge','closure'])console.log(mode,m.validateRequirementBody(b,{mode}).ok)})"
```

Expected: 两种模式都 `true`

- [ ] **Step 3: 推 issue**

```bash
gh issue edit 1347 --body-file /tmp/1347-body.md
```

---

## 自检

**Spec 覆盖**

| Spec 段 | 落在哪个 Task |
|---|---|
| A. Signal 移除（模型层） | Task 1 |
| A. emergence state 收缩 | Task 2 |
| A. 投影类型与 PeekHost | Task 3 |
| A. `entry` 删除 | Task 4 |
| A. 能力体去 depth 分支 | Task 5 |
| A. 连带文档 | Task 8 |
| A. 连带 e2e | Task 9 |
| B. 排版角色 | Task 6 |
| B. 删 `rowLineHeight` | Task 6 |
| C.1 marker 对齐 | Task 7 |
| C.2 图标 | Task 7 |
| C.3 `available` 不画灰 | Task 7 |
| D. 删 chevron | Task 7 |
| 验证 1–6 | Task 10 / 11 |
| `#1347` 报告 | Task 12 |

**已知偏离 spec 一处**：spec 写「把 `WorkspaceViewBinding.icon` 引入 entry」，实现改为在 `CapsuleProjectionBinding` 上声明。原因是 `terminal-keys` **没有 Workspace view**（SC-38 的刻意形状），从 Workspace 注册表取图标会让它——App 上的第一行——画一个空列，比现状更糟。两个 surface 各自声明自己的 chrome，与 Workspace 注册表那条「an icon is chrome, and chrome belongs to the app layer」一致。两处重复的是 `Bot` / `GitBranch` 两个标识符。

**类型一致性**：`resolveCapabilityProjection` 在 Task 1 返回 `CapabilityId | undefined`，Task 2 立刻按此消费；`CapsuleCapabilityProjection` 在 Task 3 去掉 `depth` / `onDeeper`，Task 2 的返回值已同步；`iconFor` 在 Task 7 定义并当步消费。
