'use strict';
// #845 SC-11: no protocol operation reaches remotes, switches branches,
// rewrites history or discards worktree content. The manifest is the offer; a
// unit that is absent cannot be called.
const assert = require('node:assert/strict');
const { git, makeRepo, openStack, pass, run } = require('../../../shared/git-write-cases.cjs');

const FORBIDDEN = [
  'git.push',
  'git.pull',
  'git.fetch',
  'git.checkout',
  'git.switch',
  'git.reset',
  'git.restore',
  'git.clean',
  'git.rebase',
  'git.merge',
  'git.cherry-pick',
  'git.remote',
  'git.create-branch',
  'git.delete-branch',
];

run(async () => {
  const stack = await openStack();
  try {
    const protocols = stack.agent.protocols?.protocols ?? {};
    for (const unit of ['git.status', 'git.diff', 'git.stage', 'git.unstage', 'git.create-commit']) {
      assert.ok(protocols[unit], 'the agent must advertise ' + unit);
    }
    for (const unit of FORBIDDEN) {
      assert.equal(protocols[unit], undefined, 'the agent must not advertise ' + unit);
    }

    const home = stack.runtime.home;
    const dir = makeRepo(home, 'sc11');
    const remotes = git(dir, ['remote']);
    assert.equal(remotes, '', 'the fixture repository must have no remote');
    assert.equal(git(dir, ['branch', '--show-current']), 'main', 'the branch is unchanged');

    return pass(
      'The real Agent advertises no remote, branch-switching or history-rewriting unit, and the repository has no remote or branch movement.',
      [
        { type: 'protocol', value: 'manifest offers git.stage/unstage/create-commit and none of ' + FORBIDDEN.join(',') },
        { type: 'runtime', value: 'git remote is empty and the current branch is main' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha + ' repo=' + dir },
      ],
    );
  } finally {
    stack.close();
  }
});
