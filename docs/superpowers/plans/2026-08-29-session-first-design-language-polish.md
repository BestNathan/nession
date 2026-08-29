# Session-first Design Language Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish session-first visual language via a scoped token overlay + interaction/a11y sweep — keep light chrome + dark well, no IA or Dashboard changes.

**Architecture:** Extend `.session-first-shell` CSS vars (spacing, type, focus, motion) in `web/src/index.css`. Sweep session-first chrome components to use those tokens and meet focus / touch / transition rules. No global `:root` retheme that bleeds into legacy Dashboard.

**Tech Stack:** React 18, Tailwind v4, shadcn/ui, Vitest + Testing Library, Playwright. Worktree base: `origin/staging`. Branch: `feat/session-first-design-language-polish`. PR base: `staging`.

**Spec:** `docs/superpowers/specs/2026-08-29-session-first-design-language-polish-design.md`  
**Related:** [#492](https://github.com/BestNathan/nession/issues/492)

---

## File map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `web/src/index.css` | Extend `.session-first-shell` with `--sf-space-*`, type, focus, motion tokens + reduced-motion |
| Modify | `web/src/session-first/SessionFirstShell.tsx` | Ensure shell root keeps `session-first-shell`; optional data attr for tests |
| Modify | `web/src/session-first/patterns/SessionHeader.tsx` | Tokenized padding/type; focus-visible on back |
| Modify | `web/src/session-first/patterns/SessionListHeader.tsx` | Spacing rhythm; create/filters already have max-lg heights — align transitions |
| Modify | `web/src/session-first/patterns/SessionItem.tsx` | Row padding/type; focus-visible; kill not hover-only on touch |
| Modify | `web/src/session-first/SessionFirstSidebar.tsx` | Footer/list spacing via tokens |
| Modify | `web/src/session-first/TerminalCapsule.tsx` | Use motion/focus tokens; keep V4 safe-area/hit targets |
| Modify | Related `web/src/session-first/__tests__/integration/*.test.tsx` | Assert token classes / focus / shell overlay |
| Optional | `web/src/session-first/tokens.css` | Only if `index.css` block grows unwieldy — prefer single `.session-first-shell` block first |

**Do not touch:** `sessionFirst.ts` default, legacy Dashboard / BottomBar, `visualViewport` keyboard helpers, `k8s/overlays/**`.

**Worktree setup:**

```bash
cd /path/to/nession
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree add -b feat/session-first-design-language-polish \
  .claude/worktrees/feat-session-first-design-language-polish origin/staging
cd .claude/worktrees/feat-session-first-design-language-polish
```

Claim/comment on #492 (or a follow-up issue) before coding; release when PR merges.

---

### Task 1: Token overlay on `.session-first-shell` (TDD)

**Files:**
- Modify: `web/src/index.css` (`.session-first-shell` block)
- Modify: `web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx`

- [ ] **Step 1: Failing test — shell exposes design tokens**

In `SessionFirstShell.test.tsx`, add (reuse existing render helpers):

```tsx
it('exposes session-first design-language tokens on the shell root', () => {
  renderShell(); // existing helper that mounts SessionFirstShell
  const shell = screen.getByTestId('session-first-shell');
  expect(shell).toHaveClass('session-first-shell');
  const style = getComputedStyle(shell);
  // Custom props are readable when set on the element; if jsdom omits CSS file,
  // assert class + data attribute instead:
  expect(shell).toHaveAttribute('data-sf-design', 'polish');
});
```

If the existing shell test already asserts `session-first-shell`, extend it with `data-sf-design="polish"` rather than inventing a new helper name — match the file’s real helper.

- [ ] **Step 2: Run — expect FAIL**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionFirstShell.test.tsx
```

Expected: missing `data-sf-design`.

- [ ] **Step 3: Implement tokens + data attr**

In `SessionFirstShell.tsx`, on the root `div` with `data-testid="session-first-shell"`:

```tsx
className="session-first-shell flex h-[100dvh] flex-col bg-background"
data-sf-design="polish"
```

In `web/src/index.css`, extend `.session-first-shell` (keep existing light lock + `--sf-terminal-well` / `--sf-terminal-well` naming as on branch):

```css
.session-first-shell {
  /* existing light lock vars… */

  /* Design language polish (#492 follow-up) */
  --sf-space-1: 0.25rem; /* 4 */
  --sf-space-2: 0.5rem;  /* 8 */
  --sf-space-3: 0.75rem; /* 12 */
  --sf-space-4: 1rem;    /* 16 */
  --sf-space-5: 1.5rem;  /* 24 */

  --sf-text-title: 1rem;
  --sf-text-body: 0.875rem;
  --sf-text-muted: 0.75rem;
  --sf-leading: 1.5;

  --sf-focus-ring: 2px;
  --sf-focus-offset: 2px;
  --sf-motion: 180ms;
  --sf-ease: cubic-bezier(0.2, 0, 0, 1);
}

.session-first-shell :focus-visible {
  outline: var(--sf-focus-ring) solid var(--ring);
  outline-offset: var(--sf-focus-offset);
}

@media (prefers-reduced-motion: reduce) {
  .session-first-shell {
    --sf-motion: 0ms;
  }
}
```

If the branch uses `--sf-terminal-well` vs `--sf-terminal-well`, **do not rename** — only append polish vars.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/src/index.css web/src/session-first/SessionFirstShell.tsx \
  web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): add session-first design-language token overlay

Scoped spacing/type/focus/motion vars under .session-first-shell
without retuning legacy Dashboard :root theme.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Header + list chrome consume tokens (TDD)

**Files:**
- Modify: `web/src/session-first/patterns/SessionHeader.tsx`
- Modify: `web/src/session-first/patterns/SessionListHeader.tsx`
- Modify: `web/src/session-first/patterns/SessionItem.tsx`
- Modify: matching integration tests

- [ ] **Step 1: Failing tests**

`SessionHeader.test.tsx`:

```tsx
it('applies design-language spacing and focus-friendly back control', () => {
  render(
    <SessionHeader
      sessionName="demo"
      agentLabel="host"
      state={healthy}
      surface="terminal"
      onSurfaceChange={vi.fn()}
      onOpenAgent={vi.fn()}
      onBackToSessions={vi.fn()}
    />,
  );
  const header = screen.getByRole('banner'); // or the <header> element
  expect(header.className).toMatch(/gap-\[var\(--sf-space-3\)\]|p-\[var\(--sf-space/);
  const back = screen.getByTestId('session-first-back-to-list');
  expect(back.className).toMatch(/transition-|duration-|max-lg:size-11/);
});
```

Use the **actual** testids/props from the file on the branch (V4 already added `max-lg:size-11` on back). Prefer asserting at least one `--sf-space-*` usage and that back retains `max-lg:size-11`.

`SessionItem.test.tsx` — assert row uses tokenized padding or `transition-[background-color,box-shadow]` with duration referencing motion (or `duration-200` mapped via arbitrary value):

```tsx
expect(screen.getByTestId(/* existing session-item testid */).className).toMatch(
  /sf-space|p-\[var\(--sf-space/,
);
```

- [ ] **Step 2: Run — FAIL**

```bash
cd web && npx vitest run \
  src/session-first/__tests__/integration/SessionHeader.test.tsx \
  src/session-first/__tests__/integration/SessionListHeader.test.tsx \
  src/session-first/__tests__/integration/SessionItem.test.tsx
```

- [ ] **Step 3: Implement chrome**

Examples (adjust to real class strings on branch):

`SessionHeader.tsx`:

```tsx
<header className="flex flex-row flex-wrap items-center gap-[var(--sf-space-3)] border-b px-[var(--sf-space-3)] py-[var(--sf-space-3)] lg:px-[var(--sf-space-4)]">
  {onBackToSessions ? (
    <Button
      className="size-9 shrink-0 transition-[background-color,transform] duration-[var(--sf-motion)] ease-[var(--sf-ease)] max-lg:size-11 lg:hidden"
      ...
```

`SessionListHeader.tsx` root:

```tsx
<div className="flex shrink-0 flex-col gap-[var(--sf-space-2)] border-b p-[var(--sf-space-3)] max-lg:gap-[var(--sf-space-3)] lg:p-[var(--sf-space-2)]">
```

Create / Filters: keep `max-lg:min-h-11`; add `transition-colors duration-[var(--sf-motion)]`.

`SessionItem.tsx`: row `px-[var(--sf-space-3)] py-[var(--sf-space-2)]`; ensure Kill remains visible on selected / `focus-within` (V2 rule) — do not regress to hover-only.

No raw palette hex in these files.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/patterns/SessionHeader.tsx \
  web/src/session-first/patterns/SessionListHeader.tsx \
  web/src/session-first/patterns/SessionItem.tsx \
  web/src/session-first/__tests__/integration/SessionHeader.test.tsx \
  web/src/session-first/__tests__/integration/SessionListHeader.test.tsx \
  web/src/session-first/__tests__/integration/SessionItem.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): wire session-first chrome to design tokens

Header/list/item spacing and transitions consume --sf-* vars;
preserve V4 touch targets and V2 kill visibility rules.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Sidebar footer + capsule polish (TDD)

**Files:**
- Modify: `web/src/session-first/SessionFirstSidebar.tsx`
- Modify: `web/src/session-first/TerminalCapsule.tsx`
- Modify: `SessionFirstShell.test.tsx` and/or `TerminalCapsule.test.tsx`

- [ ] **Step 1: Failing tests**

Footer (extend existing safe-area test):

```tsx
expect(screen.getByTestId('session-first-sidebar-footer').className).toMatch(
  /sf-space|px-\[var\(--sf-space/,
);
```

Capsule:

```tsx
it('uses design-language motion on capsule controls', () => {
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
  expect(screen.getByTestId('terminal-capsule-expand').className).toMatch(
    /duration-\[var\(--sf-motion\)\]|duration-\[var\(--sf-motion/,
  );
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Footer:

```tsx
className="flex shrink-0 items-center justify-end border-t px-[var(--sf-space-2)] py-[var(--sf-space-2)] pb-[max(0.5rem,env(safe-area-inset-bottom))]"
```

Capsule expand + mode buttons: append  
`transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]`  
Keep V4 classes: safe-area bottom, `max-lg:size-11` / `max-h-[28vh]` / `lg:max-h-[32vh]`. Modes remain input|commands only.

- [ ] **Step 4: Run — PASS**

```bash
cd web && npx vitest run \
  src/session-first/__tests__/integration/TerminalCapsule.test.tsx \
  src/session-first/__tests__/integration/SessionFirstShell.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(web): apply design tokens to sidebar footer and capsule

Motion/spacing vars on footer + capsule controls; keep V4
safe-area and Input/Commands-only modes.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Regression gate + PR + Playwright

- [ ] **Step 1: Full web gate**

```bash
cd web && npm run lint && npm test && npx tsc --noEmit
```

Expected: all green.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin HEAD
gh pr create --base staging \
  --title "feat: session-first design language polish (#492)" \
  --body "$(cat <<'EOF'
## 变更内容
- Scoped \`.session-first-shell\` design tokens (spacing/type/focus/motion)
- Chrome + capsule interaction/a11y polish
- Spec: docs/superpowers/specs/2026-08-29-session-first-design-language-polish-design.md

Related to #492. Does not flip \`session_first\` default. Legacy Dashboard untouched.

## 测试报告
- [x] \`npm run lint\`
- [x] \`npm test\`
- [ ] Playwright (PR comment): desktop + 375 list/detail/focus

EOF
)"
gh pr merge --auto --rebase
```

- [ ] **Step 3: Playwright**

`?session_first=1`

1. Desktop list + detail + capsule collapsed  
2. 375×812 list XOR detail + capsule  
3. Keyboard Tab: visible focus on New Session / back / capsule expand  

Save under `.playwright-mcp/screenshots/dl-*.png`, upload via `screenshots/pr-<N>-dl` branch, comment on PR. Check Playwright box in body.

- [ ] **Step 4: After merge**

Comment on #492 that design-language polish landed; remove `in-progress` if claimed for this work.

---

## Spec coverage

| Spec | Task |
|------|------|
| Token overlay under `.session-first-shell` | 1 |
| Header / list / item consume tokens | 2 |
| Focus / motion / reduced-motion | 1–3 |
| Touch ≥44px narrow (preserve V4) | 2–3 |
| Capsule Input/Commands only; dark well | 3 |
| No Dashboard / no default flip | 1–4 |
| Playwright | 4 |

## Self-review

- No placeholders; class/testid names must be verified against the staging branch at implement time (V4 renamed some strings).  
- Prefer extending existing tests over new files.  
- Do not rename `--sf-terminal-well` / light-lock vars.

---

## Execution handoff

Plan complete. Two options:

1. **Subagent-driven (recommended)** — fresh subagent per task + review between tasks  
2. **Inline** — execute in this session with checkpoints  

Which approach?
