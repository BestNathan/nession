# Session-first ChatGPT Shell V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship #492 V2 — quiet session-history sidebar (hover Kill, calmer create CTA, collapsed filters/sort) and move Env / ServerInfo / Legacy into a sidebar footer overflow; header stays brand + badge only.

**Architecture:** Restyle-in-place on existing `SessionList` / `SessionItem` / `SessionListHeader` / `SessionFirstSidebar` APIs. Relocate `SessionFirstOverflowMenu` from `SessionFirstChrome` into a pinned sidebar footer. Flag remains default off; validate with `?session_first=1`.

**Tech Stack:** React 18, Tailwind v4, shadcn/ui, Vitest + Testing Library. Worktree base: `origin/staging`. Branch: `feat/session-first-chatgpt-shell-v2`. PR base: `staging`.

**Spec:** `docs/superpowers/specs/2026-08-28-session-first-chatgpt-shell-v2-design.md`  
**Issue:** [#492](https://github.com/BestNathan/nession/issues/492)

---

## File map (V2)

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `web/src/session-first/patterns/SessionItem.tsx` | Rounded selected row; hover / focus-within / selected Kill |
| Modify | `web/src/session-first/__tests__/integration/SessionItem.test.tsx` | Hover-reveal + kill without select |
| Modify | `web/src/session-first/patterns/SessionListHeader.tsx` | New Session CTA; search always on; filters+sort disclosure |
| Modify | `web/src/session-first/__tests__/integration/SessionListHeader.test.tsx` | Disclosure defaults closed; filters/sort behind control |
| Modify | `web/src/session-first/patterns/SessionList.tsx` | Drop always-visible sort strip; calmer padding/skeletons |
| Modify | `web/src/session-first/__tests__/integration/SessionList.test.tsx` | No permanent Name/Activity sort row when props present |
| Modify | `web/src/session-first/SessionFirstSidebar.tsx` | Footer hosts overflow menu |
| Modify | `web/src/session-first/SessionFirstChrome.tsx` | Remove overflow; brand + badge only |
| Modify | `web/src/session-first/__tests__/integration/SessionFirstChrome.test.tsx` | No overflow in chrome |
| Modify | `web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx` | Open Env via footer overflow |
| Modify | `web/src/session-first/SessionFirstWorkspace.tsx` | Pass `onOpenEnv` / `onLegacy` into sidebar if needed |

**Do not touch in V2:** `TerminalWell`, capsule/`BottomBar`, mobile XOR polish, `sessionFirst.ts` default, `k8s/overlays/**`.

**Worktree setup (before Task 1):**

```bash
cd /path/to/nession   # project root on main
git fetch origin
git checkout main && git pull --ff-only origin main
git worktree add -b feat/session-first-chatgpt-shell-v2 \
  .claude/worktrees/feat-session-first-chatgpt-shell-v2 origin/staging
cd .claude/worktrees/feat-session-first-chatgpt-shell-v2
```

Claim #492 (`in-progress` + claim comment) before coding.

---

### Task 1: SessionItem hover-reveal Kill

**Files:**
- Modify: `web/src/session-first/patterns/SessionItem.tsx`
- Modify: `web/src/session-first/__tests__/integration/SessionItem.test.tsx`

- [ ] **Step 1: Update tests first**

Keep select + kill behavior. Add visibility expectations:

```tsx
it('reveals kill on hover and does not select when kill is clicked', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const onKill = vi.fn();
  render(
    <SessionItem
      session={session}
      domain={domain}
      agentLabel="devbox-01"
      selected={false}
      onSelect={onSelect}
      onKill={onKill}
    />,
  );
  const row = screen.getByTestId('session-item-a1:fix').closest('[data-testid="session-item-row"]');
  expect(row).toBeTruthy();
  // Kill may be in DOM but visually hidden until hover — prefer:
  // opacity-0 / invisible / pointer-events-none until group-hover
  await user.hover(row!);
  const kill = await screen.findByTestId('session-kill-a1:fix');
  await user.click(kill);
  expect(onKill).toHaveBeenCalledWith(session);
  expect(onSelect).not.toHaveBeenCalled();
});

it('shows kill when selected even without hover', () => {
  render(
    <SessionItem
      session={session}
      domain={domain}
      agentLabel="devbox-01"
      selected
      onSelect={vi.fn()}
      onKill={vi.fn()}
    />,
  );
  expect(screen.getByTestId('session-kill-a1:fix')).toBeVisible();
});
```

Adapt assertions to the chosen hide strategy (`group-hover:opacity-100` + `opacity-0`, or conditional render). Prefer **always in DOM** + CSS reveal so focus-within works without remounting.

- [ ] **Step 2: Run — expect FAIL on old always-visible styling / missing row testid**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionItem.test.tsx
```

- [ ] **Step 3: Implement**

Target shape:

```tsx
<div
  data-testid="session-item-row"
  className={cn(
    'group flex items-start gap-1 rounded-lg px-2 py-1.5 transition-colors',
    selected && 'bg-muted',
  )}
>
  <button /* select … */ data-testid={`session-item-${session.session_id}`} … />
  {onKill ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid={`session-kill-${session.session_id}`}
            aria-label="Kill session"
            className={cn(
              'mt-0.5 size-8 shrink-0 text-muted-foreground hover:text-destructive',
              'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto',
              'group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
              selected && 'opacity-100 pointer-events-auto',
            )}
            onClick={(event) => {
              event.stopPropagation();
              onKill(session);
            }}
          />
        }
      >
        <Trash2 className="size-4" />
      </TooltipTrigger>
      <TooltipContent side="bottom">Kill session</TooltipContent>
    </Tooltip>
  ) : null}
