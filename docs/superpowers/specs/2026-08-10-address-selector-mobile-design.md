# AddressSelector Mobile Redesign & Switching Fix — Design Spec

**Date:** 2026-08-10
**Branch:** feat/address-selector-mobile

## Overview

Redesign the AddressSelector component for mobile — replacing the inline `<Select>` dropdown (which wraps to multiple lines on narrow screens) with a pure icon button that opens a bottom sheet. Also fix a bug where address switching doesn't reliably trigger a reconnection.

## Goals

1. **Mobile optimization:** AddressSelector degrades to an icon-only button below `640px`; tap opens a shadcn `Sheet` with large touch targets
2. **Bug fix:** Address switching reliably reconnects to the selected P2P address, even when the previous connection fell back to relay
3. **Visual feedback:** Loading spinner on the icon during reconnection; color-coded reachability status

## Architecture

### Component Split

```
AddressSelector (entry, responsive switch via useMediaQuery)
├── AddressSelectorDesktop (≥640px) — existing Select dropdown, unchanged
└── AddressSelectorMobile (<640px) — new
    ├── Trigger button: icon-only (Wifi / WifiOff / Loader2), colour = status
    └── Sheet (side="bottom")
        ├── SheetHeader / SheetTitle: "Select Route"
        └── Address list (min-h-11 per item, 44px touch target)
            ├── "Auto (lowest latency)" — default, shown first
            └── Per address: ReachIcon + label + latency ms
```

### Files Changed

| File | Action | Detail |
|------|--------|--------|
| `AddressSelector.tsx` | Rewrite | Split into desktop + mobile sub-components; `useMediaQuery('(min-width: 640px)')` toggles which mounts |
| `useP2PWithFallback.ts` | Fix | Reset `forcedRelay` synchronously when `manualOverride` is set to a non-null value; expose `isSwitching` boolean for the loading spinner |
| `TerminalView.tsx` | Tweak | Remove the `!forcedRelay` guard so AddressSelector remains visible during relay fallback — users must be able to manually switch back to P2P |

### shadcn Components Used

- `Sheet`, `SheetTrigger`, `SheetContent`, `SheetHeader`, `SheetTitle` — bottom sheet (already installed)
- `Select`, `SelectTrigger`, `SelectContent`, `SelectItem`, `SelectValue` — desktop dropdown (already installed)
- `Button` — trigger button (already installed)
- All other primitives unchanged.

## Bug Fix: Synchronous forcedRelay Reset

### Root Cause

In `useP2PWithFallback`, when `manualOverride` changes (user picks a manual address), `forcedRelay` is reset to `false` inside a `useEffect` keyed on `planUrlsKey`. React batches state updates — there is a one-render gap where `forcedRelay` is still `true` while `plan` already points to the new address:

```
Render N:   manualOverride = newUrl, forcedRelay = true (stale)
            → isP2P = false, activeUrl = null, P2P connection = null
Render N+1: forcedRelay = false (effect committed)
            → isP2P = true, activeUrl = newUrl, connection starts
```

This one-render gap is enough to break the switch — the old relay connection may be torn down before the new P2P connection starts.

### Fix

Use a ref to track the previous `manualOverride` value and synchronously derive `forcedRelay`:

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

Also expose `isSwitching: boolean` in the return value — true when `manualOverride` is non-null and `p2pConnection.connectionState !== 'connected'`.

## Mobile UI Design

### Icon Button States

| Condition | Icon | Colour | Description |
|-----------|------|--------|-------------|
| Connected (auto/manual) | `Wifi` | `text-green-500` | P2P is live |
| Switching / connecting | `Loader2` + `animate-spin` | `text-muted-foreground` | Reconnecting after address change |
| Relay fallback | `WifiOff` | `text-amber-500` | Using relay; tap to pick a P2P route |
| All unreachable | `WifiOff` | `text-red-500` | No route works |

The button is `size="icon" variant="ghost"` with `h-9 w-9` (matching the existing terminal header icon buttons).

### Bottom Sheet Content

```
┌─────────────────────────────────┐
│         Select Route            │  ← SheetTitle
│                                 │
│ ┌─────────────────────────────┐ │
│ │ 🟢 Auto (lowest latency)   │ │  ← SelectItem, h-11
│ └─────────────────────────────┘ │
│ ┌─────────────────────────────┐ │
│ │ 🟢 Tailscale    12ms       │ │
│ └─────────────────────────────┘ │
│ ┌─────────────────────────────┐ │
│ │ 🟢 LAN           8ms       │ │
│ └─────────────────────────────┘ │
│ ┌─────────────────────────────┐ │
│ │ 🔴 Public IP    unreachable│ │
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

- Current selection marked with `bg-accent`
- Reachability icon: `Wifi` green / `WifiOff` red
- Latency in ms, muted, right-aligned

### Desktop (Unchanged)

The existing `<Select>` with "Route:" label continues to render at `≥640px`. No behavioural change.

## Behavior

### Address Switch Flow

```
1. User taps Wifi icon → Sheet slides up
2. User taps an address → onSelect(url) fires
3. Sheet closes (animated, ~200ms)
4. Icon switches to Loader2 spinner
5. useP2PConnection connects to new agentUrl
6. Connected → icon switches to Wifi green
   Failed → icon switches to WifiOff red
```

### forcedRelay Visibility

AddressSelector is now visible in ALL P2P mode states (including forced relay). During relay fallback the icon shows amber `WifiOff` — tapping it re-opens the sheet so the user can manually pick a P2P route.

## Testing

### Unit Tests (AddressSelector.test.tsx)

- Renders nothing when `addresses.length <= 1`
- Desktop: renders Select trigger with "Route:" label
- Mobile: renders icon button (mock `useMediaQuery`)
- Mobile: tapping icon opens Sheet
- Sheet lists all addresses + Auto option
- Selecting an address calls `onSelect` with the URL
- Selecting "Auto" calls `onSelect` with `null`
- Icon colour matches connection state (green/amber/red/spinner)

### Hook Tests (useP2PWithFallback)

- Setting `manualOverride` to a non-null URL resets `forcedRelay` to false on the SAME render
- `isSwitching` is true while manual URL is set and connection isn't connected
- `isSwitching` becomes false once connection reaches 'connected'

### Manual Verification

1. Start local stack (server + agent + web)
2. Open on mobile viewport (or resize < 640px)
3. Attach to a P2P session with multiple addresses
4. Verify: icon button visible in terminal header
5. Tap icon → sheet opens with address list
6. Select a different address → sheet closes, spinner shows
7. Verify: terminal reconnects to the new address
8. Switch back to Auto → verify latency-based selection
