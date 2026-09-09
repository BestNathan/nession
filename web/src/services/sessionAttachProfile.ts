import type { AttachInfo, AttachMode, EnvFileRef, Session } from '../types';

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
  if (
    !Array.isArray(choice.envRefs) ||
    !isAttachMode(choice.mode) ||
    !isRenderer(choice.renderer) ||
    (choice.selectedUrl !== null && typeof choice.selectedUrl !== 'string')
  ) {
    return null;
  }
  const envRefs = choice.envRefs.filter(isEnvFileRef);
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
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
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

/** Persist (or refresh) the profile a confirmed choice produced. The choice's
 *  FRESH attachInfo supplies the fingerprint, so the stored fingerprint always
 *  matches what validation will compare against next time. The choice param
 *  stays coupled to the write-side interface via Pick: any value carrying the
 *  four persistable fields (e.g. the dialog's AttachChoice) is accepted. */
export function persistConfirmedChoice(
  session: Pick<Session, 'session_id' | 'agent_id'>,
  choice: Pick<PersistedAttachChoice, 'mode' | 'renderer' | 'envRefs' | 'selectedUrl'>,
  info: AttachInfo,
): void {
  saveSessionProfile(session, choice, buildOptionsFingerprint(info));
}

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
