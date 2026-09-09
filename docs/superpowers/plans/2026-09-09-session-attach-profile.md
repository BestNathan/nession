# Per-Session Attach Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a per-Session attach profile so repeated attaches skip `AttachDialog` when the saved choice is still valid, with a row Settings action for explicit reconfiguration (#672).

**Architecture:** A pure services module (`sessionAttachProfile.ts`) owns profile parse/save, options fingerprinting and validation. Choice resolution is generalized in `services/deepLinkAttach.ts` (shared by fast-path replay, deep-link restore and the legacy global-prefs path). Decision code lives in the two app-composition hooks (`useSessionFirstAttach`, `useDeepLinkRestore`/`useSessionFirstDeepLink`); `AttachDialog` gains an `intent` ('attach' | 'configure') and profile prefill; `SessionItem` gains a Settings button. `attachToSessionAtom` is untouched.

**Tech Stack:** React 18 + Jotai + Tailwind v4 + shadcn/ui (Dialog, Button, Tooltip) + lucide-react + Vitest/jsdom. All changes are `web/src/**` — zero Rust changes.

**Spec:** `docs/superpowers/specs/2026-09-09-session-attach-profile-design.md`

**Working dir for all commands:** `web/` (repo worktree root: `.claude/worktrees/feat-session-attach-profile`).

**Conventions:** ESLint `--max-warnings 0`, no `eslint-disable`. Every commit in this worktree (never on `main`). Test files live beside what they test under `__tests__/{unit,integration}`. Use `npx vitest run <path>` from `web/` for single files.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `web/src/services/sessionAttachProfile.ts` | Create | Profile types, localStorage load/save, fingerprint, validation, prefill sanitize, persist-from-choice |
| `web/src/services/__tests__/unit/sessionAttachProfile.test.ts` | Create | Pure-logic unit tests |
| `web/src/services/__tests__/integration/sessionAttachProfile.test.ts` | Create | localStorage storage tests (jsdom) |
| `web/src/services/deepLinkAttach.ts` | Modify | Generalize choice resolution; add `resolveProfileAttach` decision fn |
| `web/src/services/__tests__/unit/deepLinkAttach.test.ts` | Modify | Extend for the new resolver + decision fn |
| `web/src/atoms/session.ts` | Modify | Add `attachDialogIntentAtom`; reset it where the dialog session atom is cleared |
| `web/src/atoms/__tests__/unit/session.test.ts` | Modify | Assert intent resets on attach/disconnect |
| `web/src/app/useSessionFirstAttach.ts` | Modify | Profile-aware `requestAttach` fast path, in-flight guard, `openAttachSettings`, cancel→home rule, confirm persist option |
| `web/src/features/sessions/components/AttachDialog.tsx` | Modify | `intent` prop, profile prefill (mode/renderer/env/manual URL), Save footer |
| `web/src/features/sessions/components/__tests__/integration/AttachDialog.test.tsx` | Modify | New tests for profile prefill + configure intent |
| `web/src/features/sessions/components/SessionItem.tsx` | Modify | Settings ghost button, `lg`-gated hover reveal shared with Kill |
| `web/src/features/sessions/components/SessionList.tsx` | Modify | Thread `onConfigure` |
| `web/src/features/sessions/components/__tests__/integration/SessionItem.test.tsx` | Modify | Settings button tests |
| `web/src/features/sessions/components/__tests__/integration/SessionList.test.tsx` | Modify | `onConfigure` pass-through test |
| `web/src/app/SessionFirstSidebar.tsx` | Modify | Thread `onConfigure` to SessionList |
| `web/src/app/SessionFirstWorkspace.tsx` | Modify | Thread `onConfigure` into sidebar/drawer/spatial props |
| `web/src/app/fixture/FixtureShell.tsx`, `web/src/app/fixture/FixtureApp.tsx` | Modify | No-op `onConfigure` |
| `web/src/app/SessionFirstDialogs.tsx` | Modify | Render AttachDialog with intent + configure save handler |
| `web/src/app/SessionFirstShell.tsx` | Modify | Wire `onConfigure` |
| `web/src/app/useSessionFirstShellState.ts` | Modify | `openAttachSettings` + `saveAttachSettings` + dialogs wiring |
| `web/src/app/useDeepLinkRestore.ts` | Modify | Profile-validated restore branches |
| `web/src/app/useSessionFirstDeepLink.ts` | Modify | `onProfileInvalid` dialog opener; suppress spinner while dialog open |
| `web/src/app/__tests__/integration/useDeepLinkRestore.test.ts` | Modify | New restore branches |
| `web/src/app/__tests__/integration/SessionFirstShell.test.tsx` | Modify | `localStorage.clear()` hygiene in beforeEach |
| `web/src/app/__tests__/integration/AttachFlow.test.tsx` | Create | End-to-end shell flow tests (row fast path, configure save, restore dialog) |
| `docs/superpowers/specs/2026-09-09-session-attach-profile-design.md` | Existing | Design source of truth |

**Fixture recipes reused across tasks** (from existing tests, quoted verbatim where copied):

- Session: `{ session_id: 'a1:fix', agent_id: 'a1', session_name: 'fix', status: 'active', window_count: 1, attached_clients: 0, last_activity: '2026-01-01T00:00:00Z' }` (also `'agent-1:dev'` variants in AttachDialog.test).
- AttachInfo: `{ mode: 'p2p', session_id: s.session_id, session_name: s.session_name, agent_address: 'ws://a/ws', connection_token: 'tok', addresses }`; addresses `{ url, label, network_type: 'lan', priority: 0, status: 'reachable' }`.
- Module mocks in services tests: `vi.mock('@/features/sessions', () => ({ sessionsApi: sessionsApiMock }))` with hoisted `sessionsApiMock`; Renderer mocked `{ detectWebGLSupport: () => true }`.
- jsdom localStorage tests annotate `// @vitest-environment jsdom` + `beforeEach(() => localStorage.clear())`.

---

### Task 1: Profile module — storage layer

**Files:**
- Create: `web/src/services/__tests__/integration/sessionAttachProfile.test.ts`
- Create: `web/src/services/sessionAttachProfile.ts`

- [ ] **Step 1: Write the failing storage test**

Create `web/src/services/__tests__/integration/sessionAttachProfile.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSessionProfile,
  saveSessionProfile,
  type PersistedAttachChoice,
} from '@/services/sessionAttachProfile';

const session = {
  session_id: 'agent-1:dev',
  agent_id: 'agent-1',
};

const choice: PersistedAttachChoice = {
  mode: 'p2p',
  renderer: 'webgl',
  envRefs: [{ name: 'prod.env', source: 'server' }],
  selectedUrl: null,
};

describe('sessionAttachProfile storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when nothing is stored', () => {
    expect(loadSessionProfile(session)).toBeNull();
  });

  it('round-trips a saved profile for its session', () => {
    saveSessionProfile(session, choice, 'fp-1');
    const loaded = loadSessionProfile(session);
    expect(loaded).not.toBeNull();
    expect(loaded?.schemaVersion).toBe(1);
    expect(loaded?.sessionId).toBe('agent-1:dev');
    expect(loaded?.agentId).toBe('agent-1');
    expect(loaded?.optionsFingerprint).toBe('fp-1');
    expect(loaded?.choice).toEqual(choice);
    expect(loaded?.updatedAt).toBeGreaterThan(0);
  });

  it('isolates profiles between sessions', () => {
    saveSessionProfile(session, choice, 'fp-1');
    const other = { session_id: 'agent-2:other', agent_id: 'agent-2' };
    expect(loadSessionProfile(other)).toBeNull();
  });

  it('overwrites an existing profile for the same session', () => {
    saveSessionProfile(session, { ...choice, mode: 'relay' }, 'fp-1');
    saveSessionProfile(session, { ...choice, mode: 'p2p' }, 'fp-2');
    expect(loadSessionProfile(session)?.choice.mode).toBe('p2p');
    expect(loadSessionProfile(session)?.optionsFingerprint).toBe('fp-2');
  });

  it('keeps other sessions when one is overwritten', () => {
    saveSessionProfile({ session_id: 'a:one', agent_id: 'a' }, choice, 'fp-1');
    saveSessionProfile({ session_id: 'a:two', agent_id: 'a' }, choice, 'fp-2');
    expect(loadSessionProfile({ session_id: 'a:one', agent_id: 'a' })?.optionsFingerprint).toBe('fp-1');
    expect(loadSessionProfile({ session_id: 'a:two', agent_id: 'a' })?.optionsFingerprint).toBe('fp-2');
  });

  it('returns null for a session whose profile entry is corrupt', () => {
    localStorage.setItem(
      'nession_session_attach_profiles',
      JSON.stringify({ 'agent-1:dev': { schemaVersion: 999 } }),
    );
    expect(loadSessionProfile(session)).toBeNull();
  });

  it('returns null when the stored blob is not JSON', () => {
    localStorage.setItem('nession_session_attach_profiles', '{not json');
    expect(loadSessionProfile(session)).toBeNull();
  });

  it('returns null when the profile was written for a different agent', () => {
    saveSessionProfile(session, choice, 'fp-1');
    const renamed = { session_id: 'agent-1:dev', agent_id: 'agent-2' };
    expect(loadSessionProfile(renamed)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/services/__tests__/integration/sessionAttachProfile.test.ts`
Expected: FAIL — `Cannot find module '@/services/sessionAttachProfile'`.

- [ ] **Step 3: Implement the profile module storage layer**

Create `web/src/services/sessionAttachProfile.ts`:

