# AddressSelector Mobile Redesign & Switching Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign AddressSelector for mobile (icon-only button + bottom sheet), fix address switching bug (synchronous forcedRelay reset), and add visual feedback (loading spinner).

**Architecture:** Split `AddressSelector.tsx` into desktop (unchanged `<Select>`) and mobile (`<Sheet>` bottom sheet) variants gated by `useMediaQuery('(min-width: 640px)')`. Fix `useP2PWithFallback` to derive `forcedRelay` synchronously from `manualOverride`. Compute `isSwitching` in `TerminalView` and pass down as a prop for the loading spinner.

**Tech Stack:** React, TypeScript, shadcn/ui (Sheet, Select, Button), vitest + @testing-library/react

---

## File Structure

```
AddressSelector.tsx          ← Rewrite: responsive split + mobile Sheet
useP2PWithFallback.ts        ← Fix: derived forcedRelay + expose isSwitching
TerminalView.tsx             ← Tweak: remove !forcedRelay guard, compute & pass isSwitching
AddressSelector.test.tsx     ← Update: mobile Sheet tests
useP2PWithFallback.test.ts   ← New: forcedRelay sync reset + isSwitching tests
```

### Responsibilities

- **AddressSelector.tsx** — Renders desktop `<Select>` or mobile icon+`<Sheet>` based on viewport. Takes `addresses`, `latencies`, `activeUrl`, `isAuto`, `isSwitching`, `effectiveMode` props. Calls `onSelect(url | null)` on choice.
- **useP2PWithFallback.ts** — Derives `forcedRelay` from `manualOverride` (manual = forced P2P). Returns `isSwitching` boolean.
- **TerminalView.tsx** — Passes new `isSwitching` and `effectiveMode` props to `AddressSelector`; removes `!forcedRelay` visibility guard.

---

### Task 1: Fix forcedRelay synchronous reset in useP2PWithFallback

**Files:**
- Modify: `web/src/hooks/useP2PWithFallback.ts:66-77`

- [ ] **Step 1: Replace the effect-based forcedRelay reset with derived state**

Read the file and locate the `useEffect` block at lines 66-77 that resets `forcedRelay` on `planUrlsKey` change. Replace with derived logic:

```ts
// forcedRelay is held in state (set by the fallback driver effect), but
// we derive the effective value: when manualOverride is non-null, the user
// explicitly chose a P2P route — ignore any stale relay fallback state
// on the SAME render, no effect gap.
const [forcedRelayState, setForcedRelay] = useState(false);
const forcedRelay = manualOverride ? false : forcedRelayState;

// When manualOverride transitions null→url, reset the underlying state so
// the derived value stays consistent on future renders after manualOverride
// returns to null.
const prevManualRef = useRef(manualOverride);
useEffect(() => {
  const prev = prevManualRef.current;
  prevManualRef.current = manualOverride;
  if (manualOverride && !prev) {
    setForcedRelay(false);
  }
}, [manualOverride]);
```

Also remove the old `useEffect` on `planUrlsKey` that did `setForcedRelay(false)` (it will no longer be needed for forcedRelay reset — keep only the `setAddressIndex(0)` part).

- [ ] **Step 2: Add isSwitching to the return type and value**

Add to `P2PFallbackResult` interface:

```ts
export interface P2PFallbackResult {
  // ... existing fields
  /** True while a manually-selected address is being connected to. */
  isSwitching: boolean;
}
```

Add to the return object:

```ts
const isSwitching = manualOverride !== null && p2pConnection?.connectionState !== 'connected';

return {
  p2pConnection,
  effectiveMode: isP2P ? 'p2p' : 'relay',
  activeUrl,
  forcedRelay,
  manualOverride,
  setManualOverride,
  isSwitching,
};
```

- [ ] **Step 3: Run existing tests to verify no regression**

```bash
cd web && npx vitest run src/hooks/__tests__/useP2PConnection.test.ts src/components/__tests__/Terminal.p2pGate.test.tsx
```

