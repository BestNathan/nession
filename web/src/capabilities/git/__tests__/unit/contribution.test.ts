import { describe, expect, it } from 'vitest';
import { GIT_ID, GIT_TITLE, gitView, resolveGitState } from '@/capabilities/git';

describe('git contribution', () => {
  it('registers under a stable id and a human title', () => {
    expect(GIT_ID).toBe('git');
    expect(GIT_TITLE).toBe('Git');
    expect(gitView.id).toBe(GIT_ID);
  });

  it('is unavailable without a Session and available with one', () => {
    expect(resolveGitState(undefined)).toBe('unavailable');
    expect(resolveGitState('a1:work')).toBe('available');
  });

  it('stays available rather than guessing at a repository (#750 SC4)', () => {
    // Whether the Session sits in a repository is an answer only the agent can
    // give, and it costs a round trip. Presence must not collapse "no git
    // installed", "not a repository" and "cannot tell" into one silent absence —
    // the view is what reports them, so the capability stays reachable.
    expect(resolveGitState('a1:work')).not.toBe('unavailable');
  });

  it('draws the same view in both experiences', () => {
    // Git's Web/App difference is the chrome around it, which the experience
    // compositions own — not something this binding branches on.
    expect(gitView.layout.web).toBe(gitView.layout.app);
  });
});
