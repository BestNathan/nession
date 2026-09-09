# Per-Session Attach Profile — Design Spec

**Date:** 2026-09-09
**Issue:** [#672](https://github.com/BestNathan/nession/issues/672)
**Branch:** `feat/session-attach-profile` (base: `main`)

## Overview

The Session-first flow opens `AttachDialog` on every attach, even when the
available configuration and the user's previous choice have not changed.
This design extends the existing attach flow with a **persisted per-Session
attach profile**: the first attach to a Session still asks; later attaches
skip the dialog and attach immediately while the saved choice is still valid;
every Session row exposes a Settings action to inspect or change the saved
configuration.

All behavior reuses the existing `AttachDialog` / `AttachChoice` /
`attachToSessionAtom` machinery. No second attach implementation is
introduced; no Rust/server changes.

## Current State

Attach has exactly two entry points, both funnelling through `confirmAttach`
(`web/src/app/useSessionFirstAttach.ts:19`), which persists global prefs
(`saveAttachPrefs`) and calls the single attach action `attachToSessionAtom`
(`web/src/atoms/session.ts:42`):

1. **Row click** — `SessionItem` `onSelect` →
   `useSessionFirstShellState.handleSelect` (`web/src/app/useSessionFirstShellState.ts:62`)
   → `requestAttach(session)` sets `attachDialogSessionAtom`
   (`web/src/atoms/session.ts:22`) → `AttachDialog`
   (`web/src/features/sessions/components/AttachDialog.tsx`) opens →
   confirm → `confirmAttach`.
2. **Deep-link restore** (`/terminal/:sessionId`) —
   `useSessionFirstDeepLink` → `useDeepLinkRestore`
   (`web/src/app/useDeepLinkRestore.ts`) → `resolveDeepLinkAttachChoice`
   (`web/src/services/deepLinkAttach.ts:13`, dialog-less, honours **global**
   prefs only) → `confirmAttach`.

Supporting facts:

- `AttachDialog` prefills from the global `nession_attach_prefs`
  (`web/src/services/attachPrefs.ts`), and deliberately maps a stored `relay`
  mode back to `auto` on load.
- Session identity: `session_id` is `"agent_id:session_name"`
  (`web/src/types.ts:27`) — stable across reloads and refreshes for the same
  tmux session on the same agent.
- `AttachChoice` embeds `attachInfo` (fresh `connection_token`, candidate
  URLs, browser latencies) — volatile, per-request data that must **never** be
  persisted (its own session-scoped secrets; #672 forbids persisting tokens /
  resolved temporary addresses / runtime attachment state).
- A fresh `requestAttach` (which mints the connection token) is required for
  *any* p2p/relay attach, dialog or not — so validating a profile costs the
  same one request the dialog would make anyway.
- Row actions (`SessionItem.tsx`) are hover/focus-revealed ghost icon buttons
  (`opacity-0 group-hover:` + `group-focus-within:` + selected) — not
  touch-safe on the narrow drawer, where the same `SessionItem` is reused
  (`SessionDrawer` overlays `SessionFirstSidebar` content).

## Goals

- First attach to a Session opens `AttachDialog` (unchanged).
- Later attaches skip the dialog and attach immediately when the saved
  configuration is still valid and the available options are unchanged.
- Every Session row (Web + narrow/App-proxy layouts) exposes a Settings
  action that opens the same dialog in a configure mode, prefilled, saving
  only the profile (no attach, no reconnect of an active Session).
- Deep-link/session-restore follows the same validation rule and never
  attaches with an invalid saved choice.
- Zero migration burden for existing users (no profile ⇒ current first-attach
  behavior); no new server API; no cross-device sync.

## Decision Log

Resolved with the user on 2026-09-09:

1. **Row entry affordance (compact/touch):** Kill + Settings icons are
   **always visible below `lg`**, and keep the existing hover/selected/focus
   reveal at `lg` and above. This also makes the existing Kill control
   touch-safe on narrow layouts. No row DropdownMenu.
2. **Restore policy:** when a profile exists, restore validates it — valid →
   attach per profile (its `mode` is honoured, not forced to `auto`); invalid
   → open `AttachDialog` (stay on `/terminal/:sessionId`; cancel navigates
   home). With **no** profile, restore keeps today's behavior exactly:
   dialog-less auto attach from global prefs, and **does not write a
   profile** — a profile is only ever created by an explicit user
   confirmation.
3. **Decision layer:** pure profile/validation logic in a new services
   module (unit-testable, no React); decision code lives in the two
   app-composition hooks (`useSessionFirstAttach`, `useDeepLinkRestore`);
   components stay dumb; `attachToSessionAtom` is untouched.

## Design

### 1. Persisted profile — data model and storage

New module `web/src/services/sessionAttachProfile.ts` (no React imports):

```ts
export interface SessionAttachProfile {
  schemaVersion: 1;
  sessionId: string;              // "agent_id:session_name" — storage key
  agentId: string;
  choice: PersistedAttachChoice;  // sanitized subset of AttachChoice
  optionsFingerprint: string;
  updatedAt: number;
}

export interface PersistedAttachChoice {
  mode: AttachMode;                    // 'auto' | 'p2p' | 'relay', stored as confirmed
  renderer: 'webgl' | 'canvas';
  envRefs: EnvFileRef[];
  selectedUrl: string | null;          // manual P2P path or manual relay endpoint; null = auto
}
```

- `attachInfo` is **excluded** from `choice` — it carries the per-request
  `connection_token`, resolved candidates and latencies.
- Storage: `localStorage` key `nession_session_attach_profiles`, a
  `Record<session_id, SessionAttachProfile>`, read/written defensively
  (try/catch, per-entry validation, unknown entries dropped) mirroring the
  `attachPrefs.ts` style.
- Orphaned profiles (session deleted/recreated under a different identity)
  are **ignored**, never consulted — acceptable per #672. No cleanup hooks,
  no server round trip.

### 2. Validation and the fast path

Pure functions in `sessionAttachProfile.ts`:

- `buildOptionsFingerprint(requestedMode: AttachMode, info: AttachInfo): string`
  — fingerprint of the **stable** attach-option fields of a fresh
  `requestAttach` response: `info.mode` plus the sorted
  `` `${url}|${network_type}` `` list of `info.addresses` (falling back to
  the legacy single `agent_address` when present). `status`, `rtt_ms`,
  browser latencies, and ordering are excluded as volatile.
- `validateSessionProfile(session, profile, info, webglSupported)`
  → `{ ok: true } | { ok: false; reason: ... }`, reasons: `no-profile`,
  `schema` (parse/version/agent mismatch), `fingerprint` (options changed),
  `manual-url-missing` (saved `selectedUrl` no longer in the fresh candidate
  set), `renderer` (webgl saved but unsupported now). Env files and latency
  are deliberately **not** part of the fingerprint.
- The closest-valid helper staged in this module (`sanitizeChoiceForPrefill`)
  was **removed as unused** — the dialog performs the equivalent sanitization
  as staged inline logic: the renderer fallback (webgl → canvas) in the open
  prefill (`prefillOnOpen`), and saved manual-URL membership against the
  fresh candidate set at attach-info arrival (`fetchAttachInfo`).

Validation always runs against a **fresh** `requestAttach`
(`requestedMode = mode === 'auto' ? 'p2p' : mode`, mirroring
`AttachDialog.tsx:119` and `deepLinkAttach.ts:19`), which also supplies the
fresh `connection_token` the attach itself needs.

**Write rule:** every attach or save executed through an explicit user
confirmation persists (or refreshes) the Session profile; the restore-no-
profile default path never writes one. `confirmAttach` gains an option
`{ persistProfile?: boolean }` (default `true`).

**Row-click decision** (`useSessionFirstAttach.requestAttach` becomes
asynchronous when a profile exists):

```text
Row click
 ├─ no profile ────────────────► open AttachDialog (unchanged)
 └─ profile exists ── validate (fresh requestAttach)
     ├─ valid ──► build choice from profile → confirmAttach (attach immediately)
     └─ invalid ─► open AttachDialog prefilled from profile
```

The replay path constructs the same `AttachChoice` the dialog would have
produced (mode from profile; URL ordering from the probe cache with the
`testAddresses` fallback already used by `resolveDeepLinkAttachChoice`;
`manualOverride`/`relayUrl` from the profile's `selectedUrl` when it is still
a member of the fresh candidate set).

**Restore decision** (`useDeepLinkRestore`): profile exists → validate; valid
→ attach per profile (`persistProfile: true` refresh); invalid → open
`AttachDialog` for the session and suppress the restore spinner while the
dialog is open (cancel → `navigate('/', { replace: true })`). No profile →
exactly today's path (`resolveDeepLinkAttachChoice` + `confirmAttach` with
`persistProfile: false`).

