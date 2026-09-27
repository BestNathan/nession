import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import type { ClaudeCodeConversationResponse } from '@/capabilities/claude-code';
import type {
  ConversationCandidateV1,
  ConversationItemV1,
} from '@/generated/protocol/claude-code/conversation/v1';
import { FIXTURE_AGENTS } from './fixtureData';

/**
 * A canned Claude Code conversation backend for the fixture route.
 *
 * The fixture is offline, so the capability has nothing to talk to. This stands
 * in for the agent's `claude-code.conversation` answer with deterministic data,
 * which is what lets the route render the conversation view at all — and
 * therefore what lets a golden capture it (#1029, #1128).
 *
 * It exists because the surface #1005 stage D created was in **no** baseline:
 * `openedCapability` could not open this capability and `FIXTURE_MANIFEST` did
 * not advertise this wire, so every state below was unreachable, and #1125 and
 * #1127 both shipped UI carrying a "not visually verified" caveat.
 *
 * What it varies is what the **transcript directory held**, never the
 * component's state: a route cannot ask for "the candidate list" directly, only
 * for a directory that produces one. A fixture that could name a state would
 * let a test assert a rendering the app never decided on.
 *
 * Answers must be shapes the real agent can produce. `has_more`, `partial_tail`
 * and `skipped` are required by the contract, so they are always present rather
 * than omitted where they would default.
 *
 *   /#/fixture/workspace?capability=claude-code                → one resolved conversation
 *   /#/fixture/workspace?capability=claude-code&conversation=ambiguous
 *   /#/fixture/workspace?capability=claude-code&conversation=not_found
 *
 * The last two are answers a user acts on, not failures (#1005 criterion 2).
 */
