# Session-first ChatGPT Shell V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship #492 V1 — light session-first shell chrome with thin top bar, quieter spacing, and a rounded dark Terminal well (Catppuccin remains inside the well).

**Architecture:** Scope visual changes to `SessionFirstShell` only (flag still default off). Force light semantic surfaces on the shell root so scheduled/legacy dark habits cannot darken chrome. Move Env / ServerInfo / Legacy out of the primary header into a compact overflow menu. Wrap Terminal surface content in `TerminalWell`. V2–V4 (history rows, capsule, mobile polish) are **out of this plan** — see roadmap at the end.

**Tech Stack:** React 18, Tailwind v4, shadcn/ui, Vitest + Testing Library. Worktree base: `origin/staging` (session-first code lives there). Branch: `feat/session-first-chatgpt-shell-v1`. PR base: `staging`.

**Spec:** `docs/superpowers/specs/2026-08-28-session-first-chatgpt-shell-design.md`  
**Issue:** [#492](https://github.com/BestNathan/nession/issues/492)

---

## File map (V1)

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `web/src/session-first/TerminalWell.tsx` | Rounded dark inset around terminal surface children |
| Create | `web/src/session-first/SessionFirstOverflowMenu.tsx` | Header `⋯` menu: Env, ServerInfo trigger, Legacy |
| Create | `web/src/session-first/__tests__/integration/TerminalWell.test.tsx` | Well renders children + test id / classes |
| Create | `web/src/session-first/__tests__/integration/SessionFirstOverflowMenu.test.tsx` | Menu items fire callbacks |
| Modify | `web/src/session-first/SessionFirstShell.tsx` | Root `data-testid` + light shell class; wire overflow props |
| Modify | `web/src/session-first/SessionFirstChrome.tsx` | Thin bar: brand + badge only; overflow menu; keep error banner |
| Modify | `web/src/session-first/SessionFirstMain.tsx` | Wrap `SessionFirstTerminal` in `TerminalWell` when terminal surface |
| Modify | `web/src/session-first/SessionFirstWorkspace.tsx` | Light main padding around well / workspace |
| Modify | `web/src/session-first/patterns/SessionHeader.tsx` | Slightly calmer spacing (padding/gap) |
| Modify | `web/src/index.css` | `.session-first-shell` light lock + `--sf-terminal-well` color |
| Modify | `web/src/session-first/__tests__/integration/SessionFirstChrome.test.tsx` | Expect overflow, not inline Env/Legacy buttons |
| Modify | `web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx` | Shell root class + overflow / well smoke |

**Do not touch in V1:** `MobileTerminalLayout` capsule, `SessionItem` history restyle, `BottomBar`, cutover/`sessionFirst.ts` default, `k8s/overlays/**`.

**Worktree setup (before Task 1):**

```bash
cd /path/to/nession   # project root on main
git fetch origin
git checkout main && git pull --ff-only origin main
git worktree add -b feat/session-first-chatgpt-shell-v1 \
  .claude/worktrees/feat-session-first-chatgpt-shell-v1 origin/staging
cd .claude/worktrees/feat-session-first-chatgpt-shell-v1
```

---

### Task 1: TerminalWell + failing tests

**Files:**
- Create: `web/src/session-first/__tests__/integration/TerminalWell.test.tsx`
- Create: `web/src/session-first/TerminalWell.tsx` (minimal stub after red)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalWell } from '@/session-first/TerminalWell';

