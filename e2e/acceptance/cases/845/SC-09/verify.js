'use strict';
// #845 SC-09: a retry after a lost response cannot create the same commit
// twice — the repeated request id replays the first answer.
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
  revCount,
  run,
  stage,
  status,
} = require('../../../shared/git-write-cases.cjs');

run(async () => {
  const stack = await openStack();
  try {
    const dir = makeRepo(stack.runtime.home, 'sc09');
    const session = await createSession(stack, 'case-845-sc09', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'committed\n');
    const reviewed = await status(stack, session);
    const staged = await stage(stack, session, 'a.txt', reviewed.snapshot.token);

    const request = {
      message: 'feat: one commit',
      requestId: 'case-845-sc09-commit',
    };
    const first = await createCommit(
      stack,
      session,
      staged.snapshot.token,
      request.message,
      request.requestId,
    );
    assert.equal(first.state, 'ok', 'first commit failed: ' + JSON.stringify(first));
    const firstOid = first.commit.oid;
    assert.equal(revCount(dir), 2, 'the first commit must exist');

    const retried = await createCommit(
      stack,
      session,
      staged.snapshot.token,
      request.message,
      request.requestId,
    );
    assert.equal(retried.state, 'ok', 'the retry must replay the outcome: ' + JSON.stringify(retried));
    assert.equal(retried.commit.oid, firstOid, 'the retry must report the same commit');
    assert.equal(revCount(dir), 2, 'the retry must not create a second commit');
    assert.equal(head(dir), firstOid, 'HEAD must still be the first commit');

    return pass(
      'A commit retried with the same request id returned the first oid and left exactly one new commit in history.',
      [
        { type: 'protocol', value: 'git.create-commit requestId=case-845-sc09-commit replayed oid=' + firstOid },
        { type: 'runtime', value: 'git rev-list --count HEAD = 2 after the retry (initial + one commit)' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
