import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import {
  PROTOCOL,
  type ConversationItemV1,
  type ConversationsResponse,
} from '@/generated/protocol/claude-code/conversations/v1';
import {
  PROTOCOL as MESSAGES_PROTOCOL,
  type MessageItemV1,
  type MessagesResponse,
} from '@/generated/protocol/claude-code/messages/v1';
import {
  PROTOCOL as LIST_PROTOCOL,
  type ConfigCategory,
  type ListResponse,
  type Scope as ConfigScope,
} from '@/generated/protocol/claude-code/list/v1';
import { FIXTURE_AGENTS } from './fixtureData';

/**
 * The conversation half of the fixture's Claude Code capability (#1128,
 * re-cut for `#1222`'s two units).
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
 * nothing. `fixtureConversation.test.ts` asserts the pairing, now for both
 * units: `conversations` (the list and the binding) and `messages` (one
 * explicitly named conversation's timeline).
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
 * The conversations, deliberately not all the same shape.
 *
 * Pairing has to be exercised, not just presence: a row is title + preview, and
 * each half can be absent on its own. So the three rows are the three
 * combinations a real list actually contains —
 *
 * 1. **title + preview**, the common case;
 * 2. **no title, with a preview** — measured, 3 of 14 real transcripts carry no
 *    `ai-title`, so the client's own fallback is a real path and not a defensive
 *    one. Its prompt is a slash command, which is what a measured `lastPrompt`
 *    frequently is;
 * 3. **title, no preview** — measured, 14 of 120 carried no prompt, and the row
 *    must then degrade to title and time rather than reserve a blank line.
 *
 * The third is also the oldest, so the list has an order to show rather than a
 * single row.
 */
const CONVERSATIONS: ConversationItemV1[] = [
  {
    id: BOUND_ID,
    cwd: '/Users/dev/code/nession-capsule',
    updated_at: '2026-09-01T11:40:00Z',
    title: 'Terminal ownership handoff',
    preview: 'Review the controller/observer handoff before the capsule moves again',
  },
  {
    id: 'd4e5f6a7-2222-4333-8444-555566667777',
    cwd: '/Users/dev/code/nession-capsule',
    updated_at: '2026-09-01T09:05:00Z',
    // No title on purpose — the fallback is a real path, not a defensive one.
    preview: '/nession-web-design 收敛 radius 层级',
  },
  {
    id: 'e8f9a0b1-3333-4444-8555-666677778888',
    cwd: '/Users/dev/code/nession-capsule',
    updated_at: '2026-08-29T08:15:00Z',
    title: 'Capsule radius review',
    // No preview on purpose — the row degrades rather than reserving a blank line.
  },
];

/**
 * One page of transcript, covering every shape the renderer has to draw.
 *
 * ## Why this fixture is long
 *
 * `#1167` replaced a `whitespace-pre-wrap` paragraph with a Markdown renderer,
 * a code block and an expandable tool activity. A fixture of plain prose and
 * one-line tool summaries — which is what this used to be — cannot reach any of
 * that, so every new branch would be invisible to the visual gate: the goldens
 * would keep passing while showing a product that no longer exists. That is the
 * failure `#714` recorded for the workspace baselines, and the reason this is
 * now built from the acceptance list rather than from what was easy to write.
 *
 * ## What each item is here to keep reachable
 *
 * - **Markdown**: headings, a list, a table, a link, inline code and a rule, so
 *   a regression in the prose treatment shows up as a diff rather than as
 *   nothing.
 * - **Two code fences**, in different languages, so the label and the highlight
 *   are both exercised — one fence alone would not show a wrong language.
 * - **Four tool states**: succeeded, failed, truncated and still running. A
 *   fixture that only produced successes would make the failure and truncation
 *   treatments unreachable from every golden — the same argument the git
 *   fixture makes for its statuses.
 * - **One `unknown`**, because it is a kind the wire can carry and nothing else
 *   in the app can produce it.
 */
