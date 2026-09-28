import { describe, expect, it } from 'vitest';
import { fixtureConversationSurface } from '@/app/fixture/fixtureConversation';
import { FIXTURE_AGENTS } from '@/app/fixture/fixtureData';
// v2, because that is the generation the fixture now serves (#1167). Reading it
// through v1's types would have the test assert a shape the surface under test
// no longer produces — and it would typecheck, which is the dangerous part.
import type { ConversationResponse } from '@/generated/protocol/claude-code/conversation/v2';

/**
 * The fixture's conversation surface is an *input*, so it has no rendering to
 * look wrong — which is how it went missing for three PRs (#1128).
 *
 * These tests are the two halves of that: the route is advertised, and what it
 * answers can actually reach the states the UI switches on.
 */
describe('fixture conversation surface', () => {
  const surface = fixtureConversationSurface('');

  /**
   * A wire lives in **two** places: the manifest the agents advertise, and the
   * surface that answers it. `#1108` cost two commits because only one was
   * updated — a request is resolved against the manifest *before* it is sent,
   * so an unadvertised wire never reaches the arm that would answer it.
   *
   * Named as a literal rather than driven from a table: `scripts/protocol-gate.mjs`
   * refuses a `request` whose wire it cannot resolve, and it is right to.
   */
  it('advertises the conversation wire it answers', () => {
    const advertised = Object.keys(FIXTURE_AGENTS[0]?.protocols?.protocols ?? {});
    expect(advertised, 'claude-code.conversation is answered but not advertised').toContain(
      'claude-code.conversation',
    );
  });

  it('answers a conversation bound to the Session', async () => {
    const response = await surface.request<ConversationResponse>('claude-code.conversation', {});

    expect(response.state).toBe('ready');
    expect(response.conversation).not.toBeNull();
    // The bound conversation must be one of the candidates, because that is
    // where its display metadata lives — the identity shape carries an id and a
    // cwd and nothing to draw (#1124).
    const bound = response.candidates?.find(
      (c) => c.claude_session_id === response.conversation?.claude_session_id,
    );
    expect(bound, 'the bound conversation is missing from its own candidate list').toBeDefined();
    expect(bound?.title).toBeTruthy();
  });

  it('carries a named candidate and an unnamed one, so the fallback is reachable', async () => {
    // Measured against real transcripts: 3 of 14 carry no `ai-title`. A fixture
    // where every conversation is named would leave the client's fallback
    // unreachable from every golden — the state would exist and nothing could
    // photograph it.
    const response = await surface.request<ConversationResponse>('claude-code.conversation', {});
    const titles = (response.candidates ?? []).map((c) => c.title);

    expect(titles.some((t) => typeof t === 'string' && t.length > 0)).toBe(true);
    expect(titles.some((t) => t === undefined || t === null)).toBe(true);
  });

  it('covers every item kind the renderer has a branch for', async () => {
    // The transcript draws a message by its speaker, a tool by its status, and a
    // record it cannot read as a marker. Each of those is a different branch,
    // and a fixture that missed one would make that branch unreachable from
    // every golden — the state would exist and nothing could photograph it.
    const response = await surface.request<ConversationResponse>('claude-code.conversation', {});
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
    const response = await surface.request<ConversationResponse>('claude-code.conversation', {});
    const tools = (response.items ?? []).flatMap((item) => (item.kind === 'tool' ? [item.tool] : []));
    const statuses = tools.map((tool) => tool.status);

    expect(statuses).toContain('success');
    expect(statuses).toContain('error');
    expect(statuses).toContain('running');
    expect(statuses).toContain('unknown');

    // The error has to carry its output: a failed tool with nothing to read is
    // the state a reader most needs, and the one v1 could not express at all.
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
    const response = await surface.request<ConversationResponse>('claude-code.conversation', {});
    const prose = (response.items ?? []).flatMap((item) =>
      item.kind === 'message' ? item.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])) : [],
    );

    expect(prose.some((text) => text.includes('## '))).toBe(true);
    expect(prose.some((text) => text.includes('```'))).toBe(true);
  });

  it('models the ambiguous and no-conversation states, not just the happy one', async () => {
    // `ambiguous` is the state `#1005` forbids guessing in, and `not_found` is
    // the ordinary "no conversation here" — both are screens, so both need an
    // input that produces them.
    const ambiguous = await fixtureConversationSurface('?conversation=ambiguous').request<
      ConversationResponse
    >('claude-code.conversation', {});
    expect(ambiguous.state).toBe('ambiguous');
    expect(ambiguous.conversation ?? null).toBeNull();
    expect((ambiguous.candidates ?? []).length).toBeGreaterThan(1);

    const none = await fixtureConversationSurface('?conversation=none').request<ConversationResponse>(
      'claude-code.conversation',
      {},
    );
    expect(none.state).toBe('not_found');
    expect((none.items ?? []).length).toBe(0);
  });

  it('refuses a scenario it does not model rather than inventing one', async () => {
    // A fixture that answered something plausible here would let a case assert
    // on a state the product cannot produce, which is the one thing a fixture
    // must not do.
    const surface = fixtureConversationSurface('?conversation=nonsense');

    await expect(
      surface.request<ConversationResponse>('claude-code.conversation', {}),
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
    await expect(surface.request<ConversationResponse>('claude-code.read', {})).rejects.toThrow(
      /does not answer/,
    );
  });
});
