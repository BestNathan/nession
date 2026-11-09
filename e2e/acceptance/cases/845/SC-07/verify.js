'use strict';
// #845 SC-07: commit reports the effective author identity it used, or a
// specific actionable missing-identity failure.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createCommit,
  createSession,
  head,
  makeRepo,
  openStack,
  pass,
  run,
  stage,
  status,
} = require('../../../shared/git-write-cases.cjs');

run(async () => {
  const stack = await openStack();
  try {
    const dir = makeRepo(stack.runtime.home, 'sc07');
    const session = await createSession(stack, 'case-845-sc07', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'committed\n');
    const reviewed = await status(stack, session);
    const staged = await stage(stack, session, 'a.txt', reviewed.snapshot.token);

    const committed = await createCommit(
      stack,
      session,
      staged.snapshot.token,
      'feat: identity proof',
      'case-845-sc07',
    );
    assert.equal(committed.state, 'ok', 'commit failed: ' + JSON.stringify(committed));
    assert.match(
      committed.commit.author,
      /^Acceptance Test <acceptance@example\.com>$/,
      'the answer must state the effective author, got ' + committed.commit.author,
    );
    assert.equal(head(dir), committed.commit.oid, 'the reported oid must be the new HEAD');

    // A repository whose configured name is explicitly empty cannot build an
    // identity; the failure must be specific, not a generic command error.
    const missingDir = makeRepo(stack.runtime.home, 'sc07-missing', {
      identity: null,
      unborn: true,
    });
    const missingSession = await createSession(stack, 'case-845-sc07-missing', missingDir);
    fs.writeFileSync(path.join(missingDir, 'a.txt'), 'one\n');
    const missingReviewed = await status(stack, missingSession);
    const missingStaged = await stage(
      stack,
      missingSession,
      'a.txt',
      missingReviewed.snapshot.token,
    );
    const missing = await createCommit(
      stack,
      missingSession,
      missingStaged.snapshot.token,
      'feat: no identity',
      'case-845-sc07-missing',
    );
    assert.equal(missing.state, 'missing_identity', 'expected missing_identity: ' + JSON.stringify(missing));
    assert.match(missing.message, /user\.name/, 'the failure must say what to configure');
    assert.match(missing.message, /user\.email/, 'the failure must say what to configure');

    return pass(
      'A real commit reported its effective author and new HEAD; a repository with no usable identity produced the specific missing_identity answer.',
      [
        { type: 'protocol', value: 'git.create-commit ok commit.author=Acceptance Test <acceptance@example.com> oid=' + committed.commit.oid },
        { type: 'protocol', value: 'second repository commit -> state=missing_identity naming user.name/user.email' },
        { type: 'runtime', value: 'git rev-parse HEAD equals the reported oid' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha },
      ],
    );
  } finally {
    stack.close();
  }
});
