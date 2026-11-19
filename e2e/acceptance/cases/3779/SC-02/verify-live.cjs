'use strict';
// #3779 SC-02 live in-process path: `enter new` sends `/clear`, `enter resume`
// sends `/resume <exact id>`, a foreign Agent target is refused, and a waiting
// Claude is never redirected into a second writer.
//
// The Shell launch path is the sibling `verify-live-shell.cjs`.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/mcp-cases.cjs');
const {
  createSession, enter, oneLine, runLive, seedConversation, settleClaude, startLiveStack,
  submit, waitForStatus,
} = require('../../../shared/claude-live.cjs');

const WAITING_PROMPT = 'Use the AskUserQuestion tool to ask me which color I prefer: red or blue.';

runLive(async ({ evidence }) => {
  const sha = targetSha();
  const stack = await startLiveStack();
  try {
    await createSession(stack);
    const first = await enter(stack, 'new');
    assert.ok(first.conversation_id);
    const firstIdle = await settleClaude(stack, { expectedConversationId: first.conversation_id });
    const originalId = firstIdle.conversation_id;
    const seedPrompt = await seedConversation(stack, originalId);
    evidence.push({
      type: 'runtime',
      value: 'exact SHA ' + sha + ': CLI ' + stack.cli.requested + ' (resolved ' + stack.cli.resolved + '); enter new launched a verified idle conversation ' + originalId + ' whose first turn (' + seedPrompt + ') was readable by the exact id',
    });

    const cleared = await enter(stack, 'new');
    assert.ok(cleared.status === 'entered' || cleared.status === 'pending',
      'in-process enter new answered ' + cleared.status);
    const second = await waitForStatus(
      stack,
      (current) => current.activity === 'idle' && current.observation === 'verified' &&
        current.conversation_id && current.conversation_id !== originalId,
      'the in-process /clear to produce a different verified conversation',
      30_000,
    );
    evidence.push({
      type: 'runtime',
      value: 'enter new on the verified idle CLI sent /clear and reported ' + cleared.status + '; the exact verified id changed from ' + originalId + ' to ' + second.conversation_id,
    });

    const resumed = await enter(stack, 'resume', originalId);
    assert.ok(resumed.status === 'entered' || resumed.status === 'pending',
      'in-process enter resume answered ' + resumed.status);
    const restored = await waitForStatus(
      stack,
      (current) => current.activity === 'idle' && current.observation === 'verified' &&
        current.conversation_id === originalId,
      'the in-process /resume to restore the exact requested conversation',
      30_000,
    );
    assert.equal(restored.conversation_id, originalId);
    evidence.push({
      type: 'runtime',
      value: 'enter resume ' + originalId + ' on the verified idle CLI sent /resume and restored exactly that id (' + resumed.status + ', verified idle)',
    });

    let foreign = null;
    try {
      await stack.mcp.call('nession_claude_enter', {
        agent_id: 'foreign-agent',
        session_id: 'foreign-agent:' + stack.sessionName,
        mode: 'new',
      });
    } catch (error) {
      foreign = String(error && error.message ? error.message : error);
    }
    assert.ok(foreign, 'a foreign Agent target must be refused');
    assert.match(foreign, /foreign-agent|not 'claude-live'|Agent/);
    evidence.push({
      type: 'runtime',
      value: 'enter addressed to a foreign Agent was refused before any input: ' + oneLine(foreign, 300),
    });

    const asked = await submit(stack, WAITING_PROMPT, originalId);
    assert.equal(asked.status, 'input_sent');
    const waiting = await waitForStatus(stack, (current) => current.activity === 'waiting',
      'the live waiting observation', 45_000);
    assert.equal(waiting.observation, 'verified');
    assert.equal(waiting.conversation_id, originalId);
    const refused = await enter(stack, 'new');
    assert.equal(refused.status, 'refused');
    evidence.push({
      type: 'runtime',
      value: 'enter new while the live CLI waited at an AskUserQuestion prompt answered status=refused with the same verified conversation and no second writer: ' + oneLine(refused.detail),
    });

    return 'a real Claude CLI ' + stack.cli.resolved + ' changed to a new exact conversation via /clear, restored the exact requested id via /resume, refused a foreign Agent target, and refused to redirect a waiting CLI';
  } finally {
    await stack.stop();
  }
});
