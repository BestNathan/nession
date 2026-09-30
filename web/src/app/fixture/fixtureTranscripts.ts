import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import {
  PROTOCOL,
  type TranscriptItemV1,
  type TranscriptsResponse,
} from '@/generated/protocol/claude-code/transcripts/v1';
import {
  PROTOCOL as TRANSCRIPT_ITEMS_PROTOCOL,
  type TranscriptEntryV1,
  type TranscriptItemsResponse,
} from '@/generated/protocol/claude-code/transcript-items/v1';
import { FIXTURE_AGENTS } from './fixtureData';

/**
 * The transcript half of the fixture's Claude Code capability (#1234).
 *
 * **Separate from `fixtureConversation`, and it has to be.** The two units
 * answer different shapes, so a transcript view rendered against the
 * conversation's data would never exercise the cases that distinguish it:
 * reasoning (which the conversation hides entirely), attachment bodies, the
 * explicit `unknown` kind, session-state metadata, and sidecar transcripts that
 * carry a `parent_id`. A fixture that only ever produces `message` and `tool`
 * would let the whole timeline render as a conversation and pass.
 *
 * ## Scenarios are route parameters
 *
 * `?transcripts=` names the *input* — which state the provider is in — never the
 * resolved screen, the same rule the conversation and git surfaces follow. The
 * default is the richest state, so a case that wants to photograph something
 * has to say which something.
 *
 * ## The manifest is the other half
 *
 * `FIXTURE_MANIFEST` advertises these two units. Nothing here would be reachable
 * without that: `addressed()` resolves against the manifest before a request is
 * sent, so an unadvertised unit throws before this surface is ever consulted —
 * a route that looks wired and answers nothing. `fixtureTranscripts.test.ts`
 * asserts the pairing, as `fixtureConversation.test.ts` does for its two.
 */

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';

/** The session's own transcript, plus the subagents it spawned. */
function transcriptItemsForScenario(scenario: string): TranscriptsResponse | undefined {
  const primary: TranscriptItemV1 = {
    id: SESSION,
    cwd: '/work/nession',
    kind: 'primary',
    title: 'Transcript execution view',
    preview: 'add the transcripts tab',
    created_at: '2026-09-30T09:00:00Z',
    updated_at: '2026-09-30T09:31:12Z',
  };
  const sidechain: TranscriptItemV1 = {
    id: `${SESSION}/agent-a11ce`,
    cwd: '/work/nession/web',
    kind: 'sidechain',
    parent_id: SESSION,
    agent_id: 'agent-a11ce',
    preview: 'explore the generated bindings',
    created_at: '2026-09-30T09:04:00Z',
    updated_at: '2026-09-30T09:06:40Z',
  };

  switch (scenario) {
    case 'ready':
      return {
        state: 'ready',
        cwd: '/work/nession',
        items: [sidechain, primary],
        binding: { transcript_id: SESSION, activity: 'active' },
        has_more: false,
      };
    case 'unbound':
      // No exact binding: the list is still the answer, exactly as it is for
      // conversations. A subagent is listed and not bound to anything.
      return { state: 'ready', cwd: '/work/nession', items: [sidechain, primary], has_more: false };
    case 'none':
      // A successful answer with nothing in it — not a failure state.
      return { state: 'ready', cwd: '/work/nession', items: [], has_more: false };
    case 'unavailable':
      // The host cannot establish the cwd, so it cannot say what is visible.
      // Distinct from `none`: nothing is claimed about the directory.
      return { state: 'unavailable', has_more: false };
    default:
      return undefined;
  }
}

/**
 * A timeline containing every broad kind, on purpose.
 *
 * The point of a *transcript* fixture rather than a conversation one: the
 * conversation projection hides reasoning, attachments, events, metadata and
 * unknown records entirely, so a fixture that produced only messages and tools
 * would let the whole timeline render as a conversation and still pass.
 */
