import { useEffect, useMemo, useRef } from 'react';
import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import { sessionsApi } from '@/product/session';
import type { PluginSurface } from '@/platform/socket/types';
import type {
  SessionMetadata,
  SessionMetadataResponse,
} from '@/product/session/types';
import {
  normalizeSessionMetadataDraft,
  validateSessionMetadataDraft,
} from '@/product/session/model/sessionMetadata';
import { loadSessionMetadata } from '@/product/session/state/metadata';
import { FIXTURE_AGENTS, FIXTURE_SELECTED_ID } from './fixtureData';

/**
 * A canned Agent-owned metadata store for the fixture routes (#2789).
 *
 * The fixture is offline, so nothing answers `server.session.metadata.*`
 * unless this stands in for the Agent's store. It answers only what the real
 * Agent can answer: absent metadata is revision 0, a save is revision-guarded,
 * invalid values are refused, and a stale revision is a conflict that leaves
 * the stored metadata intact.
 *
 * The scenario is a route input, never a rendering:
 *
 *   absent / ?sessionMetadata=legacy   → every Session is a legacy revision 0
 *   ?sessionMetadata=normal            → two Sessions carry work context
 *   ?sessionMetadata=offline           → the Agent does not answer
 *   ?sessionMetadata=conflict          → another client saves between the
 *                                        client's read and its save
 *   ?sessionMetadata=ownership-save    → A's save is held until the Case
 *                                        releases it (#2970)
 *   ?sessionMetadata=ownership-reload  → A's save conflicts, and the forced
 *                                        read is held until the Case releases it
 *   ?sessionMetadata=late-read         → a forced read is held while a normal
 *                                        save succeeds, then released with its
 *                                        pre-save answer (#3319)
 *
 * `legacy` is the default the canonical routes already render: the fixture's
 * Session rows keep their tmux names, so existing goldens do not move.
 *
 * The controlled scenarios also publish a real in-place Session switch (two
 * Sessions on the same Agent) and deferred transport controls on the browser
 * window, so a Case can settle A's answer after moving the Workspace to B.
 * The switch replaces the selected Session without remounting the capability
 * view, which is the render condition the editor's ownership rule exists for.
 */
export type FixtureSessionMetadataScenario =
  | 'normal'
  | 'legacy'
  | 'offline'
  | 'conflict'
  | 'ownership-save'
  | 'ownership-reload'
  | 'late-read';

export function isFixtureControlledScenario(
  scenario: FixtureSessionMetadataScenario,
): boolean {
  return (
    scenario === 'ownership-save' ||
    scenario === 'ownership-reload' ||
    scenario === 'late-read'
  );
}

export function fixtureSessionMetadataScenario(search: string): FixtureSessionMetadataScenario {
  const requested = new URLSearchParams(search).get('sessionMetadata');
  if (
    requested === 'normal' ||
    requested === 'offline' ||
    requested === 'conflict' ||
    requested === 'ownership-save' ||
    requested === 'ownership-reload' ||
    requested === 'late-read'
  ) {
    return requested;
  }
  return 'legacy';
}

function fixtureAttachScenario(search: string): 'normal' | 'long' | 'relay' | 'offline' {
  const requested = new URLSearchParams(search).get('attach');
  if (requested === 'long' || requested === 'relay' || requested === 'offline') {
    return requested;
  }
  return 'normal';
}

const FIXTURE_LONG_ADDRESS =
  'wss://gateway-01.example.test:8443/nession/connection/candidate/sessions/dev-session/long-readable-address/endpoint';

