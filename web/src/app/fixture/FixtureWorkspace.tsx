import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { WorkspaceShell } from '@/app/workspace/WorkspaceShell';
import { fixtureCapabilityFacts } from '@/app/fixture/fixtureCapabilityFacts';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import {
  FIXTURE_AGENTS,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '@/app/fixture/fixtureData';
import { mapDomainState } from '@/product/session/model/domainState';
import type { CapabilityId } from '@/product/capability';
import { gitApi } from '@/capabilities/git';
import { claudeCodeApi } from '@/capabilities/claude-code';
import type { PluginSurface } from '@/platform/socket/types';
import { fixtureFileOps } from './fixtureFileOps';
import { fixtureGitSurface } from './fixtureGit';
import { fixtureConversationSurface } from './fixtureConversation';

// Module-stable — the stub is immutable and stateless, so a single instance
// is safe to share across renders (same pattern as fixtureRoute).
const fixtureOps = fixtureFileOps();

/**
 * Canonical Workspace surface (#561 Phase 2B): the real plugin shell with
 * deterministic files data, no network. Phase 6 baseline source.
 */
export function FixtureWorkspace() {
  // Route parameters express session observations; without them the fixture is
  // exactly the canonical screen the golden screenshots capture.
  const search = useLocation().search;
  const facts = fixtureCapabilityFacts(search);
  const capability = openedCapability(search);
  const surfaceReady = useFixtureSurface(capability, search);
  const selectedSession =
    FIXTURE_SESSIONS.find((s) => s.session_id === FIXTURE_SELECTED_ID) ?? null;
  const selectedAgent = FIXTURE_AGENTS.find(
    (a) => a.agent_id === selectedSession?.agent_id,
  );
  const domain = selectedSession
    ? mapDomainState({
        session: selectedSession,
        agent: selectedAgent,
        staleAgentIds: [],
        clientSessionId: FIXTURE_SELECTED_ID,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;
  if (!surfaceReady) {
    // One frame, and only while the opened capability's stub is being bound.
    return null;
  }

  const ctx: WorkspaceContext = {
    session: selectedSession,
    agent: selectedAgent,
    agents: FIXTURE_AGENTS,
    domain,
    fileOps: fixtureOps,
    experience: 'web',
    facts,
    onToolChange: () => {},
  };
  return (
    <div
      data-testid="shell"
      data-sf-design="polish"
      className="shell flex h-[100dvh] flex-col bg-background"
    >
      <WorkspaceShell ctx={ctx} activeCapabilityId={capability} />
    </div>
  );
}

/** A canned backend, and the singleton it binds to. */
interface FixtureSurface {
  install: (surface: PluginSurface) => () => void;
  surface: (search: string) => PluginSurface;
}

/**
 * The canned backends this route can install, keyed by capability.
 *
 * One table, because the two halves have to agree: `openedCapability` decides
 * what opens, and this decides what can answer for it. A capability in one and
 * not the other is either a view that cannot render or a stub nothing reaches,
 * so there is deliberately no second list to keep in step.
 *
 * A `Map` rather than an object literal: `'toString' in {}` is true, so an
 * object would let `?capability=toString` past the membership test and into a
 * binding that is not there.
 */
const FIXTURE_SURFACES = new Map<string, FixtureSurface>([
  ['git', { install: (s) => gitApi.install(s), surface: fixtureGitSurface }],
  [
    'claude-code',
    {
      install: (s) => claudeCodeApi.install(s),
      surface: fixtureConversationSurface,
    },
  ],
]);

/**
 * Which capability the route opens, defaulting to Files.
 *
 * Derived from `FIXTURE_SURFACES` rather than restated: every other capability
 * keeps the canonical route exactly as the golden screenshots capture it, and
 * opening one with nothing behind it would render a view whose first request
 * fails — a state the product does not have.
 */
function openedCapability(search: string): CapabilityId {
  const requested = new URLSearchParams(search).get('capability') ?? '';
  return FIXTURE_SURFACES.has(requested) ? requested : 'files';
}

/**
 * Stand in for the agent while the route asks for a capability the fixture
 * cannot otherwise reach, and report whether it is in place yet.
 *
 * The gate is not decoration. Effects run bottom-up, so an install in this
 * component's effect would land *after* the view's own effect had already asked
 * into an unbound plugin — the first request would fail and the view would
 * settle on a transport error. Holding the subtree back until the stub is bound
 * closes that window. It costs one frame, and only on a route that asked for a
 * capability in `FIXTURE_SURFACES`: every other route renders immediately.
 *
 * Released on unmount, because the singleton is shared — in the browser the
 * fixture is one route among several, and in tests a leaked binding would
 * answer for whatever ran next.
 */
function useFixtureSurface(capability: CapabilityId, search: string): boolean {
  const binding = FIXTURE_SURFACES.get(capability);
  const [installed, setInstalled] = useState<string | null>(null);

  useEffect(() => {
    if (binding === undefined) {
      setInstalled(null);
      return;
    }
    const release = binding.install(binding.surface(search));
    setInstalled(search);
    return () => {
      release();
      setInstalled(null);
    };
  }, [binding, search]);

  return binding === undefined || installed === search;
}
