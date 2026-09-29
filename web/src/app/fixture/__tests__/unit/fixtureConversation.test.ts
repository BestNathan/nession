import { describe, expect, it } from 'vitest';
import { fixtureConversationSurface } from '@/app/fixture/fixtureConversation';
import { FIXTURE_AGENTS } from '@/app/fixture/fixtureData';
import type { ConversationsResponse } from '@/generated/protocol/claude-code/conversations/v1';
import type { MessagesResponse } from '@/generated/protocol/claude-code/messages/v1';

/**
 * The fixture's conversation surface is an *input*, so it has no rendering to
 * look wrong — which is how it went missing for three PRs (#1128).
 *
 * These tests are the two halves of that: the routes are advertised, and what
 * they answer can actually reach the states the UI switches on. Since `#1222`
 * that means **two** units — `conversations` (the list and the exact binding)
 * and `messages` (one explicitly named conversation's timeline) — and the
 * pairing assertions cover both, because a wire that is advertised but not
 * answered, or answered but not advertised, never reaches the arm that would
 * produce the screen.
 */
describe('fixture conversation surface', () => {
  const surface = fixtureConversationSurface('');

  /**
   * A wire lives in **two** places: the manifest the agents advertise, and the
   * surface that answers it. `#1108` cost two commits because only one was
   * updated — a request is resolved against the manifest *before* it is sent,
   * so an unadvertised wire never reaches the arm that would answer it.
   *
   * Named as literals rather than driven from a table: `scripts/protocol-gate.mjs`
   * refuses a `request` whose wire it cannot resolve, and it is right to.
   */
  it('advertises the conversation wires it answers', () => {
    const advertised = Object.keys(FIXTURE_AGENTS[0]?.protocols?.protocols ?? {});
    expect(advertised, 'claude-code.conversations is answered but not advertised').toContain(
      'claude-code.conversations',
    );
    expect(advertised, 'claude-code.messages is answered but not advertised').toContain(
      'claude-code.messages',
    );
    // And the retired unit is gone from both sides, not just one (#1222) —
    // advertising it would route requests to an arm that no longer exists.
    expect(advertised).not.toContain('claude-code.conversation');
  });

  it('answers the list with the binding the auto-open follows', async () => {
    const response = await surface.request<ConversationsResponse>(
      'claude-code.conversations',
      {},
    );

    expect(response.state).toBe('ready');
    expect(response.binding).toBeDefined();
    // The binding must name one of the listed items: the auto-open asks
    // `messages` for exactly that id, so a binding that named nothing in the
    // list would open with `not_found` — the one substitution #1222 forbids.
    const bound = (response.items ?? []).find(
      (c) => c.id === response.binding?.conversation_id,
    );
    expect(bound, 'the binding names a conversation the list does not carry').toBeDefined();
    expect(bound?.title).toBeTruthy();
  });

  it('answers the bound conversation with the full item — no client join', async () => {
    // The property #1222 bought: the header renders from this response alone,
    // so the fixture must carry the display metadata *on the messages answer*
    // or the join it replaced would secretly still be load-bearing.
    const list = await surface.request<ConversationsResponse>('claude-code.conversations', {});
    const boundId = list.binding?.conversation_id as string;
    const response = await surface.request<MessagesResponse>('claude-code.messages', {
      conversation_id: boundId,
    });

    expect(response.state).toBe('ready');
    expect(response.conversation?.id).toBe(boundId);
    expect(response.conversation?.title).toBeTruthy();
    expect(response.activity).toBe('active');
  });

  it('carries a named conversation and an unnamed one, so the fallback is reachable', async () => {
    // Measured against real transcripts: 3 of 14 carry no `ai-title`. A fixture
    // where every conversation is named would leave the client's fallback
    // unreachable from every golden — the state would exist and nothing could
    // photograph it.
    const response = await surface.request<ConversationsResponse>(
      'claude-code.conversations',
      {},
    );
    const titles = (response.items ?? []).map((c) => c.title);

    expect(titles.some((t) => typeof t === 'string' && t.length > 0)).toBe(true);
    expect(titles.some((t) => t === undefined || t === null)).toBe(true);
  });

  it('covers every item kind the renderer has a branch for', async () => {
    // The transcript draws a message by its speaker, a tool by its status, and a
    // record it cannot read as a marker. Each of those is a different branch,
    // and a fixture that missed one would make that branch unreachable from
    // every golden — the state would exist and nothing could photograph it.
    const response = await surface.request<MessagesResponse>('claude-code.messages', {
      conversation_id: 'c0a1b2c3-1111-4222-8333-444455556666',
    });
    const items = response.items ?? [];

    expect(items.map((item) => item.kind)).toContain('message');
    expect(items.map((item) => item.kind)).toContain('tool');
    expect(items.map((item) => item.kind)).toContain('unknown');

    const roles = items.flatMap((item) => (item.kind === 'message' ? [item.role] : []));
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('covers every tool status, truncation, and a readable body', async () => {
    // Four statuses, because they are four renderings — and `running` beside
    // `unknown` most of all: describing the second as the first is the claim
    // the provider deliberately does not make, so a fixture that only produced
    // one of them could not show the difference.
    const response = await surface.request<MessagesResponse>('claude-code.messages', {
      conversation_id: 'c0a1b2c3-1111-4222-8333-444455556666',
    });
    const tools = (response.items ?? []).flatMap((item) => (item.kind === 'tool' ? [item.tool] : []));
    const statuses = tools.map((tool) => tool.status);

    expect(statuses).toContain('success');
    expect(statuses).toContain('error');
    expect(statuses).toContain('running');
    expect(statuses).toContain('unknown');

    // The error has to carry its output: a failed tool with nothing to read is
    // the state a reader most needs.
    const failed = tools.find((tool) => tool.status === 'error');
    expect(failed?.output?.text).toBeTruthy();

    // And truncation, which is indistinguishable from a short body unless
    // something says so.
    expect(tools.some((tool) => tool.output?.truncated === true)).toBe(true);
  });

  it('carries Markdown and a code fence, so the renderer has something to draw', async () => {
    // The regression this guards is the one #714 recorded: the fixture stops
    // reaching the feature, the golden keeps passing, and the gate goes on
    // protecting a screen the product no longer has.
    const response = await surface.request<MessagesResponse>('claude-code.messages', {
      conversation_id: 'c0a1b2c3-1111-4222-8333-444455556666',
    });
    const prose = (response.items ?? []).flatMap((item) =>
      item.kind === 'message' ? item.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])) : [],
    );

    expect(prose.some((text) => text.includes('## '))).toBe(true);
    expect(prose.some((text) => text.includes('```'))).toBe(true);
  });

  it('models the unbound and no-conversation states, not just the happy one', async () => {
    // Unbound is the state `#1005` forbids guessing in — a list and no binding,
    // which is *not* a state of its own anymore (#1222) — and an empty list is
    // the ordinary "no conversation here". Both are screens, so both need an
    // input that produces them.
    const unbound = await fixtureConversationSurface('?conversation=unbound').request<
      ConversationsResponse
    >('claude-code.conversations', {});
    expect(unbound.state).toBe('ready');
    expect(unbound.binding ?? null).toBeNull();
    expect((unbound.items ?? []).length).toBeGreaterThan(1);

    const none = await fixtureConversationSurface('?conversation=none').request<ConversationsResponse>(
      'claude-code.conversations',
      {},
    );
    expect(none.state).toBe('ready');
    expect((none.items ?? []).length).toBe(0);
  });

  it('models an older page behind a cursor, so pull-to-load is reachable', async () => {
    // Without this scenario the entire older-page path — pull-to-load,
    // prepend, anchor preservation — is a shipped feature no fixture state
    // could reach, which is exactly how it broke without a gate noticing.
    const paged = fixtureConversationSurface('?conversation=paged');
    const list = await paged.request<ConversationsResponse>('claude-code.conversations', {});
    expect(list.state).toBe('ready');
    const boundId = list.binding?.conversation_id as string;
    expect(boundId).toBeTruthy();

    const newest = await paged.request<MessagesResponse>('claude-code.messages', {
      conversation_id: boundId,
    });
    expect(newest.has_more).toBe(true);
    const cursor = newest.next_cursor as string;
    expect(cursor).toBeTruthy();

    // The cursor is the paging contract: handing it back must return a page
    // that is *different* items, older than everything held, and the end of
    // the history.
    const older = await paged.request<MessagesResponse>('claude-code.messages', {
      conversation_id: boundId,
      cursor,
    });
    expect(older.state).toBe('ready');
    expect(older.has_more).toBe(false);
    const newestIds = (newest.items ?? []).map((item) => item.id);
    const olderIds = (older.items ?? []).map((item) => item.id);
    expect(olderIds.length).toBeGreaterThan(0);
    expect(olderIds.every((id) => !newestIds.includes(id))).toBe(true);

    // A cursor no page handed out is a client bug, and the fixture says so
    // loudly rather than answering a page that cannot exist.
    await expect(
      paged.request<MessagesResponse>('claude-code.messages', {
        conversation_id: boundId,
        cursor: 'not-a-cursor',
      }),
    ).rejects.toThrow(/no page handed out/);
  });

  it('answers not_found for a conversation id it does not know', async () => {
    // The unit's only selection mechanism is the explicit id, and an unknown
    // one is never substituted — not by the binding, not by the newest, not by
    // the only conversation (#1222).
    const response = await surface.request<MessagesResponse>('claude-code.messages', {
      conversation_id: 'no-such-conversation',
    });

    expect(response.state).toBe('not_found');
    expect(response.conversation ?? null).toBeNull();
    expect((response.items ?? []).length).toBe(0);
  });

  it('refuses a scenario it does not model rather than inventing one', async () => {
    // A fixture that answered something plausible here would let a case assert
    // on a state the product cannot produce, which is the one thing a fixture
    // must not do.
    const surface = fixtureConversationSurface('?conversation=nonsense');

    await expect(
      surface.request<ConversationsResponse>('claude-code.conversations', {}),
    ).rejects.toThrow(/does not model/);
  });

  it('refuses a wire it does not answer', async () => {
    // `claude-code.read` — the capability's third wire, and the one this surface
    // genuinely does not implement.
    //
    // This named `claude-code.list` until the surface started answering it (for
    // `#1120`'s Configuration baseline), at which point the test failed. That
    // was the test working: it is asserting a real property — a fixture that
    // quietly answers a wire it does not model would let a case assert on a
    // state the product cannot produce — so the example moved rather than the
    // assertion.
    await expect(surface.request<ConversationsResponse>('claude-code.read', {})).rejects.toThrow(
      /does not answer/,
    );
  });
});
