import { describe, expect, it } from 'vitest';
import { fixtureTranscriptsSurface } from '@/app/fixture/fixtureTranscripts';
import { FIXTURE_AGENTS } from '@/app/fixture/fixtureData';
import type { TranscriptsResponse } from '@/generated/protocol/claude-code/transcripts/v1';
import type { TranscriptItemsResponse } from '@/generated/protocol/claude-code/transcript-items/v1';

/**
 * The fixture's transcript surface is an *input*, so it has no rendering to look
 * wrong — the same blind spot `#1128` left the conversation surface in for three
 * PRs.
 *
 * These are the two halves of that. **A wire lives in two places**: the manifest
 * the agents advertise, and the surface that answers it. `#1108` cost two
 * commits because only one was updated — a request is resolved against the
 * manifest *before* it is sent, so an unadvertised wire never reaches the arm
 * that would answer it, and the route looks wired while answering nothing. That
 * failure presents as "nothing happened" rather than as an error, which is why it
 * is asserted here rather than trusted.
 */
describe('fixture transcript surface', () => {
  const surface = fixtureTranscriptsSurface('');

  it('advertises the transcript wires it answers', () => {
    const advertised = Object.keys(FIXTURE_AGENTS[0]?.protocols?.protocols ?? {});
    expect(advertised, 'claude-code.transcripts is answered but not advertised').toContain(
      'claude-code.transcripts',
    );
    expect(
      advertised,
      'claude-code.transcript-items is answered but not advertised',
    ).toContain('claude-code.transcript-items');
  });

  it('lists a session and the subagents it spawned, with the relation intact', async () => {
    const response = await surface.request<TranscriptsResponse>('claude-code.transcripts', {});

    expect(response.state).toBe('ready');
    const items = response.items ?? [];
    expect(items.map((item) => item.kind)).toContain('primary');
    expect(items.map((item) => item.kind)).toContain('sidechain');

    // The relation is the whole reason a subagent is listable without a tree
    // UI: dropping `parent_id` would leave transcripts that belong to something
    // and do not say what.
    const sidechain = items.find((item) => item.kind === 'sidechain');
    expect(sidechain?.parent_id).toBeTruthy();
    expect(sidechain?.agent_id).toBeTruthy();
  });

  it('answers a timeline with every broad kind the contract stabilizes', async () => {
    // The point of a transcript fixture rather than a conversation one. The
    // conversation projection hides reasoning, attachments, events, metadata
    // and unknown records entirely, so a fixture producing only messages and
    // tools would let the whole timeline render as a conversation and pass.
    const response = await surface.request<TranscriptItemsResponse>(
      'claude-code.transcript-items',
      { transcript_id: 'a1b2c3d4-0000-4000-8000-000000000001' },
    );

    expect(response.state).toBe('ready');
    const kinds = new Set((response.items ?? []).map((item) => item.kind));
    for (const kind of [
      'message',
      'tool',
      'reasoning',
      'attachment',
      'event',
      'metadata',
      'unknown',
    ]) {
      expect(kinds, `the fixture never produces a ${kind} item`).toContain(kind);
    }
  });

  it('includes the states a timeline has to survive rather than only the happy one', async () => {
    // A fixture of whole bodies and complete records would let a client forget
    // both flags exist. The wire cuts attachment bodies (measured max 1.2 MB)
    // and reports a half-written tail; the fixture must produce both.
    const response = await surface.request<TranscriptItemsResponse>(
      'claude-code.transcript-items',
      { transcript_id: 'a1b2c3d4-0000-4000-8000-000000000001' },
    );

    const items = response.items ?? [];
    expect(
      items.some(
        (item) => item.kind === 'attachment' && item.payload?.truncated === true,
      ),
      'no truncated body — a client could forget the flag',
    ).toBe(true);
    expect(
      items.some((item) => item.kind === 'tool' && item.tool.status === 'running'),
      'no in-flight tool — a client could forget that state',
    ).toBe(true);

    const partial = await fixtureTranscriptsSurface('?transcripts=partial').request<
      TranscriptItemsResponse
    >('claude-code.transcript-items', { transcript_id: 'a1b2c3d4-0000-4000-8000-000000000001' });
    expect(partial.partial_tail).toBe(true);
  });

  it('answers not_found for an id it does not model, and names no substitute', async () => {
    // The contract's substitution ban, and the one thing this surface must not
    // paper over: a request that names a transcript must never be answered with
    // a different one.
    const response = await surface.request<TranscriptItemsResponse>(
      'claude-code.transcript-items',
      { transcript_id: 'not-a-transcript' },
    );

    expect(response.state).toBe('not_found');
    expect(response.transcript).toBeUndefined();
    expect(response.items ?? []).toHaveLength(0);
    expect(response.stats).toBeUndefined();
  });

  it('answers unavailable rather than an empty list when the cwd cannot be established', async () => {
    const unavailable = fixtureTranscriptsSurface('?transcripts=unavailable');
    const list = await unavailable.request<TranscriptsResponse>('claude-code.transcripts', {});
    expect(list.state).toBe('unavailable');
    expect(list.items ?? []).toHaveLength(0);
  });

  it('rejects a scenario it does not model, rather than answering something plausible', async () => {
    // A surface that silently answered the default would make every unmodelled
    // route photograph as a working screen.
    await expect(
      fixtureTranscriptsSurface('?transcripts=nonsense').request('claude-code.transcripts', {}),
    ).rejects.toThrow('does not model ?transcripts=nonsense');
  });

  it('answers every scenario it names on both halves, not just the one that renders first', async () => {
    // The scenario list is the fixture's own contract, and it is easy to model
    // one half of a scenario and not the other: the two halves live in two
    // functions and the list is what the view asks for first, so a gap there
    // hides the scenario behind an error screen rather than failing loudly.
    const scenarios = ['ready', 'unbound', 'none', 'unavailable', 'partial'];
    for (const scenario of scenarios) {
      const scoped = fixtureTranscriptsSurface(`?transcripts=${scenario}`);
      const list = await scoped.request<TranscriptsResponse>('claude-code.transcripts', {});
      expect(list.state, `?transcripts=${scenario} list`).toBeTruthy();

      const timeline = await scoped.request<TranscriptItemsResponse>(
        'claude-code.transcript-items',
        { transcript_id: 'a1b2c3d4-0000-4000-8000-000000000001' },
      );
      expect(timeline.state, `?transcripts=${scenario} timeline`).toBeTruthy();
    }
  });

  it('models a cut body that could actually overflow, not a stub', async () => {
    // The fixture carries a `truncated` body so a client cannot forget the flag
    // exists — but a stub carries the flag and still proves nothing about the
    // layout: a body with no unbroken run long enough to overflow cannot fail a
    // wrapping rule, so a client that dropped `break-words` would look
    // identical. Measured, the real thing is a 1.2 MB tail cut at 8 KB, so the
    // fixture has to be awkward in the same way.
    const response = await surface.request<TranscriptItemsResponse>(
      'claude-code.transcript-items',
      { transcript_id: 'a1b2c3d4-0000-4000-8000-000000000001' },
    );
    const cut = (response.items ?? []).find(
      (entry) => entry.kind === 'attachment' && entry.payload?.truncated,
    );
    expect(cut, 'no truncated attachment in the timeline').toBeTruthy();
    const text = cut?.kind === 'attachment' ? (cut.payload?.text ?? '') : '';

    const longestRun = Math.max(...text.split(/\s+/).map((run) => run.length));
    expect(longestRun, 'no unbroken run long enough to overflow a pane').toBeGreaterThan(200);
    expect(text.length, 'body too short to be worth a ceiling').toBeGreaterThan(1000);
  });

  it('models the partial tail as a timeline fact, with the list still intact', async () => {
    const partial = fixtureTranscriptsSurface('?transcripts=partial');
    const list = await partial.request<TranscriptsResponse>('claude-code.transcripts', {});
    // A partial tail is a fact about a transcript's *content* — the file ended
    // mid-record — not about which transcripts exist, so the list is unchanged.
    expect(list.state).toBe('ready');
    expect((list.items ?? []).length).toBeGreaterThan(0);

    const timeline = await partial.request<TranscriptItemsResponse>(
      'claude-code.transcript-items',
      { transcript_id: 'a1b2c3d4-0000-4000-8000-000000000001' },
    );
    expect(timeline.partial_tail).toBe(true);
  });
});