export function fixtureConversationSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('conversation') ?? 'ready';

  // The real directory is filled by `AgentsPlugin` from the agent list; the
  // fixture has no agent list request, so it fills the same directory from the
  // same `FIXTURE_AGENTS` the rest of the fixture renders. Built with the same
  // `manifestsOf`, so the fixture cannot present a directory the app would not.
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));

  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      if (type === 'claude-code.conversation') {
        return Promise.resolve(
          answerFor(scenario, payload.claude_session_id) as T,
        );
      }
      return Promise.reject(
        new Error(`fixture claude-code surface does not answer ${type}`),
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

/**
 * The directory the fixture pretends the Session is running in.
 *
 * A transcript's recorded `cwd` is its own field, not the directory it was
 * found in — those disagree in practice (#1128's contract notes 10 of 39), so
 * the candidates below each carry the one their transcript recorded.
 */
const FIXTURE_CWD = '/Users/dev/code/nession';

/** The conversation `ready` resolves to, and the one a pick resolves to. */
const OPEN_ID = 'e2e1f4c2-7a30-4b19-9f6c-1d2b3a4c5d6e';

/**
 * The three item kinds, so all three transcript renderings are reachable.
 *
 * The tool item is the one that carries a `<details>` — `#1029` asks for it
 * explicitly, and the same rule `fixtureGit` follows for its statuses: an
 * answer that cannot produce every kind leaves the renderings for those kinds in
 * no image.
 */
const ITEMS: ConversationItemV1[] = [
  {
    id: 'u1',
    kind: 'user',
    timestamp: '2026-08-31T09:12:00.000Z',
    text: 'Why does the capsule lose focus when the accessory yields?',
  },
  {
    id: 'a1',
    kind: 'assistant',
    timestamp: '2026-08-31T09:12:04.000Z',
    text: 'Because the accessory owned focus while it was open, and nothing hands it back on close. The yield has to be explicit.',
  },
  {
    id: 't1',
    kind: 'tool',
    timestamp: '2026-08-31T09:12:06.000Z',
    tool: {
      name: 'Bash',
      summary: 'rg -n "yieldFocus|inputRef" web/src/product/terminal',
      is_error: false,
      truncated: false,
    },
  },
  {
    id: 'a2',
    kind: 'assistant',
    timestamp: '2026-08-31T09:12:11.000Z',
    text: 'Three call sites, and only one of them restores the input afterwards.',
  },
];

/** The conversations the directory holds, in the order the agent would report. */
const CANDIDATES: ConversationCandidateV1[] = [
  {
    claude_session_id: OPEN_ID,
    cwd: FIXTURE_CWD,
    updated_at: '2026-08-31T09:12:11.000Z',
    title: 'Capsule focus after the accessory yields',
  },
  {
    claude_session_id: 'b7c8d9e0-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
    cwd: FIXTURE_CWD,
    updated_at: '2026-08-30T16:40:00.000Z',
    title: 'Session list grouping by recency',
  },
  {
    claude_session_id: 'c1d2e3f4-5a6b-4c7d-9e8f-a0b1c2d3e4f5',
    cwd: '/Users/dev/code/nession-tools',
    updated_at: '2026-08-29T11:05:00.000Z',
    title: 'Protocol gate false positives',
  },
];

/**
 * The candidate with no title.
 *
 * Absent for roughly a fifth of real transcripts (measured: 3 of 14), so the
 * UI's fallback exists — and a fixture that always carried a title would leave
 * that fallback in no image. `claude_session_id` is still the identity, which is
 * why this stays selectable.
 */
const UNTITLED_CANDIDATES: ConversationCandidateV1[] = CANDIDATES.map(
  (candidate) =>
    candidate.claude_session_id === OPEN_ID
      ? {
          claude_session_id: candidate.claude_session_id,
          cwd: candidate.cwd,
          updated_at: candidate.updated_at,
        }
      : candidate,
);

/** Every answer carries these; only `state` and the rest vary. */
const EMPTY = {
  has_more: false,
  partial_tail: false,
  skipped: 0,
  next_cursor: null,
} as const;

/**
 * What the agent answers for a scenario, given what the caller asked to open.
 *
 * A request naming a `claude_session_id` **resolves**, even under `ambiguous`:
 * choosing from the list is the one way a caller selects a conversation, and a
 * fixture that kept answering `ambiguous` would make the pick a dead control —
 * a control that does nothing is a state the product does not have.
 */
function answerFor(
  scenario: string,
  requestedId: unknown,
): ClaudeCodeConversationResponse {
  const requested = typeof requestedId === 'string' ? requestedId : null;
  const picked = CANDIDATES.find(
    (candidate) => candidate.claude_session_id === requested,
  );
  if (picked) {
    return {
      ...EMPTY,
      state: 'ready',
      conversation: {
        claude_session_id: picked.claude_session_id,
        cwd: picked.cwd,
      },
      candidates: CANDIDATES,
      items: ITEMS,
    };
  }

  switch (scenario) {
    case 'ambiguous':
      return { ...EMPTY, state: 'ambiguous', candidates: CANDIDATES, items: [] };
    case 'not_found':
      return { ...EMPTY, state: 'not_found', items: [] };
    case 'unavailable':
      return { ...EMPTY, state: 'unavailable', items: [] };
    case 'untitled':
      return {
        ...EMPTY,
        state: 'ready',
        conversation: { claude_session_id: OPEN_ID, cwd: FIXTURE_CWD },
        candidates: UNTITLED_CANDIDATES,
        items: ITEMS,
      };
    case 'inactive':
      // A real, readable conversation whose Claude has finished (#1005
      // criterion 4) — the same items, and the header says `Finished` rather
      // than `Running now`. That difference is the whole state.
      return {
        ...EMPTY,
        state: 'inactive',
        conversation: { claude_session_id: OPEN_ID, cwd: FIXTURE_CWD },
        candidates: CANDIDATES,
        items: ITEMS,
      };
    default:
      return {
        ...EMPTY,
        state: 'ready',
        conversation: { claude_session_id: OPEN_ID, cwd: FIXTURE_CWD },
        candidates: CANDIDATES,
        items: ITEMS,
      };
  }
}
