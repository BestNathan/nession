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
import { claudeCodeApi } from '@/capabilities/claude-code';
import { gitApi } from '@/capabilities/git';
import { fixtureConversationSurface } from './fixtureConversation';
import { fixtureFileOps } from './fixtureFileOps';
import { fixtureGitSurface } from './fixtureGit';

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
  const gitReady = useFixtureSurface(capability === 'git', search, installGitSurface);
  const conversationReady = useFixtureSurface(
    capability === 'claude-code',
    search,
    installConversationSurface,
  );
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
  if (!gitReady || !conversationReady) {
    // One frame, and only while the asked-for route's stub is being bound.
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

/**
 * Which capability the route opens, defaulting to Files.
 *
 * Git and Claude Code have canned backends installed below; every other
 * capability keeps the canonical route exactly as the golden screenshots
 * capture it.
 */
function openedCapability(search: string): CapabilityId {
  const requested = new URLSearchParams(search).get('capability');
  if (requested === 'git') {
    return 'git';
  }
  return requested === 'claude-code' ? 'claude-code' : 'files';
}

/** Bind the Git stub to the shared singleton. */
function installGitSurface(search: string): () => void {
  return gitApi.install(fixtureGitSurface(search));
}

/**
 * Bind the Claude Code conversation stub.
 *
 * This is the route the conversation is reachable from: the App route can open
 * the capability, but Claude Code's *Workspace* is what draws a transcript, and
 * `#/fixture/workspace?capability=claude-code` is how a spec gets there.
 */
function installConversationSurface(search: string): () => void {
  return claudeCodeApi.install(fixtureConversationSurface(search));
}


/**
 * Stand in for the agent while the route asks for a capability the fixture
 * cannot otherwise reach, and report whether it is in place yet.
 *
 * The gate is not decoration. Effects run bottom-up, so an install in this
 * component's effect would land *after* `GitWorkspace`'s own effect had already
 * asked into an unbound plugin — the first request would fail and the view
 * would settle on a transport error. Holding the subtree back until the stub is
 * bound closes that window. It costs one frame, and only on the route that
 * asked for Git: every other route renders immediately.
 *
 * Released on unmount, because the singleton is shared — in the browser the
 * fixture is one route among several, and in tests a leaked binding would
 * answer for whatever ran next.
 *
 * Takes the installer rather than naming a capability, because Git and Claude
 * Code both need this and the reasoning above is subtle enough that a second
 * copy of it would be a second chance to get it wrong. The installer must be
 * stable — module scope, not a closure created per render — or the effect
 * re-runs and rebinds the singleton every time.
 */
function useFixtureSurface(
  needed: boolean,
  search: string,
  install: (search: string) => () => void,
): boolean {
  const key = needed ? search : null;
  const [installed, setInstalled] = useState<string | null>(null);

  useEffect(() => {
    if (key === null) {
      setInstalled(null);
      return;
    }
    const release = install(key);
    setInstalled(key);
    return () => {
      release();
      setInstalled(null);
    };
  }, [key, install]);

  return !needed || installed === key;
}
