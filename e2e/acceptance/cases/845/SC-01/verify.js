'use strict';
// #845 SC-01: the protocol/provider distinguishes HEAD→WORKTREE, HEAD→INDEX
// and INDEX→WORKTREE against a real repository and a real Session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSession,
  diff,
  git,
  makeRepo,
  openStack,
  pass,
  run,
  status,
} = require('../../../shared/git-write-cases.cjs');

run(async () => {
  const stack = await openStack();
  try {
    const dir = makeRepo(stack.runtime.home, 'sc01');
    const session = await createSession(stack, 'case-845-sc01', dir);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
    git(dir, ['add', 'a.txt']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\nunstaged\n');

    const combined = await diff(stack, session, 'a.txt', 'worktree');
    const staged = await diff(stack, session, 'a.txt', 'staged');
    const unstaged = await diff(stack, session, 'a.txt', 'unstaged');

    assert.ok(combined.diff.text.includes('+staged'), 'combined view misses the staged line');
    assert.ok(combined.diff.text.includes('+unstaged'), 'combined view misses the unstaged line');
    assert.ok(staged.diff.text.includes('+staged'), 'staged view misses the index change');
    assert.ok(!staged.diff.text.includes('+unstaged'), 'staged view leaked the worktree change');
    assert.ok(unstaged.diff.text.includes('+unstaged'), 'unstaged view misses the worktree change');
    assert.ok(!unstaged.diff.text.includes('+staged'), 'unstaged view leaked the index change');

    const listing = await status(stack, session);
    const file = listing.status.modified.find((item) => item.path === 'a.txt');
    assert.ok(file, 'the changed file is listed');
    assert.equal(file.staged, true);
    assert.equal(file.unstaged, true);

    return pass(
      'The real provider returned three separately-worded diffs for one path and a status row that is both staged and unstaged.',
      [
        { type: 'protocol', value: 'git.diff source=worktree text contains +staged and +unstaged' },
        { type: 'protocol', value: 'git.diff source=staged contains +staged and not +unstaged' },
        { type: 'protocol', value: 'git.diff source=unstaged contains +unstaged and not +staged' },
        { type: 'protocol', value: 'git.status v2 a.txt staged=true unstaged=true' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
