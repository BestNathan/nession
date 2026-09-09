import type { AttachMode, EnvFileRef, Session } from '../types';

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
