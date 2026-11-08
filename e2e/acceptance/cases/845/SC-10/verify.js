'use strict';
// #845 SC-10: two mutations of one repository do not race through the query
// lane; they serialize on the Session key and the second revalidates its
// snapshot instead of overwriting the first.
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
    const dir = makeRepo(stack.runtime.home, 'sc10');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a changed\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b new\n');
    const session = await createSession(stack, 'case-845-sc10', dir);
    const reviewed = await status(stack, session);

    // Both mutations are in flight at once against the same reviewed state.
    const [first, second] = await Promise.all([
      stage(stack, session, 'a.txt', reviewed.snapshot.token),
      stage(stack, session, 'b.txt', reviewed.snapshot.token),
    ]);

    const results = [first, second];
    assert.equal(
      results.filter((result) => result.state === 'ok').length,
      1,
      'exactly one concurrent stage may apply: ' + JSON.stringify(results),
    );
    assert.equal(
      results.filter((result) => result.state === 'repository_changed').length,
      1,
      'the serialized second mutation must refuse its stale snapshot: ' + JSON.stringify(results),
    );
    assert.equal(
      results.filter((result) => result.state === 'failed').length,
      0,
      'serialization must not surface an index-lock failure: ' + JSON.stringify(results),
    );

    const staged = git(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    assert.equal(staged.length, 1, 'exactly one path may be in the index, got ' + JSON.stringify(staged));

    return pass(
      'Concurrent same-repository stages serialized: one applied, the other was refused as stale, and the index held exactly one path.',
      [
        { type: 'protocol', value: 'two concurrent git.stage calls with one token -> one ok + one repository_changed, zero failed' },
        { type: 'runtime', value: 'git diff --cached --name-only listed exactly one path: ' + staged.join(',') },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
