'use strict';
// #845 SC-06: commit refuses a stale reviewed state and creates no commit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createCommit,
  createSession,
  git,
  makeRepo,
  openStack,
  pass,
  revCount,
  run,
  stage,
  status,
} = require('../../../shared/git-write-cases.cjs');

run(async () => {
  const stack = await openStack();
  try {
    const dir = makeRepo(stack.runtime.home, 'sc06');
    const session = await createSession(stack, 'case-845-sc06', dir);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
    const reviewed = await status(stack, session);
    const staged = await stage(stack, session, 'a.txt', reviewed.snapshot.token);
    assert.equal(staged.state, 'ok', 'stage failed: ' + JSON.stringify(staged));

    // Another Terminal-side index change after the commit review.
    fs.writeFileSync(path.join(dir, 'b.txt'), 'other\n');
    git(dir, ['add', 'b.txt']);

    const refused = await createCommit(
      stack,
      session,
      staged.snapshot.token,
      'stale commit must not run',
      'case-845-sc06-stale',
    );
    assert.equal(refused.state, 'repository_changed', 'a stale commit must be refused: ' + JSON.stringify(refused));
    assert.equal(revCount(dir), 1, 'HEAD must not move after a stale refusal');
    assert.equal(
      git(dir, ['log', '-1', '--format=%s']),
      'initial',
      'the only commit must still be the fixture initial commit',
    );

    return pass(
      'A commit request holding the pre-edit snapshot was refused with repository_changed and created no commit.',
      [
        { type: 'protocol', value: 'git.create-commit with stale token -> state=repository_changed' },
        { type: 'runtime', value: 'git rev-list --count HEAD = 1 and HEAD subject = initial after the refusal' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
