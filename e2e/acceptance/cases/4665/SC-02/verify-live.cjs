'use strict';
// #4665 SC-02 live path: a real Claude composer pre-filled with unsubmitted
// text (the lost-Enter state) still observes `idle` — the activity oracle is
// composer-blind. A submit against it must be refused without appending, a
// replay must stay refused, and the safe reconcile (an explicit Enter) must
// deliver the queued text exactly once, after which a new submit confirms
// exactly once. No concatenated or duplicated prompt reaches the transcript.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/mcp-cases.cjs');
const {
  createSession, enter, getConversation, oneLine, runLive, seedConversation, settleClaude,
  startLiveStack, status, submit, waitFor, waitForStatus,
} = require('../../../shared/claude-live.cjs');

const DIRTY_PROMPT = 'Reply with the single word DIRTY and nothing else.';
const NEW_PROMPT = 'Reply with the single word NEW and nothing else.';

function messageText(item) {
  if (!item || item.kind !== 'message' || !Array.isArray(item.content)) return '';
  return item.content
    .filter((block) => block && block.type === 'text')
    .map((block) => String(block.text || ''))
    .join('\n');
}

function userMessages(conversation, text) {
  return (conversation.items || []).filter(
    (item) => item.kind === 'message' && item.role === 'user' && messageText(item) === text,
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
    await seedConversation(stack, id);

    // Pre-fill the composer without submitting: the exact state a lost Enter
    // leaves behind. The text lands in the input box; no transcript record.
    stack.sendKeys('-l', '--', DIRTY_PROMPT);
    await waitFor('the pre-filled composer text on the pane', async () => {
      const pane = stack.capture();
      return pane.includes(DIRTY_PROMPT) ? pane : null;
    }, { timeoutMs: 15_000, intervalMs: 250 });
    const blind = await status(stack);
    assert.equal(blind.observation, 'verified');
    assert.equal(blind.activity, 'idle',
      'the activity oracle must still report idle against a dirty composer — that blind spot is what the composer gate covers');
    evidence.push({
      type: 'runtime',
      value: 'exact SHA ' + sha + ': CLI ' + stack.cli.requested + ' (resolved ' + stack.cli.resolved + '); a composer pre-filled with unsubmitted text still observed verified idle (conversation ' + id + ')',
    });

    // Submit against the dirty composer: refused, nothing sent, nothing
    // appended. The idle guard alone would have accepted this call.
    const refused = await submit(stack, NEW_PROMPT, id);
    assert.equal(refused.status, 'refused',
      'a submit against a dirty composer must be refused: ' + JSON.stringify(refused));
    assert.match(String(refused.detail), /unsubmitted|composer/,
      'the refusal must name the dirty composer: ' + JSON.stringify(refused));
    const afterRefusal = await getConversation(stack, id, { limit: 50 });
    assert.equal(userMessages(afterRefusal, NEW_PROMPT).length, 0,
      'a refused submit must not deliver the prompt');
    const paneAfterRefusal = stack.capture();
    assert.ok(paneAfterRefusal.includes(DIRTY_PROMPT),
      'the composer keeps its own unsubmitted text');
    assert.ok(!paneAfterRefusal.includes(NEW_PROMPT),
      'a refused submit must not append keys to the composer');
    evidence.push({
      type: 'runtime',
      value: 'submit against the dirty composer was refused (' + oneLine(refused.detail) + '); the transcript gained no prompt and the pane shows no appended text',
    });

    // Replay: the same call again is still refused — no unchecked second
    // submission while the composer is dirty.
    const replay = await submit(stack, NEW_PROMPT, id);
    assert.equal(replay.status, 'refused',
      'a replay against the still-dirty composer must be refused: ' + JSON.stringify(replay));
    const afterReplay = await getConversation(stack, id, { limit: 50 });
    assert.equal(userMessages(afterReplay, NEW_PROMPT).length, 0);
    evidence.push({
      type: 'runtime',
      value: 'the replayed submit was refused again with no delivery — no unchecked second submission',
    });

    // Safe reconcile: an explicit Enter submits the queued text once.
    stack.sendKeys('Enter');
    await waitForStatus(stack,
      (current) => current.activity === 'idle' && current.conversation_id === id,
      'idle after the explicit Enter reconciled the composer', 90_000);
    const reconciled = await waitFor('the reconciled prompt in the transcript',
      async () => {
        const conversation = await getConversation(stack, id, { limit: 50 });
        if (conversation.state !== 'ready') return null;
        return userMessages(conversation, DIRTY_PROMPT).length === 1 ? conversation : null;
      }, { timeoutMs: 60_000, intervalMs: 1000 });
    assert.equal(userMessages(reconciled, DIRTY_PROMPT).length, 1,
      'the queued text is delivered exactly once by the reconcile');
    const concatenated = (reconciled.items || []).filter(
      (item) => item.kind === 'message' && item.role === 'user' &&
        messageText(item).includes(DIRTY_PROMPT) && messageText(item).includes(NEW_PROMPT),
    );
    assert.equal(concatenated.length, 0,
      'no concatenated prompt may reach the transcript');
    evidence.push({
      type: 'runtime',
      value: 'the explicit Enter reconciled the composer: the queued prompt was recorded exactly once, with no concatenated user message',
    });

    // Against the now-empty composer a new submit confirms exactly once.
    const sent = await submit(stack, NEW_PROMPT, id);
    assert.equal(sent.status, 'input_sent');
    assert.equal(sent.observation, 'verified');
    assert.equal(sent.conversation_id, id);
    const delivered = await waitFor('the new prompt in the transcript',
      async () => {
        const conversation = await getConversation(stack, id, { limit: 50 });
        if (conversation.state !== 'ready') return null;
        return userMessages(conversation, NEW_PROMPT).length === 1 ? conversation : null;
      }, { timeoutMs: 60_000, intervalMs: 1000 });
    assert.equal(userMessages(delivered, NEW_PROMPT).length, 1);
    assert.equal(userMessages(delivered, DIRTY_PROMPT).length, 1,
      'the reconciled prompt is still recorded exactly once');
    evidence.push({
      type: 'runtime',
      value: 'the submit against the emptied composer answered input_sent+verified and the same conversation recorded the new prompt exactly once alongside the single reconciled prompt',
    });

    return 'a real Claude CLI ' + stack.cli.resolved + ' refused every submit against a dirty composer without appending, delivered the queued text exactly once on the explicit reconcile, and confirmed the next submit exactly once — no concatenated or duplicated prompt reached the transcript';
  } finally {
    await stack.stop();
  }
});
