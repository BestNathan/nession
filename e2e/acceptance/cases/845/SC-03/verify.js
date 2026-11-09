'use strict';
// #845 SC-03: stage refuses a stale expected_snapshot and leaves the index
// unchanged; the refusal carries the current authoritative state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSession,
  git,
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
    const dir = makeRepo(stack.runtime.home, 'sc03');
    const session = await createSession(stack, 'case-845-sc03', dir);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'reviewed\n');
    const reviewed = await status(stack, session);

    // The Terminal edits the same file after the review.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'edited after review\n');

    const refused = await stage(stack, session, 'a.txt', reviewed.snapshot.token);
    assert.equal(refused.state, 'repository_changed', 'a stale stage must be refused: ' + JSON.stringify(refused));
    assert.ok(refused.snapshot.token, 'the refusal must carry the current snapshot');
    assert.notEqual(refused.snapshot.token, reviewed.snapshot.token, 'the current state differs');
    assert.ok(
      refused.status.modified.some((file) => file.path === 'a.txt' && file.staged === false),
      'the refusal state must show the change as unstaged',
    );

    const staged = git(dir, ['diff', '--cached', '--name-only']);
    assert.equal(staged, '', 'the index must be untouched after a stale refusal');

    return pass(
      'A stage request holding the pre-edit snapshot was refused with repository_changed and the index stayed empty.',
      [
        { type: 'protocol', value: 'git.stage with stale token -> state=repository_changed with current snapshot+status' },
        { type: 'runtime', value: 'git diff --cached --name-only returned an empty index after the refusal' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