```ts
import type { AttachInfo, AttachMode, Session } from '../types';
import type { EnvFileRef } from '../types';

const STORAGE_KEY = 'nession_session_attach_profiles';
export const ATTACH_PROFILE_SCHEMA_VERSION = 1 as const;

/** User-adjustable subset of AttachChoice that is safe to persist. */
export interface PersistedAttachChoice {
  mode: AttachMode;
  renderer: 'webgl' | 'canvas';
  envRefs: EnvFileRef[];
  /** Manual P2P path or manual relay endpoint; null = auto selection. */
  selectedUrl: string | null;
}

export interface SessionAttachProfile {
  schemaVersion: typeof ATTACH_PROFILE_SCHEMA_VERSION;
  sessionId: string;
  agentId: string;
  choice: PersistedAttachChoice;
  optionsFingerprint: string;
  updatedAt: number;
}

function isAttachMode(v: unknown): v is AttachMode {
  return v === 'auto' || v === 'p2p' || v === 'relay';
}

function isRenderer(v: unknown): v is 'webgl' | 'canvas' {
  return v === 'webgl' || v === 'canvas';
}

function isEnvFileRef(v: unknown): v is EnvFileRef {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const ref = v as Record<string, unknown>;
  return (
    typeof ref.name === 'string' &&
    (ref.source === 'server' || ref.source === 'agent') &&
    (ref.agent_id === undefined || typeof ref.agent_id === 'string')
  );
}

/** Parse one raw entry; unknown entries are dropped, never thrown on. */
function parseProfile(entry: unknown): SessionAttachProfile | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const p = entry as Record<string, unknown>;
  const c = p.choice;
  if (
    p.schemaVersion !== ATTACH_PROFILE_SCHEMA_VERSION ||
    typeof p.sessionId !== 'string' ||
    typeof p.agentId !== 'string' ||
    typeof p.optionsFingerprint !== 'string' ||
    typeof p.updatedAt !== 'number' ||
    typeof c !== 'object' ||
    c === null
  ) {
    return null;
  }
  const choice = c as Record<string, unknown>;
  const envRefs = Array.isArray(choice.envRefs)
    ? choice.envRefs.filter(isEnvFileRef)
    : [];
  if (
    !isAttachMode(choice.mode) ||
    !isRenderer(choice.renderer) ||
    (choice.selectedUrl !== null && typeof choice.selectedUrl !== 'string')
  ) {
    return null;
  }
  return {
    schemaVersion: ATTACH_PROFILE_SCHEMA_VERSION,
    sessionId: p.sessionId,
    agentId: p.agentId,
    optionsFingerprint: p.optionsFingerprint,
    updatedAt: p.updatedAt,
    choice: {
      mode: choice.mode,
      renderer: choice.renderer,
      envRefs,
      selectedUrl: choice.selectedUrl === null ? null : choice.selectedUrl,
    },
  };
}

/** Read the persisted profile for one session; any corruption means "no profile". */
export function loadSessionProfile(
  session: Pick<Session, 'session_id' | 'agent_id'>,
): SessionAttachProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const entry = (parsed as Record<string, unknown>)[session.session_id];
    if (!entry) {
      return null;
    }
    const profile = parseProfile(entry);
    if (!profile) {
      return null;
    }
    if (profile.sessionId !== session.session_id || profile.agentId !== session.agent_id) {
      return null;
    }
    return profile;
  } catch {
    return null;
  }
}

/** Persist (or overwrite) one session's profile. Failures are non-fatal. */
export function saveSessionProfile(
  session: Pick<Session, 'session_id' | 'agent_id'>,
  choice: PersistedAttachChoice,
  fingerprint: string,
): void {
  try {
    let map: Record<string, unknown> = {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          map = parsed as Record<string, unknown>;
        }
      } catch {
        map = {};
      }
    }
    map[session.session_id] = {
      schemaVersion: ATTACH_PROFILE_SCHEMA_VERSION,
      sessionId: session.session_id,
      agentId: session.agent_id,
      choice,
      optionsFingerprint: fingerprint,
      updatedAt: Date.now(),
    } satisfies SessionAttachProfile;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore quota / disabled-storage errors.
  }
}
```

Check `web/src/types.ts` re-exports `EnvFileRef` (it does — `AttachDialog.tsx:14` imports it from `'@/types'`). If the import above does not resolve, import from `'../features/env/types'` instead.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/services/__tests__/integration/sessionAttachProfile.test.ts`
Expected: 9 passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/services/sessionAttachProfile.ts src/services/__tests__/integration/sessionAttachProfile.test.ts
git commit -m "feat(web): session-attach profile storage (#672)"
```

---

### Task 2: Fingerprint, validation and prefill sanitize (pure logic)

**Files:**
- Create: `web/src/services/__tests__/unit/sessionAttachProfile.test.ts`
- Modify: `web/src/services/sessionAttachProfile.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `web/src/services/__tests__/unit/sessionAttachProfile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { AttachInfo, Session } from '@/types';
import {
  buildOptionsFingerprint,
  candidateUrlsOf,
  sanitizeChoiceForPrefill,
  validateProfile,
  type PersistedAttachChoice,
  type SessionAttachProfile,
} from '@/services/sessionAttachProfile';

const session: Session = {
  session_id: 'agent-1:dev',
  agent_id: 'agent-1',
  session_name: 'dev',
  status: 'active',
  window_count: 1,
  attached_clients: 0,
  last_activity: '2026-01-01T00:00:00Z',
};

function addr(url: string, networkType = 'lan') {
  return {
    url,
    label: networkType,
    network_type: networkType as 'lan' | 'vpn',
    priority: 0,
    status: 'reachable' as const,
  };
}

function info(overrides: Partial<AttachInfo> = {}): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent-1:dev',
    connection_token: 'tok',
    agent_address: 'ws://a/ws',
    addresses: [addr('ws://a/ws')],
    ...overrides,
  };
}

const choice: PersistedAttachChoice = {
  mode: 'auto',
  renderer: 'webgl',
  envRefs: [],
  selectedUrl: null,
};

function profile(overrides: Partial<SessionAttachProfile> = {}): SessionAttachProfile {
  return {
    schemaVersion: 1,
    sessionId: 'agent-1:dev',
    agentId: 'agent-1',
    choice,
    optionsFingerprint: buildOptionsFingerprint(info()),
    updatedAt: 1,
    ...overrides,
  };
}

describe('candidateUrlsOf', () => {
  it('returns address urls', () => {
    expect(candidateUrlsOf(info())).toEqual(['ws://a/ws']);
  });

  it('falls back to agent_address when addresses are empty', () => {
    expect(candidateUrlsOf(info({ addresses: [] }))).toEqual(['ws://a/ws']);
  });
});

describe('buildOptionsFingerprint', () => {
  it('is stable across address ordering changes', () => {
    const a = info({ addresses: [addr('ws://b/ws', 'vpn'), addr('ws://a/ws', 'lan')] });
    const b = info({ addresses: [addr('ws://a/ws', 'lan'), addr('ws://b/ws', 'vpn')] });
    expect(buildOptionsFingerprint(a)).toBe(buildOptionsFingerprint(b));
  });

  it('is stable across probe-volatile fields (status, rtt)', () => {
    const a = info({ addresses: [{ ...addr('ws://a/ws'), status: 'reachable', rtt_ms: 5 }] });
    const b = info({ addresses: [{ ...addr('ws://a/ws'), status: 'unreachable', rtt_ms: 999 }] });
    expect(buildOptionsFingerprint(a)).toBe(buildOptionsFingerprint(b));
  });

  it('changes when a candidate url is added', () => {
    const a = info();
    const b = info({ addresses: [addr('ws://a/ws'), addr('ws://c/ws', 'vpn')] });
    expect(buildOptionsFingerprint(a)).not.toBe(buildOptionsFingerprint(b));
  });

  it('changes when a candidate network type changes', () => {
    const a = info();
    const b = info({ addresses: [addr('ws://a/ws', 'vpn')] });
    expect(buildOptionsFingerprint(a)).not.toBe(buildOptionsFingerprint(b));
  });

  it('changes when the effective mode changes', () => {
    const a = info();
    const b = info({ mode: 'relay' });
    expect(buildOptionsFingerprint(a)).not.toBe(buildOptionsFingerprint(b));
  });

  it('does not include the connection token', () => {
    const a = info({ connection_token: 'tok-1' });
    const b = info({ connection_token: 'tok-2' });
    expect(buildOptionsFingerprint(a)).toBe(buildOptionsFingerprint(b));
  });
});

describe('validateProfile', () => {
  it('accepts a matching profile', () => {
    expect(validateProfile(profile(), info(), true)).toEqual({ ok: true });
  });

  it('rejects when the options changed', () => {
    const p = profile();
    const changed = info({ addresses: [addr('ws://a/ws'), addr('ws://new/ws', 'vpn')] });
    expect(validateProfile(p, changed, true)).toEqual({ ok: false, reason: 'fingerprint' });
  });

  it('rejects a manual url that left the candidate set', () => {
    const p = profile({
      choice: { ...choice, mode: 'p2p', selectedUrl: 'ws://gone/ws' },
      optionsFingerprint: buildOptionsFingerprint(info({ addresses: [addr('ws://gone/ws')] })),
    });
    expect(validateProfile(p, info(), true)).toEqual({ ok: false, reason: 'manual-url' });
  });

  it('accepts a manual url still present in the candidate set', () => {
    const p = profile({
      choice: { ...choice, mode: 'p2p', selectedUrl: 'ws://a/ws' },
      optionsFingerprint: buildOptionsFingerprint(info()),
    });
    expect(validateProfile(p, info(), true)).toEqual({ ok: true });
  });

  it('rejects webgl when the browser does not support it', () => {
    expect(validateProfile(profile(), info(), false)).toEqual({ ok: false, reason: 'renderer' });
  });
});

