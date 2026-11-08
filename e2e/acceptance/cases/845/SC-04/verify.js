'use strict';
// #845 SC-04: unstage refuses a stale snapshot and never discards worktree
// content — it is an index mutation, not a restore.
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
    const dir = makeRepo(stack.runtime.home, 'sc04');
    const session = await createSession(stack, 'case-845-sc04', dir);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
    const reviewed = await status(stack, session);
    const staged = await stage(stack, session, 'a.txt', reviewed.snapshot.token);
    assert.equal(staged.state, 'ok', 'the fixture stage must succeed: ' + JSON.stringify(staged));

    // The Terminal edits the worktree after the staged state was reviewed.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'worktree kept\n');

    const refused = await unstage(stack, session, 'a.txt', staged.snapshot.token);
    assert.equal(refused.state, 'repository_changed', 'a stale unstage must be refused: ' + JSON.stringify(refused));

    const current = await status(stack, session);
    const applied = await unstage(stack, session, 'a.txt', current.snapshot.token);
    assert.equal(applied.state, 'ok', 'unstage with the current state must succeed: ' + JSON.stringify(applied));
    assert.equal(
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'),
      'worktree kept\n',
      'unstage must preserve the worktree bytes',
    );
    assert.ok(
      applied.status.modified.some((file) => file.path === 'a.txt' && file.staged === false && file.unstaged === true),
      'the post-state must show the change as unstaged',
    );

    return pass(
      'Unstage refused the stale snapshot, then restored the index with the current snapshot while keeping the edited worktree content.',
      [
        { type: 'protocol', value: 'git.unstage with stale token -> state=repository_changed' },
        { type: 'protocol', value: 'git.unstage with current token -> state=ok, a.txt staged=false unstaged=true' },
        { type: 'runtime', value: 'a.txt bytes after unstage were exactly "worktree kept"' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
