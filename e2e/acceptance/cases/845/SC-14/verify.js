'use strict';
// #845 SC-14: the edge states are exercised against real repositories —
// unborn, detached HEAD, conflicted index, missing identity, hook failure and
// stale snapshot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createCommit,
  createSession,
  git,
  gitTry,
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
    const evidence = [];
    const home = stack.runtime.home;

    // Unborn repository: stage works, unstage has no HEAD to assume.
    const unborn = makeRepo(home, 'sc14-unborn', { unborn: true });
    const unbornSession = await createSession(stack, 'case-845-sc14-unborn', unborn);
    fs.writeFileSync(path.join(unborn, 'new.txt'), 'hello\n');
    const unbornRead = await status(stack, unbornSession);
    assert.equal(unbornRead.snapshot.head, undefined, 'an unborn repository has no HEAD');
    const unbornStaged = await stage(stack, unbornSession, 'new.txt', unbornRead.snapshot.token);
    assert.equal(unbornStaged.state, 'ok', 'unborn stage failed: ' + JSON.stringify(unbornStaged));
    const unbornUnstaged = await unstage(stack, unbornSession, 'new.txt', unbornStaged.snapshot.token);
    assert.equal(unbornUnstaged.state, 'ok', 'unborn unstage failed: ' + JSON.stringify(unbornUnstaged));
    assert.equal(fs.readFileSync(path.join(unborn, 'new.txt'), 'utf8'), 'hello\n');
    evidence.push({ type: 'protocol', value: 'unborn: head absent; stage ok; unstage ok; worktree bytes kept' });

    // Detached HEAD: staging and committing still work and report the state.
    const detached = makeRepo(home, 'sc14-detached');
    git(detached, ['checkout', '--detach', '-q']);
    fs.writeFileSync(path.join(detached, 'a.txt'), 'detached change\n');
    const detachedSession = await createSession(stack, 'case-845-sc14-detached', detached);
    const detachedRead = await status(stack, detachedSession);
    assert.equal(detachedRead.status.detached, true);
    const detachedStaged = await stage(stack, detachedSession, 'a.txt', detachedRead.snapshot.token);
    assert.equal(detachedStaged.state, 'ok');
    const detachedCommit = await createCommit(
      stack,
      detachedSession,
      detachedStaged.snapshot.token,
      'feat: detached commit',
      'case-845-sc14-detached',
    );
    assert.equal(detachedCommit.state, 'ok', 'detached commit failed: ' + JSON.stringify(detachedCommit));
    const detachedAfter = await status(stack, detachedSession);
    assert.equal(detachedAfter.status.detached, true, 'the post-state still reports detached HEAD');
    assert.notEqual(detachedAfter.snapshot.head, detachedRead.snapshot.head);
    evidence.push({ type: 'protocol', value: 'detached: stage ok; commit ok; post-state detached=true with a new HEAD' });

    // Conflicted index: explicit conflct refusal, never a generic error.
    const conflicted = makeRepo(home, 'sc14-conflict');
    git(conflicted, ['checkout', '-qb', 'other']);
    fs.writeFileSync(path.join(conflicted, 'a.txt'), 'other\n');
    git(conflicted, ['commit', '-qam', 'other']);
    git(conflicted, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(conflicted, 'a.txt'), 'main\n');
    git(conflicted, ['commit', '-qam', 'main']);
    const merge = gitTry(conflicted, ['merge', 'other']);
    assert.notEqual(merge.status, 0, 'the fixture must actually conflict');
    const conflictSession = await createSession(stack, 'case-845-sc14-conflict', conflicted);
    const conflictRead = await status(stack, conflictSession);
    assert.deepEqual(conflictRead.status.unmerged, ['a.txt']);
    const conflictStage = await stage(stack, conflictSession, 'a.txt', conflictRead.snapshot.token);
    assert.equal(conflictStage.state, 'refused', 'conflicted stage must be refused: ' + JSON.stringify(conflictStage));
    assert.match(conflictStage.message, /conflicted/i);
    const conflictCommit = await createCommit(
      stack,
      conflictSession,
      conflictRead.snapshot.token,
      'merge',
      'case-845-sc14-conflict',
    );
    assert.equal(conflictCommit.state, 'refused', 'conflicted commit must be refused: ' + JSON.stringify(conflictCommit));
    evidence.push({ type: 'protocol', value: 'conflict: stage and commit both refused naming the conflict' });

    // Missing identity.
    const missing = makeRepo(home, 'sc14-identity', { identity: null, unborn: true });
    const missingSession = await createSession(stack, 'case-845-sc14-identity', missing);
    fs.writeFileSync(path.join(missing, 'a.txt'), 'one\n');
    const missingRead = await status(stack, missingSession);
    const missingStaged = await stage(stack, missingSession, 'a.txt', missingRead.snapshot.token);
    const missingCommit = await createCommit(
      stack,
      missingSession,
      missingStaged.snapshot.token,
      'feat: no identity',
      'case-845-sc14-identity',
    );
    assert.equal(missingCommit.state, 'missing_identity');
    evidence.push({ type: 'protocol', value: 'missing identity: create-commit -> missing_identity' });

    // Hook failure.
    const hooked = makeRepo(home, 'sc14-hook');
    const hook = path.join(hooked, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(hooked, 'a.txt'), 'hooked\n');
    const hookSession = await createSession(stack, 'case-845-sc14-hook', hooked);
    const hookRead = await status(stack, hookSession);
    const hookStaged = await stage(stack, hookSession, 'a.txt', hookRead.snapshot.token);
    const hookCommit = await createCommit(
      stack,
      hookSession,
      hookStaged.snapshot.token,
      'feat: hook',
      'case-845-sc14-hook',
    );
    assert.equal(hookCommit.state, 'failed');
    assert.ok(hookCommit.status, 'the hook failure must carry post-attempt state');
    evidence.push({ type: 'protocol', value: 'hook failure: create-commit -> failed with authoritative status' });

    // Stale snapshot.
    const stale = makeRepo(home, 'sc14-stale');
    fs.writeFileSync(path.join(stale, 'a.txt'), 'reviewed\n');
    const staleSession = await createSession(stack, 'case-845-sc14-stale', stale);
    const staleRead = await status(stack, staleSession);
    fs.writeFileSync(path.join(stale, 'a.txt'), 'edited\n');
    const staleStage = await stage(stack, staleSession, 'a.txt', staleRead.snapshot.token);
    assert.equal(staleStage.state, 'repository_changed');
    evidence.push({ type: 'protocol', value: 'stale snapshot: stage -> repository_changed' });

    evidence.push({ type: 'runtime', value: 'target_sha=' + stack.runtime.target_sha });
    return pass(
      'Six real-repository edge states produced their specific answers: unborn, detached HEAD, conflicted index, missing identity, hook failure and stale snapshot.',
      evidence,
    );
  } finally {
    stack.close();
  }
});
