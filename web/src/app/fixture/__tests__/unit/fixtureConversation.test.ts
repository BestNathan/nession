import { describe, expect, it } from 'vitest';
import { fixtureConversationSurface } from '@/app/fixture/fixtureConversation';
import { FIXTURE_AGENTS } from '@/app/fixture/fixtureData';
import type { ClaudeCodeConversationResponse } from '@/capabilities/claude-code';

/**
 * The fixture's conversation surface is an *input*, so it has no rendering to
 * look wrong.
 *
 * That is why the gap these tests cover went unnoticed: no route could open the
 * capability and no surface answered the wire, so every state of the view #1005
 * stage D built was unreachable and in no baseline (#1029, #1128).
 */
describe('fixture conversation surface', () => {
  /**
   * A wire lives in **two** places in this fixture: the manifest the agents
   * advertise, and the surface that answers it.
   *
   * #1108 is the worked example of getting this wrong — its first fix updated
   * only the surface and the route stayed broken, because a request is resolved
   * against the manifest *before* it is sent, so an unadvertised wire never
   * reaches the arm that would answer it.
   */
  it('advertises the wire it answers, so the request resolves at all', () => {
    const advertised = Object.keys(FIXTURE_AGENTS[0]?.protocols?.protocols ?? {});
    expect(advertised).toContain('claude-code.conversation');
  });

  /**
   * The three item kinds, and the reason all three must be reachable.
   *
   * The transcript renders each kind differently and the tool kind is the one
   * that collapses into a `<details>`. An answer that could not produce every
   * kind would leave those renderings in no image, which is the same rule
   * `fixtureGit` follows for its statuses.
   */
  it('produces every item kind the transcript renders', async () => {
    const surface = fixtureConversationSurface('');
    const response = await surface.request<ClaudeCodeConversationResponse>(
      'claude-code.conversation',
      {},
    );
    expect(response.state).toBe('ready');
    const kinds = (response.items ?? []).map((item) => item.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant');
    expect(kinds).toContain('tool');
  });

  /**
   * Choosing from the candidate list has to actually resolve.
   *
   * `ambiguous` offers several conversations; picking one is the only way a
   * caller selects (`#1005` forbids picking by recency). A surface that kept
   * answering `ambiguous` after a selection would make the pick a dead control
   * — and a control that does nothing is a state the product does not have.
   */
  it('resolves the conversation a caller names, even under ambiguous', async () => {
    const surface = fixtureConversationSurface('?conversation=ambiguous');
    const ambiguous = await surface.request<ClaudeCodeConversationResponse>(
      'claude-code.conversation',
      {},
    );
    expect(ambiguous.state).toBe('ambiguous');
    const chosen = ambiguous.candidates?.[0]?.claude_session_id;
    expect(chosen).toBeDefined();

    const picked = await surface.request<ClaudeCodeConversationResponse>(
      'claude-code.conversation',
      { claude_session_id: chosen },
    );
    expect(picked.state).toBe('ready');
    expect(picked.conversation?.claude_session_id).toBe(chosen);
  });

  /**
   * The fallback the UI carries exists for a real case, so the fixture has to
   * produce it: a transcript with no recorded title (~3 of 14, measured).
   */
  it('can produce a conversation whose transcript recorded no title', async () => {
    const surface = fixtureConversationSurface('?conversation=untitled');
    const response = await surface.request<ClaudeCodeConversationResponse>(
      'claude-code.conversation',
      {},
    );
    expect(response.state).toBe('ready');
    const open = response.candidates?.find(
      (candidate) => candidate.claude_session_id === response.conversation?.claude_session_id,
    );
    expect(open).toBeDefined();
    expect(open?.title ?? null).toBeNull();
  });

  /**
   * The two states that carry nothing, asserted as such: `ConversationView`
   * branches on `state` and on whether a conversation resolved, so a fixture
   * that left a conversation behind in these answers would render the open body
   * instead of the notice — the state would be unreachable while looking set up.
   */
  it.each(['not_found', 'unavailable'])(
    'answers %s with no conversation and no items',
    async (scenario) => {
      const surface = fixtureConversationSurface(`?conversation=${scenario}`);
      const response = await surface.request<ClaudeCodeConversationResponse>(
        'claude-code.conversation',
        {},
      );
      expect(response.state).toBe(scenario);
      expect(response.conversation ?? null).toBeNull();
      expect(response.items ?? []).toEqual([]);
    },
  );

  /**
   * A wire it does not answer is rejected rather than answered with a shape.
   *
   * `claude-code.list` is a real, advertised wire that this surface is not the
   * answerer for — so the case is not hypothetical. A request resolves against
   * the manifest *before* it is sent, which is why the manifest advertising a
   * wire its surface does not handle is exactly how a caller reaches this arm.
   */
  it('rejects a wire it does not answer', async () => {
    const surface = fixtureConversationSurface('');
    await expect(surface.request('claude-code.list', {})).rejects.toThrow(
      /does not answer/,
    );
  });
});
