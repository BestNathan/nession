import { describe, expect, it } from 'vitest';
import { fixtureConversationSurface } from '@/app/fixture/fixtureConversation';
import { FIXTURE_AGENTS } from '@/app/fixture/fixtureData';
import type { ConversationResponse } from '@/generated/protocol/claude-code/conversation/v1';

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

  it('covers all three item kinds, including a tool that failed', async () => {
    // The transcript draws user, assistant and tool differently, and a tool
    // twice more by `is_error`. A fixture that only ever produced successes
    // would make the failure treatment unreachable from any golden.
    const response = await surface.request<ConversationResponse>('claude-code.conversation', {});
    const items = response.items ?? [];
    const kinds = items.map((item) => item.kind);

    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant');
    expect(kinds).toContain('tool');

    const tools = items.filter((item) => item.kind === 'tool');
    expect(tools.some((item) => item.tool?.is_error === true)).toBe(true);
    expect(tools.some((item) => item.tool?.is_error === false)).toBe(true);
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