/** The deterministic attach reply a fixture Case renders (#3089). */
function fixtureAttachInfo(
  state: FixtureSessionMetadataTransport,
  payload: Record<string, unknown>,
): unknown {
  if (state.attachScenario === 'offline') {
    throw new Error('Agent is offline');
  }
  const sessionId = String(payload.session_id ?? 'agent:session');
  const sessionName = sessionId.split(':').slice(1).join(':') || sessionId;
  const relay = state.attachScenario === 'relay';
  const long = state.attachScenario === 'long';
  return {
    mode: relay ? 'relay' : 'p2p',
    session_id: sessionId,
    session_name: sessionName,
    connection_token: relay ? undefined : 'fixture-attach-token',
    terminal_cols: 96,
    addresses: [
      {
        url: long
          ? FIXTURE_LONG_ADDRESS
          : 'wss://agent.example.test:8443/ws/session',
        label: 'Direct / private network',
        network_type: 'lan',
        priority: 0,
        status: relay ? 'reachable' : 'unknown',
        rtt_ms: relay ? 12 : undefined,
      },
      {
        url: 'wss://relay.example.test/attach',
        label: 'Relay endpoint',
        network_type: 'tunnel',
        priority: 1,
        status: relay ? 'unreachable' : 'unknown',
        rtt_ms: relay ? 48 : undefined,
      },
    ],
  };
}

function emptyMetadata(): SessionMetadata {
  return {
    revision: 0,
    title: null,
    description: null,
    tags: [],
    created_at: null,
    updated_at: null,
  };
}

/** Deterministic timestamps: goldens stay comparable across runs. */
const CREATED_AT = 1762300000;
const UPDATED_AT = 1762303600;

const SEED: Record<string, SessionMetadata> = {
  [FIXTURE_SELECTED_ID]: {
    revision: 4,
    title: 'Terminal reconnect reliability',
    description:
      'Fix cross-device Terminal display drift after reconnect and verify tmux control-mode recovery.',
    tags: ['nession', 'terminal', 'bugfix'],
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  },
  'devbox-01:design-system': {
    revision: 1,
    title: 'Design system audit',
    description: null,
    tags: ['design'],
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  },
  // A Session whose metadata exists but has no title: the row must still fall
  // back to the tmux name without losing its description or tags.
  'macbook:review-pr-561': {
    revision: 1,
    title: null,
    description: 'Review the Session attach changes.',
    tags: [],
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  },
};

/** The "another client saved" answer the conflict route reveals. */
const REMOTE_CONFLICT: SessionMetadata = {
  revision: 5,
  title: 'Terminal reconnect — updated elsewhere',
  description: 'Another device just updated this work context.',
  tags: ['nession', 'terminal'],
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
};

function failure(kind: string, message: string): SessionMetadataResponse {
  return { success: false, error: message, error_kind: kind, metadata: null };
}

/** The two Sessions the ownership route can move between, in place. */
export const FIXTURE_OWNERSHIP_SESSION_A = FIXTURE_SELECTED_ID;
export const FIXTURE_OWNERSHIP_SESSION_B = 'devbox-01:design-system';

let ownershipSessionId: string = FIXTURE_OWNERSHIP_SESSION_A;
const ownershipListeners = new Set<() => void>();

export function fixtureOwnershipSessionId(): string {
  return ownershipSessionId;
}

export function subscribeFixtureOwnershipSession(listener: () => void): () => void {
  ownershipListeners.add(listener);
  return () => {
    ownershipListeners.delete(listener);
  };
}

/**
 * Move the fixture Workspace to the other Session, as the product's Workspace
 * move does — `SessionDetails` (and its metadata editor) observes a changed
 * `session` without remounting.
 */
export function selectFixtureOwnershipSession(sessionId: string): void {
  if (
    sessionId === ownershipSessionId ||
    (sessionId !== FIXTURE_OWNERSHIP_SESSION_A &&
      sessionId !== FIXTURE_OWNERSHIP_SESSION_B)
  ) {
    return;
  }
  ownershipSessionId = sessionId;
  for (const listener of [...ownershipListeners]) {
    listener();
  }
}

