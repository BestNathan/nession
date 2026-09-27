import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import { PROTOCOL, type ConversationResponse } from '@/generated/protocol/claude-code/conversation/v1';
import { FIXTURE_AGENTS } from './fixtureData';

/**
 * The conversation half of the fixture's Claude Code capability (#1128).
 *
 * It exists because the manifest advertised `claude-code.list` and
 * `claude-code.read` and nothing else, so **no fixture state could render a
 * conversation at all** — and therefore none of the conversation UI could
 * appear in a golden. Three PRs of #1120 shipped in that blind spot before
 * this.
 *
 * This is the other half of the same rule `#1108` taught: a wire lives in two
 * places — the manifest agents advertise and the surface that answers it — and
 * updating one without the other leaves a route that looks wired and answers
 * nothing. `fixtureConversation.test.ts` asserts the pairing.
 *
 * ## Scenarios are route parameters, like the git surface's
 *
 * `?conversation=` names the *input* (which state the provider is in), never
 * the resolved screen — the same rule `fixtureCapabilityFacts` states. The
 * default is the richest state so a case that wants to photograph something
 * has to say which something, rather than getting whichever scenario was
 * convenient for the last author.
 */

/** A conversation the fixture pretends the Session is bound to. */
const BOUND_ID = 'c0a1b2c3-1111-4222-8333-444455556666';

/**
 * The candidates, deliberately not all the same shape.
 *
 * One carries a title (the common case), one carries none (measured: 3 of 14
 * real transcripts) so the client's own fallback is reachable, and one is older
 * so the list has an order to show rather than a single row.
 */
const CANDIDATES = [
  {
    claude_session_id: BOUND_ID,
    cwd: '/Users/dev/code/nession-capsule',
    updated_at: '2026-09-01T11:40:00Z',
    title: 'Terminal ownership handoff',
  },
  {
    claude_session_id: 'd4e5f6a7-2222-4333-8444-555566667777',
    cwd: '/Users/dev/code/nession-capsule',
    updated_at: '2026-09-01T09:05:00Z',
    // No title on purpose — the fallback is a real path, not a defensive one.
  },
  {
    claude_session_id: 'e8f9a0b1-3333-4444-8555-666677778888',
    cwd: '/Users/dev/code/nession-capsule',
    updated_at: '2026-08-29T08:15:00Z',
    title: 'Capsule radius review',
  },
];

/**
 * One page of transcript, covering the three kinds it has to be able to draw.
 *
 * `tool` appears twice with opposite `is_error`, because the transcript renders
 * those differently and a fixture that only ever produced successes would make
 * the failure treatment unreachable from every golden — the same argument the
 * git fixture makes for its statuses.
 */
const ITEMS = [
  {
    id: 'i1',
    kind: 'user' as const,
    timestamp: '2026-09-01T11:30:00Z',
    text: 'Where is the ownership handoff today, and what breaks when two clients attach?',
  },
  {
    id: 'i2',
    kind: 'tool' as const,
    timestamp: '2026-09-01T11:31:00Z',
    tool: { name: 'Read', summary: 'web/src/product/terminal/capsule/PeekHost.tsx', is_error: false, truncated: false },
  },
  {
    id: 'i3',
    kind: 'assistant' as const,
    timestamp: '2026-09-01T11:32:00Z',
    text: 'The controller is whoever attached last, and nothing arbitrates it. Two clients attaching to the same Session therefore both believe they own the keyboard, and the pane receives whichever keystroke arrives first.',
  },
  {
    id: 'i4',
    kind: 'tool' as const,
    timestamp: '2026-09-01T11:33:00Z',
    tool: { name: 'Bash', summary: 'cargo test -p nession-agent -- ownership', is_error: true, truncated: false },
  },
  {
    id: 'i5',
    kind: 'assistant' as const,
    timestamp: '2026-09-01T11:34:00Z',
    text: 'The observer path is the one with no test — that is where the regression would sit.',
  },
];

/**
 * What the provider answers for a named scenario.
 *
 * `undefined` for a scenario this fixture does not model, so the surface below
 * rejects loudly rather than answering something plausible: a fixture that
 * guessed would let a case assert on a state the product cannot produce.
 */
function responseFor(scenario: string): ConversationResponse | undefined {
  switch (scenario) {
    case 'ready':
      return {
        state: 'ready',
        conversation: { claude_session_id: BOUND_ID, cwd: '/Users/dev/code/nession-capsule' },
        candidates: CANDIDATES,
        items: ITEMS,
        has_more: false,
        partial_tail: false,
        skipped: 0,
      };
    case 'ambiguous':
      // No binding: several conversations at this cwd and no answer about
      // which is the Session's. `#1005` forbids choosing one.
      return {
        state: 'ambiguous',
        conversation: null,
        candidates: CANDIDATES,
        items: [],
        has_more: false,
        partial_tail: false,
        skipped: 0,
      };
    case 'none':
      return {
        state: 'not_found',
        conversation: null,
        candidates: [],
        items: [],
        has_more: false,
        partial_tail: false,
        skipped: 0,
      };
    default:
      return undefined;
  }
}

/**
 * The fixture's Claude Code conversation surface.
 *
 * `search` is the route's query string, so a route parameter names the input the
 * provider is in rather than the screen it draws.
 */
export function fixtureConversationSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('conversation') ?? 'ready';

  // The same directory the git surface publishes, built from the same
  // `manifestsOf`, so this route cannot present a capability directory the app
  // would not — resolution happens against it before a request is sent.
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));

  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      // The id is the contract's, not a literal: a renamed wire would then fail
      // here rather than silently answering nothing.
      if (type === PROTOCOL) {
        const response = responseFor(scenario);
        if (response === undefined) {
          return Promise.reject(
            new Error(`fixture conversation surface does not model ?conversation=${scenario}`),
          );
        }
        void payload;
        return Promise.resolve(response as T);
      }
      return Promise.reject(new Error(`fixture conversation surface does not answer ${type}`));
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
