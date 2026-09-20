import { describe, expect, it } from 'vitest';
import {
  classifyDiffLine,
  describeStatus,
  describeUnavailable,
  formatBytes,
  isSelectable,
  statusRows,
} from '@/capabilities/git/state';
import type { GitStatus, GitUnavailable } from '@/capabilities/git/types';

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    detached: false,
    ahead: 0,
    behind: 0,
    modified: [],
    untracked: [],
    unmerged: [],
    ...overrides,
  };
}

describe('statusRows', () => {
  it('groups changed and untracked files without merging them', () => {
    const rows = statusRows(
      status({
        modified: [
          {
            path: 'src/a.ts',
            kind: 'modified',
            staged: false,
            unstaged: true,
          },
        ],
        untracked: ['notes.txt'],
      }),
    );

    expect(rows.map((row) => row.kind)).toEqual(['tracked', 'untracked']);
  });

  it('lists conflicts before ordinary changes', () => {
    const rows = statusRows(
      status({
        unmerged: ['both.ts'],
        modified: [
          { path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true },
        ],
      }),
    );
    expect(rows[0]).toEqual({ kind: 'unmerged', path: 'both.ts' });
  });
});

describe('isSelectable', () => {
  it('makes a tracked change openable and an untracked file not (#750 SC2)', () => {
    // The rule the view is built on: an untracked path has no diff — `git diff
    // HEAD -- <untracked>` exits 0 with no output — so it must not present a
    // control that opens onto an empty pane.
    const rows = statusRows(
      status({
        modified: [
          { path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true },
        ],
        untracked: ['notes.txt'],
        unmerged: ['both.ts'],
      }),
    );

    expect(rows.filter(isSelectable).map((row) => row.path)).toEqual(['src/a.ts']);
  });
});

describe('describeStatus', () => {
  it('calls a clean tree clean, with no decoration (#750 C5)', () => {
    expect(describeStatus(status())).toBe('Working tree clean');
  });

  it('counts ahead and behind only when they are non-zero', () => {
    expect(describeStatus(status({ ahead: 2 }))).toBe('2 ahead');
    expect(describeStatus(status({ behind: 1, ahead: 0 }))).toBe('1 behind');
  });

  it('reports a conflict in its own words rather than as a modified file', () => {
    // The edge case the issue names: a merge in progress must not be presented
    // as an ordinary change set.
    const text = describeStatus(status({ unmerged: ['both.ts'], modified: [] }));
    expect(text).toBe('1 conflicted file');
  });

  it('singularises one and pluralises many', () => {
    const modified = [
      { path: 'a', kind: 'modified' as const, staged: false, unstaged: true },
      { path: 'b', kind: 'modified' as const, staged: false, unstaged: true },
    ];
    expect(describeStatus(status({ modified }))).toBe('2 changed files');
    expect(describeStatus(status({ modified: modified.slice(0, 1) }))).toBe('1 changed file');
    expect(describeStatus(status({ untracked: ['x'] }))).toBe('1 untracked file');
  });

  it('joins the parts without collapsing them', () => {
    expect(
      describeStatus(
        status({
          ahead: 1,
          untracked: ['x'],
          modified: [{ path: 'a', kind: 'modified', staged: false, unstaged: true }],
        }),
      ),
    ).toBe('1 ahead, 1 changed file, 1 untracked file');
  });
});

describe('describeUnavailable', () => {
  it('tells "no git installed" apart from "not a repository" (#750 SC4)', () => {
    const noTool: GitUnavailable = {
      state: 'unavailable',
      reason: 'git_not_installed',
      message: 'git is not available on this host.',
    };
    const noRepo: GitUnavailable = {
      state: 'not_a_repository',
      message: 'not a git repository',
    };

    const tool = describeUnavailable(noTool);
    const repo = describeUnavailable(noRepo);

    expect(tool.title).not.toBe(repo.title);
    // Different problems, different fixes — the tool one points at the host,
    // the repository one at the directory.
    expect(tool.detail).toMatch(/install git/i);
    expect(repo.detail).not.toBe(tool.detail);

    // This used to assert `repo.detail` matched /directory/i, which came from
    // `UNAVAILABLE_DETAILS` — reachable only while `message` was optional in
    // the hand-written mirror. The contract requires it on every non-ok answer,
    // so the agent's own message is what a reader sees. Whether Nession's
    // curated copy is better than git's is a product question, and
    // `UNAVAILABLE_DETAILS` is now the fallback for a peer that omits the
    // field rather than the usual path.
    expect(repo.detail).toBe('not a git repository');
  });

  it('tells an unresolvable session apart from both', () => {
    const copy = describeUnavailable({
      state: 'unavailable',
      reason: 'session_workdir_unknown',
      message: "could not resolve this Session's working directory",
    });
    expect(copy.title).toMatch(/can't find this Session's directory/i);
    expect(copy.detail).toMatch(/may have exited/i);
  });

  it('keeps the agent’s own message for an error state', () => {
    const copy = describeUnavailable({
      state: 'error',
      message: 'fatal: detected dubious ownership in repository',
    });
    expect(copy.detail).toBe('fatal: detected dubious ownership in repository');
  });

  it('gives every state a non-empty title', () => {
    // `message` is required on every non-ok variant — the contract says the
    // agent always explains itself, and the hand-written mirror this replaced
    // had it optional, which is why these could be built without one.
    const answers: GitUnavailable[] = [
      { state: 'unavailable', reason: 'other', message: 'unknown' },
      { state: 'not_a_repository', message: 'not a git repository' },
      { state: 'error', message: 'fatal: something' },
    ];
    for (const answer of answers) {
      expect(describeUnavailable(answer).title.length).toBeGreaterThan(0);
    }
  });
});

describe('classifyDiffLine', () => {
  it('reads +++/--- as headers, not as added and removed lines', () => {
    // `+++ b/file` starts with `+` and `--- a/file` starts with `-`; classifying
    // them as changes would paint the file headers as a change that is not there.
    expect(classifyDiffLine('+++ b/src/a.ts')).toBe('meta');
    expect(classifyDiffLine('--- a/src/a.ts')).toBe('meta');
    expect(classifyDiffLine('@@ -1,3 +1,4 @@')).toBe('meta');
  });

  it('classifies real changes', () => {
    expect(classifyDiffLine('+const a = 1;')).toBe('added');
    expect(classifyDiffLine('-const a = 0;')).toBe('removed');
    expect(classifyDiffLine(' context')).toBe('context');
  });
});

describe('formatBytes', () => {
  it('scales to the unit a person reads', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
