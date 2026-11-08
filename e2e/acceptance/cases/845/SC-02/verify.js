'use strict';
// #845 SC-02: status responses expose an opaque repository snapshot suitable
// for optimistic concurrency: stable while the state is stable, different when
// it changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSession,
  makeRepo,
  openStack,
  pass,
  run,
  status,
} = require('../../../shared/git-write-cases.cjs');

run(async () => {
  const stack = await openStack();
  try {
    const dir = makeRepo(stack.runtime.home, 'sc02');
    const session = await createSession(stack, 'case-845-sc02', dir);

    const first = await status(stack, session);
    assert.equal(typeof first.snapshot.token, 'string');
    assert.ok(first.snapshot.token.length > 0, 'the token must not be empty');
    assert.match(first.snapshot.head, /^[0-9a-f]{40}$/, 'HEAD identity must be the commit id');

    const second = await status(stack, session);
    assert.equal(second.snapshot.token, first.snapshot.token, 'unchanged state must keep its token');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    const third = await status(stack, session);
    assert.notEqual(third.snapshot.token, first.snapshot.token, 'an edit must change the token');

    return pass(
      'The real status answer carried an opaque, stable token and HEAD identity, and a worktree edit changed it.',
      [
        { type: 'protocol', value: 'git.status v2 snapshot.token stable across two reads; head=' + first.snapshot.head },
        { type: 'protocol', value: 'token changed after an on-disk edit (' + first.snapshot.token + ' -> ' + third.snapshot.token + ')' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