function timelineItems(): TranscriptEntryV1[] {
  return [
    {
      kind: 'message',
      id: 'm1',
      timestamp: '2026-09-30T09:00:01Z',
      source: 'human',
      content: [{ type: 'text', text: 'Give the session a transcript view.' }],
    },
    {
      kind: 'message',
      id: 'm2',
      timestamp: '2026-09-30T09:00:02Z',
      source: 'synthetic',
      content: [
        {
          type: 'text',
          text: 'Caveat: the messages below were generated while running local commands',
        },
      ],
    },
    {
      kind: 'reasoning',
      id: 'r1',
      timestamp: '2026-09-30T09:00:03Z',
      reasoning_type: 'thinking',
      text: {
        text: 'The conversation projection hides this; the transcript draws it. Same page, opposite policy.',
        kind: 'text',
        truncated: false,
      },
    },
    {
      kind: 'tool',
      id: 't1',
      timestamp: '2026-09-30T09:00:04Z',
      tool: {
        call_id: 'call-1',
        name: 'Bash',
        status: 'success',
        summary: 'cargo test -p nession-claude-code',
        input: { text: '{\n  "command": "cargo test"\n}', kind: 'json', truncated: false },
        output: { text: 'test result: ok. 229 passed; 0 failed', kind: 'text', truncated: false },
      },
    },
    {
      kind: 'attachment',
      id: 'a1',
      timestamp: '2026-09-30T09:00:05Z',
      attachment_type: 'file',
      payload: { text: 'src/transcript.rs', kind: 'text', truncated: false },
    },
    {
      kind: 'event',
      id: 'e1',
      timestamp: '2026-09-30T09:00:06Z',
      category: 'checkpoint',
      name: 'file-history-snapshot',
    },
    {
      kind: 'metadata',
      id: 'd1',
      timestamp: '2026-09-30T09:00:07Z',
      name: 'ai-title',
    },
    {
      kind: 'unknown',
      id: 'u1',
      timestamp: '2026-09-30T09:00:08Z',
      upstream_type: 'quantum-entanglement-state',
    },
    {
      kind: 'tool',
      id: 't2',
      timestamp: '2026-09-30T09:00:09Z',
      tool: {
        call_id: 'call-2',
        name: 'SomeFutureTool',
        status: 'running',
        summary: 'alpha, beta',
      },
    },
    {
      kind: 'attachment',
      id: 'a2',
      timestamp: '2026-09-30T09:00:10Z',
      attachment_type: 'hook_success',
      // Cut and marked, which is what the wire does with the measured 1.2 MB
      // tail — a fixture that only ever showed whole bodies would let a client
      // forget the flag exists.
      payload: { text: 'hook output…', kind: 'text', truncated: true },
    },
  ];
}

function timelineForScenario(
  scenario: string,
  transcriptId: string,
): TranscriptItemsResponse | undefined {
  const unknownTranscript: TranscriptItemsResponse = {
    state: 'not_found',
    items: [],
    has_more: false,
    partial_tail: false,
  };

  if (scenario === 'unavailable') {
    return {
      state: 'unavailable',
      items: [],
      has_more: false,
      partial_tail: false,
    };
  }

  const transcript: TranscriptItemV1 =
    transcriptId === SESSION
      ? {
          id: SESSION,
          cwd: '/work/nession',
          kind: 'primary',
          title: 'Transcript execution view',
          updated_at: '2026-09-30T09:31:12Z',
        }
      : {
          id: transcriptId,
          cwd: '/work/nession/web',
          kind: 'sidechain',
          parent_id: SESSION,
          agent_id: transcriptId.split('/')[1] ?? 'agent',
          updated_at: '2026-09-30T09:06:40Z',
        };

  // A transcript that is not one of the two the fixture models answers
  // `not_found` and names no substitute — the ban the contract is explicit
  // about, and the one thing this surface must not paper over.
  if (transcriptId !== SESSION && !transcriptId.startsWith(`${SESSION}/`)) {
    return unknownTranscript;
  }

  const items = timelineItems();

  if (scenario === 'partial') {
    return {
      state: 'ready',
      transcript,
      activity: 'active',
      items: items.slice(0, 4),
      has_more: false,
      partial_tail: true,
      stats: {
        raw_records: 9,
        recognized_records: 7,
        metadata_absorbed: 1,
        unknown_records: 1,
        invalid_records: 0,
      },
    };
  }

  return {
    state: 'ready',
    transcript,
    activity: 'active',
    items,
    has_more: false,
    partial_tail: false,
    stats: {
      raw_records: 11,
      recognized_records: 9,
      metadata_absorbed: 1,
      unknown_records: 1,
      invalid_records: 0,
    },
  };
}

/**
 * The fixture's Claude Code transcript surface.
 *
 * `search` is the route's query string, so a route parameter names the input the
 * provider is in rather than the screen it draws.
 */
export function fixtureTranscriptsSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('transcripts') ?? 'ready';

  // The same directory the conversation and git surfaces publish, built from the
  // same `manifestsOf`, so this route cannot present a capability directory the
  // app would not — resolution happens against it before a request is sent.
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));

  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      if (type === PROTOCOL) {
        const response = transcriptItemsForScenario(scenario);
        if (response === undefined) {
          return Promise.reject(
            new Error(`fixture transcript surface does not model ?transcripts=${scenario}`),
          );
        }
        return Promise.resolve(response as T);
      }
      if (type === TRANSCRIPT_ITEMS_PROTOCOL) {
        const transcriptId = payload.transcript_id;
        if (typeof transcriptId !== 'string') {
          return Promise.reject(
            new Error(
              'fixture transcript-items request without a transcript_id — the unit has no other selection',
            ),
          );
        }
        const response = timelineForScenario(scenario, transcriptId);
        if (response === undefined) {
          return Promise.reject(
            new Error(`fixture transcript surface does not model ?transcripts=${scenario}`),
          );
        }
        return Promise.resolve(response as T);
      }
      return Promise.reject(
        new Error(`fixture transcript surface does not answer ${type}`),
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