describe('sanitizeChoiceForPrefill', () => {
  it('keeps an unchanged choice as-is', () => {
    expect(sanitizeChoiceForPrefill(choice, info(), true)).toEqual(choice);
  });

  it('falls back to canvas when webgl is unsupported', () => {
    const out = sanitizeChoiceForPrefill({ ...choice, renderer: 'webgl' }, info(), false);
    expect(out.renderer).toBe('canvas');
  });

  it('clears a manual url that is no longer a candidate', () => {
    const out = sanitizeChoiceForPrefill(
      { ...choice, selectedUrl: 'ws://gone/ws' },
      info(),
      true,
    );
    expect(out.selectedUrl).toBeNull();
  });

  it('keeps a manual url that is still a candidate', () => {
    const out = sanitizeChoiceForPrefill(
      { ...choice, selectedUrl: 'ws://a/ws' },
      info(),
      true,
    );
    expect(out.selectedUrl).toBe('ws://a/ws');
  });

  it('preserves envRefs and mode untouched', () => {
    const out = sanitizeChoiceForPrefill(
      { ...choice, mode: 'relay', envRefs: [{ name: 'x.env', source: 'server' }] },
      info(),
      false,
    );
    expect(out.mode).toBe('relay');
    expect(out.envRefs).toEqual([{ name: 'x.env', source: 'server' }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/__tests__/unit/sessionAttachProfile.test.ts`
Expected: FAIL — `buildOptionsFingerprint` / `candidateUrlsOf` / `validateProfile` / `sanitizeChoiceForPrefill` are not exported.

- [ ] **Step 3: Implement the pure functions**

Append to `web/src/services/sessionAttachProfile.ts`:

```ts
/** Candidate urls the dialog would offer, legacy agent_address included. */
export function candidateUrlsOf(info: AttachInfo): string[] {
  const urls = (info.addresses ?? []).map((a) => a.url);
  if (urls.length === 0 && info.agent_address) {
    urls.push(info.agent_address);
  }
  return urls;
}

/**
 * Fingerprint of the STABLE attach options of a fresh requestAttach response.
 * Excludes probe-volatile fields (status/rtt_ms), the connection token, and
 * ordering. Any change here means the saved choice must be re-confirmed.
 */
export function buildOptionsFingerprint(info: AttachInfo): string {
  const candidates = (info.addresses ?? [])
    .map((a) => `${a.url}|${a.network_type}`)
    .sort();
  if (candidates.length === 0 && info.agent_address) {
    candidates.push(`agent|${info.agent_address}`);
  }
  return JSON.stringify([info.mode, candidates]);
}

export type ProfileInvalidReason = 'fingerprint' | 'manual-url' | 'renderer';

export type ProfileVerdict = { ok: true } | { ok: false; reason: ProfileInvalidReason };

/** Validate a saved profile against a FRESH attach-info response. */
export function validateProfile(
  profile: SessionAttachProfile,
  info: AttachInfo,
  webglSupported: boolean,
): ProfileVerdict {
  if (buildOptionsFingerprint(info) !== profile.optionsFingerprint) {
    return { ok: false, reason: 'fingerprint' };
  }
  if (
    profile.choice.selectedUrl !== null &&
    !candidateUrlsOf(info).includes(profile.choice.selectedUrl)
  ) {
    return { ok: false, reason: 'manual-url' };
  }
  if (profile.choice.renderer === 'webgl' && !webglSupported) {
    return { ok: false, reason: 'renderer' };
  }
  return { ok: true };
}

/** Closest-valid form of a saved choice for dialog prefill. */
export function sanitizeChoiceForPrefill(
  choice: PersistedAttachChoice,
  info: AttachInfo,
  webglSupported: boolean,
): PersistedAttachChoice {
  return {
    ...choice,
    renderer: choice.renderer === 'webgl' && !webglSupported ? 'canvas' : choice.renderer,
    selectedUrl:
      choice.selectedUrl !== null && candidateUrlsOf(info).includes(choice.selectedUrl)
        ? choice.selectedUrl
        : null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/services/__tests__/unit/sessionAttachProfile.test.ts`
Expected: 18 passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/services/sessionAttachProfile.ts src/services/__tests__/unit/sessionAttachProfile.test.ts
git commit -m "feat(web): attach-profile fingerprint + validation (#672)"
```

---

### Task 3: Generalize choice resolution + profile attach decision

**Files:**
- Modify: `web/src/services/__tests__/unit/deepLinkAttach.test.ts`
- Modify: `web/src/services/deepLinkAttach.ts`

Read `web/src/services/deepLinkAttach.ts` and its test first (both currently small). The legacy `resolveDeepLinkAttachChoice` keeps its exact public behavior; it is reimplemented over a generalized `resolveTargetChoice`.

- [ ] **Step 1: Write failing tests for the new exports**

Append to `web/src/services/__tests__/unit/deepLinkAttach.test.ts`. Preserve that file's existing mocks (`attachPrefs` → `{ loadAttachPrefs: () => ({ mode: 'auto', renderer: 'webgl' }) }`, `Renderer` → `detectWebGLSupport: () => true`, `addressSelection`, hoisted `sessionsApiMock`). Add the new describe blocks at the end:

```ts
import {
  resolveProfileAttach,
  resolveTargetChoice,
} from '@/services/deepLinkAttach';
import type { SessionAttachProfile, PersistedAttachChoice } from '@/services/sessionAttachProfile';
import { buildOptionsFingerprint } from '@/services/sessionAttachProfile';
import type { Session } from '@/types';

const p2pSession: Session = {
  session_id: 'agent-1:dev',
  agent_id: 'agent-1',
  session_name: 'dev',
  status: 'active',
  window_count: 1,
  attached_clients: 0,
  last_activity: '2026-01-01T00:00:00Z',
};

const p2pChoice: PersistedAttachChoice = {
  mode: 'p2p',
  renderer: 'webgl',
  envRefs: [{ name: 'prod.env', source: 'server' }],
  selectedUrl: null,
};

function p2pProfile(): SessionAttachProfile {
  return {
    schemaVersion: 1,
    sessionId: 'agent-1:dev',
    agentId: 'agent-1',
    choice: p2pChoice,
    optionsFingerprint: buildOptionsFingerprint({
      mode: 'p2p',
      session_id: 'agent-1:dev',
      connection_token: 'tok',
      addresses: [
        {
          url: 'ws://a/ws',
          label: 'lan',
          network_type: 'lan',
          priority: 0,
          status: 'reachable',
        },
      ],
    }),
    updatedAt: 1,
  };
}

describe('resolveTargetChoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionsApiMock.requestAttach.mockResolvedValue({
      mode: 'p2p',
      session_id: 'agent-1:dev',
      connection_token: 'tok',
      addresses: [
        {
          url: 'ws://a/ws',
          label: 'lan',
          network_type: 'lan',
          priority: 0,
          status: 'reachable',
        },
      ],
    });
  });

  it('builds a choice honouring a p2p target', async () => {
    const choice = await resolveTargetChoice(
      p2pSession,
      p2pChoice,
      new Map(),
      undefined,
    );
    expect(sessionsApiMock.requestAttach).toHaveBeenCalledWith('agent-1:dev', 'p2p', undefined);
    expect(choice).toMatchObject({
      mode: 'p2p',
      selectedUrl: null,
      renderer: 'webgl',
      envRefs: [{ name: 'prod.env', source: 'server' }],
    });
    expect(choice.attachInfo.connection_token).toBe('tok');
  });

  it('requests relay info for a relay target and maps manual url to relayUrl', async () => {
    sessionsApiMock.requestAttach.mockResolvedValue({
      mode: 'relay',
      session_id: 'agent-1:dev',
      agent_address: '',
      connection_token: '',
      addresses: [
        {
          url: 'ws://relay/ws',
          label: 'lan',
          network_type: 'lan',
          priority: 0,
          status: 'reachable',
        },
      ],
    });
    const choice = await resolveTargetChoice(
      p2pSession,
      { ...p2pChoice, mode: 'relay', selectedUrl: 'ws://relay/ws' },
      new Map(),
      undefined,
    );
    expect(sessionsApiMock.requestAttach).toHaveBeenCalledWith(
      'agent-1:dev',
      'relay',
      'ws://relay/ws',
    );
    expect(choice.relayUrl).toBe('ws://relay/ws');
  });

  it('falls back to live address testing when the probe cache is cold', async () => {
    const choice = await resolveTargetChoice(p2pSession, p2pChoice, new Map(), undefined);
    expect(testAddresses).toHaveBeenCalled();
    expect(orderedUrls).toContain('ws://fast/ws');
  });
});

describe('resolveProfileAttach', () => {
  it('returns a choice when the profile is still valid', async () => {
    const probe = new Map([
      ['agent-1', { latencies: [], orderedUrls: ['ws://a/ws'], probedAt: 1 }],
    ]);
    const resolution = await resolveProfileAttach(p2pSession, p2pProfile(), probe);
    expect(resolution.kind).toBe('choice');
  });

  it('returns dialog when the options changed', async () => {
    sessionsApiMock.requestAttach.mockResolvedValue({
      mode: 'p2p',
      session_id: 'agent-1:dev',
      connection_token: 'tok',
      addresses: [
        {
          url: 'ws://a/ws',
          label: 'lan',
          network_type: 'lan',
          priority: 0,
          status: 'reachable',
        },
        {
          url: 'ws://new/ws',
          label: 'vpn',
          network_type: 'vpn',
          priority: 0,
          status: 'reachable',
        },
      ],
    });
    const resolution = await resolveProfileAttach(p2pSession, p2pProfile(), new Map());
    expect(resolution).toEqual({ kind: 'dialog' });
  });

  it('returns dialog when the attach request fails', async () => {
    sessionsApiMock.requestAttach.mockRejectedValue(new Error('boom'));
    const resolution = await resolveProfileAttach(p2pSession, p2pProfile(), new Map());
    expect(resolution).toEqual({ kind: 'dialog' });
  });
});
```

Note the existing file imports `testAddresses` / `orderByLatency` (its mock returns latency results `[{ url: 'ws://fast/ws', latencyMs: 10 }, …]` and `orderByLatency` as identity) — if those names aren't imported into the new describe blocks' scope, import them from `'@/services/addressSelection'` at the top of the appended block. Adjust the existing file's imports so both the old and new describes compile.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/__tests__/unit/deepLinkAttach.test.ts`
Expected: FAIL — `resolveTargetChoice` / `resolveProfileAttach` not exported.

- [ ] **Step 3: Reimplement `deepLinkAttach.ts`**

Rewrite `web/src/services/deepLinkAttach.ts`:

```ts
import type { Session } from '../types';
import type { AttachChoice } from '@/features/sessions/components/AttachDialog';
import { sessionsApi } from '../features/sessions';
import type { AgentProbe } from '../atoms/probe';
import { loadAttachPrefs } from './attachPrefs';
import { detectWebGLSupport } from '../core/terminal-runtime/Renderer';
import { orderByLatency, testAddresses } from './addressSelection';
import type { SessionAttachProfile } from './sessionAttachProfile';
import { validateProfile } from './sessionAttachProfile';
import type { PersistedAttachChoice } from './sessionAttachProfile';
import type { AttachInfo } from '../types';

/** Requested transport the dialog/server uses for a stored mode ('auto' asks for p2p info). */
function requestedModeOf(mode: PersistedAttachChoice['mode']): 'p2p' | 'relay' {
  return mode === 'auto' ? 'p2p' : mode;
}

function relayOverrideOf(choice: PersistedAttachChoice): string | undefined {
  return choice.mode === 'relay' && choice.selectedUrl !== null
    ? choice.selectedUrl
    : undefined;
}

function orderedUrlsFor(
  attachInfo: AttachInfo,
  probe: AgentProbe | undefined,
  latencies: { url: string; latencyMs: number | null }[],
): { orderedUrls: string[]; latencies: { url: string; latencyMs: number | null }[] } {
  let ordered = probe?.orderedUrls ?? [];
  let measured = probe?.latencies ?? [];
  if (ordered.length === 0 && attachInfo.mode === 'p2p') {
    const candidates = attachInfo.addresses ?? [];
    if (candidates.length > 0) {
      measured = latencies;
      ordered = orderByLatency(latencies);
    } else if (attachInfo.agent_address) {
      ordered = [attachInfo.agent_address];
    }
  }
  return { orderedUrls: ordered, latencies: measured };
}

async function fetchAttachInfo(
  session: Session,
  choice: PersistedAttachChoice,
): Promise<AttachInfo> {
  const requestedMode = requestedModeOf(choice.mode);
  return sessionsApi.requestAttach(
    session.session_id,
    requestedMode,
    relayOverrideOf(choice),
  );
}

/**
 * Build the AttachChoice the dialog would produce for a persisted target,
 * without showing the dialog. `attachInfo` may be supplied (e.g. already
 * fetched for validation) to avoid a second request.
 */
export async function resolveTargetChoice(
  session: Session,
  choice: PersistedAttachChoice,
  probeResults: Map<string, AgentProbe>,
  attachInfo?: AttachInfo,
): Promise<AttachChoice> {
  const info = attachInfo ?? (await fetchAttachInfo(session, choice));
  const probe = probeResults.get(session.agent_id);
  const live = (await testAddresses(info.addresses ?? [])).catch(() => []);
  // Only probe live when the cache has nothing usable; otherwise reuse cache.
  const cached = orderedUrlsFor(info, probe, probe?.latencies ?? []);
  if (cached.orderedUrls.length === 0 && info.mode === 'p2p' && (info.addresses?.length ?? 0) > 0) {
    const measured = await live;
    const resolved = orderedUrlsFor(info, undefined, measured);
    return finalChoice(session, choice, info, resolved.orderedUrls, resolved.latencies);
  }
  return finalChoice(session, choice, info, cached.orderedUrls, cached.latencies);
}

function finalChoice(
  _session: Session,
  choice: PersistedAttachChoice,
  attachInfo: AttachInfo,
  orderedUrls: string[],
  latencies: { url: string; latencyMs: number | null }[],
): AttachChoice {
  return {
    mode: choice.mode,
    attachInfo,
    orderedUrls,
    latencies,
    selectedUrl: choice.selectedUrl,
    relayUrl: choice.mode === 'relay' ? choice.selectedUrl : null,
    renderer: detectWebGLSupport() ? choice.renderer : 'canvas',
    envRefs: choice.envRefs,
  };
}

/** Restore a previously-confirmed profile: valid → immediate attach, else dialog. */
export type ProfileAttachResolution =
  | { kind: 'choice'; choice: AttachChoice }
  | { kind: 'dialog' };

export async function resolveProfileAttach(
  session: Session,
  profile: SessionAttachProfile,
  probeResults: Map<string, AgentProbe>,
): Promise<ProfileAttachResolution> {
  try {
    const info = await fetchAttachInfo(session, profile.choice);
    const verdict = validateProfile(profile, info, detectWebGLSupport());
    if (!verdict.ok) {
      return { kind: 'dialog' };
    }
    const choice = await resolveTargetChoice(session, profile.choice, probeResults, info);
    return { kind: 'choice', choice };
  } catch {
    return { kind: 'dialog' };
  }
}

/**
 * Legacy dialog-less path for deep-link / refresh restore with NO per-session
 * profile: resolve the same auto-mode choice AttachDialog would produce from
 * the global attach prefs. Stored relay maps to auto (legacy semantics).
 */
export async function resolveDeepLinkAttachChoice(
  session: Session,
  probeResults: Map<string, AgentProbe>,
): Promise<AttachChoice> {
  const prefs = loadAttachPrefs();
  const target: PersistedAttachChoice = {
    mode: prefs.mode === 'relay' ? 'auto' : prefs.mode,
    renderer: prefs.renderer,
    envRefs: [],
    selectedUrl: null,
  };
  return resolveTargetChoice(session, target, probeResults);
}
```

Careful notes for the executor:

- The original `resolveDeepLinkAttachChoice` body (fetch → probe-cache/`testAddresses` fallback → choice) must keep producing **identical choices** for identical inputs — the legacy tests in this file assert `requestAttach` called with `(session.session_id, 'p2p')` and choice shape. If the naive rewrite above causes an assertion mismatch (e.g. the cache-warm path previously skipped `testAddresses` entirely while this version fires it unconditionally as `live`), restructure so the live probe only ever runs when the cache is cold: compute the cache path first and only call `testAddresses` inside the cold branch (drop the eager `live` promise).
- The `vi.hoisted` `sessionsApiMock` used by the file must gain `requestAttach` with the right default resolved value for the new tests; the test file already mocks `@/services/addressSelection` `testAddresses` to resolve and `orderByLatency` to identity.
- `relayOverrideOf` returns `undefined` for non-relay — matches `requestAttach` being called with a 3rd arg `undefined` (asserted by existing tests).

- [ ] **Step 4: Run the full test file to verify it passes**

Run: `npx vitest run src/services/__tests__/unit/deepLinkAttach.test.ts`
Expected: ALL tests pass (legacy + new). If a legacy assertion differs, fix the implementation to reproduce the original behavior exactly, not the test.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/deepLinkAttach.ts src/services/__tests__/unit/deepLinkAttach.test.ts
git commit -m "feat(web): profile-aware attach choice resolution (#672)"
```

---

### Task 4: Dialog intent atom + reset points

**Files:**
- Modify: `web/src/atoms/__tests__/unit/session.test.ts`
- Modify: `web/src/atoms/session.ts`

- [ ] **Step 1: Write failing atom tests**

Append to `web/src/atoms/__tests__/unit/session.test.ts` (the file already has `makeSession()` / `makeChoice(session)` factories and `store` + `navigate` patterns quoted in the file map):

```ts
import {
  attachDialogIntentAtom,
  attachDialogSessionAtom,
  type AttachDialogIntent,
} from '@/atoms/session';

describe('attachDialogIntentAtom', () => {
  it('defaults to attach', () => {
    const store = createStore();
    expect(store.get(attachDialogIntentAtom)).toBe('attach');
  });

  it('resets to attach when attachToSessionAtom confirms', () => {
    const store = createStore();
    const session = makeSession();
    store.set(attachDialogSessionAtom, session);
    store.set(attachDialogIntentAtom, 'configure');
    store.set(attachToSessionAtom, {
      session,
      choice: makeChoice(session),
      navigate,
    });
    expect(store.get(attachDialogIntentAtom)).toBe('attach');
    expect(store.get(attachDialogSessionAtom)).toBeNull();
  });

  it('resets to attach on disconnect', () => {
    const store = createStore();
    const session = makeSession();
    store.set(attachDialogSessionAtom, session);
    store.set(attachDialogIntentAtom, 'configure');
    store.set(disconnectAtom, navigate);
    expect(store.get(attachDialogIntentAtom)).toBe('attach');
  });
});
```

(Adjust: `makeSession`/`makeChoice`/`navigate`/`createStore` are already defined at the top of the existing file — reference them, don't redefine. `type AttachDialogIntent` may be imported or dropped from the import list if unused.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/atoms/__tests__/unit/session.test.ts`
Expected: FAIL — `attachDialogIntentAtom` not exported.

- [ ] **Step 3: Implement the intent atom + resets**

In `web/src/atoms/session.ts`:

Add next to `attachDialogSessionAtom` (after line 22):

```ts
/** Why the attach dialog is open: 'attach' (confirm → attach) or 'configure'
 *  (Save → persist the profile only, never attach/reconnect). */
export type AttachDialogIntent = 'attach' | 'configure';

export const attachDialogIntentAtom = atom<AttachDialogIntent>('attach');
```

In `attachToSessionAtom`, where it clears `attachDialogSessionAtom` (currently `set(attachDialogSessionAtom, null);` at line 67), also add:

```ts
    set(attachDialogIntentAtom, 'attach');
```

In `disconnectAtom`, where it clears `attachDialogSessionAtom` (line 83), also add:

```ts
    set(attachDialogIntentAtom, 'attach');
```

- [ ] **Step 4: Run the atom tests to verify they pass**

Run: `npx vitest run src/atoms/__tests__/unit/session.test.ts`
Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add src/atoms/session.ts src/atoms/__tests__/unit/session.test.ts
git commit -m "feat(web): attach-dialog intent atom (#672)"
```

---

### Task 5: `useSessionFirstAttach` — persist, fast path, configure, cancel rules

**Files:**
- Modify: `web/src/app/useSessionFirstAttach.ts`

This task changes hook behavior; its behavioral assertions come with the flow tests in Task 10, but the compile + existing `SessionFirstShell.test.tsx` suite must stay green here.

- [ ] **Step 1: Rewrite the hook**

Rewrite `web/src/app/useSessionFirstAttach.ts`:

```ts
import { useCallback, useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AttachChoice } from '@/features/sessions/components/AttachDialog';
import {
  attachDialogIntentAtom,
  attachDialogSessionAtom,
  attachToSessionAtom,
  sessionIdAtom,
} from '../atoms/session';
import { saveAttachPrefs } from '../services/attachPrefs';
import { probeResultsAtom } from '../atoms/probe';
import { resolveProfileAttach } from '../services/deepLinkAttach';
import {
  loadSessionProfile,
  persistConfirmedChoice,
} from '../services/sessionAttachProfile';
import type { Session } from '../types';

/** Session-first attach: profile-aware dialog bypass + explicit configure. */
export function useSessionFirstAttach() {
  const [attachDialogSession, setAttachDialogSession] = useAtom(attachDialogSessionAtom);
  const setAttachDialogIntent = useSetAtom(attachDialogIntentAtom);
  const attachToSession = useSetAtom(attachToSessionAtom);
  const probeResults = useAtomValue(probeResultsAtom);
  const clientSessionId = useAtomValue(sessionIdAtom);
  const navigate = useNavigate();
  const location = useLocation();

  /** Guards a running fast-path validation against double clicks. */
  const inFlightRef = useRef<boolean>(false);

  const openAttachDialog = useCallback((session: Session, intent: 'attach' | 'configure') => {
    setAttachDialogSession(session);
    setAttachDialogIntent(intent);
  }, [setAttachDialogSession, setAttachDialogIntent]);

  /** Row click entry: no profile → dialog; profile → validate, attach or dialog. */
  const requestAttach = useCallback((session: Session) => {
    const profile = loadSessionProfile(session);
    if (!profile) {
      openAttachDialog(session, 'attach');
      return;
    }
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    void (async () => {
      try {
        const resolution = await resolveProfileAttach(session, profile, probeResults);
        if (resolution.kind === 'choice') {
          confirmAttach(session, resolution.choice);
        } else {
          openAttachDialog(session, 'attach');
        }
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [probeResults, confirmAttach, openAttachDialog]);

  /** Every explicit confirmation persists (or refreshes) the Session profile. */
  const confirmAttach = useCallback((
    session: Session,
    choice: AttachChoice,
    opts: { persistProfile?: boolean } = {},
  ) => {
    saveAttachPrefs({ mode: choice.mode, renderer: choice.renderer });
    if (opts.persistProfile !== false) {
      // The fingerprint must reflect the FRESH options the choice was built
      // against — choice.attachInfo always comes from the latest requestAttach.
      persistConfirmedChoice(session, choice, choice.attachInfo);
    }
    attachToSession({ session, choice, navigate });
  }, [attachToSession, navigate]);

  /** Session-row Settings entry: dialog in configure mode (persist only). */
  const openAttachSettings = useCallback((session: Session) => {
    openAttachDialog(session, 'configure');
  }, [openAttachDialog]);

  const cancelAttach = useCallback(() => {
    setAttachDialogSession(null);
    setAttachDialogIntent('attach');
    // A restore that landed on /terminal/:sessionId with nothing attached and
    // whose dialog was cancelled must leave: nothing would re-drive the
    // attach, and the restore effect would otherwise re-fire on every poll.
    if (clientSessionId === '' && location.pathname.startsWith('/terminal/')) {
      navigate('/');
    }
  }, [setAttachDialogSession, setAttachDialogIntent, clientSessionId, location.pathname, navigate]);

  return {
    attachDialogSession,
    requestAttach,
    confirmAttach,
    cancelAttach,
    openAttachSettings,
  };
}
```

Executing this requires the fingerprint builder to accept the persistable choice's own request shape. **Simplification to keep the module contract clean:** the fingerprint recorded must equal the one computed at validation time from the same `attachInfo`. Export a helper from `sessionAttachProfile.ts` instead of importing `buildOptionsFingerprint` here:

```ts
/** Persist the choice a confirm produced, fingerprinting its FRESH attachInfo. */
export function persistConfirmedChoice(
  session: Pick<Session, 'session_id' | 'agent_id'>,
  choice: {
    mode: AttachMode;
    renderer: 'webgl' | 'canvas';
    envRefs?: EnvFileRef[];
    selectedUrl?: string | null;
  },
  info: AttachInfo,
): void {
  saveSessionProfile(
    session,
    {
      mode: choice.mode,
      renderer: choice.renderer,
      envRefs: choice.envRefs ?? [],
      selectedUrl: choice.selectedUrl ?? null,
    },
    buildOptionsFingerprint(info),
  );
}
```

so `confirmAttach` becomes:

```ts
    if (opts.persistProfile !== false) {
      persistConfirmedChoice(session, choice, choice.attachInfo);
    }
```

with the hook importing `persistConfirmedChoice` and `PersistedAttachChoice` dropped if unused.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors. If `requestAttach`'s dependency array references `confirmAttach`/`openAttachDialog` before their `const` initializers, reorder declarations (put `confirmAttach` and `openAttachDialog` above `requestAttach`) — hooks rules require stable order; ESLint `react-hooks/exhaustive-deps` demands the listed deps only.

- [ ] **Step 3: Run the existing shell + unit suites to confirm no regression**

Run: `npx vitest run src/app/__tests__/integration/SessionFirstShell.test.tsx src/atoms/__tests__/unit/session.test.ts`
Expected: ALL pass. (The suite still goes through the no-profile dialog path; note `confirmAttach` now writes a profile — any cross-test bleed is cleaned up in Task 10 Step 1, which adds `localStorage.clear()` to that file's `beforeEach`.)

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/app/useSessionFirstAttach.ts src/services/sessionAttachProfile.ts
git commit -m "feat(web): profile-aware row attach with configure entry (#672)"
```

---

### Task 6: AttachDialog — intent, profile prefill, Save footer

**Files:**
- Modify: `web/src/features/sessions/components/__tests__/integration/AttachDialog.test.tsx`
- Modify: `web/src/features/sessions/components/AttachDialog.tsx`

- [ ] **Step 1: Write failing dialog tests**

Append to `web/src/features/sessions/components/__tests__/integration/AttachDialog.test.tsx` (reuse its existing mocks/fixtures; the `attachInfo()` factory there has `addresses` default `[]` — the tests below pass addresses explicitly; the `session()` factory is local):

```ts
import { loadSessionProfile, saveSessionProfile } from '@/services/sessionAttachProfile';
import type { PersistedAttachChoice } from '@/services/sessionAttachProfile';

describe('AttachDialog profile prefill + configure intent', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockedEnvApi.listEnvFiles.mockResolvedValue({ files: [] });
    mockedSessionsApi.requestAttach.mockImplementation(async () =>
      attachInfo([
        { url: 'ws://a/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' },
      ]),
    );
  });

  const choice: PersistedAttachChoice = {
    mode: 'p2p',
    renderer: 'webgl',
    envRefs: [],
    selectedUrl: null,
  };

  function seedProfile(overrides: Partial<PersistedAttachChoice> = {}) {
    saveSessionProfile(
      { session_id: 'agent-1:dev', agent_id: 'agent-1' },
      { ...choice, ...overrides },
      'any-fp',
    );
  }

  it('prefills mode and renderer from the session profile', async () => {
    seedProfile({ mode: 'relay', renderer: 'canvas' });
    render(<AttachDialog isOpen onClose={onClose} session={session()} onConfirm={onConfirm} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Attach$/ })).toBeEnabled());
    // Relay mode selected → requestAttach asks for relay info.
    expect(mockedSessionsApi.requestAttach).toHaveBeenCalledWith('agent-1:dev', 'relay', undefined);
  });

  it('prefills the manual url when it is still a candidate', async () => {
    seedProfile({ mode: 'p2p', selectedUrl: 'ws://a/ws' });
    render(<AttachDialog isOpen onClose={onClose} session={session()} onConfirm={onConfirm} />);
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'agent-1:dev' }),
      expect.objectContaining({ mode: 'p2p', selectedUrl: 'ws://a/ws' }),
    );
  });

  it('falls back to auto url when the saved manual url is gone', async () => {
    seedProfile({ mode: 'p2p', selectedUrl: 'ws://gone/ws' });
    render(<AttachDialog isOpen onClose={onClose} session={session()} onConfirm={onConfirm} />);
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ selectedUrl: null }),
    );
  });

  it('shows Save and still calls onConfirm once in configure mode', async () => {
    render(
      <AttachDialog
        isOpen
        intent="configure"
        onClose={onClose}
        session={session()}
        onConfirm={onConfirm}
      />,
    );
    const saveBtn = await screen.findByRole('button', { name: /^Save$/ });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    await user.click(saveBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows Attach (not Save) in attach mode', async () => {
    render(<AttachDialog isOpen onClose={onClose} session={session()} onConfirm={onConfirm} />);
    await screen.findByRole('button', { name: /^Attach$/ });
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
  });

  it('prefills env file selection from the profile, filtering missing files', async () => {
    mockedEnvApi.listEnvFiles.mockResolvedValue({
      files: [
        { name: 'prod.env', source: 'server', size: 10, modified: 0, var_count: 3 },
      ],
    });
    seedProfile({
      envRefs: [
        { name: 'prod.env', source: 'server' },
        { name: 'gone.env', source: 'server' },
      ],
    });
    render(<AttachDialog isOpen onClose={onClose} session={session()} onConfirm={onConfirm} />);
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ envRefs: [{ name: 'prod.env', source: 'server' }] }),
    );
  });
});
```

Notes for adapting: existing file defines `onClose = vi.fn()` / `onConfirm = vi.fn()` per-describe or top-level — reuse whichever exists; if `user` is not yet set up at top level of the file, add `const user = userEvent.setup()` beside the other setup. Existing describe blocks share the module mocks — don't redeclare the `vi.mock` calls.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/sessions/components/__tests__/integration/AttachDialog.test.tsx`
Expected: new describe fails (intent prop type / profile prefill missing); old tests still pass.

- [ ] **Step 3: Implement dialog changes**

In `web/src/features/sessions/components/AttachDialog.tsx`:

a) Add imports:

```ts
import {
  loadSessionProfile,
  sanitizeChoiceForPrefill,
} from '@/services/sessionAttachProfile';
import { candidateUrlsOf } from '@/services/sessionAttachProfile';
```

b) Extend props (interface at lines 41–47):

```ts
interface AttachDialogProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
  /** Which flow opened the dialog: attach (confirm → attach) or configure
   *  (Save → persist the profile only). Defaults to 'attach'. */
  intent?: 'attach' | 'configure';
  /** Called with the resolved attach choice; the flow shows the terminal
   *  (attach intent) or persists only (configure intent). */
  onConfirm: (session: Session, choice: AttachChoice) => void;
}
```

c) Destructure `intent = 'attach'` in the function signature; keep an `intentRef` mirroring the latest intent inside the confirm handler only if needed for button label (simplest: label derives from `intent` directly):

Footer becomes:

```tsx
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={!attachInfo}>
            {intent === 'configure' ? 'Save' : 'Attach'}
          </Button>
        </DialogFooter>
```

d) Prefill from the session profile in the reset effect (lines 85–100). Replace the effect body's prefs logic:

```ts
  // Profile refs captured at open time (dialog state resets per open).
  const prefillProfileRef = useRef<SessionAttachProfile | null>(null);

  // Reset per open: prefill from the session profile when one exists, else
  // the legacy global prefs. Only explicit confirms create profiles, so a
  // missing profile keeps the classic first-attach experience.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const profile = session ? loadSessionProfile(session) : null;
    prefillProfileRef.current = profile;
    const source = profile?.choice;
    setMode(source ? source.mode : loadAttachPrefs().mode === 'relay' ? 'auto' : loadAttachPrefs().mode);
    const prefs = loadAttachPrefs();
    setRenderer(source ? (source.renderer === 'webgl' && !webglSupported ? 'canvas' : source.renderer)
      : webglSupported ? prefs.renderer : 'canvas');
    setAttachInfo(null);
    setSelectedUrl(AUTO_URL);
    setError(null);
    // Load available env files and clear the previous selection on each open.
    envApi.listEnvFiles()
      .then((resp) => {
        setEnvFiles(resp.files);
        const prof = prefillProfileRef.current;
        prefillProfileRef.current = null;
        if (prof) {
          const files = resp.files;
          setSelectedEnv(prof.choice.envRefs.filter((ref) =>
            files.some((f) => f.name === ref.name && f.source === ref.source &&
              (!ref.agent_id || f.agent_id === ref.agent_id)),
          ));
        } else {
          setSelectedEnv([]);
        }
      })
      .catch(() => {});
  }, [isOpen, webglSupported, setAttachInfo, session]);
```

Import `SessionAttachProfile` as a type. Keep `setSelectedEnv` inside the promise (it now depends on the fetched file list).

e) Preselect the profile's manual URL once candidates arrive (extend the fetch effect at lines 113–141, inside the `.then` after `setAttachInfo(info)`):

```ts
        // Preselect the saved manual path when it is still offered; the
        // dialog otherwise starts on Auto (closest valid prefill).
        const savedUrl = prefillProfileRef.current?.choice.selectedUrl;
        if (savedUrl && info && candidateUrlsOf(info).includes(savedUrl)) {
          setSelectedUrl(savedUrl);
        }
```

Guard so it only applies on the initial candidate arrival for this open (it runs once per effect run whose deps include `mode`/`relayUrl` — safe because once the user manually picks a row the state no longer equals `AUTO_URL`, and candidate refetch for a *new* session resets `AUTO_URL` first via the reset effect).

Note the stale `prefillProfileRef` must not leak across opens: the reset effect assigns it on every open and clears it in the env promise — if a profile is present, prefill ref stays non-null until the env promise resolves, so the URL preselect below is only armed while that open's candidates arrive. That is the intended window.

- [ ] **Step 4: Run the dialog tests to verify they pass**

Run: `npx vitest run src/features/sessions/components/__tests__/integration/AttachDialog.test.tsx`
Expected: ALL pass (old + new).

- [ ] **Step 5: Lint + typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/features/sessions/components/AttachDialog.tsx src/features/sessions/components/__tests__/integration/AttachDialog.test.tsx
git commit -m "feat(web): attach dialog profile prefill and configure intent (#672)"
```

---

### Task 7: SessionItem Settings button + `lg`-gated hover reveal

**Files:**
- Modify: `web/src/features/sessions/components/__tests__/integration/SessionItem.test.tsx`
- Modify: `web/src/features/sessions/components/SessionItem.tsx`

- [ ] **Step 1: Write failing item tests**

Append to `web/src/features/sessions/components/__tests__/integration/SessionItem.test.tsx` (file already defines module-level `session` / `domain` fixtures and `onSelect = vi.fn()` style per-test setup — follow its existing shape):

```ts
import { Settings } from 'lucide-react';

describe('SessionItem settings action', () => {
  it('renders no settings button when onConfigure is absent', () => {
    render(
      <SessionItem session={session} domain={domain} agentLabel="devbox-01"
        selected={false} onSelect={onSelect} />,
    );
    expect(screen.queryByTestId(`session-settings-${session.session_id}`)).toBeNull();
  });

  it('calls onConfigure with the session and never selects the row', async () => {
    const onConfigure = vi.fn();
    render(
      <SessionItem session={session} domain={domain} agentLabel="devbox-01"
        selected={false} onSelect={onSelect} onConfigure={onConfigure} />,
    );
    const button = screen.getByTestId(`session-settings-${session.session_id}`);
    expect(button).toHaveAccessibleName(`Configure attach settings for ${session.session_name}`);
    await userEvent.click(button);
    expect(onConfigure).toHaveBeenCalledWith(session);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('is always interactive below lg and revealed on hover at lg+ (kill parity)', () => {
    render(
      <SessionItem session={session} domain={domain} agentLabel="devbox-01"
        selected={false} onSelect={onSelect}
        onConfigure={() => {}} onKill={() => {}} />,
    );
    const settings = screen.getByTestId(`session-settings-${session.session_id}`);
    const kill = screen.getByTestId(`session-kill-${session.session_id}`);
    // Below lg: visible and clickable by default.
    expect(settings.className).not.toMatch(/opacity-0/);
    expect(kill.className).not.toMatch(/opacity-0/);
    // lg+ reveal classes are present (jsdom cannot test group-hover itself).
    expect(settings.className).toMatch(/lg:opacity-0/);
    expect(settings.className).toMatch(/lg:group-hover:opacity-100/);
    expect(settings.className).toMatch(/lg:pointer-events-none/);
    expect(kill.className).toMatch(/lg:opacity-0/);
  });

  it('keeps the icon visible while selected', () => {
    render(
      <SessionItem session={session} domain={domain} agentLabel="devbox-01"
        selected onSelect={onSelect} onConfigure={() => {}} onKill={() => {}} />,
    );
    const settings = screen.getByTestId(`session-settings-${session.session_id}`);
    expect(settings.className).toMatch(/opacity-100/);
    expect(settings.className).toMatch(/pointer-events-auto/);
  });
});
```

(Adapt names — the existing file may already alias `userEvent`; `Settings` import is unused by these tests and can be dropped. The file's existing visibility tests assert kill classes — keep their assertions valid after the class change by updating them in this same task if they asserted the un-prefixed forms. Run the whole file after the change.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/sessions/components/__tests__/integration/SessionItem.test.tsx`
Expected: new tests fail (`session-settings-…` not found).

- [ ] **Step 3: Implement the item changes**

Rewrite the action-button block of `web/src/features/sessions/components/SessionItem.tsx`. Import `Settings` from `lucide-react` alongside `Trash2`. Add to the props interface:

```ts
  onConfigure?: (session: Session) => void;
```

Extract the reveal classes into a shared constant inside the file (module scope):

```ts
/**
 * Row icon visibility: always interactive below lg (touch-safe drawer rows);
 * at lg+ revealed on row hover / keyboard focus / when selected — jsdom
 * cannot exercise group-hover, so tests assert the class composition.
 */
const iconReveal = cn(
  'size-8 shrink-0 mt-0.5 text-muted-foreground',
  'lg:opacity-0 lg:pointer-events-none',
  'lg:group-hover:opacity-100 lg:group-hover:pointer-events-auto',
  'lg:group-focus-within:opacity-100 lg:group-focus-within:pointer-events-auto',
);
```

(Adjust `mt-0.5 size-8` placement — keep each button's own hover color classes: Settings `hover:text-foreground`, Kill `hover:text-destructive`.)

Render the settings button before the kill button (inside the same `group` row container, only when `onConfigure` is provided):

```tsx
      {onConfigure ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon"
                variant="ghost"
                data-testid={`session-settings-${session.session_id}`}
                aria-label={`Configure attach settings for ${session.session_name}`}
                className={cn(
                  iconReveal,
                  selected && 'opacity-100 pointer-events-auto',
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onConfigure(session);
                }}
              >
                <Settings className="size-4" />
              </Button>
            }
          />
          <TooltipContent side="bottom">Configure attach settings</TooltipContent>
        </Tooltip>
      ) : null}
```

Update the kill button's className to share `iconReveal`:

```tsx
                className={cn(
                  iconReveal,
                  'hover:text-destructive',
                  selected && 'opacity-100 pointer-events-auto',
                )}
```

and delete the old `'opacity-0 pointer-events-none group-hover:…'` chain from Kill.

- [ ] **Step 4: Run the item tests to verify they pass**

Run: `npx vitest run src/features/sessions/components/__tests__/integration/SessionItem.test.tsx`
Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/sessions/components/SessionItem.tsx src/features/sessions/components/__tests__/integration/SessionItem.test.tsx
git commit -m "feat(web): session-row attach-settings action (#672)"
```

---

### Task 8: Thread `onConfigure` through the list surfaces

**Files:**
- Modify: `web/src/features/sessions/components/SessionList.tsx`
- Modify: `web/src/features/sessions/components/__tests__/integration/SessionList.test.tsx`
- Modify: `web/src/app/SessionFirstSidebar.tsx`
- Modify: `web/src/app/SessionFirstWorkspace.tsx`
- Modify: `web/src/app/fixture/FixtureShell.tsx`
- Modify: `web/src/app/fixture/FixtureApp.tsx`
- (grep for other `SessionList`/`SessionFirstSidebar` mount sites in `app/` — e.g. `SessionFirstSpatialLayout.tsx` — and thread the same prop where they forward sidebar props)

- [ ] **Step 1: Add the pass-through test**

In `web/src/features/sessions/components/__tests__/integration/SessionList.test.tsx`, extend an existing render to pass `onConfigure` and assert it reaches the row:

```ts
  it('forwards onConfigure to the row', async () => {
    const onConfigure = vi.fn();
    render(
      <SessionList sessions={[sess]} agents={[agent]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" onSelect={vi.fn()} onConfigure={onConfigure} />,
    );
    await userEvent.click(screen.getByTestId(`session-settings-${sess.session_id}`));
    expect(onConfigure).toHaveBeenCalledWith(sess);
  });
```

(Use the file's existing `sess`/`agent` consts and render-props baseline.)

- [ ] **Step 2: Implement the threading**

- `SessionList.tsx`: add `onConfigure?: (session: Session) => void;` to `SessionListProps` and pass `onConfigure={onConfigure}` to each `SessionItem`.
- `SessionFirstSidebar.tsx`: add `onConfigure: (session: Session) => void;` to its props interface (check whether other optional props exist and mirror them) and forward into `<SessionList … onConfigure={onConfigure} />`.
- `SessionFirstWorkspace.tsx`: add `onConfigure: (session: Session) => void;` to `SessionFirstWorkspaceProps`; include `onConfigure` in the `sidebarProps` object (lines ~76–81) so both the drawer and spatial paths get it; if the drawer call site (lines ~106–112) adds a wrapper around `onSelect` to close the drawer, add the same wrapper for `onConfigure`: `onConfigure={(session) => { setShowDrawer(false); onConfigure(session); }}`.
- `fixture/FixtureShell.tsx` and `fixture/FixtureApp.tsx`: their `sidebarProps` objects already pass `onKill: () => {}` — add `onConfigure: () => {}` alongside.
- Grep for other mounts: `rg -n "<SessionFirstSidebar|<SessionList" src/app -g '*.tsx'` — thread the prop at each site that renders rows.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors (fixtures and spatial layouts compile with the new required prop).

- [ ] **Step 4: Run list + sidebar suites**

Run: `npx vitest run src/features/sessions/components/__tests__/integration/SessionList.test.tsx src/features/sessions/components/__tests__/integration/SessionItem.test.tsx`
Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/sessions/components/SessionList.tsx src/features/sessions/components/__tests__/integration/SessionList.test.tsx src/app/SessionFirstSidebar.tsx src/app/SessionFirstWorkspace.tsx src/app/fixture/FixtureShell.tsx src/app/fixture/FixtureApp.tsx
git commit -m "feat(web): thread attach-settings action through session lists (#672)"
```

---

### Task 9: Shell wiring — dialogs, configure save, restore branches

**Files:**
- Modify: `web/src/app/useSessionFirstShellState.ts`
- Modify: `web/src/app/SessionFirstDialogs.tsx`
- Modify: `web/src/app/SessionFirstShell.tsx`
- Modify: `web/src/app/useDeepLinkRestore.ts`
- Modify: `web/src/app/useSessionFirstDeepLink.ts`
- Modify: `web/src/app/__tests__/integration/useDeepLinkRestore.test.ts`
- Modify: `web/src/app/__tests__/integration/SessionFirstShell.test.tsx`

- [ ] **Step 1: Write failing restore-branch tests**

Extend `web/src/app/__tests__/integration/useDeepLinkRestore.test.ts`. The file mocks `@/services/deepLinkAttach` with `resolveDeepLinkAttachChoice`; the profile path calls `loadSessionProfile` (from `@/services/sessionAttachProfile`) and `resolveProfileAttach`. Add module-level mocks **at the top of the file** alongside the existing one:

```ts
const profileModule = vi.hoisted(() => ({
  loadSessionProfile: vi.fn<[unknown], unknown>(),
  persistConfirmedChoice: vi.fn(),
}));
vi.mock('@/services/sessionAttachProfile', () => profileModule);
```

(If the file needs the real `buildOptionsFingerprint` for fixtures, mock the module with `importActual` and spread it, or construct the profile literal by hand — a literal `SessionAttachProfile` object needs no fingerprint helper, so a full mock is simplest.)

Existing tests render the hook with `confirmAttach` + `navigate` props. The hook's options now include `requestConfigForRestore`. Update every existing `renderHook` call to pass `requestConfigForRestore: requestConfigForRestoreMock` (hoisted or describe-scope `vi.fn()`). New tests:

```ts
describe('restore with a per-session profile', () => {
  it('attaches immediately when the profile validates (persist refresh)', async () => {
    profileModule.loadSessionProfile.mockReturnValue(validProfile);
    vi.mocked(resolveProfileAttach).mockResolvedValue({ kind: 'choice', choice });
    renderHook(() => useDeepLinkRestore({ ...base, requestConfigForRestore: requestConfig }));

    await waitFor(() => {
      expect(vi.mocked(resolveProfileAttach)).toHaveBeenCalledWith(
        session, validProfile, new Map());
      expect(confirmAttach).toHaveBeenCalledWith(session, choice);
    });
  });

  it('opens the config dialog when the profile is stale', async () => {
    profileModule.loadSessionProfile.mockReturnValue(validProfile);
    vi.mocked(resolveProfileAttach).mockResolvedValue({ kind: 'dialog' });
    renderHook(() => useDeepLinkRestore({ ...base, requestConfigForRestore: requestConfig }));

    await waitFor(() => {
      expect(requestConfig).toHaveBeenCalledWith(session);
      expect(confirmAttach).not.toHaveBeenCalled();
    });
  });

  it('does not attach or open a dialog when no profile exists (legacy path)', async () => {
    profileModule.loadSessionProfile.mockReturnValue(null);
    vi.mocked(resolveDeepLinkAttachChoice).mockResolvedValue(choice);
    renderHook(() => useDeepLinkRestore({ ...base, requestConfigForRestore: requestConfig }));

    await waitFor(() => {
      expect(resolveDeepLinkAttachChoice).toHaveBeenCalled();
      expect(confirmAttach).toHaveBeenCalledWith(session, choice, { persistProfile: false });
      expect(requestConfig).not.toHaveBeenCalled();
    });
  });
});
```

Where `validProfile` is a literal matching `SessionAttachProfile`, `choice`/`session`/`base` reuse the file's existing fixtures (`session = makeSession()`, the mocked `choice` object) and `base = { pendingSessionId: 'agent-1:s1', attachedSession: null, sessionsLoaded: true, loadingSessions: false, sessions: [session], probeResults: new Map(), confirmAttach, navigate }`. Adjust `resolveProfileAttach`'s mock import: the file currently mocks `'@/services/deepLinkAttach'` wholesale — extend that mock object to also export `resolveProfileAttach: vi.fn()`, then `vi.mocked(resolveProfileAttach)` works after re-import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/__tests__/integration/useDeepLinkRestore.test.ts`
Expected: new tests fail (props/behaviour missing); existing tests may fail on the new required prop until updated.

- [ ] **Step 3: Implement the restore branches**

`web/src/app/useDeepLinkRestore.ts` — new options + effect branch. Full rewrite of the effect body after the session lookup:

```ts
import { loadSessionProfile } from '../services/sessionAttachProfile';
import { resolveDeepLinkAttachChoice, resolveProfileAttach } from '../services/deepLinkAttach';

export function useDeepLinkRestore(opts: {
  pendingSessionId: string | null;
  attachedSession: AttachedSession | null;
  sessionsLoaded: boolean;
  loadingSessions: boolean;
  sessions: Session[];
  probeResults: Map<string, AgentProbe>;
  confirmAttach: (session: Session, choice: AttachChoice,
    attachOpts?: { persistProfile?: boolean }) => void;
  /** A saved profile is stale/invalid: the caller opens the attach dialog. */
  requestConfigForRestore: (session: Session) => void;
  navigate: NavigateFunction;
}) {
  const {
    pendingSessionId, attachedSession, sessionsLoaded, loadingSessions,
    sessions, probeResults, confirmAttach, requestConfigForRestore, navigate,
  } = opts;

  const confirmedRef = useRef<string | null>(null);
  const configRequestedRef = useRef<string | null>(null);
  const probeResultsRef = useRef(probeResults);
  probeResultsRef.current = probeResults;

  useEffect(() => {
    if (!pendingSessionId) {
      confirmedRef.current = null;
      configRequestedRef.current = null;
    }
  }, [pendingSessionId]);

  useEffect(() => {
    if (!pendingSessionId) { return; }
    if (attachedSession) { return; }
    if (!sessionsLoaded || loadingSessions) { return; }
    if (confirmedRef.current === pendingSessionId) { return; }
    if (configRequestedRef.current === pendingSessionId) { return; }

    const session = sessions.find((s) => s.session_id === pendingSessionId);
    if (!session) {
      navigate('/', { replace: true });
      return;
    }

    let cancelled = false;
    void (async () => {
      const profile = loadSessionProfile(session);
      if (!profile) {
        // Legacy path: no per-session preference exists — global-prefs auto
        // attach, and DO NOT mint a profile from an implicit default.
        try {
          const legacyChoice = await resolveDeepLinkAttachChoice(
            session, probeResultsRef.current);
          if (cancelled) { return; }
          confirmAttach(session, legacyChoice, { persistProfile: false });
          confirmedRef.current = pendingSessionId;
        } catch {
          if (!cancelled) { navigate('/', { replace: true }); }
        }
        return;
      }
      try {
        const resolution = await resolveProfileAttach(
          session, profile, probeResultsRef.current);
        if (cancelled) { return; }
        if (resolution.kind === 'choice') {
          confirmAttach(session, resolution.choice);
          confirmedRef.current = pendingSessionId;
        } else {
          // Never attach with a stale saved choice: ask the user instead.
          configRequestedRef.current = pendingSessionId;
          requestConfigForRestore(session);
        }
      } catch {
        if (!cancelled) { navigate('/', { replace: true }); }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    pendingSessionId, attachedSession, sessionsLoaded, loadingSessions,
    sessions, confirmAttach, requestConfigForRestore, navigate,
  ]);
}
```

`web/src/app/useSessionFirstDeepLink.ts` — own the dialog opener and pass it down; hide the restore spinner while the dialog is open:

```ts
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  attachDialogIntentAtom,
  attachDialogSessionAtom,
  attachInfoAtom,
  hasActiveSessionAtom,
  sessionIdAtom,
  sessionIdFromUrlAtom,
  sessionNameAtom,
} from '@/atoms/session';

export function useSessionFirstDeepLink(opts: {
  sessions: Session[];
  sessionsLoaded: boolean;
  loadingSessions: boolean;
  confirmAttach: (session: Session, choice: AttachChoice,
    attachOpts?: { persistProfile?: boolean }) => void;
  onRestoreSession: (session: Session) => void;
}) {
  // …existing hooks…
  const setAttachDialogSession = useSetAtom(attachDialogSessionAtom);
  const setAttachDialogIntent = useSetAtom(attachDialogIntentAtom);
  const attachDialogSession = useAtomValue(attachDialogSessionAtom);

  const requestConfigForRestore = useCallback((session: Session) => {
    onRestoreSession(session);
    setAttachDialogSession(session);
    setAttachDialogIntent('attach');
  }, [onRestoreSession, setAttachDialogSession, setAttachDialogIntent]);

  // …pass requestConfigForRestore into useDeepLinkRestore…
  // isRestoringDeepLink: do not sit on the restore spinner while the dialog
  // that is asking the user sits on top of it.
  const isRestoringDeepLink = Boolean(terminalMatch && !hasActiveSession &&
    attachDialogSession === null);

  return { isRestoringDeepLink, sessionIdFromUrl };
}
```

(`useDeepLinkRestore`'s `confirmAttach` prop type gains the optional third arg; the `deepLinkConfirmAttach` wrapper passes it through: `confirmAttach(session, choice, attachOpts)` — update its signature accordingly.)

`web/src/app/useSessionFirstShellState.ts` — extend the attach hook's returns and add the configure-save handler:

```ts
  const { attachDialogSession, requestAttach, confirmAttach, cancelAttach,
    openAttachSettings } = useSessionFirstAttach();

  const saveAttachSettings = useCallback((session: Session, choice: AttachChoice) => {
    persistConfirmedChoice(session, choice, choice.attachInfo);
    cancelAttach();
    toast('Attach settings saved — applies to the next attach');
  }, [cancelAttach]);
```

with imports `persistConfirmedChoice` from `../services/sessionAttachProfile`, `AttachChoice` type, and `toast` from `'sonner'`. Also add `attachDialogIntent` read (`useAtomValue(attachDialogIntentAtom)`) and return `saveAttachSettings`, `openAttachSettings`, `attachDialogIntent` from the hook. Note: `persistConfirmedChoice(session, choice, …)` derives mode/renderer/envRefs/selectedUrl from the choice — mirror Task 5's helper signature (`choice` is assignable to its structural param).

`web/src/app/SessionFirstDialogs.tsx` — accept and pass the new props; render one dialog driven by the atoms:

```tsx
export function SessionFirstDialogs({ /* …existing… */
  attachDialogSession,
  attachDialogIntent,
  onAttachConfirm,
  onConfigureConfirm,
  onAttachClose,
}: { /* …existing… */
  attachDialogIntent: 'attach' | 'configure';
  onAttachConfirm: (session: Session, choice: AttachChoice) => void;
  onConfigureConfirm: (session: Session, choice: AttachChoice) => void;
}) {
  return (
    <>
      {/* …create + kill dialogs unchanged… */}
      <AttachDialog
        isOpen={attachDialogSession !== null}
        intent={attachDialogIntent}
        onClose={onAttachClose}
        session={attachDialogSession}
        onConfirm={attachDialogIntent === 'configure' ? onConfigureConfirm : onAttachConfirm}
      />
    </>
  );
}
```

`web/src/app/SessionFirstShell.tsx` — pass through:

```tsx
      attachDialogSession={state.attachDialogSession}
      attachDialogIntent={state.attachDialogIntent}
      onAttachConfirm={state.confirmAttach}
      onConfigureConfirm={state.saveAttachSettings}
      onAttachClose={state.cancelAttach}
```

and add the row entry:

```tsx
            onConfigure={state.openAttachSettings}
```

to the `SessionFirstWorkspace` invocation (beside `onSelect`/`onKill`).

- [ ] **Step 4: Run the restore tests to verify they pass**

Run: `npx vitest run src/app/__tests__/integration/useDeepLinkRestore.test.ts`
Expected: ALL pass (updated + new).

- [ ] **Step 5: Typecheck + run the shell suite**

Run: `npx tsc --noEmit && npx vitest run src/app/__tests__/integration/SessionFirstShell.test.tsx`
Expected: 0 tsc errors; shell suite passes. Add `localStorage.clear()` to `SessionFirstShell.test.tsx`'s `beforeEach` if the file has no existing storage hygiene (profiles written by prior tests must not leak), and also assert the configure dialog opens from the mocked `AttachDialog` by extending the mock to surface `intent` (`data-testid="attach-dialog-intent"` rendered as `intent`) if a settings-flow shell test is wanted here (the focused flow tests live in Task 10).

- [ ] **Step 6: Commit**

```bash
git add src/app/useDeepLinkRestore.ts src/app/useSessionFirstDeepLink.ts src/app/useSessionFirstShellState.ts src/app/SessionFirstDialogs.tsx src/app/SessionFirstShell.tsx src/app/__tests__/integration/useDeepLinkRestore.test.ts src/app/__tests__/integration/SessionFirstShell.test.tsx
git commit -m "feat(web): restore validates session profile before auto-attach (#672)"
```

---

### Task 10: End-to-end attach-flow integration tests

**Files:**
- Create: `web/src/app/__tests__/integration/AttachFlow.test.tsx`

This file renders the real `SessionFirstShell` (real `useSessionFirstAttach`, real `AttachDialog`, real `sessionAttachProfile`) with module-mocked data sources, replicating the harness from `SessionFirstShell.test.tsx` (quoted in the file map). Differences: **do not** mock `AttachDialog`; mock `@/features/sessions` (`sessionsApi.requestAttach`), `@/features/env` (`envApi.listEnvFiles`), `@/app/useDashboard` (hoisted `dashboard` object incl. `filteredSessions`, `agents`, `staleAgents`, `loadingSessions`, `sessionToKill`, `setSessionToKill`, `handleSessionKilled`, `showCreateModal`, `setShowCreateModal`, `handleSessionCreated`, `fetchSessions`, `error`, `clearError`, `searchQuery`/`statusFilter`/`sortField`/`sortDirection`/`toggleSort`/`setSearchQuery`/`setStatusFilter`/`isSearchActive`), `useProbePolling` → `() => {}`, the workspace/detail children (`SessionFirstTerminal`, `SessionFirstWorkspace` internals render as stubs where the original file does), `useSessionFirstMobileNav` via hoisted `mobileNav`, `useSessionFirstDeepLink` real (NOT mocked — this task needs the restore branch). Where the original mocked `useSessionFirstDeepLink`, instead let it run for real but stub `useDeepLinkRestore`'s async bodies via the mocked `sessionsApi` — a deep-link restore only fires when the router lands on `/terminal/:sessionId` and nothing is attached, which the fast-path tests avoid by starting at `/`.

Before each test: `localStorage.clear()`, reset the hoisted dashboard seed, `vi.clearAllMocks()`.

Tests to write:

1. **First attach (no profile) opens the dialog** — click `session-item-a1:fix` (via the drawer opener if the harness needs it) → `attach-dialog` visible; confirm (real dialog: wait for the enabled `Attach` button, click it) → `store.get(sessionIdAtom) === 'a1:fix'`; `localStorage['nession_session_attach_profiles']` contains an entry for `a1:fix`.
2. **Valid profile attaches without the dialog** — seed the profile for `a1:fix` via `saveSessionProfile` with a fingerprint built from the same attachInfo the mocked `sessionsApi.requestAttach` returns; click the row; assert no `attach-dialog` appears and `sessionIdAtom` becomes `a1:fix` (waitFor).
3. **Stale profile opens the dialog** — seed a profile whose fingerprint does not match the mocked response; click row; assert `attach-dialog` appears and `sessionIdAtom` stays `''`.
4. **Settings opens the dialog in configure mode; Save persists without attaching** — seed a profile; click `session-settings-a1:fix`; assert the dialog shows a `Save` button and no `Attach` button; click Save; assert `sessionIdAtom` stays `''` (no navigation/attach) and the stored profile changed (e.g. mode relay → p2p if the test toggles mode first via the mode buttons; at minimum assert the profile still exists with the same fingerprint).
5. **Restore with a stale profile opens the dialog; cancel returns home** — `renderShell('/terminal/a1:fix')` with a stale seeded profile and `useSessionFirstDeepLink` real; assert the dialog appears; click Cancel; assert the router left `/terminal/a1:fix` (MemoryRouter location via a `LocationProbe` component reading `useLocation()`, or assert `store.get(sessionIdAtom) === ''` plus absence of the restore spinner).
6. **Restore with a valid profile attaches immediately** — same entry, valid profile; waitFor `sessionIdAtom === 'a1:fix'` with no dialog ever appearing.

Mocked `requestAttach` response shared by the profile fixtures:

```ts
const attachInfoResponse = {
  mode: 'p2p' as const,
  session_id: 'a1:fix',
  session_name: 'fix',
  connection_token: 'tok',
  agent_address: 'ws://a/ws',
  addresses: [
    { url: 'ws://a/ws', label: 'lan', network_type: 'lan' as const,
      priority: 0, status: 'reachable' as const },
  ],
};
```

Profile seed helper (imports from `@/services/sessionAttachProfile`):

```ts
function seedProfile(sessionId: string, agentId: string, fingerprint: string) {
  localStorage.setItem('nession_session_attach_profiles', JSON.stringify({
    [sessionId]: {
      schemaVersion: 1, sessionId, agentId,
      choice: { mode: 'auto', renderer: 'canvas', envRefs: [], selectedUrl: null },
      optionsFingerprint: fingerprint, updatedAt: 1,
    },
  }));
}
```

Use `buildOptionsFingerprint(attachInfoResponse)` for the valid fingerprint and `'stale-fp'` for the invalid one. jsdom has no WebGL → `detectWebGLSupport()` is false → stored renderer `'canvas'` keeps validation passing (see Task 2's renderer rule).

- [ ] **Step 1: Create the harness + first-attach test** (tests 1) and watch it fail/settle.

Run: `npx vitest run src/app/__tests__/integration/AttachFlow.test.tsx`
Expected: test 1 passes once the harness compiles (real dialog + persist path already implemented in Tasks 5–6).

- [ ] **Step 2: Add tests 2 and 3 (fast path)** — expected to pass against Task 5 logic; if they fail, the likely culprits are the in-flight guard or `requestAttach` deps — fix the hook, not the test.

- [ ] **Step 3: Add test 4 (configure save)** — expected to pass against Tasks 5–6 wiring.

- [ ] **Step 4: Add tests 5 and 6 (restore branches)** — expected to pass against Task 9.

- [ ] **Step 5: Full app suite**

Run: `npx vitest run src/app/__tests__/integration/AttachFlow.test.tsx src/app/__tests__/integration/SessionFirstShell.test.tsx src/app/__tests__/integration/useDeepLinkRestore.test.ts`
Expected: ALL pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/__tests__/integration/AttachFlow.test.tsx
git commit -m "test(web): end-to-end attach-flow coverage for profiles (#672)"
```

---

### Task 11: Full gates, Playwright verification, screenshots

**Files:**
- None (verification + fixes)

- [ ] **Step 1: Full web suite**

Run: `npm test`
Expected: ALL pass. Fix any fallout (e.g. stale mocks in `SessionFirstShell.test.tsx` from the new hook signature).

- [ ] **Step 2: Coverage**

Run: `npm run coverage`
Expected: thresholds met (lines 78 / functions 72 / statements 76 / branches 65). Add focused tests for any uncovered branch in `sessionAttachProfile.ts` / `deepLinkAttach.ts` / the hook / the dialog.

- [ ] **Step 3: Lint + typecheck + build**

Run: `npm run lint && npx tsc --noEmit && npm run build`
Expected: 0 warnings, 0 errors, build success.

- [ ] **Step 4: Playwright functional verification (mandatory)**

Start the local demo stack (three terminals, isolated HOME — see repo root `CLAUDE.md`):

```bash
HOME=/tmp/nession-demo cargo run -p nession-server      # :19090 ws
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml   # :19091
cd web && npm run dev                                    # :13000
```

Via Playwright MCP at `http://localhost:13000` (login with any non-empty token after `localStorage.clear()`):

1. First attach to a session → `AttachDialog` appears → confirm → terminal opens.
2. Re-select the same session row → attaches immediately, **no dialog** (fast path).
3. Open the row Settings → dialog prefilled with the saved mode → switch mode → Save → confirm no attach/reconnect happened (still attached, no spinner) and the row click now uses the new mode without a dialog.
4. `browser_resize` to 375px → open the drawer → both Settings and Kill icons are visible without hover.
5. `browser_console_messages` clean (no errors).

Collect screenshots (`.playwright-mcp/screenshots/`): settings icon row (desktop), row with drawer at 375px, the configure dialog — for the PR comment.

- [ ] **Step 5: Update the design spec's status line and commit any final fixes**

If verification found spec deviations, update `docs/superpowers/specs/2026-09-09-session-attach-profile-design.md` and commit.

- [ ] **Step 6: Final commit checkpoint**

```bash
git log --oneline origin/main..HEAD   # review the commit trail
git status                            # clean
```

---

## Self-review notes (filled by the plan author)

- Spec §1 (data model/storage) → Task 1; §2 (fingerprint/validate/prefill) → Task 2; §2 decision flow (row + restore) → Tasks 5, 9; §3 (dialog) → Task 6; §4 (row entry + threading) → Tasks 7, 8; §5 (edge cases) → spread across Tasks 1–10; testing matrix → Tasks 1–10 + 11.
- Decision-log items: narrow always-visible icons → Task 7; restore policy → Task 9; services+hooks decision layer → file map.
- Placeholder scan: no TBD/TODO; every step carries code or an exact command. Where a snippet must adapt to a file's existing local fixture names, the step names the fixture to reuse and says so explicitly.
- Type consistency: `PersistedAttachChoice`, `SessionAttachProfile`, `buildOptionsFingerprint`, `candidateUrlsOf`, `sanitizeChoiceForPrefill`, `validateProfile`, `persistConfirmedChoice`, `resolveTargetChoice`, `resolveProfileAttach`, `ProfileAttachResolution`, `attachDialogIntentAtom`/`AttachDialogIntent`, `openAttachSettings`, `saveAttachSettings`, `requestConfigForRestore` are the cross-task API surface — defined once, referenced consistently.