const ITEMS: MessageItemV1[] = [
  {
    id: 'i1',
    kind: 'message',
    role: 'user',
    timestamp: '2026-09-01T11:30:00Z',
    content: [
      {
        type: 'text',
        text: 'Where is the ownership handoff today, and what breaks when two clients attach? I looked at `PeekHost.tsx` and could not tell.',
      },
    ],
  },
  {
    id: 'i2',
    kind: 'tool',
    timestamp: '2026-09-01T11:31:00Z',
    tool: {
      call_id: 'call-read-1',
      name: 'Read',
      status: 'success',
      summary: 'web/src/product/terminal/capsule/PeekHost.tsx',
      input: {
        text: '{\n  "file_path": "web/src/product/terminal/capsule/PeekHost.tsx"\n}',
        kind: 'json',
        truncated: false,
      },
      output: { text: 'export function PeekHost({ sessionId }: PeekHostProps) {', kind: 'text', truncated: false },
    },
  },
  {
    id: 'i3',
    kind: 'message',
    role: 'assistant',
    timestamp: '2026-09-01T11:32:00Z',
    content: [
      {
        type: 'text',
        text: [
          '## What actually decides ownership',
          '',
          'The controller is **whoever attached last**, and nothing arbitrates it. Two clients',
          'attaching to the same Session therefore both believe they own the keyboard, and the',
          'pane receives whichever keystroke arrives first.',
          '',
          'The three consumers of that fact are:',
          '',
          '- `ConnectionManager`, which holds the socket',
          '- the input router, which decides what a keystroke means',
          '- the capsule, which draws the caret',
          '',
          '| Path | Arbitrated? | Tested? |',
          '| --- | --- | --- |',
          '| attach | yes | yes |',
          '| observer | no | **no** |',
          '',
          '---',
          '',
          'The observer path is the one with no test — that is where the regression would sit.',
          'You can see the same shape in the [stream replay notes](https://example.com/nession).',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'i4',
    kind: 'tool',
    timestamp: '2026-09-01T11:33:00Z',
    tool: {
      call_id: 'call-bash-1',
      name: 'Bash',
      status: 'error',
      summary: 'cargo test -p nession-agent -- ownership',
      input: {
        text: '{\n  "command": "cargo test -p nession-agent -- ownership"\n}',
        kind: 'json',
        truncated: false,
      },
      output: {
        text: 'running 3 tests\ntest ownership::observer_keeps_the_keyboard ... FAILED\n\nfailures:\n    ownership::observer_keeps_the_keyboard\n\ntest result: FAILED. 2 passed; 1 failed',
        kind: 'text',
        truncated: false,
      },
    },
  },
  {
    id: 'i5',
    kind: 'message',
    role: 'assistant',
    timestamp: '2026-09-01T11:34:00Z',
    content: [
      {
        type: 'text',
        text: [
          'That failure is the bug. The fix belongs where the epoch is bumped, not in the router:',
          '',
          '```rust',
          'impl ConnectionManager {',
          '    fn attach(&mut self, client: ClientId) -> Epoch {',
          '        self.epoch.bump();',
          '        self.owner = Some(client);',
          '        self.epoch',
          '    }',
          '}',
          '```',
          '',
          'and the client side has to stop assuming its own epoch is current:',
          '',
          '```ts',
          'const stillMine = (epoch: number) => epoch === api.identityEpoch;',
          '```',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'i6',
    kind: 'tool',
    timestamp: '2026-09-01T11:35:00Z',
    tool: {
      call_id: 'call-bash-2',
      name: 'Bash',
      status: 'success',
      summary: 'cargo test -p nession-agent -- ownership',
      output: {
        text: 'running 3 tests\ntest ownership::observer_keeps_the_keyboard ... ok\ntest result: ok. 3 passed; 0 failed',
        kind: 'text',
        truncated: true,
      },
    },
  },
  {
    id: 'i7',
    kind: 'tool',
    timestamp: '2026-09-01T11:36:00Z',
    tool: {
      call_id: 'call-bash-3',
      name: 'Bash',
      status: 'running',
      summary: 'cargo test --workspace',
      input: {
        text: '{\n  "command": "cargo test --workspace"\n}',
        kind: 'json',
        truncated: false,
      },
    },
  },
  {
    id: 'i8',
    kind: 'tool',
    timestamp: '2026-09-01T11:36:15Z',
    tool: {
      call_id: 'call-read-2',
      name: 'Read',
      status: 'unknown',
      summary: 'crates/nession-agent/src/tmux/cmd.rs',
    },
  },
  {
    id: 'i9',
    kind: 'unknown',
    timestamp: '2026-09-01T11:36:30Z',
  },
];

/** The item a `messages` answer carries whole — no client join by id (#1222). */
function itemOf(conversationId: string): ConversationItemV1 | undefined {
  return [...CONVERSATIONS, RICH_CONVERSATION].find((c) => c.id === conversationId);
}

/** The conversation the `rich` scenario is bound to (#1184's Chat dialect). */
const RICH_ID = 'a9b8c7d6-9999-4aaa-8bbb-ccccddddeeee';

const RICH_CONVERSATION: ConversationItemV1 = {
  id: RICH_ID,
  cwd: '/Users/dev/code/nession-capsule',
  updated_at: '2026-09-01T11:52:00Z',
  title: 'Chat Markdown dialect',
  preview: 'The corpus the Chat profile has to keep readable',
};

/**
 * The `rich` scenario's page: the #1184 acceptance corpus as one assistant
 * turn, plus a user turn that carries Markdown of its own.
 *
 * It exists because the dialect's guarantees are *negative* — `$HOME` is not
 * math, `60~70%` is not strikethrough, `<tool_call>` is not a tool call — and
 * a negative is exactly what a prose fixture cannot reach: the canonical
 * conversation contains none of these shapes, so a regression that swallowed
 * `$HOME` into KaTeX would leave every existing golden identical. The
 * requirement lists this corpus by name (#1184 Testing), and a state with no
 * route is a state with no gate.
 *
 * The definitions deliberately sit at the *end* of the message: the settled
 * full parse must resolve a reference and a footnote the streaming prefix
 * would have rendered literally, which is the behaviour SC-14 is about.
 */
const RICH_ITEMS: MessageItemV1[] = [
  {
    id: 'rich-1',
    kind: 'message',
    role: 'user',
    timestamp: '2026-09-01T11:50:00Z',
    content: [
      {
        type: 'text',
        text: '这个 **PeekHost.tsx** 的 ownership 是怎么决定的？顺便看看 `$HOME` 下面的配置。',
      },
    ],
  },
  {
    id: 'rich-2',
    kind: 'message',
    role: 'assistant',
    timestamp: '2026-09-01T11:52:00Z',
    content: [
      {
        type: 'text',
        text: [
          '## Ownership, and the things that look like formulas',
          '',
          'The controller is whoever attached last, and the config it reads is whatever',
          '`$HOME` resolved to at launch — `$PATH` and `$SHELL` ride along. A run costs',
          '$100 in the worst case and finishes in ~10ms, and 60~70% of that is the render;',
          'the rest is the tmux round trip.',
          '',
          '中文**重点。**下一句继续，强调在这里收尾。',
          '',
          'Inline math stays explicit: \\(E = mc^2\\), and display math is its own block:',
          '',
          '\\[',
          '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
          '\\]',
          '',
          'The tag below is literal text in a conversation, not a tool call:',
          '',
          '<tool_call>{"name": "Read", "path": "~/.claude/CLAUDE.md"}</tool_call>',
          '',
          'The handler everyone reaches for:',
          '',
          '```rust',
          'impl ConnectionManager {',
          '    fn attach(&mut self, client: ClientId) -> Epoch {',
          '        self.epoch.bump();',
          '        self.owner = Some(client);',
          '        self.epoch',
          '    }',
          '',
          '    fn observer(&self, client: ClientId) -> bool {',
          '        self.observer == Some(client)',
          '    }',
          '}',
          '```',
          '',
          '| Path | Arbitrated? | Tested? |',
          '| --- | --- | --- |',
          '| attach | yes | yes |',
          '| observer | no | **no** |',
          '',
          'The observer path is the untested one. See the [stream replay notes][notes]',
          'and the footnote for the measured shape.[^observer] The local path',
          '[PeekHost.tsx](web/src/product/terminal/capsule/PeekHost.tsx) stays text until a',
          'resolver vouches for it.',
          '',
          '[notes]: https://example.com/nession',
          '[^observer]: Only the attach path is covered by the ownership suite.',
        ].join('\n'),
      },
    ],
  },
];

/**
 * The page *behind* `ITEMS` — what the `paged` scenario answers to a request
 * carrying the first page's cursor.
 *
 * Without a scenario whose newest page says `has_more`, the entire older-page
 * path — pull-to-load, prepend, anchor preservation — is a shipped feature no
 * fixture state can reach, which is exactly how it broke without a gate
 * noticing. Two items is enough: what the client must prove is that a cursor
 * request prepends, not that it can count.
 */
const OLDER_ITEMS: MessageItemV1[] = [
  {
    id: 'older-1',
    kind: 'message',
    role: 'user',
    timestamp: '2026-09-01T11:20:00Z',
    content: [{ type: 'text', text: 'Earlier page — the pull-to-load boundary marker.' }],
  },
  {
    id: 'older-2',
    kind: 'message',
    role: 'assistant',
    timestamp: '2026-09-01T11:21:00Z',
    content: [{ type: 'text', text: 'This answer only arrives through the cursor request.' }],
  },
];

/**
 * The page *behind* that one, so the history is more than a single step deep.
 *
 * One older page proves a cursor round-trips; it cannot show whether the
 * transcript *keeps* paging. That distinction is the whole of a reported
 * defect — a reader scrolling up through a long conversation had to nudge the
 * transcript between pages instead of pulling continuously — and a fixture
 * that runs out of history after one step can never express it.
 */
const OLDEST_ITEMS: MessageItemV1[] = [
  {
    id: 'oldest-1',
    kind: 'message',
    role: 'user',
    timestamp: '2026-09-01T11:02:00Z',
    content: [{ type: 'text', text: 'The oldest thing recorded — history ends here.' }],
  },
];

/** The cursors the `paged` scenario hands out, in the order it hands them out. */
const PAGED_CURSOR = 'page-boundary-1';
const PAGED_CURSOR_2 = 'page-boundary-2';

/**
 * What the `conversations` unit answers for a named scenario.
 *
 * `undefined` for a scenario this fixture does not model, so the surface below
 * rejects loudly rather than answering something plausible: a fixture that
 * guessed would let a case assert on a state the product cannot produce.
 */
function conversationsFor(scenario: string): ConversationsResponse | undefined {
  switch (scenario) {
    case 'ready':
      return {
        state: 'ready',
        cwd: '/Users/dev/code/nession-capsule',
        items: CONVERSATIONS,
        binding: { conversation_id: BOUND_ID, activity: 'active' },
        has_more: false,
      };
    case 'unbound':
      // No binding: several conversations at this cwd and no answer about
      // which is the Session's. That is not an `ambiguous` state anymore —
      // the list is the answer (#1222), and `#1005` forbids choosing from it.
      return {
        state: 'ready',
        cwd: '/Users/dev/code/nession-capsule',
        items: CONVERSATIONS,
        has_more: false,
      };
    case 'rich':
      // The #1184 corpus, bound on purpose: the Peek's "View conversation"
      // action only renders in the bound state, and that overlay is one of
      // the two surfaces the requirement's acceptance names.
      return {
        state: 'ready',
        cwd: RICH_CONVERSATION.cwd ?? '/Users/dev/code/nession-capsule',
        items: [RICH_CONVERSATION],
        binding: { conversation_id: RICH_ID, activity: 'inactive' },
        has_more: false,
      };
    case 'none':
      // Read, and empty. There is no `not_found` on this unit: an empty list
      // is a complete answer rather than an error.
      return {
        state: 'ready',
        cwd: '/Users/dev/code/nession-capsule',
        items: [],
        has_more: false,
      };
    case 'inactive':
      // The same directory as `ready`, bound to a conversation whose Claude
      // has finished: `#1005` criterion 4 makes that a real, readable
      // conversation, and the only difference the UI draws is the header —
      // `Finished` rather than `Running now`.
      return {
        state: 'ready',
        cwd: '/Users/dev/code/nession-capsule',
        items: CONVERSATIONS,
        binding: { conversation_id: BOUND_ID, activity: 'inactive' },
        has_more: false,
      };
    case 'unavailable':
      // A different answer from `none`, and a different screen: the directory
      // could not be read at all, against one that was read and held no
      // conversations. `#1128` names both, and the view renders them apart.
      return { state: 'unavailable', items: [], has_more: false };
    case 'thread-unavailable':
      // The list reads fine and the *thread* cannot be. Kept as its own
      // scenario because `unavailable` above means the folder could not be
      // listed at all — a different screen, and until now the only one a
      // browser could reach. `#1397` gave the thread its own arm precisely
      // because "cannot say" is not "there is nothing"; the round-2 review
      // named the absence of a path driving that arm as a gap.
      return {
        state: 'ready',
        cwd: '/Users/dev/code/nession-capsule',
        items: CONVERSATIONS,
        binding: { conversation_id: BOUND_ID, activity: 'active' },
        has_more: false,
      };
    case 'list-stale':
      // `ready`'s directory: what differs is a *later* list read, which the
      // surface fails once the thread has been opened. See `threadOpened`.
      return {
        state: 'ready',
        cwd: '/Users/dev/code/nession-capsule',
        items: CONVERSATIONS,
        binding: { conversation_id: BOUND_ID, activity: 'active' },
        has_more: false,
      };
    case 'paged':
      // `ready`, plus a messages unit that admits an older page exists. See
      // `messagesFor`: the paging lives entirely on the messages answer — the
      // conversations list is identical to `ready`, because a longer history
      // is not a property of the list.
      return {
        state: 'ready',
        cwd: '/Users/dev/code/nession-capsule',
        items: CONVERSATIONS,
        binding: { conversation_id: BOUND_ID, activity: 'active' },
        has_more: false,
      };
    default:
      return undefined;
  }
}

/**
 * What the `messages` unit answers for a named scenario and an explicit id.
 *
 * The id is the only selection mechanism — an unknown one answers `not_found`
 * and never the binding, the newest, or the only conversation. `undefined`
 * means the scenario itself is unmodelled, as above.
 */
function messagesFor(
  scenario: string,
  conversationId: string,
  cursor?: string,
): MessagesResponse | undefined {
  const named = itemOf(conversationId);
  if (conversationsFor(scenario) === undefined) {
    return undefined;
  }
  if (scenario === 'none' || scenario === 'unavailable' || named === undefined) {
    return {
      state: 'not_found',
      items: [],
      has_more: false,
      partial_tail: false,
      skipped: 0,
    };
  }
  if (scenario === 'rich' && named.id !== RICH_ID) {
    // The canonical conversations are not part of this scenario's directory —
    // answering one with the corpus would be the substitution `#1222` forbids.
    return {
      state: 'not_found',
      items: [],
      has_more: false,
      partial_tail: false,
      skipped: 0,
    };
  }
  switch (scenario) {
    case 'list-stale':
    case 'thread-unavailable':
      // The read the list above promised and could not make. `items: []` here
      // is the provider being honest, not a conversation that is empty — and
      // the surface must not turn one into the other, which is the whole point
      // of the state.
      //
      // `list-stale` shares the answer, and not for atmosphere: the only
      // control in this surface that reloads *both* halves is the Retry a
      // non-ready thread offers, so without it the list refresh above could
      // never be asked for. See `threadOpened`.
      return {
        state: 'unavailable',
        items: [],
        has_more: false,
        partial_tail: false,
        skipped: 0,
      };
    case 'ready':
      return {
        state: 'ready',
        conversation: named,
        activity: 'active',
        items: ITEMS,
        has_more: false,
        partial_tail: false,
        skipped: 0,
      };
    case 'paged': {
      // The only scenario with history behind the newest page. The cursor is
      // the paging contract: the newest page hands out `PAGED_CURSOR`, and
      // only that value is meaningful back. Anything else is a client bug,
      // and the fixture says so loudly rather than answering a page that
      // cannot exist — the same doctrine as an unknown conversation id.
      if (cursor === undefined) {
        return {
          state: 'ready',
          conversation: named,
          activity: 'active',
          items: ITEMS,
          has_more: true,
          next_cursor: PAGED_CURSOR,
          partial_tail: false,
          skipped: 0,
        };
      }
      if (cursor === PAGED_CURSOR) {
        return {
          state: 'ready',
          conversation: named,
          activity: 'active',
          items: OLDER_ITEMS,
          // More history behind this one, so a reader who pulls twice gets two
          // pages — the behaviour a single-step fixture cannot show.
          has_more: true,
          next_cursor: PAGED_CURSOR_2,
          partial_tail: false,
          skipped: 0,
        };
      }
      if (cursor === PAGED_CURSOR_2) {
        return {
          state: 'ready',
          conversation: named,
          activity: 'active',
          items: OLDEST_ITEMS,
          has_more: false,
          partial_tail: false,
          skipped: 0,
        };
      }
      return undefined;
    }
    case 'inactive':
      // The same transcript as `ready`, and that is the point: a fixture that
      // gave this state no items would leave a reader unable to tell the two
      // apart, and would make the distinction unassertable everywhere
      // downstream.
      return {
        state: 'ready',
        conversation: named,
        activity: 'inactive',
        items: ITEMS,
        has_more: false,
        partial_tail: false,
        skipped: 0,
      };
    case 'unbound':
      // Reachable only by an explicit click — nothing auto-opens without a
      // binding. `unknown` rather than a guessed liveness: the host is not
      // claiming this one is or is not running, and the header draws no claim
      // either. It is also the only scenario that reaches that third branch.
      return {
        state: 'ready',
        conversation: named,
        activity: 'unknown',
        items: ITEMS,
        has_more: false,
        partial_tail: false,
        skipped: 0,
      };
    case 'rich':
      // Settled and inactive: the corpus is the *settled* full parse's job
      // (SC-14 — references and footnotes resolve there), and `inactive` keeps
      // `partial_tail` from turning the last item into a streaming one.
      return {
        state: 'ready',
        conversation: named,
        activity: 'inactive',
        items: RICH_ITEMS,
        has_more: false,
        partial_tail: false,
        skipped: 0,
      };
    default:
      return undefined;
  }
}

/**
 * What the Configuration section browses, per scope.
 *
 * The two scopes are deliberately **different shapes**, because the section's
 * whole job is to say which one you are looking at: a fixture where they held
 * the same files would let a rendering bug that showed `global` under the
 * `project` tab pass every assertion. Project carries an extra category and
 * global an extra file, so a swap is visible rather than coincidentally right.
 *
 * Read-only and static: this is a *listing*, and the fixture has no answering
 * state to model here — unlike the conversation surface, which has several. What
 * matters is that the paths resolve to something the reader can recognise, not
 * that the bytes are real.
 */
const CONFIG_FILES: Record<ConfigScope, ConfigCategory[]> = {
  global: [
    {
      name: 'Instructions',
      icon: 'file-text',
      files: [{ path: '~/.claude/CLAUDE.md', size: 1284, content_type: 'text/markdown' }],
    },
    {
      name: 'Settings',
      icon: 'settings',
      files: [
        { path: '~/.claude/settings.json', size: 412, content_type: 'application/json' },
        { path: '~/.claude/settings.local.json', size: 96, content_type: 'application/json' },
      ],
    },
  ],
  project: [
    {
      name: 'Instructions',
      icon: 'file-text',
      files: [{ path: '.claude/CLAUDE.md', size: 2640, content_type: 'text/markdown' }],
    },
    {
      name: 'Settings',
      icon: 'settings',
      files: [{ path: '.claude/settings.json', size: 388, content_type: 'application/json' }],
    },
    {
      // Project-only, on purpose — see above.
      name: 'Commands',
      icon: 'terminal',
      files: [{ path: '.claude/commands/review.md', size: 730, content_type: 'text/markdown' }],
    },
  ],
};

/** The list answer for a scope. */
function listFor(scope: ConfigScope): ListResponse {
  return { available: true, categories: CONFIG_FILES[scope] };
}

/**
 * The fixture's Claude Code conversation surface.
 *
 * `search` is the route's query string, so a route parameter names the input the
 * provider is in rather than the screen it draws.
 */
export function fixtureConversationSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('conversation') ?? 'ready';

  /**
   * Whether the reader has opened a conversation yet.
   *
   * `list-stale` answers the directory normally until the thread has been read,
   * and fails every list read after that. The trigger is the reader's own
   * action rather than a count of list reads, and it has to be: this app reads
   * the list twice on mount in development (StrictMode double-invokes the
   * effect, and only in development), so "fail after the first list read" would
   * answer the same scenario differently in the two environments the fixture
   * runs in — rows in the production build the E2E uses, an error screen in the
   * dev server a human uses.
   *
   * It is also the state worth reaching, in the review's own words: the list
   * loaded, the reader opened a thread, and the *refresh* is what failed. A
   * scenario that failed the first read would be a different screen — the one
   * `ListStateGuard` already draws.
   */
  let threadOpened = false;

  // The same directory the git surface publishes, built from the same
  // `manifestsOf`, so this route cannot present a capability directory the app
  // would not — resolution happens against it before a request is sent.
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));

  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      // The ids are the contracts', not literals: a renamed wire would then
      // fail here rather than silently answering nothing.
      if (type === PROTOCOL) {
        if (scenario === 'list-stale' && threadOpened) {
          return Promise.reject(new Error('the conversations could not be listed'));
        }
        const response = conversationsFor(scenario);
        if (response === undefined) {
          return Promise.reject(
            new Error(`fixture conversation surface does not model ?conversation=${scenario}`),
          );
        }
        void payload;
        return Promise.resolve(response as T);
      }
      if (type === MESSAGES_PROTOCOL) {
        threadOpened = true;
        const conversationId = payload.conversation_id;
        if (typeof conversationId !== 'string') {
          return Promise.reject(
            new Error('fixture messages request without a conversation_id — the unit has no other selection'),
          );
        }
        const cursor = payload.cursor;
        if (cursor !== undefined && typeof cursor !== 'string') {
          return Promise.reject(
            new Error('fixture messages request with a non-string cursor — the contract sends a string'),
          );
        }
        const response = messagesFor(scenario, conversationId, cursor);
        if (response === undefined) {
          // Either the scenario is unmodelled at all, or the scenario is
          // `paged` and the cursor is not the one its newest page handed out.
          // Both are client bugs; the message says which.
          const what =
            scenario === 'paged'
              ? `fixture paged scenario got cursor ${JSON.stringify(cursor)}, which no page handed out`
              : `fixture conversation surface does not model ?conversation=${scenario}`;
          return Promise.reject(new Error(what));
        }
        return Promise.resolve(response as T);
      }
      // The capability's other wire. It used to be rejected outright, which
      // meant the Configuration section rendered a transport error and could
      // not be photographed at all — so `#1120`'s "baselines include …
      // Configuration" had no way to be met. Answering it is what makes that
      // section a reachable state rather than a dead route.
      if (type === LIST_PROTOCOL) {
        const scope = payload.scope === 'global' ? 'global' : 'project';
        return Promise.resolve(listFor(scope) as T);
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
