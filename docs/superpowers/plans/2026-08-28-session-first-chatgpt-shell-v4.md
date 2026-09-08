# Session-first ChatGPT Shell V4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship #492 V4 — narrow-viewport visual/touch polish so list XOR detail + TerminalCapsule match the desktop ChatGPT-style shell language, without IA or cutover changes.

**Architecture:** Restyle-in-place with Tailwind `max-lg:` / safe-area utilities on existing session-first surfaces. No new mobile chrome component. Capsule gains bottom safe-area, larger narrow hit targets, and a tighter expanded sheet height; chrome tightens spacing so New Session / Filters / footer overflow stay usable on one column.

**Tech Stack:** React 18, Tailwind v4, shadcn/ui, Vitest + Testing Library, Playwright MCP. Worktree base: `origin/staging`. Branch: `feat/session-first-chatgpt-shell-v4`. PR base: `staging`.

**Spec:** `docs/superpowers/specs/2026-08-28-session-first-chatgpt-shell-v4-design.md`  
**Issue:** [#492](https://github.com/BestNathan/nession/issues/492)

---

## File map (V4)

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `web/src/session-first/TerminalCapsule.tsx` | Safe-area bottom inset; `max-lg` hit targets (~44px); sheet `max-h-[28vh]` under `max-lg`, `lg:max-h-[32vh]` |
| Modify | `web/src/session-first/__tests__/integration/TerminalCapsule.test.tsx` | Assert mobile class tokens on root / sheet / controls |
| Modify | `web/src/session-first/patterns/SessionHeader.tsx` | Narrow padding + keep back control ≥44px touch (`size-11` under `max-lg`) |
| Modify | `web/src/session-first/patterns/SessionListHeader.tsx` | Calm narrow spacing; New Session / Filters touch-friendly heights |
| Modify | `web/src/session-first/SessionFirstSidebar.tsx` | Footer safe-area padding so overflow stays above home indicator |
| Modify | Related header/list tests if class/testid assertions exist | Keep XOR + back tests green |

**Do not touch in V4:** `sessionFirst.ts` default, legacy Dashboard / BottomBar, soft-keyboard `visualViewport` helpers, new mobile nav components, `k8s/overlays/**`.

**Worktree setup:**

```bash
cd /path/to/nession
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree add -b feat/session-first-chatgpt-shell-v4 \
  .claude/worktrees/feat-session-first-chatgpt-shell-v4 origin/staging
cd .claude/worktrees/feat-session-first-chatgpt-shell-v4
```

Claim #492 (`in-progress`) before coding. Release when V4 PR merges to staging.

---

### Task 1: TerminalCapsule mobile polish (TDD)

**Files:**
- Modify: `web/src/session-first/TerminalCapsule.tsx`
- Modify: `web/src/session-first/__tests__/integration/TerminalCapsule.test.tsx`

- [ ] **Step 1: Failing tests**

Add:

```tsx
it('applies safe-area and narrow sheet height classes', () => {
  render(
    <TerminalCapsule
      mode="input"
      onModeChange={vi.fn()}
      expanded
      onExpandedChange={vi.fn()}
      inputPanel={<div data-testid="input-panel" />}
      commandsPanel={<div />}
    />,
  );
  const root = screen.getByTestId('terminal-capsule');
  expect(root.className).toMatch(/bottom-\[max\(0\.75rem,env\(safe-area-inset-bottom\)\)\]/);
  const sheet = screen.getByTestId('terminal-capsule-sheet');
  expect(sheet.className).toMatch(/max-h-\[28vh\]/);
  expect(sheet.className).toMatch(/lg:max-h-\[32vh\]/);
});

it('uses larger expand control on narrow viewports', () => {
  render(
    <TerminalCapsule
      mode="input"
      onModeChange={vi.fn()}
      expanded={false}
      onExpandedChange={vi.fn()}
      inputPanel={<div />}
      commandsPanel={<div />}
    />,
  );
  const expand = screen.getByTestId('terminal-capsule-expand');
  expect(expand.className).toMatch(/max-lg:size-11/);
});
```

Keep existing expand / mode / disabled tests intact.

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/TerminalCapsule.test.tsx
```

Expected: FAIL on missing class tokens.

- [ ] **Step 3: Implement capsule classes**

Replace positioning / sheet / control sizing in `TerminalCapsule.tsx`:

```tsx
<div
  data-testid="terminal-capsule"
  data-disabled={disabled ? 'true' : undefined}
  className="absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-10 flex flex-col gap-2"
>
  {expanded ? (
    <div
      data-testid="terminal-capsule-sheet"
      className={cn(
        'max-h-[28vh] overflow-auto rounded-2xl lg:max-h-[32vh]',
        'border border-border/60 bg-background/95 shadow-lg backdrop-blur-sm',
      )}
    >
      {mode === 'input' ? inputPanel : commandsPanel}
    </div>
  ) : null}

  <div
    className={cn(
      'flex flex-row items-center gap-1 rounded-full',
      'border border-border/60 bg-background/95 px-2 py-1.5 shadow-lg backdrop-blur-sm',
      'max-lg:min-h-11 max-lg:py-2',
    )}
  >
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="max-lg:size-11"
      data-testid="terminal-capsule-expand"
      disabled={disabled}
      aria-label={expanded ? 'Collapse capsule' : 'Expand capsule'}
      onClick={() => onExpandedChange(!expanded)}
    >
      {expanded ? <ChevronUp className="size-4" /> : <Plus className="size-4" />}
    </Button>
    {/* mode buttons: add className="rounded-full max-lg:min-h-11 max-lg:px-3" */}
```

Do **not** add Env. Do **not** change props API.

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/TerminalCapsule.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/TerminalCapsule.tsx \
  web/src/session-first/__tests__/integration/TerminalCapsule.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): polish TerminalCapsule for narrow viewports (#492 V4)

Safe-area bottom inset, larger touch targets under max-lg, and a
tighter expanded sheet so the terminal well stays readable.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Session header + list chrome polish (TDD)

**Files:**
- Modify: `web/src/session-first/patterns/SessionHeader.tsx`
- Modify: `web/src/session-first/patterns/SessionListHeader.tsx`
- Modify: `web/src/session-first/__tests__/integration/SessionHeader.test.tsx` (extend)
- Modify: `web/src/session-first/__tests__/integration/SessionListHeader.test.tsx` (extend if present; else add class assertions to existing create/filters tests)

- [ ] **Step 1: Failing header test**

In `SessionHeader.test.tsx`, add:

```tsx
it('uses a larger back control under max-lg', () => {
  render(
    <SessionHeader
      sessionName="demo"
      agentLabel="host"
      state={/* existing fixture DomainState */}
      surface="terminal"
      onSurfaceChange={vi.fn()}
      onOpenAgent={vi.fn()}
      onBackToSessions={vi.fn()}
    />,
  );
  const back = screen.getByTestId('session-first-back-to-list');
  expect(back.className).toMatch(/max-lg:size-11/);
});
```

Reuse the same `DomainState` fixture the file already uses — do not invent a new mapper.

- [ ] **Step 2: Run — expect FAIL**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionHeader.test.tsx
```

- [ ] **Step 3: Implement header + list header**

`SessionHeader.tsx`:

```tsx
<header className="flex flex-row flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2.5 max-lg:gap-x-2 lg:px-4 lg:py-3">
  {onBackToSessions ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-9 shrink-0 max-lg:size-11 lg:hidden"
      aria-label="Back to sessions"
      data-testid="session-first-back-to-list"
      onClick={() => onBackToSessions()}
    >
      <ChevronLeft className="size-5" />
    </Button>
  ) : null}
  {/* rest unchanged */}
```

`SessionListHeader.tsx` root + CTA:

```tsx
<div className="flex shrink-0 flex-col gap-2 border-b p-3 max-lg:gap-2.5 lg:p-2">
  {/* SearchBar unchanged */}
  <Button
    type="button"
    className="w-full rounded-lg max-lg:min-h-11"
    data-testid="session-first-create"
    ...
  >
```

Filters trigger: add `max-lg:min-h-11` to the outline Filters button `className` (keep `min-h-8` desktop via `lg:min-h-8` or replace with `min-h-8 max-lg:min-h-11`).

Do **not** change XOR wiring in `SessionFirstWorkspace`.

- [ ] **Step 4: Run header + list tests — PASS**

```bash
cd web && npx vitest run \
  src/session-first/__tests__/integration/SessionHeader.test.tsx \
  src/session-first/__tests__/integration/SessionListHeader.test.tsx
```

If `SessionListHeader.test.tsx` has no class assertion, add one for `session-first-create` containing `max-lg:min-h-11`.

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/patterns/SessionHeader.tsx \
  web/src/session-first/patterns/SessionListHeader.tsx \
  web/src/session-first/__tests__/integration/SessionHeader.test.tsx \
  web/src/session-first/__tests__/integration/SessionListHeader.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): tighten session-first mobile chrome (#492 V4)

Larger back/create/filters touch targets and calmer narrow padding
while keeping list XOR detail and back-to-list behavior.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Sidebar footer safe-area

**Files:**
- Modify: `web/src/session-first/SessionFirstSidebar.tsx`
- Modify: `web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx` **or** a focused sidebar test — assert footer class includes safe-area

- [ ] **Step 1: Failing assertion**

Wherever the footer is queried today (`session-first-sidebar-footer`), add:

```tsx
expect(screen.getByTestId('session-first-sidebar-footer').className).toMatch(
  /pb-\[max\(0\.5rem,env\(safe-area-inset-bottom\)\)\]/,
);
```

If no existing test renders the sidebar footer, extend the shell test that already opens overflow / More.

- [ ] **Step 2: Run — FAIL**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionFirstShell.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
<div
  data-testid="session-first-sidebar-footer"
  className="flex shrink-0 items-center justify-end border-t px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
>
  <SessionFirstOverflowMenu onOpenEnv={onOpenEnv} onLegacy={onLegacy} />
</div>
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/SessionFirstSidebar.tsx \
  web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): safe-area pad session-first sidebar footer (#492 V4)

Keep Env/ServerInfo/Legacy overflow above the home indicator on
narrow devices.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Regression sweep + PR + Playwright

**Files:** none new (verification + ship)

- [ ] **Step 1: Full web gate locally**

```bash
cd web && npm run lint && npm test && npx tsc --noEmit
```

Expected: all green. Fix any fallout in-scope (no eslint-disable).

- [ ] **Step 2: Push + PR**

```bash
git push -u origin HEAD
gh pr create --base staging \
  --title "feat: session-first ChatGPT shell V4 — mobile polish (#492)" \
  --body "$(cat <<'EOF'
## 变更内容
- Narrow viewport capsule: safe-area, larger hit targets, tighter sheet height
- List/detail chrome polish (back / New Session / Filters / footer safe-area)
- Spec: docs/superpowers/specs/2026-08-28-session-first-chatgpt-shell-v4-design.md

Part of #492 (V4/4). Does not flip \`session_first\` default.

## 测试报告
- [x] \`npm run lint\`
- [x] \`npm test\`
- [ ] Playwright screenshots (PR comment): 375 list + detail capsule states

EOF
)"
gh pr merge --auto --rebase
```

- [ ] **Step 3: Playwright at 375×812**

```text
?session_first=1
viewport: 375×812
```

1. List-only (no session selected / after back)  
2. Detail + collapsed capsule in well  
3. Expanded Input  
4. Commands mode — confirm no Env in capsule  

Save under `.playwright-mcp/screenshots/` (`v4-*.png`). Upload via `screenshots/pr-<N>-v4` orphan branch + raw URLs in a **PR comment** (same pattern as V1–V3). Check Playwright checklist in the PR body.

- [ ] **Step 4: After merge**

```bash
gh issue edit 492 --remove-label in-progress
gh issue comment 492 --body "V4 landed via https://github.com/BestNathan/nession/pull/<N> — \`in-progress\` released. Remaining: #472 PR7 cutover."
```

---

## Spec coverage

| Spec | Task |
|------|------|
| Restyle-in-place; no new mobile chrome | 1–3 |
| Capsule safe-area + hit targets + sheet cap | 1 |
| Keep XOR + back-to-list | 2 (no Workspace XOR edits) |
| List CTA / Filters / footer usable | 2–3 |
| No visualViewport keyboard avoidance | — (explicit non-goal) |
| Playwright 375 | 4 |
| Flag default still off | 4 |

## Self-review notes

- Class-string assertions are brittle but match V3 capsule testing style; prefer exact tokens from this plan.  
- Desktop `lg:` prefixes must preserve current desktop look (sheet 32vh, smaller icon buttons).  
- Do not change `sessionFirst` default.  
- Do not put Env in the capsule.

---

## Execution handoff

Plan complete. Two options:

1. **Subagent-driven (recommended)** — fresh subagent per task + review between tasks  
2. **Inline** — execute in this session with checkpoints  

Which approach?
