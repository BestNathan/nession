'use strict';
// #845 SC-15: the existing read-only `git.commit` detail unit stays backward
// compatible; commit creation is a distinct unit and cannot be misrouted.
const assert = require('node:assert/strict');
const {
  createSession,
  git,
  gitAsk,
  makeRepo,
  openStack,
  pass,
  revCount,
  run,
} = require('../../../shared/git-write-cases.cjs');

run(async () => {
  const stack = await openStack();
  try {
    const dir = makeRepo(stack.runtime.home, 'sc15');
    const session = await createSession(stack, 'case-845-sc15', dir);
    const oid = git(dir, ['rev-parse', 'HEAD']);

    const detail = await gitAsk(stack, 'git.commit', {
      session,
      contract_version: 1,
      oid,
    });
    assert.equal(detail.state, 'ok', 'git.commit detail must still answer: ' + JSON.stringify(detail));
    assert.equal(detail.commit.oid, oid);
    assert.equal(detail.commit.subject, 'initial');

    // Sending creation-shaped fields to the read unit is a decode error, not a
    // commit: the two units have different request shapes.
    const misrouted = await gitAsk(stack, 'git.commit', {
      session,
      contract_version: 1,
      expected_snapshot: 'anything',
      message: 'must not commit',
      request_id: 'case-845-sc15',
    });
    assert.equal(misrouted.state, 'error', 'git.commit must reject a creation-shaped request: ' + JSON.stringify(misrouted));
    assert.equal(revCount(dir), 1, 'git.commit must never create a commit');

    const protocols = stack.agent.protocols?.protocols ?? {};
    assert.ok(protocols['git.commit'], 'the read unit is advertised');
    assert.ok(protocols['git.create-commit'], 'the write unit is advertised separately');

    return pass(
      'git.commit still answered commit detail and rejected a creation-shaped request; creation remained on its distinct git.create-commit unit.',
      [
        { type: 'protocol', value: 'git.commit v1 oid=' + oid + ' subject=initial' },
        { type: 'protocol', value: 'git.commit with expected_snapshot/message/request_id -> state=error' },
        { type: 'protocol', value: 'manifest carries git.commit and git.create-commit as two units' },
        { type: 'runtime', value: 'rev count stayed 1 after both calls' },
        { type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha },
      ],
    );
  } finally {
    stack.close();
  }
});