**Double-click guard:** `useSessionFirstAttach` keeps an in-flight ref per
`session_id`; a second `requestAttach` for a session whose validation is
already running is ignored (prevents two `attachToSessionAtom` calls from
racing on the same session and re-triggering the route-epoch disconnect of
#668).

### 3. AttachDialog changes

- New intent atom `attachDialogIntentAtom: 'attach' | 'configure'` (default
  `attach`), cleared wherever `attachDialogSessionAtom` is cleared
  (`attachToSessionAtom`, `disconnectAtom`, `cancelAttach`).
- Prefill on open: `loadProfile(session.session_id)` hit → prefill
  mode/renderer/envRefs from the profile, with `relay` kept as-is (the
  closest-valid sanitization runs inline in the dialog itself, per the
  note in section 2); miss → today's global-prefs prefill.
- After fresh `attachInfo` arrives, preselect the profile's manual
  `selectedUrl` when it is still a member of the candidates; otherwise Auto.
- Footer: `attach` intent → Cancel / **Attach** (persist profile +
  `attachToSessionAtom`, unchanged); `configure` intent → Cancel / **Save**
  (persist profile only, close, toast "applies to the next attach"; **never**
  attaches or navigates — editing an active Session cannot silently
  reconnect it). An exception exists only in the deep-link-restore corner:
  when a config dialog is dismissed while nothing is attached on a
  `/terminal/:sid` route, the shared cancel handler navigates home
  (`replace`) to stop the restore effect from re-firing — unreachable from
  the normal flow. Confirm handler passed from the shell differs by intent.

### 4. Session-row Settings entry

- `SessionItem` gains optional `onConfigure?: (session: Session) => void` and
  a `Settings` ghost icon button next to Kill: Tooltip, accessible name
  `Configure attach settings for <session name>`,
  `data-testid="session-settings-<session_id>"`,
  `onClick` stops propagation (never triggers row select/attach).
- Visibility: always visible below `lg`; at `lg+` the existing
  hover/selected/focus-within reveal (same classes migrated onto Kill so the
  two behave identically — this is what makes the narrow/drawer layout
  touch-safe).
- Threading: `SessionFirstShell` → `useSessionFirstShellState` → new
  `openAttachSettings(session)` in `useSessionFirstAttach` (sets session +
  `configure` intent) → `SessionList`/`SessionItem` prop; fixture shells get
  a no-op prop.

### 5. Edge cases

| Case | Behavior |
|---|---|
| Corrupt / unknown-schema / agent-mismatch profile | treated as no profile; dialog opens; parsing never throws |
| WebGL support disappears | validation fails → dialog prefills `canvas` |
| Manual URL vanishes from candidates | validation fails → dialog prefills Auto |
| Session deleted; same name recreated on same agent | same `session_id`; stale profile fails fingerprint (fresh request reflects the new session's reality) → dialog |
| Session killed (profile orphaned) | ignored; no removal hook |
| Two tabs | last write wins on the shared localStorage key; validation is per-tab against live state |
| Double click during fast path | in-flight guard ignores the second request |
| Deep-link to a session with an invalid profile | dialog on `/terminal/:sid`; cancel returns home; never auto-attaches with the stale choice |

## Non-Goals / Follow-ups

- Live reconnect of an active Session when its settings change (next attach
  only) — explicitly out of scope in #672.
- Cross-device / server-side preference sync — no new server API.
- Cleanup of orphaned profiles — explicitly optional in #672.
- Relay-mode memory in the legacy **global** prefs (relay → auto mapping) is
  untouched; the per-Session profile is the new source of truth for sessions
  the user has configured.

## Testing

- Unit (pure, `sessionAttachProfile`): fingerprint stability under probe
  volatility and ordering changes; sensitivity to candidate/URL changes;
  schema parse, corruption, agent mismatch; manual-URL membership; renderer
  fallback.
- Unit/integration (`attachPrefs`-style storage tests): load/save round trip,
  corrupted storage falls back safely, per-Session isolation.
- Integration (`AttachDialog.test.tsx`, extended): profile prefill (incl.
  `relay` kept), configure-intent Save semantics (no attach, no navigation),
  invalid-profile prefill fallback to Auto/canvas.
- Integration (`SessionItem`/`SessionList`): Settings button a11y name,
  `stopPropagation` (no row select), visibility below/above `lg`, Kill +
  Settings coexistence.
- Integration (`SessionFirstShell` / `useDeepLinkRestore` updates): row fast
  path (valid → attach without dialog; invalid → dialog; no profile →
  dialog), restore three branches (no profile / valid / invalid), double-
  click guard.
- Regression: existing P2P/relay/auto attach paths and their current tests
  keep passing.
- Playwright MCP full-stack functional verification + screenshots before the
  PR (mandatory for UI/interaction changes); run the local demo stack per the
  repo guide.
