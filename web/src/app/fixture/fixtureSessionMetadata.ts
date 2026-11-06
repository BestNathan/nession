import { useEffect, useMemo } from 'react';
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
 *
 * `legacy` is the default the canonical routes already render: the fixture's
 * Session rows keep their tmux names, so existing goldens do not move.
 */
export type FixtureSessionMetadataScenario = 'normal' | 'legacy' | 'offline' | 'conflict';

export function fixtureSessionMetadataScenario(search: string): FixtureSessionMetadataScenario {
  const requested = new URLSearchParams(search).get('sessionMetadata');
  if (requested === 'normal' || requested === 'offline' || requested === 'conflict') {
    return requested;
  }
  return 'legacy';
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

export function fixtureSessionMetadataSurface(search: string): PluginSurface {
  const scenario = fixtureSessionMetadataScenario(search);
  const store = new Map<string, SessionMetadata>(
    scenario === 'legacy' ? [] : Object.entries(SEED),
  );
  // The conflict route changes the store once, standing in for the other
  // client's save that happens between this client's read and its write.
  let conflictEscalated = false;

  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));

  const current = (sessionId: string): SessionMetadata =>
    store.get(sessionId) ?? emptyMetadata();

  function read(sessionId: unknown): SessionMetadataResponse {
    if (scenario === 'offline') {
      return failure('unavailable', 'Agent is offline');
    }
    return { success: true, metadata: current(String(sessionId)) };
  }

  function update(payload: Record<string, unknown>): SessionMetadataResponse {
    if (scenario === 'offline') {
      return failure('unavailable', 'Agent is offline');
    }
    const sessionId = String(payload.session_id);
    const expectedRevision = Number(payload.expected_revision ?? 0);
    const metadata = current(sessionId);

    if (scenario === 'conflict' && !conflictEscalated) {
      conflictEscalated = true;
      store.set(sessionId, REMOTE_CONFLICT);
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
    store.set(sessionId, next);
    return { success: true, metadata: next };
  }

  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      if (type === 'server.session.metadata.get') {
        return Promise.resolve(read(payload.session_id) as T);
      }
      if (type === 'server.session.metadata.update') {
        return Promise.resolve(update(payload) as T);
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

/** Bind the stub for a fixture route's lifetime, one surface per scenario. */
export function useFixtureSessionMetadata(search: string): void {
  const surface = useMemo(() => fixtureSessionMetadataSurface(search), [search]);
  useEffect(() => sessionsApi.install(surface), [surface]);
}