function resetFixtureOwnershipSession(): void {
  if (ownershipSessionId === FIXTURE_OWNERSHIP_SESSION_A) {
    return;
  }
  ownershipSessionId = FIXTURE_OWNERSHIP_SESSION_A;
  for (const listener of [...ownershipListeners]) {
    listener();
  }
}

/** Browser-window controls the #2970 Cases drive the deferred transport with. */
export interface FixtureSessionMetadataControls {
  select(sessionId: string): void;
  selected(): string;
  /** Hold the next `metadata.get` answer until `releaseRead()`. */
  holdNextRead(): void;
  releaseRead(): void;
  releaseSave(): void;
  /**
   * Force-read one Session, as the reconnect-triggered refresh does (#3319).
   * The read is the production owner's; the Case awaits `heldRead()` rather
   * than the promise because the answer may be intentionally held.
   */
  read(sessionId: string): void;
  /** How many `metadata.update` requests this surface was asked for. */
  saves(): number;
  heldRead(): boolean;
}

export interface FixtureSessionMetadataWindow {
  fixtureSessionMetadata?: FixtureSessionMetadataControls;
  fixtureSessionProject?: FixtureSessionProjectControls;
}

/** Browser-window controls for the explicit Session→Project wire (#3082). */
export interface FixtureSessionProjectControls {
  bindings(): Record<string, string | null>;
  setRequests(): { session_id: string; project_id: string | null }[];
}

interface FixtureSessionMetadataTransport {
  scenario: FixtureSessionMetadataScenario;
  /** The attach-info answer a #3089 presentation Case reads. */
  attachScenario: 'normal' | 'long' | 'relay' | 'offline';
  /** A controlled scenario with deferred answers and in-place selection. */
  controlled: boolean;
  store: Map<string, SessionMetadata>;
  conflictEscalated: boolean;
  saveCount: number;
  releaseHeldSave: (() => void) | null;
  holdRead: boolean;
  releaseHeldRead: (() => void) | null;
  readHeld: boolean;
  bindings: Map<string, string | null>;
  projectSetRequests: { session_id: string; project_id: string | null }[];
  onProjectSet?: (sessionId: string, projectId: string | null) => void;
}

function currentMetadata(
  state: FixtureSessionMetadataTransport,
  sessionId: string,
): SessionMetadata {
  return state.store.get(sessionId) ?? emptyMetadata();
}

function readMetadata(
  state: FixtureSessionMetadataTransport,
  sessionId: unknown,
): SessionMetadataResponse | Promise<SessionMetadataResponse> {
  if (state.scenario === 'offline') {
    return failure('unavailable', 'Agent is offline');
  }
  const answer: SessionMetadataResponse = {
    success: true,
    metadata: currentMetadata(state, String(sessionId)),
  };
  if (!state.controlled || !state.holdRead) {
    return answer;
  }
  // The answer is captured now and delivered after the Case moves to B.
  // This is the in-flight forced read SC-02 fences, not a rendering.
  state.holdRead = false;
  state.readHeld = true;
  return new Promise((resolve) => {
    state.releaseHeldRead = () => {
      state.readHeld = false;
      resolve(answer);
    };
  });
}

function normalUpdate(
  state: FixtureSessionMetadataTransport,
  payload: Record<string, unknown>,
): SessionMetadataResponse {
  const sessionId = String(payload.session_id);
  const expectedRevision = Number(payload.expected_revision ?? 0);
  const metadata = currentMetadata(state, sessionId);

  if (state.scenario === 'conflict' && !state.conflictEscalated) {
    state.conflictEscalated = true;
    state.store.set(sessionId, REMOTE_CONFLICT);
    return failure(
      'conflict',
      `expected revision ${expectedRevision}, current revision ${REMOTE_CONFLICT.revision}`,
    );
  }
  if (metadata.revision !== expectedRevision) {
    return failure(
      'conflict',
      `expected revision ${expectedRevision}, current revision ${metadata.revision}`,
    );
  }

  const title = typeof payload.title === 'string' ? payload.title : '';
  const description = typeof payload.description === 'string' ? payload.description : '';
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const normalized = normalizeSessionMetadataDraft({ title, description, tags });
  const invalid = validateSessionMetadataDraft({
    title: title,
    description: description,
    tags: normalized.tags,
  });
  if (invalid !== null) {
    return failure('invalid', invalid);
  }

  const next: SessionMetadata = {
    revision: metadata.revision + 1,
    title: normalized.title,
    description: normalized.description,
    tags: normalized.tags,
    created_at: metadata.created_at ?? CREATED_AT,
    updated_at: UPDATED_AT,
  };
  state.store.set(sessionId, next);
  return { success: true, metadata: next };
}