</div>
```

Use `bg-muted` / `bg-accent` consistently with shell light tokens — soft selected block, no left rail. Drop loud `border-destructive` outline.

- [ ] **Step 4: Tests PASS**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionItem.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git branch --show-current  # not main
git add web/src/session-first/patterns/SessionItem.tsx \
  web/src/session-first/__tests__/integration/SessionItem.test.tsx
git commit -m "feat(web): hover-reveal Kill on session-first history rows (#492 V2)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: SessionListHeader — CTA + filter disclosure

**Files:**
- Modify: `web/src/session-first/patterns/SessionListHeader.tsx`
- Modify: `web/src/session-first/__tests__/integration/SessionListHeader.test.tsx`

**Props change:** Accept sort props from sidebar (move from `SessionList`):

```tsx
sortField?: SortField;
sortDirection?: SortDirection;
toggleSort?: (field: SortField) => void;
```

- [ ] **Step 1: Tests first**

```tsx
it('keeps search visible and hides filters until disclosure opens', async () => {
  render(<SessionListHeader {...baseProps} toggleSort={vi.fn()} sortField="name" sortDirection="asc" />);
  expect(screen.getByPlaceholderText('Search agents and sessions...')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Online' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByTestId('session-list-filters'));
  expect(await screen.findByRole('button', { name: /Online/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Name/ })).toBeInTheDocument();
});

it('renders New Session CTA that calls onCreate', async () => {
  const onCreate = vi.fn();
  render(<SessionListHeader {...baseProps} onCreate={onCreate} />);
  await userEvent.click(screen.getByTestId('session-first-create'));
  expect(onCreate).toHaveBeenCalled();
});
```

Note: `SearchBar` today always renders filter pills. Options (pick one, prefer A):

- **A (recommended):** Split search input from filters — use `SearchBar` only for the input path, or add a prop `showStatusFilters?: boolean` default true for legacy, false in session-first header and render filters inside the disclosure. Prefer **session-first-local** filters UI in the disclosure rather than widening `SearchBar` API unless tests for Dashboard break.
- **B:** Fork a thin `SessionSearchField` in session-first that wraps the same debounced input pattern.

Do **not** change legacy Dashboard SearchBar behavior unless using an optional prop with default preserving current UI.

- [ ] **Step 2: Run — FAIL**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionListHeader.test.tsx
```

- [ ] **Step 3: Implement header**

Layout sketch:

```tsx
<div className="flex shrink-0 flex-col gap-2 border-b p-3">
  <Button
    type="button"
    data-testid="session-first-create"
    className="w-full rounded-full"
    disabled={createDisabled}
    onClick={() => onCreate()}
  >
    <Plus className="size-4" />
    <span className="ml-1">New Session</span>
  </Button>
  <div className="flex items-center gap-1">
    {/* search field — always visible */}
    <Button
      type="button"
      size="icon"
      variant="ghost"
      data-testid="session-list-filters"
      aria-expanded={filtersOpen}
      aria-label="Filters and sort"
      onClick={() => setFiltersOpen((o) => !o)}
    >
      <SlidersHorizontal className="size-4" />
    </Button>
    <RefreshButton … />
  </div>
  {filtersOpen ? (
    <div data-testid="session-list-filters-panel" className="flex flex-col gap-2">
      {/* All / Online / Offline */}
      {/* Name / Activity sort buttons — reuse SortButton logic from SessionList */}
    </div>
  ) : null}
</div>
```

Use local `useState` for `filtersOpen` (default `false`).

- [ ] **Step 4: PASS + Commit**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionListHeader.test.tsx
git add web/src/session-first/patterns/SessionListHeader.tsx \
  web/src/session-first/__tests__/integration/SessionListHeader.test.tsx
# include SearchBar optional prop file if touched
git commit -m "feat(web): session-first New Session CTA and filter disclosure (#492 V2)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: SessionList — drop always-visible sort strip

**Files:**
- Modify: `web/src/session-first/patterns/SessionList.tsx`
- Modify: `web/src/session-first/SessionFirstSidebar.tsx` (wire sort props into header)
- Modify: `web/src/session-first/__tests__/integration/SessionList.test.tsx` (if it asserts sort row)

- [ ] **Step 1:** Remove the `toggleSort ? (… SortButton row …)` block from `SessionList`. Keep `SortButton` export or move helper into `SessionListHeader` to avoid duplication — prefer **one** SortButton helper (extract to small local shared file only if both need it; otherwise copy minimal buttons into header and delete from list).

- [ ] **Step 2:** Sidebar passes `sortField` / `sortDirection` / `toggleSort` to `SessionListHeader` instead of (or in addition until list stops using them) `SessionList`.

- [ ] **Step 3:** Calmer list padding (`p-2` → `p-2 gap-0.5` / skeleton `h-14 rounded-lg`).

- [ ] **Step 4:** Tests + commit

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionList.test.tsx \
  src/session-first/__tests__/integration/SessionListHeader.test.tsx
git commit -m "feat(web): move session-first sort into filter disclosure (#492 V2)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Footer overflow + thin chrome

**Files:**
- Modify: `web/src/session-first/SessionFirstChrome.tsx`
- Modify: `web/src/session-first/SessionFirstSidebar.tsx`
- Modify: `web/src/session-first/SessionFirstWorkspace.tsx` (and/or Shell) — thread `onOpenEnv` / `onLegacy`
- Modify: chrome + shell integration tests

- [ ] **Step 1: Chrome tests** — overflow **absent**; brand + badge present; error banner still works. Remove Env-via-overflow assertions from chrome tests.

```tsx
it('renders brand and badge without overflow menu', () => {
  render(<SessionFirstChrome … />);
  expect(screen.getByTestId('session-first-chrome')).toBeInTheDocument();
  expect(screen.getByText('Nession')).toBeInTheDocument();
  expect(screen.queryByTestId('session-first-overflow')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Implement chrome** — delete `SessionFirstOverflowMenu` import/usage. Props `onOpenEnv` / `onLegacy` can be **removed** from Chrome if unused; update call sites.

- [ ] **Step 3: Sidebar footer**

```tsx
<aside className={cn('… flex flex-col …')}>
  <SessionListHeader … />
  <SessionList className="min-h-0 flex-1" … />
  <div
    data-testid="session-first-sidebar-footer"
    className="flex shrink-0 items-center justify-end border-t px-2 py-2"
  >
    <SessionFirstOverflowMenu onOpenEnv={onOpenEnv} onLegacy={onLegacy} />
  </div>
</aside>
```

Add `onOpenEnv` / `onLegacy` to `SessionFirstSidebarProps`. Thread from `SessionFirstShell` → `SessionFirstWorkspace` → sidebar (same handlers currently passed to Chrome).

- [ ] **Step 4: Shell tests** — Env path: click footer overflow (`session-first-overflow`) then `session-first-env` with `findByTestId`. Mock `ServerInfoMenu` as today.

- [ ] **Step 5: Full web check**

```bash
cd web && npm run lint && npm test
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(web): move session-first overflow to sidebar footer (#492 V2)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: PR to staging + Playwright

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin HEAD
gh pr create --base staging \
  --title "feat: session-first ChatGPT shell V2 — history sidebar (#492)" \
  --body "$(cat <<'EOF'
## 变更内容
- Hover-reveal Kill on history rows; softer selected state
- New Session CTA; search always on; filters/sort in disclosure
- Env / ServerInfo / Legacy in sidebar footer overflow; header = brand + badge
- Spec: docs/superpowers/specs/2026-08-28-session-first-chatgpt-shell-v2-design.md

Part of #492 (V2/4). Does not flip \`session_first\` default.

## 测试报告
- [x] \`npm run lint\`
- [x] \`npm test\`
- [ ] Playwright screenshots (PR comment): sidebar history + footer overflow + hover Kill

EOF
)"
gh pr merge --auto --rebase
```

- [ ] **Step 2: Playwright** (`?session_first=1`)

Capture under `.playwright-mcp/screenshots/`:
1. History list (filters closed; New Session visible)
2. Filters disclosure open
3. Row hover showing Kill
4. Footer `⋯` open (Env / Legacy)

Post as PR comment. Release `in-progress` on #492 when merged to staging.

---

## Spec coverage (V2)

| Spec item | Task |
|-----------|------|
| Hover-reveal Kill + selected on touch | Task 1 |
| New Session CTA; search; filters/sort disclosure | Task 2–3 |
| Sidebar footer overflow; header without `⋯` | Task 4 |
| Playwright | Task 5 |

## Out of scope

V3 capsule · V4 mobile polish · #472 PR7 cutover

## Self-review notes

- Kill stays in DOM with CSS reveal so keyboard `focus-within` works.  
- Prefer optional `SearchBar` prop or session-first-local filters — do not break legacy Dashboard.  
- Thread overflow callbacks through Workspace → Sidebar; Chrome props cleanup must update all call sites + tests.
