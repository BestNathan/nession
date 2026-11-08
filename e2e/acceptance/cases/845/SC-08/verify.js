'use strict';
// #845 SC-08: a failing repository hook is surfaced together with the
// repository's actual post-attempt state, not as "nothing happened".
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
    const dir = makeRepo(stack.runtime.home, 'sc08');
    const hooks = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, 'pre-commit');
    fs.writeFileSync(
      hook,
      '#!/bin/sh\necho side > side.txt && git add side.txt\nexit 1\n',
    );
    fs.chmodSync(hook, 0o755);

    const session = await createSession(stack, 'case-845-sc08', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hooked\n');
    const reviewed = await status(stack, session);
    const staged = await stage(stack, session, 'a.txt', reviewed.snapshot.token);

    const failed = await createCommit(
      stack,
      session,
      staged.snapshot.token,
      'feat: hook failure',
      'case-845-sc08',
    );
    assert.equal(failed.state, 'failed', 'expected failed: ' + JSON.stringify(failed));
    assert.equal(revCount(dir), 1, 'HEAD must not move when the hook fails');
    assert.equal(head(dir), staged.snapshot.head, 'HEAD identity must be unchanged');
    assert.ok(failed.status, 'the failure must carry the post-attempt status');
    assert.ok(
      failed.status.modified.some((file) => file.path === 'side.txt' && file.staged === true),
      'the hook side effect must be visible in the post-attempt status',
    );

    return pass(
      'A failing pre-commit hook produced a failed answer carrying the repository state the hook itself had changed.',
      [
        { type: 'protocol', value: 'git.create-commit -> state=failed with snapshot and status' },
        { type: 'protocol', value: 'post-attempt status lists side.txt staged=true' },
        { type: 'runtime', value: 'git rev-list --count HEAD stayed 1; HEAD unchanged' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
