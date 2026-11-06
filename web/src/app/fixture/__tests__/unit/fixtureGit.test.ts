import { describe, expect, it } from 'vitest';
import { fixtureGitSurface } from '@/app/fixture/fixtureGit';
import { FIXTURE_AGENTS } from '@/app/fixture/fixtureData';
import type {
  GitCommitResponse,
  GitDiffResponse,
  GitLogResponse,
  GitPreviewResponse,
} from '@/capabilities/git';

/**
 * The fixture's git surface is an *input*, so it has no rendering to look wrong.
 *
 * That is why the gap these tests cover went unnoticed for a merge: `git.commit`
 * was never answered, so the History detail could not render, and the only thing
 * that noticed was an e2e assertion three layers away (#1108).
 */
describe('fixture git surface', () => {
  /**
   * A wire lives in **two** places in this fixture: the manifest the agents
   * advertise, and the surface that answers it.
   *
   * `#1009`/`#1010` updated neither for `git.commit`, and the first fix for
   * `#1108` updated only the surface — the route stayed broken, because a
   * request is resolved against the manifest *before* it is sent, so an
   * unadvertised wire never reaches the arm that would answer it.
   *
   * Named as literals rather than driven from a table: `scripts/protocol-gate.mjs`
   * refuses a `request` call whose wire it cannot resolve, and it is right to —
   * a wire passed as a variable is the shape that hides a misspelling. The set
   * is written out for the same reason.
   */
  it('advertises every git wire it answers, so the request resolves at all', () => {
    const advertised = Object.keys(FIXTURE_AGENTS[0]?.protocols?.protocols ?? {});

    for (const wire of [
      'git.status',
      'git.diff',
      'git.preview',
      'git.log',
      'git.commit',
      'git.branches',
      'git.worktrees',
    ]) {
      expect(advertised, `${wire} is answered but not advertised`).toContain(wire);
    }
  });

  it('answers one preview shape for every row in the preview scenario', async () => {
    const surface = fixtureGitSurface('?capability=git&git=preview-states');

    const untracked = await surface.request<GitPreviewResponse>('git.preview', {
      path: 'notes/new.ts',
      expected: 'untracked',
    });
    expect(untracked.state).toBe('ok');
    if (untracked.state === 'ok') {
      expect(untracked.preview.state).toBe('ready');
      expect(untracked.preview.text).toContain('untracked');
    }

    const conflict = await surface.request<GitPreviewResponse>('git.preview', {
      path: 'src/conflict.ts',
      expected: 'unmerged',
    });
    expect(conflict.state).toBe('ok');
    if (conflict.state === 'ok') {
      expect(conflict.preview.text).toContain('<<<<<<< HEAD');
    }

    const missing = await surface.request<GitPreviewResponse>('git.preview', {
      path: 'src/missing.txt',
      expected: 'untracked',
    });
    expect(missing.state).toBe('ok');
    if (missing.state === 'ok') {
      expect(missing.preview.state).toBe('missing');
    }
  });

  /**
   * The detail answers about the same commit the log offers.
   *
   * The fixture's rule is that answers must be shapes the agent can produce;
   * this is that rule applied to a second question about one object. A row and
   * its detail that disagreed would be two confident renderings of one commit,
   * which is the failure neither view can see.
   */
  it('answers git.commit for a commit the log offers, and agrees with it', async () => {
    const surface = fixtureGitSurface('');
    const log = await surface.request<GitLogResponse>('git.log', {});
    expect(log.state).toBe('ok');
    if (log.state !== 'ok') {
      return;
    }
    const first = log.history.commits[0];

    const response = await surface.request<GitCommitResponse>('git.commit', {
      oid: first.hash,
    });

    expect(response.state).toBe('ok');
    if (response.state !== 'ok') {
      return;
    }
    expect(response.commit.oid).toBe(first.hash);
    expect(response.commit.subject).toBe(first.subject);
    expect(response.commit.shortOid).toBe(first.shortHash);
    // The detail's whole point since #1009/#1010 is that it shows what the
    // commit changed, so an empty file list would render the panel the old
    // "not shown here" note existed to explain.
    expect(response.commit.files.length).toBeGreaterThan(0);
  });

  /**
   * An unknown revision is an error, not an invented commit.
   *
   * The agent validates the object name and refuses one it cannot resolve, so a
   * fixture that answered anyway would let a view render a repository that
   * cannot exist — the rule the surface's own doc states.
   */
  it('answers an error for a revision it does not have', async () => {
    const surface = fixtureGitSurface('');

    const response = await surface.request<GitCommitResponse>('git.commit', {
      oid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });

    expect(response.state).toBe('error');
  });

  /**
   * The route that backs the renderer's state assertions names a repository,
   * not a rendering. This checks the repository exposes one file for each
   * answer the diff view has to distinguish, so a missing fixture fails here
   * rather than as a mysterious count in a browser assertion.
   */
  it('answers one diff per state the renderer must distinguish', async () => {
    const surface = fixtureGitSurface('?capability=git&git=diff-states');
    const paths = [
      'web/src/capabilities/git/GitPlugin.ts',
      'assets/logo.png',
      'mode/run.sh',
      'src/empty.txt',
      'src/large.ts',
      'src/long.ts',
      'src/malformed.ts',
    ];

    const answers = await Promise.all(
      paths.map((path) => surface.request<GitDiffResponse>('git.diff', { path })),
    );

    expect(answers.every((answer) => answer.state === 'ok')).toBe(true);
    const diffs = answers.map((answer) => (answer.state === 'ok' ? answer.diff : null));
    expect(diffs[1]?.binary).toBe(true);
    expect(diffs[2]?.text).toContain('old mode');
    expect(diffs[3]?.text).toBe('');
    expect(diffs[4]?.truncated).toBe(true);
    expect(diffs[4]?.truncated_bytes).toBe(4096);
    expect(diffs[5]?.text).toContain('@@ -1,100 +1,101 @@');
    expect(diffs[5]?.text.split('\n').length).toBeGreaterThan(100);
    expect(diffs[6]?.text).toContain('@@ -1,2 +1,2 @@');
  });
});