function updateMetadata(
  state: FixtureSessionMetadataTransport,
  payload: Record<string, unknown>,
): SessionMetadataResponse | Promise<SessionMetadataResponse> {
  if (state.scenario === 'offline') {
    return failure('unavailable', 'Agent is offline');
  }
  if (state.scenario === 'ownership-reload') {
    // The forced-read Case needs a conflict before its held reload. The
    // remote keeps winning on later writes too, so the same-Session
    // negative control can be exercised on the `conflict` route without
    // depending on this route's store state.
    state.saveCount += 1;
    const sessionId = String(payload.session_id);
    const expectedRevision = Number(payload.expected_revision ?? 0);
    if (!state.conflictEscalated) {
      state.conflictEscalated = true;
      state.store.set(sessionId, REMOTE_CONFLICT);
    }
    return failure(
      'conflict',
      `expected revision ${expectedRevision}, current revision ${REMOTE_CONFLICT.revision}`,
    );
  }
  const answer = normalUpdate(state, payload);
  if (state.scenario !== 'ownership-save') {
    return answer;
  }
  // The save is applied now and its answer delivered after the Case moves
  // to B. This is the in-flight save SC-01 fences.
  state.saveCount += 1;
  return new Promise((resolve) => {
    state.releaseHeldSave = () => resolve(answer);
  });
}

function createMetadataSurface(state: FixtureSessionMetadataTransport): PluginSurface {
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));
  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      if (type === 'server.session.metadata.get') {
        return Promise.resolve(readMetadata(state, payload.session_id)) as Promise<T>;
      }
      if (type === 'server.session.metadata.update') {
        return Promise.resolve(updateMetadata(state, payload)) as Promise<T>;
      }
      if (type === 'server.session.project.set') {
        const sessionId = String(payload.session_id ?? '');
        const projectId =
          typeof payload.project_id === 'string' ? payload.project_id : null;
        state.bindings.set(sessionId, projectId);
        state.projectSetRequests.push({ session_id: sessionId, project_id: projectId });
        state.onProjectSet?.(sessionId, projectId);
        return Promise.resolve({
          success: true,
          project_id: projectId,
          revision: projectId === null ? 0 : 1,
        }) as Promise<T>;
      }
      if (type === 'server.session.attach') {
        try {
          return Promise.resolve(fixtureAttachInfo(state, payload)) as Promise<T>;
        } catch (error) {
          return Promise.reject(error) as Promise<T>;
        }
      }
      return Promise.reject(
        new Error(`fixture session metadata surface does not answer ${type}`),
      );
    },
    send(): void {},
    subscribe(): () => void {
      return () => {};
    },
    onBinary(): () => void {
      return () => {};
    },
    waitForConnection(): Promise<void> {
      return Promise.resolve();
    },
    onConnectionStateChange(): () => void {
      return () => {};
    },
  };
}

function createMetadataControls(
  state: FixtureSessionMetadataTransport,
): FixtureSessionMetadataControls | null {
  if (!state.controlled) {
    return null;
  }
  return {
    select: selectFixtureOwnershipSession,
    selected: fixtureOwnershipSessionId,
    holdNextRead: () => {
      state.holdRead = true;
    },
    releaseRead: () => {
      state.releaseHeldRead?.();
      state.releaseHeldRead = null;
    },
    read: (sessionId) => {
      void loadSessionMetadata(sessionId, { force: true });
    },
    releaseSave: () => {
      state.releaseHeldSave?.();
      state.releaseHeldSave = null;
    },
    saves: () => state.saveCount,
    heldRead: () => state.readHeld,
  };
}

