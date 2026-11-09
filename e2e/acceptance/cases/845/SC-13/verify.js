'use strict';
// #845 SC-13: a real external git process (the Terminal-side `git add`) between
// read and confirm is detected, and the reviewed mutation is not applied.
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
    const dir = makeRepo(stack.runtime.home, 'sc13');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'reviewed in the workspace\n');
    const session = await createSession(stack, 'case-845-sc13', dir);
    const reviewed = await status(stack, session);

    // The user runs `git add a.txt` in the Terminal, exactly as the issue's
    // edge-case table describes. This is a real git process, not a mock.
    git(dir, ['add', 'a.txt']);

    const refused = await stage(stack, session, 'a.txt', reviewed.snapshot.token);
    assert.equal(refused.state, 'repository_changed', 'the terminal race must refuse: ' + JSON.stringify(refused));
    assert.ok(refused.status.modified.some((file) => file.path === 'a.txt' && file.staged === true));

    const indexed = git(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    assert.deepEqual(indexed, ['a.txt'], 'the Terminal-side index state must survive untouched');

    return pass(
      'A real external `git add` between review and stage made the reviewed snapshot stale; the Workspace refusal did not overwrite the newer index.',
      [
        { type: 'protocol', value: 'git.status v2 reviewed; external git add; git.stage stale -> repository_changed' },
        { type: 'protocol', value: 'the refusal status shows a.txt staged=true (the external state)' },
        { type: 'runtime', value: 'git diff --cached --name-only still lists exactly a.txt' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