Expected: All existing P2P-related tests pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useP2PWithFallback.ts
git commit -m "fix: derive forcedRelay synchronously from manualOverride

Prevents a one-render gap where manual address selection is ignored
because forcedRelay is still true from a previous fallback. Also
exposes isSwitching for AddressSelector loading indicator.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Write useP2PWithFallback tests

**Files:**
- Create: `web/src/hooks/__tests__/useP2PWithFallback.test.ts`

- [ ] **Step 1: Create the test file with forcedRelay reset tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useP2PWithFallback } from '../useP2PWithFallback';
import type { AttachInfo } from '../../types';

// useP2PConnection depends on WebSocket — mock it out.
vi.mock('../useP2PConnection', () => ({
  useP2PConnection: vi.fn(() => ({
    sendMessage: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
    connectionState: 'connected',
    reconnectAttempt: 0,
    close: vi.fn(),
    waitForConnection: vi.fn(() => Promise.resolve()),
  })),
}));

function makeAttachInfo(overrides: Partial<AttachInfo> = {}): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:test-session',
    agent_address: 'ws://agent:19090/ws',
    connection_token: 'token-123',
    addresses: [
      { url: 'ws://a/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
      { url: 'ws://b/ws', label: 'VPN', network_type: 'vpn', priority: 5, status: 'reachable' },
    ],
    agent_version: '0.25.0',
    ...overrides,
  };
}

