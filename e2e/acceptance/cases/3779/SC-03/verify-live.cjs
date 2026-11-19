'use strict';
// #3779 SC-03 live path: one prompt reaches exactly one verified conversation,
// the answer carries the actual id and the `input_sent` phase, the same id is
// readable back with the prompt and reply, and a stale/waiting guard never
// produces an unchecked second submission.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { targetSha } = require('../../../shared/mcp-cases.cjs');
const {
  createSession, enter, getConversation, oneLine, runLive, settleClaude, startLiveStack,
  submit, waitFor, waitForStatus,
} = require('../../../shared/claude-live.cjs');

const ANSWER_PROMPT = 'Reply with the single word OK and nothing else.';
const WAITING_PROMPT = 'Use the AskUserQuestion tool to ask me which color I prefer: red or blue.';
const STALE_PROMPT = 'STALE-GUARD-MUST-NOT-SEND';
const WAITING_GUARD_PROMPT = 'WAITING-GUARD-MUST-NOT-SEND';

function messageText(item) {
  if (!item || item.kind !== 'message' || !Array.isArray(item.content)) return '';
  return item.content
    .filter((block) => block && block.type === 'text')
    .map((block) => String(block.text || ''))
    .join('\n');
}

function userSent(conversation, text) {
  return (conversation.items || []).some(
    (item) => item.kind === 'message' && item.role === 'user' &&
      messageText(item).includes(text),
  );
}

function assistantAnswered(conversation) {
  return (conversation.items || []).some(
    (item) => item.kind === 'message' && item.role === 'assistant' &&
      /\bOK\b/i.test(messageText(item)),
  );
}

runLive(async ({ evidence }) => {
  const sha = targetSha();
  const stack = await startLiveStack();
  try {
    await createSession(stack);
    const entry = await enter(stack, 'new');
    assert.ok(entry.conversation_id);
    const idle = await settleClaude(stack, { expectedConversationId: entry.conversation_id });
    const id = idle.conversation_id;

    const sent = await submit(stack, ANSWER_PROMPT, id);
    assert.equal(sent.status, 'input_sent');
    assert.equal(sent.conversation_id, id);
    evidence.push({
      type: 'runtime',
      value: 'exact SHA ' + sha + ': CLI ' + stack.cli.requested + ' (resolved ' + stack.cli.resolved + '); submit answered status=input_sent with the actual verified id ' + id,
    });

    const conversation = await waitLiveConversation(stack, id);
    assert.equal(userSent(conversation, ANSWER_PROMPT), true,
      'the same conversation must record the delivered prompt');
    assert.equal(assistantAnswered(conversation), true,
      'the same conversation must record the assistant answer');
    const matchingUserMessages = (conversation.items || []).filter(
      (item) => item.kind === 'message' && item.role === 'user' &&
        messageText(item).includes(ANSWER_PROMPT),
    );
    assert.equal(matchingUserMessages.length, 1,
      'one submit must deliver exactly one prompt');
    evidence.push({
      type: 'runtime',
      value: 'get_conversation with the returned id recorded exactly one user prompt (' + ANSWER_PROMPT + ') and the assistant reply OK (state=' + conversation.state + ', partial_tail=' + conversation.partial_tail + ')',
    });

    const bogusId = crypto.randomUUID();
    const stale = await submit(stack, STALE_PROMPT, bogusId);
    assert.equal(stale.status, 'refused');
    assert.match(String(stale.detail), /does not match/);
    const afterStale = await getConversation(stack, id);
    assert.equal(userSent(afterStale, STALE_PROMPT), false,
      'a stale-guard refusal must not have delivered the prompt');
    evidence.push({
      type: 'runtime',
      value: 'submit guarded by the stale id ' + bogusId + ' was refused (' + oneLine(stale.detail) + ') and the same conversation contained no `' + STALE_PROMPT + '` prompt',
    });

    const asked = await submit(stack, WAITING_PROMPT, id);
    assert.equal(asked.status, 'input_sent');
    const waiting = await waitForStatus(stack, (current) => current.activity === 'waiting',
      'the live waiting observation', 45_000);
    assert.equal(waiting.conversation_id, id);
    const guarded = await submit(stack, WAITING_GUARD_PROMPT, id);
    assert.equal(guarded.status, 'refused');
    const afterWaiting = await getConversation(stack, id);
    assert.equal(userSent(afterWaiting, WAITING_GUARD_PROMPT), false,
      'a busy/waiting refusal must not have delivered the prompt');
    evidence.push({
      type: 'runtime',
      value: 'submit while the same conversation waited at an AskUserQuestion prompt was refused (' + oneLine(guarded.detail) + ') and delivered no second prompt',
    });

    return 'a real Claude CLI ' + stack.cli.resolved + ' received exactly one prompt in one verified conversation, reported input_sent with that exact id, recorded the prompt and reply, and refused stale and waiting submissions without delivering them';
  } finally {
    await stack.stop();
  }
});

// The transcript is written as the CLI finishes the turn; poll the same
// explicit conversation until the assistant answer is recorded.
async function waitLiveConversation(stack, conversationId) {
  return waitFor('the delivered prompt and assistant answer in the same conversation',
    async () => {
      const conversation = await getConversation(stack, conversationId, { limit: 50 });
      if (conversation.state !== 'ready') return null;
      return assistantAnswered(conversation) && userSent(conversation, ANSWER_PROMPT)
        ? conversation
        : null;
    }, { timeoutMs: 60_000, intervalMs: 1000 });
}
