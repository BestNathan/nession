'use strict';
// #3779 SC-02 live Shell path: after the interactive CLI exits, `enter resume
// <exact id>` launches the Session shell command `claude --resume <id>` and
// reports that exact conversation. A stale id spawns no writer, and a busy
// Claude refuses a redirect.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { targetSha } = require('../../../shared/mcp-cases.cjs');
const {
  createSession, enter, exitClaude, oneLine, runLive, seedConversation, settleClaude,
  startLiveStack, status, submit, waitForStatus,
} = require('../../../shared/claude-live.cjs');

const BUSY_PROMPT = 'Use the Bash tool to run `sleep 12`, then reply with the single word DONE.';

runLive(async ({ evidence }) => {
  const sha = targetSha();
  const stack = await startLiveStack();
  try {
    await createSession(stack);
    const first = await enter(stack, 'new');
    assert.ok(first.conversation_id);
    const idle = await settleClaude(stack, { expectedConversationId: first.conversation_id });
    const originalId = idle.conversation_id;
    await seedConversation(stack, originalId);

    await exitClaude(stack);
    const stopped = await status(stack);
    assert.equal(stopped.process, 'not_running');
    evidence.push({
      type: 'runtime',
      value: 'exact SHA ' + sha + ': CLI ' + stack.cli.requested + ' (resolved ' + stack.cli.resolved + '); after /exit the Session answered process=not_running with the original id still known to the verifier',
    });

    const bogusId = crypto.randomUUID();
    const stale = await enter(stack, 'resume', bogusId);
    assert.notEqual(stale.status, 'entered', 'a stale resume id must not report a conversation it did not select');
    const afterStale = await status(stack);
    assert.equal(afterStale.process, 'not_running',
      'a stale resume id must not leave a running writer');
    assert.notEqual(afterStale.conversation_id, bogusId);
    evidence.push({
      type: 'runtime',
      value: 'enter resume with the stale id ' + bogusId + ' answered ' + stale.status + '; no Claude process or invented conversation was left running',
    });

    const resumed = await enter(stack, 'resume', originalId);
    assert.ok(resumed.status === 'entered' || resumed.status === 'pending');
    const restored = await settleClaude(stack, { expectedConversationId: originalId });
    assert.equal(restored.conversation_id, originalId);
    assert.equal(restored.activity, 'idle');
    evidence.push({
      type: 'runtime',
      value: 'the Session shell launched `claude --resume ' + originalId + '` and the typed status verified exactly that id, running and idle (' + resumed.status + ')',
    });

    const sent = await submit(stack, BUSY_PROMPT, originalId);
    assert.equal(sent.status, 'input_sent');
    const busy = await waitForStatus(stack, (current) => current.activity === 'busy',
      'the live busy observation', 30_000);
    assert.equal(busy.observation, 'verified');
    const refused = await enter(stack, 'new');
    assert.equal(refused.status, 'refused');
    evidence.push({
      type: 'runtime',
      value: 'enter new while the resumed shell-launched Claude was busy answered status=refused with no second transcript writer: ' + oneLine(refused.detail),
    });

    return 'a real Claude CLI ' + stack.cli.resolved + ' was resumed by exact id through the Session shell, a stale id spawned no writer, and a busy conversation refused a redirect';
  } finally {
    await stack.stop();
  }
});
