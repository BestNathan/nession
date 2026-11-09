'use strict';
// #845 SC-05: a successful stage/unstage returns or triggers an authoritative
// refreshed status/snapshot — not "the request succeeded".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSession,
  makeRepo,
  openStack,
  pass,
  run,
  stage,
  status,
  unstage,
} = require('../../../shared/git-write-cases.cjs');

run(async () => {
  const stack = await openStack();
  try {
    const dir = makeRepo(stack.runtime.home, 'sc05');
    const session = await createSession(stack, 'case-845-sc05', dir);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
    const reviewed = await status(stack, session);
    const staged = await stage(stack, session, 'a.txt', reviewed.snapshot.token);
    assert.equal(staged.state, 'ok', 'stage failed: ' + JSON.stringify(staged));

    const afterStage = await status(stack, session);
    assert.equal(staged.snapshot.token, afterStage.snapshot.token, 'the post-state token must match a fresh read');
    assert.deepEqual(staged.status, afterStage.status, 'the post-state listing must match a fresh read');

    const unstaged = await unstage(stack, session, 'a.txt', staged.snapshot.token);
    assert.equal(unstaged.state, 'ok', 'unstage failed: ' + JSON.stringify(unstaged));
    const afterUnstage = await status(stack, session);
    assert.equal(unstaged.snapshot.token, afterUnstage.snapshot.token);
    assert.deepEqual(unstaged.status, afterUnstage.status);

    return pass(
      'Both mutations answered with a snapshot and listing byte-equal to an independent fresh status read.',
      [
        { type: 'protocol', value: 'git.stage ok snapshot.token == fresh git.status snapshot.token; statuses deep-equal' },
        { type: 'protocol', value: 'git.unstage ok snapshot.token == fresh git.status snapshot.token; statuses deep-equal' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
