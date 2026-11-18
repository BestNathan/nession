'use strict';
// #3779 SC-01 live path: a real, authenticated interactive Claude CLI in a
// Nession Session, observed on demand through `nession_claude_status`.
//
// The exact CLI version under test is requested by the workflow variable
// CLAUDE_CODE_VERSION and installed by the shared helper; no version is
// admitted or rejected here. The positive states (idle/busy/waiting with a
// PID-verified conversation id) and the busy refusal are the runtime claim.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/mcp-cases.cjs');
const {
  createSession, enter, oneLine, runLive, settleClaude, startLiveStack, status, submit,
  waitForStatus,
} = require('../../../shared/claude-live.cjs');

const BUSY_PROMPT = 'Use the Bash tool to run `sleep 12`, then reply with the single word DONE.';
const WAITING_PROMPT = 'Use the AskUserQuestion tool to ask me which color I prefer: red or blue.';

runLive(async ({ evidence }) => {
  const sha = targetSha();
  const stack = await startLiveStack();
  const cli = stack.cli.requested + ' (resolved ' + stack.cli.resolved + ')';
  try {
    await createSession(stack);
    const before = await status(stack);
    assert.equal(before.process, 'not_running', 'a fresh Session must have no Claude process');
    assert.equal(before.activity, 'unknown', 'absence must not be presented as idle');
    assert.equal(before.conversation_id, null);
    assert.equal(before.observation, 'verified');
    evidence.push({
      type: 'runtime',
      value: 'exact SHA ' + sha + ': CLI ' + cli + '; before launch the named Session answered process=not_running, activity=unknown, conversation_id=null, observation=verified',
    });

    const entry = await enter(stack, 'new');
    assert.ok(entry.conversation_id, 'enter new must report the id it launched with');
    const idle = await settleClaude(stack, { expectedConversationId: entry.conversation_id });
    assert.equal(idle.process, 'running');
    assert.equal(idle.activity, 'idle');
    assert.equal(idle.observation, 'verified');
    assert.equal(idle.conversation_id, entry.conversation_id);
    evidence.push({
      type: 'runtime',
      value: 'the real CLI answered process=running, activity=idle, observation=verified with the exact launched conversation id ' + idle.conversation_id + '; the Agent bound its PID to this Session',
    });

    const sent = await submit(stack, BUSY_PROMPT, idle.conversation_id);
    assert.equal(sent.status, 'input_sent');
    assert.equal(sent.conversation_id, idle.conversation_id);
    const busy = await waitForStatus(stack, (current) => current.activity === 'busy',
      'the live busy observation', 30_000);
    assert.equal(busy.observation, 'verified');
    assert.equal(busy.conversation_id, idle.conversation_id);
    evidence.push({
      type: 'runtime',
      value: 'during a live Bash turn the same Session answered activity=busy with observation=verified and the same conversation id',
    });

    const refused = await enter(stack, 'new');
    assert.equal(refused.status, 'refused');
    evidence.push({
      type: 'runtime',
      value: 'enter new while that live turn was busy answered status=refused and created no second transcript writer: ' + oneLine(refused.detail),
    });

    await waitForStatus(stack, (current) => current.activity === 'idle',
      'idle after the busy turn', 60_000);
    const asked = await submit(stack, WAITING_PROMPT, idle.conversation_id);
    assert.equal(asked.status, 'input_sent');
    const waiting = await waitForStatus(stack, (current) => current.activity === 'waiting',
      'the live waiting observation', 45_000);
    assert.equal(waiting.observation, 'verified');
    assert.ok(waiting.waiting_for, 'a waiting answer must name what Claude waits for');
    assert.equal(waiting.conversation_id, idle.conversation_id);
    evidence.push({
      type: 'runtime',
      value: 'at a live AskUserQuestion prompt the same Session answered activity=waiting, waiting_for=`' + oneLine(waiting.waiting_for, 120) + '`, observation=verified and the same conversation id',
    });

    return 'a real Claude CLI ' + stack.cli.resolved + ' in one named Session produced verified PID-matched idle, busy and waiting observations with the exact conversation id; a busy Session refused redirect without a second writer';
  } finally {
    await stack.stop();
  }
});
