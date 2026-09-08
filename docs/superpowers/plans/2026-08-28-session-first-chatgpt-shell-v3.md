# Session-first ChatGPT Shell V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship #492 V3 — floating Input/Commands capsule inside the Terminal well for session-first; retire session-first BottomBar path; leave legacy BottomBar alone.

**Architecture:** New `TerminalCapsule` (collapsed pill + expanded sheet). Opt-in from `TerminalLayout` / `MobileTerminalLayout` when session-first (`terminalOnly` / explicit `toolbar="capsule"`). Reuse `InputPanel` + `QuickCommandsPanel`. Default collapsed on desktop and mobile. Capsule absolutely positioned inside the dark well (over xterm).

**Tech Stack:** React 18, Tailwind v4, shadcn/ui, Vitest + Testing Library. Worktree base: `origin/staging`. Branch: `feat/session-first-chatgpt-shell-v3`. PR base: `staging`.

**Spec:** `docs/superpowers/specs/2026-08-28-session-first-chatgpt-shell-v3-design.md`  
**Issue:** [#492](https://github.com/BestNathan/nession/issues/492)

---

## File map (V3)

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `web/src/session-first/TerminalCapsule.tsx` | Collapsed pill + expanded sheet; mode Input/Commands |
| Create | `web/src/session-first/__tests__/integration/TerminalCapsule.test.tsx` | Collapse/expand, mode switch, toolbarDisabled |
| Modify | `web/src/components/TerminalLayout.tsx` | Opt-in `toolbar?: 'bottombar' \| 'capsule'` (default `bottombar`) |
| Modify | `web/src/components/MobileTerminalLayout.tsx` | When `terminalOnly`, render capsule instead of old toolbar/BottomBar path |
| Modify | `web/src/session-first/SessionFirstTerminal.tsx` | Pass `toolbar="capsule"` (and keep `terminalOnly`) |
| Modify | Related integration tests for layout / terminal |

**Do not touch in V3:** legacy BottomBar callers (Dashboard FileTabs path without capsule), V4 mobile polish, `sessionFirst.ts` default, `k8s/overlays/**`.

**Worktree setup:**

```bash
cd /path/to/nession
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree add -b feat/session-first-chatgpt-shell-v3 \
  .claude/worktrees/feat-session-first-chatgpt-shell-v3 origin/staging
cd .claude/worktrees/feat-session-first-chatgpt-shell-v3
```

Claim #492 before coding.

---

### Task 1: TerminalCapsule component (TDD)

**Files:**
- Create: `web/src/session-first/TerminalCapsule.tsx`
- Create: `web/src/session-first/__tests__/integration/TerminalCapsule.test.tsx`

**Props (suggested):**

```tsx
export type CapsuleMode = 'input' | 'commands';

export interface TerminalCapsuleProps {
  mode: CapsuleMode;
  onModeChange: (mode: CapsuleMode) => void;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  disabled?: boolean;
  inputPanel: ReactNode;
  commandsPanel: ReactNode;
  /** Optional: collapsed-line send for Input mode */
  onSendLine?: (text: string) => void;
}
```

- [ ] **Step 1: Failing tests**

```tsx
it('renders collapsed pill by default and expands on expand control', async () => {
  const onExpandedChange = vi.fn();
  render(
    <TerminalCapsule
      mode="input"
      onModeChange={vi.fn()}
      expanded={false}
      onExpandedChange={onExpandedChange}
      inputPanel={<div data-testid="input-panel">input</div>}
      commandsPanel={<div data-testid="commands-panel">cmds</div>}
    />,
  );
  expect(screen.getByTestId('terminal-capsule')).toBeInTheDocument();
  expect(screen.queryByTestId('terminal-capsule-sheet')).not.toBeInTheDocument();
  await userEvent.click(screen.getByTestId('terminal-capsule-expand'));
  expect(onExpandedChange).toHaveBeenCalledWith(true);
});

it('shows sheet content when expanded for active mode', () => {
  render(
    <TerminalCapsule
      mode="commands"
      onModeChange={vi.fn()}
      expanded
      onExpandedChange={vi.fn()}
      inputPanel={<div data-testid="input-panel" />}
      commandsPanel={<div data-testid="commands-panel" />}
    />,
  );
  expect(screen.getByTestId('terminal-capsule-sheet')).toBeInTheDocument();
  expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
});

it('hides or disables when disabled', () => {
  render(
    <TerminalCapsule
      mode="input"
      onModeChange={vi.fn()}
      expanded={false}
      onExpandedChange={vi.fn()}
      disabled
      inputPanel={<div />}
      commandsPanel={<div />}
    />,
  );
  const root = screen.getByTestId('terminal-capsule');
  expect(root).toHaveAttribute('data-disabled', 'true');
  // or queryByTestId null if fully hidden — pick one and stick to it
});
```

- [ ] **Step 2: Implement collapsed pill + sheet**

Visual target:
- Root: `absolute inset-x-3 bottom-3 z-10` (inside well; parent must be `relative`)
- Pill: light surface (`bg-background/95` or similar), `rounded-full`, shadow, flex row
- Mode toggle: small segmented control Input | Commands (`data-testid="terminal-capsule-mode-input"` / `-commands`)
- Expand: `data-testid="terminal-capsule-expand"`
- Sheet: `data-testid="terminal-capsule-sheet"`, `max-h-[32vh]`, `rounded-2xl`, light bg, above pill
- No Env/Files tabs

Controlled `expanded` / `mode` from parent (parent owns state) — easier testing.

- [ ] **Step 3: PASS + commit**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/TerminalCapsule.test.tsx
git commit -m "feat(web): add TerminalCapsule for session-first (#492 V3)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Wire TerminalLayout desktop capsule

**Files:**
- Modify: `web/src/components/TerminalLayout.tsx`
- Modify: layout tests if any

Add:

```tsx
toolbar?: 'bottombar' | 'capsule'; // default 'bottombar'
```

When `toolbar === 'capsule'`:
- Desktop non-FileTabs path: terminal area `relative flex-1`, render `TerminalCapsule` over terminal instead of `BottomBar`
- Own local state for `capsuleMode` + `capsuleExpanded` (default expanded=false)
- Build `inputPanel` / `commandsPanel` as today; **do not** render `envPanel` in capsule
- When `fileOps` is set (FileTabs desktop) — session-first currently does **not** pass fileOps from SessionFirstTerminal; leave FileTabs+BottomBar path for legacy. If somehow capsule+fileOps, prefer capsule only if terminalOnly — YAGNI: session-first never passes fileOps today.

SessionFirstTerminal today:

```tsx
<TerminalLayout … terminalOnly toolbarDisabled={…} />
```

Add `toolbar="capsule"`.

- [ ] Tests: TerminalLayout or SessionFirstTerminal — with capsule, BottomBar tabs Env not present; expand opens sheet.

- [ ] Commit:

```bash
git commit -m "feat(web): opt-in capsule toolbar on TerminalLayout (#492 V3)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Mobile terminalOnly → capsule

**Files:**
- Modify: `web/src/components/MobileTerminalLayout.tsx`
- Modify: `MobileTerminalLayout.test.tsx`

When `terminalOnly`:
- Replace the existing Input|Commands toolbar / BottomBar-equivalent with `TerminalCapsule` over the terminal panel
- Keep swipe Files/Env **disabled** (already terminalOnly)
- Larger hit targets on pill controls (`min-h-10` / `min-w-10` where icon-only)

- [ ] Tests: `terminalOnly` renders `terminal-capsule`; no Env tab in capsule

- [ ] Commit:

```bash
git commit -m "feat(web): use TerminalCapsule on mobile terminalOnly (#492 V3)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: SessionFirstTerminal enable + well relative

**Files:**
- Modify: `web/src/session-first/SessionFirstTerminal.tsx`
- Modify: `web/src/session-first/TerminalWell.tsx` if needed — ensure `relative` for absolute capsule
- Modify: `SessionFirstTerminal` / shell tests

```tsx
<TerminalLayout
  …
  terminalOnly
  toolbar="capsule"
/>
```

Confirm TerminalWell / terminal flex column is `relative` so `absolute` capsule anchors correctly.

- [ ] `npm run lint && npm test`

- [ ] Commit:

```bash
git commit -m "feat(web): enable session-first TerminalCapsule (#492 V3)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: PR + Playwright

```bash
git push -u origin HEAD
gh pr create --base staging \
  --title "feat: session-first ChatGPT shell V3 — terminal capsule (#492)" \
  --body "$(cat <<'EOF'
## 变更内容
- Floating Input/Commands capsule inside Terminal well (collapsed by default)
- Retire session-first BottomBar path; legacy BottomBar unchanged
- Spec: docs/superpowers/specs/2026-08-28-session-first-chatgpt-shell-v3-design.md

Part of #492 (V3/4). Does not flip \`session_first\` default.

## 测试报告
- [x] \`npm run lint\`
- [x] \`npm test\`
- [ ] Playwright screenshots (PR comment): collapsed pill + expanded Input/Commands

EOF
)"
gh pr merge --auto --rebase
```

Playwright (`?session_first=1`, attach a session):
1. Collapsed pill inside dark well  
2. Expanded Input sheet  
3. Mode switch to Commands  
4. Confirm no Env tab in capsule  

Save under `.playwright-mcp/screenshots/`. Release `in-progress` on #492 when merged.

---

## Spec coverage

| Spec | Task |
|------|------|
| Collapsed default pill in well | 1, 2, 4 |
| Expanded Input/Commands sheet | 1–3 |
| Session-first only; legacy BottomBar | 2–4 |
| Mobile terminalOnly | 3 |
| Playwright | 5 |

## Self-review notes

- Controlled expanded/mode from parent or inside capsule — prefer parent in TerminalLayout for desktop/mobile consistency.  
- Capsule must not include EnvPanel.  
- Absolute positioning requires a `relative` well/terminal host.  
- Do not change `sessionFirst` default.