describe('useP2PWithFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('forcedRelay', () => {
    it('returns forcedRelay=false when manualOverride is set (same render)', () => {
      const { result } = renderHook(
        ({ manualOverride }) =>
          useP2PWithFallback(makeAttachInfo(), 'test', {
            orderedUrls: ['ws://a/ws', 'ws://b/ws'],
            initialSelectedAddress: manualOverride,
          }),
        { initialProps: { manualOverride: null as string | null } },
      );

      // Start in auto mode — should use orderedUrls.
      expect(result.current.forcedRelay).toBe(false);
      expect(result.current.effectiveMode).toBe('p2p');
      expect(result.current.isSwitching).toBe(false);

      // Set a manual address — forcedRelay MUST be false on this same render.
      act(() => {
        result.current.setManualOverride('ws://manual/ws');
      });

      expect(result.current.manualOverride).toBe('ws://manual/ws');
      expect(result.current.forcedRelay).toBe(false);
      expect(result.current.effectiveMode).toBe('p2p');
    });

    it('returns isSwitching=true when manual address is selected and connection is not connected', () => {
      const { useP2PConnection } = require('../useP2PConnection');
      // Simulate connecting state.
      useP2PConnection.mockReturnValue({
        sendMessage: vi.fn(),
        onMessage: vi.fn(() => vi.fn()),
        connectionState: 'connecting',
        reconnectAttempt: 0,
        close: vi.fn(),
        waitForConnection: vi.fn(() => Promise.resolve()),
      });

      const { result } = renderHook(() =>
        useP2PWithFallback(makeAttachInfo(), 'test', {
          orderedUrls: ['ws://a/ws'],
          initialSelectedAddress: 'ws://manual/ws',
        }),
      );

      expect(result.current.isSwitching).toBe(true);
    });

    it('returns isSwitching=false when manual address is selected and connection is connected', () => {
      const { useP2PConnection } = require('../useP2PConnection');
      useP2PConnection.mockReturnValue({
        sendMessage: vi.fn(),
        onMessage: vi.fn(() => vi.fn()),
        connectionState: 'connected',
        reconnectAttempt: 0,
        close: vi.fn(),
        waitForConnection: vi.fn(() => Promise.resolve()),
      });

      const { result } = renderHook(() =>
        useP2PWithFallback(makeAttachInfo(), 'test', {
          orderedUrls: ['ws://a/ws'],
          initialSelectedAddress: 'ws://manual/ws',
        }),
      );

      expect(result.current.isSwitching).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd web && npx vitest run src/hooks/__tests__/useP2PWithFallback.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/__tests__/useP2PWithFallback.test.ts
git commit -m "test: add useP2PWithFallback tests for forcedRelay and isSwitching

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Update TerminalView to pass new props and remove forcedRelay guard

**Files:**
- Modify: `web/src/components/TerminalView.tsx:62,119-126`

- [ ] **Step 1: Destructure isSwitching and effectiveMode from useP2PWithFallback**

At line 119-126 of `TerminalView.tsx`, add `isSwitching` to the destructure:

```ts
const {
  p2pConnection,
  effectiveMode,
  activeUrl,
  forcedRelay,
  manualOverride,
  setManualOverride,
  isSwitching,
} = useP2PWithFallback(attachInfo, sessionName, {
  orderedUrls: orderedUrls ?? null,
  initialSelectedAddress: selectedAddress ?? null,
});
```

- [ ] **Step 2: Remove the !forcedRelay visibility guard from AddressSelector rendering**

At line 62 of `TerminalView.tsx`, change:

```tsx
{attachInfo.mode === 'p2p' && !forcedRelay && attachInfo.addresses ? (
```

to:

```tsx
{attachInfo.mode === 'p2p' && attachInfo.addresses ? (
```

- [ ] **Step 3: Pass isSwitching and effectiveMode to AddressSelector**

In the `TerminalHeader` component, add the new props to the `AddressSelector` usage:

```tsx
<AddressSelector
  addresses={attachInfo.addresses}
  latencies={latencies ?? []}
  activeUrl={activeUrl ?? null}
  isAuto={manualOverride === null}
  onSelect={setManualOverride}
  isSwitching={isSwitching}
  effectiveMode={effectiveMode}
/>
```

Update the `TerminalHeaderProps` interface to include these props:

```ts
interface TerminalHeaderProps {
  // ... existing fields
  isSwitching: boolean;
  effectiveMode: 'p2p' | 'relay';
}
```

And pass them from the `TerminalView` render:

```tsx
<TerminalHeader
  // ... existing props
  isSwitching={isSwitching}
  effectiveMode={effectiveMode}
/>
```

- [ ] **Step 4: Update AddressSelector props to include the new fields**

Update the `AddressSelector` component's interface in `AddressSelector.tsx`:

```ts
interface AddressSelectorProps {
  addresses: ProbedAddress[];
  latencies: AddressLatency[];
  activeUrl: string | null;
  isAuto: boolean;
  onSelect: (url: string | null) => void;
  /** True while the connection for a manually-selected address is being established. */
  isSwitching: boolean;
  /** Current transport mode — used to determine icon colour on mobile. */
  effectiveMode: 'p2p' | 'relay';
}
```

- [ ] **Step 5: Run existing tests to verify TerminalView still works**

```bash
cd web && npx vitest run src/components/__tests__/Terminal.p2pGate.test.tsx src/components/__tests__/Terminal.reconnect.test.tsx
```

Expected: Existing terminal tests pass (they should — we only added optional props).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/TerminalView.tsx web/src/components/AddressSelector.tsx
git commit -m "feat: pass isSwitching and effectiveMode to AddressSelector

Remove the !forcedRelay guard so users can manually switch back to P2P
from relay fallback. Pass isSwitching for the loading spinner.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Rewrite AddressSelector with responsive split

**Files:**
- Modify: `web/src/components/AddressSelector.tsx`

- [ ] **Step 1: Create the new AddressSelector with desktop + mobile variants**

Replace the entire file content:

```tsx
import { Wifi, WifiOff, HelpCircle, Loader2 } from 'lucide-react';
import type { ProbedAddress, AddressLatency } from '../types';
import { useMediaQuery } from '../hooks/useMediaQuery';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

/** Sentinel value for the automatic (latency-based) selection option. */
const AUTO_VALUE = '__auto__';

interface AddressSelectorProps {
  addresses: ProbedAddress[];
  latencies: AddressLatency[];
  activeUrl: string | null;
  isAuto: boolean;
  onSelect: (url: string | null) => void;
  isSwitching: boolean;
  effectiveMode: 'p2p' | 'relay';
}

type Reachable = boolean | undefined;

function browserReachable(
  url: string,
  byUrl: Map<string, number | null>,
): Reachable {
  if (!byUrl.has(url)) {
    return undefined;
  }
  return byUrl.get(url) !== null;
}

function ReachIcon({ reachable }: { reachable: Reachable }) {
  if (reachable === undefined) {
    return <HelpCircle className="w-3 h-3 text-muted-foreground shrink-0" />;
  }
  return reachable ? (
    <Wifi className="w-3 h-3 text-green-500 shrink-0" />
  ) : (
    <WifiOff className="w-3 h-3 text-red-500 shrink-0" />
  );
}

// ── Mobile icon states ──────────────────────────────────────────────

function mobileIcon(
  isSwitching: boolean,
  effectiveMode: 'p2p' | 'relay',
): { Icon: typeof Wifi; className: string } {
  if (isSwitching) {
    return { Icon: Loader2, className: 'animate-spin text-muted-foreground' };
  }
  if (effectiveMode === 'relay') {
    return { Icon: WifiOff, className: 'text-amber-500' };
  }
  return { Icon: Wifi, className: 'text-green-500' };
}

// ── Shared address list content ──────────────────────────────────────

function AddressListItems({
  addresses,
  latencies,
  onSelect,
}: {
  addresses: ProbedAddress[];
  latencies: AddressLatency[];
  onSelect: (url: string | null) => void;
}) {
  const latencyByUrl = new Map(latencies.map((l) => [l.url, l.latencyMs]));

  return (
    <>
      <div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-accent rounded-md min-h-11"
        onClick={() => onSelect(null)}
      >
        <Wifi className="w-4 h-4 text-green-500 shrink-0" />
        <span className="text-sm font-medium">Auto (lowest latency)</span>
      </div>
      {addresses.map((addr) => {
        const latency = latencyByUrl.get(addr.url);
        const reachable = browserReachable(addr.url, latencyByUrl);
        return (
          <div
            key={addr.url}
            className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-accent rounded-md min-h-11"
            onClick={() => onSelect(addr.url)}
          >
            <ReachIcon reachable={reachable} />
            <span className="text-sm font-medium flex-1">
              {addr.label ?? addr.network_type}
            </span>
            {latency !== null && latency !== undefined ? (
              <span className="text-xs text-muted-foreground">{latency}ms</span>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

// ── Desktop variant (≥640px) — existing Select ───────────────────────

function AddressSelectorDesktop({
  addresses,
  latencies,
  activeUrl,
  isAuto,
  onSelect,
}: AddressSelectorProps) {
  if (addresses.length <= 1) {
    return null;
  }

  const value = isAuto ? AUTO_VALUE : (activeUrl ?? AUTO_VALUE);

  return (
    <Select
      value={value}
      onValueChange={(v) => onSelect(v === AUTO_VALUE ? null : v)}
    >
      <SelectTrigger className="h-7 w-auto gap-1 text-xs" aria-label="P2P route">
        <span className="text-muted-foreground">Route:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO_VALUE}>Auto (lowest latency)</SelectItem>
        {addresses.map((addr) => {
          const latencyByUrl = new Map(latencies.map((l) => [l.url, l.latencyMs]));
          const latency = latencyByUrl.get(addr.url);
          const reachable = browserReachable(addr.url, latencyByUrl);
          return (
            <SelectItem key={addr.url} value={addr.url}>
              <span className="flex items-center gap-1.5">
                <ReachIcon reachable={reachable} />
                <span className="font-medium">{addr.label ?? addr.network_type}</span>
                {latency !== null && latency !== undefined ? (
                  <span className="text-[10px] text-muted-foreground">{latency}ms</span>
                ) : null}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

// ── Mobile variant (<640px) — icon button + bottom sheet ────────────

function AddressSelectorMobile({
  addresses,
  latencies,
  isAuto,
  isSwitching,
  effectiveMode,
  onSelect,
}: AddressSelectorProps) {
  if (addresses.length <= 1) {
    return null;
  }

  const [open, setOpen] = useState(false);
  const { Icon, className } = mobileIcon(isSwitching, effectiveMode);

  const handleSelect = useCallback(
    (url: string | null) => {
      onSelect(url);
      setOpen(false);
    },
    [onSelect],
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            aria-label="P2P route"
          >
            <Icon className={cn('size-4', className)} data-icon />
          </Button>
        }
      />
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className="text-left mb-2">
          <SheetTitle>Select Route</SheetTitle>
        </SheetHeader>
        <div className="px-2 flex flex-col gap-0.5">
          <AddressListItems
            addresses={addresses}
            latencies={latencies}
            onSelect={handleSelect}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Entry point — responsive switch ──────────────────────────────────

export function AddressSelector(props: AddressSelectorProps) {
  // Need useState for the mobile variant's Sheet state
  const isDesktop = useMediaQuery('(min-width: 640px)');

  if (isDesktop) {
    return <AddressSelectorDesktop {...props} />;
  }
  return <AddressSelectorMobile {...props} />;
}
```

Note: The `useState` import needs to be added at the top of the file.

- [ ] **Step 2: Add missing imports**

Add `useState, useCallback` to the React import at the top of the file:

```tsx
import { useState, useCallback } from 'react';
```

Add `Sheet, SheetContent, SheetHeader, SheetTitle` to existing shadcn imports (replace the existing individual imports with a grouped import):

```tsx
import { Button } from './ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';
```

- [ ] **Step 3: Run TypeScript check**

```bash
cd web && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/AddressSelector.tsx
git commit -m "feat: split AddressSelector into desktop Select and mobile Sheet

Mobile (<640px): icon-only button (Wifi/WifiOff/Loader2) + bottom sheet
with large touch targets. Desktop (≥640px): unchanged Select dropdown.
Icon colour reflects connection state (green/amber/spinner).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Update AddressSelector tests for mobile variant

**Files:**
- Modify: `web/src/components/__tests__/AddressSelector.test.tsx`

- [ ] **Step 1: Rewrite tests to cover both desktop and mobile variants**

Replace the existing test file:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddressSelector } from '../AddressSelector';
import type { ProbedAddress } from '../../types';

function probed(url: string, label: string, status: ProbedAddress['status'] = 'reachable'): ProbedAddress {
  return { url, label, network_type: 'lan', priority: 10, status };
}

// Default props for tests.
function defaultProps(overrides: Partial<Parameters<typeof AddressSelector>[0]> = {}) {
  return {
    addresses: [probed('ws://a/ws', 'LAN'), probed('ws://b/ws', 'VPN')],
    latencies: [{ url: 'ws://a/ws', latencyMs: 12 }, { url: 'ws://b/ws', latencyMs: 8 }],
    activeUrl: 'ws://a/ws',
    isAuto: true,
    onSelect: vi.fn(),
    isSwitching: false,
    effectiveMode: 'p2p' as const,
    ...overrides,
  };
}

// Stub matchMedia — desktop by default (min-width: 640px = true).
function setDesktop(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

describe('AddressSelector', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  describe('shared', () => {
    it('renders nothing when there is at most one address', () => {
      setDesktop(true);
      const { container } = render(
        <AddressSelector
          {...defaultProps({ addresses: [probed('ws://a/ws', 'LAN')] })}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('desktop (≥640px)', () => {
    beforeEach(() => setDesktop(true));

    it('shows the route Select trigger with "Route:" label', () => {
      render(<AddressSelector {...defaultProps()} />);
      expect(screen.getByText('Route:')).toBeInTheDocument();
      expect(screen.getByLabelText('P2P route')).toBeInTheDocument();
    });

    it('calls onSelect with url when a manual address is chosen', async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      render(<AddressSelector {...defaultProps({ onSelect })} />);

      await user.click(screen.getByLabelText('P2P route'));
      await user.click(screen.getByText('LAN'));

      expect(onSelect).toHaveBeenCalledWith('ws://a/ws');
    });

    it('calls onSelect with null when Auto is chosen', async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      render(<AddressSelector {...defaultProps({ onSelect })} />);

      await user.click(screen.getByLabelText('P2P route'));
      await user.click(screen.getByText('Auto (lowest latency)'));

      expect(onSelect).toHaveBeenCalledWith(null);
    });
  });

  describe('mobile (<640px)', () => {
    beforeEach(() => setDesktop(false));

    it('renders an icon button', () => {
      render(<AddressSelector {...defaultProps()} />);
      expect(screen.getByLabelText('P2P route')).toBeInTheDocument();
      // Should NOT have the "Route:" text label.
      expect(screen.queryByText('Route:')).not.toBeInTheDocument();
    });

    it('opens Sheet when icon is clicked', async () => {
      const user = userEvent.setup();
      render(<AddressSelector {...defaultProps()} />);

      await user.click(screen.getByLabelText('P2P route'));

      expect(screen.getByText('Select Route')).toBeInTheDocument();
      expect(screen.getByText('Auto (lowest latency)')).toBeInTheDocument();
      expect(screen.getByText('LAN')).toBeInTheDocument();
      expect(screen.getByText('VPN')).toBeInTheDocument();
    });

    it('calls onSelect and closes Sheet when an address is chosen', async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      render(<AddressSelector {...defaultProps({ onSelect })} />);

      await user.click(screen.getByLabelText('P2P route'));
      await user.click(screen.getByText('LAN'));

      expect(onSelect).toHaveBeenCalledWith('ws://a/ws');
    });

    it('shows Loader2 spinner when isSwitching is true', () => {
      render(<AddressSelector {...defaultProps({ isSwitching: true })} />);
      // The spinner icon has animate-spin class.
      const btn = screen.getByLabelText('P2P route');
      expect(btn.querySelector('.animate-spin')).toBeTruthy();
    });

    it('shows amber WifiOff when in relay fallback mode', () => {
      render(<AddressSelector {...defaultProps({ effectiveMode: 'relay' })} />);
      const btn = screen.getByLabelText('P2P route');
      expect(btn.querySelector('.text-amber-500')).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd web && npx vitest run src/components/__tests__/AddressSelector.test.tsx
```

Expected: All 8 tests PASS.

- [ ] **Step 3: Run full test suite and lint**

```bash
cd web && npm test && npm run lint
```

Expected: All tests pass, 0 lint errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/__tests__/AddressSelector.test.tsx
git commit -m "test: update AddressSelector tests for mobile Sheet variant

Cover desktop Select, mobile Sheet, icon states (spinner, amber relay),
and address selection callbacks.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Manual verification with Playwright

**Files:**
- No code changes — verification only.

- [ ] **Step 1: Start local stack**

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev &
```

Wait for all three to be ready (server on :19090, agent on :19091, web on :13000).

- [ ] **Step 2: Navigate and take screenshots**

Using Playwright MCP browser:
1. Navigate to http://localhost:13000
2. Log in with any non-empty token
3. Create/attach a P2P session with multiple addresses
4. Resize viewport to 375px width (mobile)
5. Take screenshot: verify icon button is visible in terminal header
6. Click the icon → Sheet opens → take screenshot
7. Select a different address → sheet closes
8. Verify the spinner shows during reconnection
9. Resize to 1280px → verify desktop Select with "Route:" label returns

- [ ] **Step 3: Clean up**

```bash
pkill -f 'target/debug/nession-(server|agent)'
pkill -f vite
```
