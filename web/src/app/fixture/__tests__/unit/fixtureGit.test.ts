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
    expect(response.commit.short_oid).toBe(first.short_hash);
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

  /**
   * #2972: the first selection read is held so a reselection can answer first.
   * The Case (not a timer) decides when the older answer settles.
   */
  it('holds the first selection diff and lets a same-row reselection win (#2972)', async () => {
    const globalRecord = globalThis as unknown as { window?: unknown };
    const hadWindow = 'window' in globalRecord;
    const previousWindow = globalRecord.window;
    const fakeWindow: Record<string, unknown> = {};
    globalRecord.window = fakeWindow;
    try {
      const surface = fixtureGitSurface('?capability=git&git=selection-overlap');
      const first = surface.request<GitDiffResponse>('git.diff', { path: 'src/reselect.ts' });
      const second = await surface.request<GitDiffResponse>('git.diff', {
        path: 'src/reselect.ts',
      });
      expect(second.state).toBe('ok');
      if (second.state === 'ok') {
        expect(second.diff.text).toContain('NEW_DIFF_RESPONSE');
      }
      const control = fakeWindow.fixtureGitSelectionOverlap as {
        diffRequests: () => number;
        olderDiffSettled: () => boolean;
        releaseOlderDiff: (fail?: boolean) => void;
      };
      expect(control.diffRequests()).toBe(2);
      control.releaseOlderDiff(false);
      const older = await first;
      expect(older.state).toBe('ok');
      if (older.state === 'ok') {
        expect(older.diff.text).toContain('OLD_DIFF_RESPONSE');
        expect(older.diff.truncated).toBe(true);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(control.olderDiffSettled()).toBe(true);
    } finally {
      if (hadWindow) {
        globalRecord.window = previousWindow;
      } else {
        delete globalRecord.window;
      }
    }
  });

  it('holds the first selection preview and lets a same-row reselection win (#2972)', async () => {
    const globalRecord = globalThis as unknown as { window?: unknown };
    const hadWindow = 'window' in globalRecord;
    const previousWindow = globalRecord.window;
    const fakeWindow: Record<string, unknown> = {};
    globalRecord.window = fakeWindow;
    try {
      const surface = fixtureGitSurface('?capability=git&git=selection-overlap');
      const first = surface.request<GitPreviewResponse>('git.preview', {
        path: 'notes/reselect.ts',
        expected: 'untracked',
        want: 'text',
      });
      const second = await surface.request<GitPreviewResponse>('git.preview', {
        path: 'notes/reselect.ts',
        expected: 'untracked',
        want: 'text',
      });
      expect(second.state).toBe('ok');
      if (second.state === 'ok') {
        expect(second.preview.text).toContain('NEW_PREVIEW_RESPONSE notes/reselect.ts');
      }
      const control = fakeWindow.fixtureGitSelectionOverlap as {
        previewRequests: () => number;
        olderPreviewSettled: () => boolean;
        releaseOlderPreview: (fail?: boolean) => void;
      };
      expect(control.previewRequests()).toBe(2);
      control.releaseOlderPreview(false);
      const older = await first;
      expect(older.state).toBe('ok');
      if (older.state === 'ok') {
        expect(older.preview.text).toContain('OLD_PREVIEW_RESPONSE notes/reselect.ts');
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(control.olderPreviewSettled()).toBe(true);
    } finally {
      if (hadWindow) {
        globalRecord.window = previousWindow;
      } else {
        delete globalRecord.window;
      }
    }
  });

  /**
   * #3751: the History pagination scenario needs two Sessions whose histories
   * are distinguishable, pageable by cursor, and reproducible when a first page
   * is refreshed. The Case, not a timer, decides when the held older page
   * settles.
   */
  it('serves per-Session pageable histories and holds the first older page (#3751)', async () => {
    const globalRecord = globalThis as unknown as { window?: unknown };
    const hadWindow = 'window' in globalRecord;
    const previousWindow = globalRecord.window;
    const fakeWindow: Record<string, unknown> = {};
    globalRecord.window = fakeWindow;
    try {
      const surface = fixtureGitSurface('?capability=git&git=history-overlap');
      const sessionA = 'devbox-01:fix-terminal-reconnect';
      const sessionB = 'devbox-01:design-system';

      const first = await surface.request<GitLogResponse>('git.log', { session: sessionA });
      expect(first.state).toBe('ok');
      if (first.state !== 'ok') {
        return;
      }
      expect(first.history.commits).toHaveLength(50);
      expect(first.history.commits[0]?.subject).toContain('A first page 1 commit 1');
      expect(first.history.end_of_history).toBe(false);
      const cursor = first.history.next_cursor;
      // A cursor is what the agent returns: a commit OID.
      expect(cursor).toMatch(/^[0-9a-f]{40}$/);

      // The first older page is held; the next one answers immediately so a
      // Case can prove a normal continuation still appends.
      const held = surface.request<GitLogResponse>('git.log', {
        session: sessionA,
        before: cursor,
      });
      const immediate = await surface.request<GitLogResponse>('git.log', {
        session: sessionA,
        before: cursor,
      });
      expect(immediate.state).toBe('ok');
      if (immediate.state !== 'ok') {
        return;
      }
      expect(immediate.history.commits[0]?.subject).toContain('A older page 1 commit 1');
      expect(immediate.history.end_of_history).toBe(true);

      const control = fakeWindow.fixtureGitHistoryOverlap as {
        firstPageRequests: (session: string) => number;
        olderRequests: () => number;
        olderSettled: () => boolean;
        releaseOlder: () => void;
      };
      expect(control.olderRequests()).toBe(2);
      expect(control.firstPageRequests(sessionA)).toBe(1);

      control.releaseOlder();
      const older = await held;
      expect(older.state).toBe('ok');
      if (older.state === 'ok') {
        expect(older.history.commits[0]?.subject).toContain('A older page 1 commit 1');
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(control.olderSettled()).toBe(true);

      // A refresh is the next first-page generation; B is its own generation.
      const refreshed = await surface.request<GitLogResponse>('git.log', {
        session: sessionA,
      });
      expect(refreshed.state).toBe('ok');
      if (refreshed.state === 'ok') {
        expect(refreshed.history.commits[0]?.subject).toContain('A first page 2 commit 1');
        expect(refreshed.history.next_cursor).toMatch(/^[0-9a-f]{40}$/);
        expect(refreshed.history.next_cursor).not.toBe(cursor);
      }
      expect(control.firstPageRequests(sessionA)).toBe(2);

      const sessionBFirst = await surface.request<GitLogResponse>('git.log', {
        session: sessionB,
      });
      expect(sessionBFirst.state).toBe('ok');
      if (sessionBFirst.state === 'ok') {
        expect(sessionBFirst.history.commits[0]?.subject).toContain('B first page 1 commit 1');
        expect(sessionBFirst.history.next_cursor).toMatch(/^[0-9a-f]{40}$/);
        expect(sessionBFirst.history.next_cursor).not.toBe(cursor);
      }
    } finally {
      if (hadWindow) {
        globalRecord.window = previousWindow;
      } else {
        delete globalRecord.window;
      }
    }
  });

  /**
   * #4116: the failure-feedback Case needs the held older page to settle as a
   * rejection, not an error-shaped answer — the hook's catch path is what the
   * browser asserts. The retry after a failure is the next older request, which
   * answers immediately, and `olderSettled` still flips only after a macrotask.
   */
  it('rejects the held older page on demand and serves the retry (#4116)', async () => {
    const globalRecord = globalThis as unknown as { window?: unknown };
    const hadWindow = 'window' in globalRecord;
    const previousWindow = globalRecord.window;
    const fakeWindow: Record<string, unknown> = {};
    globalRecord.window = fakeWindow;
    try {
      const surface = fixtureGitSurface('?capability=git&git=history-overlap');
      const session = 'devbox-01:fix-terminal-reconnect';

      const first = await surface.request<GitLogResponse>('git.log', { session });
      expect(first.state).toBe('ok');
      if (first.state !== 'ok') {
        return;
      }
      const cursor = first.history.next_cursor;

      const held = surface.request<GitLogResponse>('git.log', {
        session,
        before: cursor,
      });
      const control = fakeWindow.fixtureGitHistoryOverlap as {
        olderRequests: () => number;
        olderSettled: () => boolean;
        releaseOlder: (outcome?: 'page' | 'reject' | 'not_a_repository') => void;
      };
      expect(control.olderRequests()).toBe(1);
      expect(control.olderSettled()).toBe(false);

      control.releaseOlder('reject');
      await expect(held).rejects.toThrow('the held older page failed');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(control.olderSettled()).toBe(true);

      // The retry is a fresh older request from the same retained cursor; the
      // fixture answers it with the page the failed read never delivered.
      const retry = await surface.request<GitLogResponse>('git.log', {
        session,
        before: cursor,
      });
      expect(retry.state).toBe('ok');
      if (retry.state === 'ok') {
        expect(retry.history.commits).toHaveLength(50);
        expect(retry.history.commits[0]?.subject).toContain('A older page 1 commit 1');
        expect(retry.history.end_of_history).toBe(true);
      }
      expect(control.olderRequests()).toBe(2);
    } finally {
      if (hadWindow) {
        globalRecord.window = previousWindow;
      } else {
        delete globalRecord.window;
      }
    }
  });

  /**
   * #4116: a continuation can also resolve with a normal non-ok answer — the
   * repository or Session directory went away — and that is a domain answer,
   * not a transport failure. The fixture must be able to produce it so the
   * rendered explanation/retry is provable in the browser.
   */
  it('answers the held older page with a fulfilled non-ok domain answer (#4116)', async () => {
    const globalRecord = globalThis as unknown as { window?: unknown };
    const hadWindow = 'window' in globalRecord;
    const previousWindow = globalRecord.window;
    const fakeWindow: Record<string, unknown> = {};
    globalRecord.window = fakeWindow;
    try {
      const surface = fixtureGitSurface('?capability=git&git=history-overlap');
      const session = 'devbox-01:fix-terminal-reconnect';

      const first = await surface.request<GitLogResponse>('git.log', { session });
      expect(first.state).toBe('ok');
      if (first.state !== 'ok') {
        return;
      }
      const cursor = first.history.next_cursor;

      const held = surface.request<GitLogResponse>('git.log', {
        session,
        before: cursor,
      });
      const control = fakeWindow.fixtureGitHistoryOverlap as {
        olderRequests: () => number;
        olderSettled: () => boolean;
        releaseOlder: (outcome?: 'page' | 'reject' | 'not_a_repository') => void;
      };
      expect(control.olderRequests()).toBe(1);

      control.releaseOlder('not_a_repository');
      await expect(held).resolves.toEqual({
        state: 'not_a_repository',
        message: 'the Session directory is no longer a git repository',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(control.olderSettled()).toBe(true);

      // The retained cursor still addresses the page the unavailable answer
      // never delivered: retry is the next older request, answered normally.
      const retry = await surface.request<GitLogResponse>('git.log', {
        session,
        before: cursor,
      });
      expect(retry.state).toBe('ok');
      if (retry.state === 'ok') {
        expect(retry.history.commits).toHaveLength(50);
        expect(retry.history.commits[0]?.subject).toContain('A older page 1 commit 1');
        expect(retry.history.end_of_history).toBe(true);
      }
      expect(control.olderRequests()).toBe(2);
    } finally {
      if (hadWindow) {
        globalRecord.window = previousWindow;
      } else {
        delete globalRecord.window;
      }
    }
  });

  /**
   * #3767: the selection Case must prove which target and OID a detail or
   * commit-sourced diff read was addressed to. The surface records each read,
   * answers a commit only when one of its served pages listed it, and refuses
   * an object name it never offered.
   */
  it('records detail and diff targets, and refuses a commit it never served (#3767)', async () => {
    const globalRecord = globalThis as unknown as { window?: unknown };
    const hadWindow = 'window' in globalRecord;
    const previousWindow = globalRecord.window;
    const fakeWindow: Record<string, unknown> = {};
    globalRecord.window = fakeWindow;
    try {
      const surface = fixtureGitSurface('?capability=git&git=history-overlap');
      const session = 'devbox-01:fix-terminal-reconnect';
      const unknownOid = 'f'.repeat(40);

      const first = await surface.request<GitLogResponse>('git.log', { session });
      expect(first.state).toBe('ok');
      if (first.state !== 'ok') {
        return;
      }
      const row = first.history.commits[0];
      expect(row).toBeDefined();
      if (!row) {
        return;
      }

      const detail = await surface.request<GitCommitResponse>('git.commit', {
        agent_id: 'devbox-01',
        session,
        oid: row.hash,
      });
      expect(detail.state).toBe('ok');
      if (detail.state === 'ok') {
        expect(detail.commit.subject).toBe(row.subject);
        expect(detail.commit.files[0]?.path).toBe('src/a-history-overlap.ts');
      }

      const diff = await surface.request<GitDiffResponse>('git.diff', {
        agent_id: 'devbox-01',
        session,
        path: 'src/a-history-overlap.ts',
        source: { kind: 'commit', oid: row.hash },
      });
      expect(diff.state).toBe('ok');

      const unknown = await surface.request<GitCommitResponse>('git.commit', {
        agent_id: 'devbox-01',
        session: 'devbox-01:design-system',
        oid: unknownOid,
      });
      expect(unknown).toEqual({
        state: 'error',
        message: `unknown revision: ${unknownOid}`,
      });

      const control = fakeWindow.fixtureGitHistoryOverlap as {
        commitRequests: () => readonly { agent_id: string; session: string; oid: string }[];
        diffRequests: () => readonly {
          agent_id: string;
          session: string;
          oid: string;
          path: string;
        }[];
      };
      expect(control.commitRequests()).toEqual([
        { agent_id: 'devbox-01', session, oid: row.hash },
        { agent_id: 'devbox-01', session: 'devbox-01:design-system', oid: unknownOid },
      ]);
      expect(control.diffRequests()).toEqual([
        {
          agent_id: 'devbox-01',
          session,
          oid: row.hash,
          path: 'src/a-history-overlap.ts',
        },
      ]);
    } finally {
      if (hadWindow) {
        globalRecord.window = previousWindow;
      } else {
        delete globalRecord.window;
      }
    }
  });
});
