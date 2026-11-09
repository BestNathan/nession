'use strict';
// #845 SC-12: the existing read-only Git behaviour still answers when no
// mutation is invoked — under both contract generations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSession,
  git,
  gitAsk,
  makeRepo,
  openStack,
  pass,
  revCount,
  run,
  status,
} = require('../../../shared/git-write-cases.cjs');

run(async () => {
  const stack = await openStack();
  try {
    const dir = makeRepo(stack.runtime.home, 'sc12');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    const session = await createSession(stack, 'case-845-sc12', dir);
    const before = git(dir, ['status', '--porcelain']);

    const v1 = await gitAsk(stack, 'git.status', { session, contract_version: 1 });
    assert.equal(v1.state, 'ok', 'v1 status must answer: ' + JSON.stringify(v1));
    assert.equal(v1.snapshot, undefined, 'v1 must not grow the v2 snapshot field');
    assert.equal(v1.status.branch, 'main');
    assert.equal(v1.root.endsWith('git-write-sc12'), true, 'v1 must still report the work tree');

    const v1Diff = await gitAsk(stack, 'git.diff', {
      session,
      contract_version: 1,
      path: 'a.txt',
    });
    assert.equal(v1Diff.state, 'ok', 'v1 diff must answer: ' + JSON.stringify(v1Diff));
    assert.equal(v1Diff.snapshot, undefined, 'v1 diff must not grow the snapshot field');
    assert.ok(v1Diff.diff.text.includes('+changed'));

    for (const wire of ['git.log', 'git.branches', 'git.worktrees', 'git.root']) {
      const response = await gitAsk(stack, wire, { session, contract_version: 1 });
      assert.equal(response.state, 'ok', wire + ' must answer: ' + JSON.stringify(response));
    }

    const v2 = await status(stack, session);
    assert.ok(v2.snapshot.token, 'the v2 read still works beside the v1 read');
    assert.equal(revCount(dir), 1, 'no read may create a commit');
    assert.equal(git(dir, ['status', '--porcelain']), before, 'no read may change repository state');

    return pass(
      'v1 status/diff and the other read units still answered on the real stack, and no read changed HEAD or the worktree.',
      [
        { type: 'protocol', value: 'git.status v1 ok without snapshot; branch=main root=...git-write-sc12' },
        { type: 'protocol', value: 'git.diff v1 ok without snapshot; text contains +changed' },
        { type: 'protocol', value: 'git.log/git.branches/git.worktrees/git.root v1 all state=ok' },
        { type: 'runtime', value: 'rev count stayed 1 and git status --porcelain was byte-identical after the reads' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha },
      ],
    );
  } finally {
    stack.close();
  }
});