export function createFixtureSessionMetadataHarness(
  search: string,
  options: {
    initialBindings?: Record<string, string | null>;
    onProjectSet?: (sessionId: string, projectId: string | null) => void;
  } = {},
): {
  surface: PluginSurface;
  controls: FixtureSessionMetadataControls | null;
  projectControls: FixtureSessionProjectControls;
} {
  const scenario = fixtureSessionMetadataScenario(search);
  const state: FixtureSessionMetadataTransport = {
    scenario,
    attachScenario: fixtureAttachScenario(search),
    controlled: isFixtureControlledScenario(scenario),
    store: new Map(scenario === 'legacy' ? [] : Object.entries(SEED)),
    // The conflict route changes the store once, standing in for the other
    // client's save that happens between this client's read and its write.
    conflictEscalated: false,
    // A controlled route holds exactly the answer a Case asks it to hold.
    saveCount: 0,
    releaseHeldSave: null,
    holdRead: false,
    releaseHeldRead: null,
    readHeld: false,
    bindings: new Map(Object.entries(options.initialBindings ?? {})),
    projectSetRequests: [],
    onProjectSet: options.onProjectSet,
  };
  return {
    surface: createMetadataSurface(state),
    controls: createMetadataControls(state),
    projectControls: {
      bindings: () => Object.fromEntries(state.bindings),
      setRequests: () => state.projectSetRequests.map((request) => ({ ...request })),
    },
  };
}

/**
 * The Agent-process surface delegates its metadata wires to this; it needs no
 * browser controls, only the answers.
 */
export function fixtureSessionMetadataSurface(search: string): PluginSurface {
  return createFixtureSessionMetadataHarness(search).surface;
}

/**
 * Bind the stub for a fixture route's lifetime, one surface per scenario.
 *
 * The Project wire lives on this surface too (#3082): a second
 * `sessionsApi.install` would replace this one, and each surface would reject
 * the other's wires.
 */
export function useFixtureSessionMetadata(
  search: string,
  options: {
    initialBindings?: Record<string, string | null>;
    onProjectSet?: (sessionId: string, projectId: string | null) => void;
  } = {},
): void {
  const onProjectSet = options.onProjectSet;
  const onProjectSetRef = useRef(onProjectSet);
  onProjectSetRef.current = onProjectSet;
  const initialBindings = JSON.stringify(options.initialBindings ?? {});
  const harness = useMemo(
    () =>
      createFixtureSessionMetadataHarness(search, {
        initialBindings: JSON.parse(initialBindings) as Record<string, string | null>,
        onProjectSet: (sessionId, projectId) =>
          onProjectSetRef.current?.(sessionId, projectId),
      }),
    [search, initialBindings],
  );
  useEffect(() => {
    if (harness.controls) {
      resetFixtureOwnershipSession();
      (window as FixtureSessionMetadataWindow).fixtureSessionMetadata = harness.controls;
    }
    (window as FixtureSessionMetadataWindow).fixtureSessionProject =
      harness.projectControls;
    const release = sessionsApi.install(harness.surface);
    return () => {
      release();
      const windowWithControls = window as FixtureSessionMetadataWindow;
      if (harness.controls) {
        if (windowWithControls.fixtureSessionMetadata === harness.controls) {
          delete windowWithControls.fixtureSessionMetadata;
        }
        resetFixtureOwnershipSession();
      }
      if (windowWithControls.fixtureSessionProject === harness.projectControls) {
        delete windowWithControls.fixtureSessionProject;
      }
    };
  }, [harness]);
}