describe('TerminalWell', () => {
  it('wraps children in a dark rounded well', () => {
    render(
      <TerminalWell>
        <div data-testid="child">term</div>
      </TerminalWell>,
    );
    const well = screen.getByTestId('terminal-well');
    expect(well).toContainElement(screen.getByTestId('child'));
    expect(well.className).toMatch(/rounded/);
    expect(well.className).toMatch(/overflow-hidden/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/TerminalWell.test.tsx
```

Expected: FAIL — module `@/session-first/TerminalWell` not found.

- [ ] **Step 3: Minimal implementation**

```tsx
// web/src/session-first/TerminalWell.tsx
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function TerminalWell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-testid="terminal-well"
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl',
        'bg-[var(--sf-terminal-well)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Add CSS variable (light shell companion)**

In `web/src/index.css`, after `.scrollbar-none` block, append:

```css
/* Session-first ChatGPT shell (#492 V1) — Catppuccin Mocha base for the well */
:root {
  --sf-terminal-well: #1e1e2e;
}

.session-first-shell {
  /* Lock chrome to light semantic tokens even if a parent adds .dark later */
  color-scheme: light;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --border: oklch(0.922 0 0);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-border: oklch(0.922 0 0);
  background-color: var(--background);
  color: var(--foreground);
}
```

Do **not** edit `design/generated/web.css` by hand.

- [ ] **Step 5: Re-run test**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/TerminalWell.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/session-first/TerminalWell.tsx \
  web/src/session-first/__tests__/integration/TerminalWell.test.tsx \
  web/src/index.css
git commit -m "feat(web): add TerminalWell for session-first dark inset (#492 V1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: SessionFirstOverflowMenu

**Files:**
- Create: `web/src/session-first/SessionFirstOverflowMenu.tsx`
- Create: `web/src/session-first/__tests__/integration/SessionFirstOverflowMenu.test.tsx`
- Reuse: `ServerInfoMenu` from `@/components/ServerInfoMenu`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionFirstOverflowMenu } from '@/session-first/SessionFirstOverflowMenu';

vi.mock('@/components/ServerInfoMenu', () => ({
  ServerInfoMenu: () => <div data-testid="server-info-menu" />,
}));

describe('SessionFirstOverflowMenu', () => {
  it('opens menu and invokes Env / Legacy', async () => {
    const onOpenEnv = vi.fn();
    const onLegacy = vi.fn();
    render(
      <SessionFirstOverflowMenu onOpenEnv={onOpenEnv} onLegacy={onLegacy} />,
    );
    await userEvent.click(screen.getByTestId('session-first-overflow'));
    await userEvent.click(screen.getByTestId('session-first-env'));
    expect(onOpenEnv).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId('session-first-overflow'));
    await userEvent.click(screen.getByTestId('use-legacy-dashboard'));
    expect(onLegacy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionFirstOverflowMenu.test.tsx
```

- [ ] **Step 3: Implement menu**

Use shadcn `DropdownMenu`. Keep these `data-testid`s stable: `session-first-overflow`, `session-first-env`, `use-legacy-dashboard`.

```tsx
import { Ellipsis, FileCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ServerInfoMenu } from '@/components/ServerInfoMenu';
import { setSessionFirst } from '@/lib/sessionFirst';

export function SessionFirstOverflowMenu({
  onOpenEnv,
  onLegacy,
}: {
  onOpenEnv: () => void;
  onLegacy: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            data-testid="session-first-overflow"
            aria-label="More"
          />
        }
      >
        <Ellipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem
          data-testid="session-first-env"
          onClick={() => onOpenEnv()}
        >
          <FileCog className="size-4" />
          Environment files
        </DropdownMenuItem>
        <div className="px-2 py-1.5">
          <ServerInfoMenu />
        </div>
        <DropdownMenuItem
          data-testid="use-legacy-dashboard"
          onClick={() => {
            setSessionFirst(false);
            onLegacy();
          }}
        >
          Legacy dashboard
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

If `DropdownMenuTrigger` API differs in-tree, match existing shadcn usage — keep the three test ids.

- [ ] **Step 4: Run tests — PASS**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionFirstOverflowMenu.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/SessionFirstOverflowMenu.tsx \
  web/src/session-first/__tests__/integration/SessionFirstOverflowMenu.test.tsx
git commit -m "feat(web): session-first overflow menu for Env/Legacy (#492 V1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Thin SessionFirstChrome

**Files:**
- Modify: `web/src/session-first/SessionFirstChrome.tsx`
- Modify: `web/src/session-first/__tests__/integration/SessionFirstChrome.test.tsx`

- [ ] **Step 1: Update tests first**

Expect brand + badge + overflow; Env/Legacy only after opening overflow.

```tsx
it('renders thin chrome with overflow for Env and Legacy', async () => {
  const onOpenEnv = vi.fn();
  const onLegacy = vi.fn();
  render(
    <SessionFirstChrome
      connectionStatus="authenticated"
      error={null}
      clearError={vi.fn()}
      onOpenEnv={onOpenEnv}
      onLegacy={onLegacy}
    />,
  );
  expect(screen.getByTestId('session-first-chrome')).toBeInTheDocument();
  expect(screen.getByText('Nession')).toBeInTheDocument();
  expect(screen.queryByTestId('session-first-env')).not.toBeInTheDocument();
  await userEvent.click(screen.getByTestId('session-first-overflow'));
  await userEvent.click(screen.getByTestId('session-first-env'));
  expect(onOpenEnv).toHaveBeenCalled();
});
```

Keep the dismissible error banner test. Mock `ServerInfoMenu` as today.

- [ ] **Step 2: Run — FAIL on old chrome layout**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionFirstChrome.test.tsx
```

- [ ] **Step 3: Rewrite chrome header**

```tsx
<header
  data-testid="session-first-chrome"
  className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-background px-4 py-3"
>
  <div className="flex min-w-0 flex-1 items-center gap-2">
    <h1 className="text-lg font-semibold tracking-tight">Nession</h1>
    <ConnectionStatusBadge status={connectionStatus} />
  </div>
  <SessionFirstOverflowMenu onOpenEnv={onOpenEnv} onLegacy={onLegacy} />
</header>
```

Keep the error banner block unchanged.

- [ ] **Step 4: Tests PASS**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/SessionFirstChrome.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/SessionFirstChrome.tsx \
  web/src/session-first/__tests__/integration/SessionFirstChrome.test.tsx
git commit -m "feat(web): thin session-first chrome with overflow (#492 V1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Wire shell class + TerminalWell in Main

**Files:**
- Modify: `web/src/session-first/SessionFirstShell.tsx`
- Modify: `web/src/session-first/SessionFirstMain.tsx`
- Modify: `web/src/session-first/SessionFirstWorkspace.tsx`
- Modify: `web/src/session-first/SessionFirstSidebar.tsx`
- Modify: `web/src/session-first/patterns/SessionHeader.tsx`
- Modify: `web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx`

- [ ] **Step 1: Shell root class**

Change the outer layout wrapper to:

```tsx
<div
  data-testid="session-first-shell"
  className="session-first-shell flex h-[100dvh] flex-col bg-background"
>
```

When rendering the EnvManager full-screen branch, wrap it in the same `session-first-shell` class so the light lock holds.

- [ ] **Step 2: Wrap terminal in well (keep-alive)**

In `SessionFirstMain.tsx`, import `TerminalWell` and `cn`. Prefer CSS `hidden` — do not unmount `SessionFirstTerminal`:

```tsx
<div className="relative flex min-h-0 flex-1 flex-col gap-0 p-3 pt-2">
  <TerminalWell
    className={cn(
      'min-h-0',
      (surface !== 'terminal' || !selectedSession) && 'hidden',
    )}
  >
    <SessionFirstTerminal
      hidden={surface !== 'terminal' || !selectedSession}
      onDisconnect={() => undefined}
      onError={() => undefined}
    />
  </TerminalWell>
  <WorkspacePanel
    hidden={surface !== 'workspace'}
    tool={tool}
    onToolChange={onToolChange}
    fileOps={fileOps}
    session={selectedSession}
    agent={selectedAgent}
    domain={domain}
  />
</div>
```

- [ ] **Step 3: Breathing room**

- `SessionFirstSidebar` aside: add `bg-sidebar text-sidebar-foreground` if missing.  
- `SessionHeader`: `className` use `px-4 py-3 gap-x-3 gap-y-2`; title `text-base font-semibold`.

- [ ] **Step 4: Shell tests**

```tsx
it('applies session-first-shell class for light chrome lock', () => {
  renderShell();
  expect(screen.getByTestId('session-first-shell').className).toMatch(
    /session-first-shell/,
  );
});
```

Update Env chrome test: click overflow before Env if the shell test opens Env from chrome.

- [ ] **Step 5: Lint + full web tests**

```bash
cd web && npm run lint && npm test
```

Expected: all pass (`--max-warnings 0`).

- [ ] **Step 6: Commit**

```bash
git add web/src/session-first/SessionFirstShell.tsx \
  web/src/session-first/SessionFirstMain.tsx \
  web/src/session-first/SessionFirstWorkspace.tsx \
  web/src/session-first/SessionFirstSidebar.tsx \
  web/src/session-first/patterns/SessionHeader.tsx \
  web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx
git commit -m "feat(web): wire light shell class and TerminalWell (#492 V1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: PR to staging

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin HEAD
gh pr create --base staging \
  --title "feat: session-first ChatGPT shell V1 — light chrome + terminal well (#492)" \
  --body "$(cat <<'EOF'
## 变更内容
- Light-locked `.session-first-shell` chrome
- Thin header; Env / ServerInfo / Legacy in overflow
- Dark rounded `TerminalWell` around session-first terminal
- Spec: docs/superpowers/specs/2026-08-28-session-first-chatgpt-shell-design.md

Part of #492 (V1/4). Does not flip `session_first` default (#472 PR7 waits).

## 测试报告
- [x] `npm run lint`
- [x] `npm test`
- [ ] Playwright screenshots (PR comment): desktop shell + terminal well

EOF
)"
gh pr merge --auto --rebase
```

- [ ] **Step 2: Playwright screenshots (mandatory for UI)**

Local stack with `?session_first=1`, capture:
- List chrome (light, thin header)
- Attached terminal showing dark well vs light shell

Save under `.playwright-mcp/screenshots/` and post as a PR comment.

---

## Spec coverage (V1)

| Spec section | Task |
|--------------|------|
| Light shell | Task 1 CSS + Task 4 shell class |
| Thin top chrome / overflow | Tasks 2–3 |
| Dark Terminal well | Tasks 1, 4 |
| Sidebar history restyle | **V2** (not this plan) |
| Capsule Input/Commands | **V3** |
| Mobile polish | **V4** |
| Cutover default on | **#472 PR7** after V1–V4 |

## Roadmap (separate plans later)

| PR | Plan when V1 merges |
|----|---------------------|
| V2 | SessionList/Item history row + sidebar create CTA density |
| V3 | Floating capsule replacing session-first BottomBar path |
| V4 | Narrow list XOR detail + capsule touch targets |
| Then | #472 PR7 cutover |

## Self-review notes

- No Primitive status palette classes on chrome; overflow reuses existing components.  
- `--sf-terminal-well` is shell-scoped CSS (Catppuccin Mocha base), not hand-edited `design/generated/web.css`.  
- Keep-alive preserved via `hidden`, not unmount.  
- Capsule / history rows explicitly deferred to V3 / V2.
