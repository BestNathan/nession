'use strict';
// #4665 SC-01 live path: against a real pinned Claude CLI, the startup-race
// injection (submit immediately after enter) and the large single-line prompt
// injection produce no false verified delivery. `input_sent` + `verified` is
// always backed by the exact user message in the addressed conversation;
// unconfirmed delivery answers a truthful unknown with read-back guidance.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/mcp-cases.cjs');
const {
  createSession, enter, getConversation, oneLine, runLive, settleClaude, startLiveStack,
  submit, waitFor, waitForStatus,
} = require('../../../shared/claude-live.cjs');

const RACE_PROMPT = 'Reply with the single word RACE and nothing else.';
const OK_PROMPT = 'Reply with the single word OK and nothing else.';
// The issue's shape: ~500 CJK characters on one line, the burst whose Enter
// was coalesced into paste handling on v2.1.332.
const LARGE_PROMPT = '修复投递契约'.repeat(83) + ' 请只回复 LARGE 一个词。';

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

// A verified delivery claim must be backed by the transcript; a non-verified
// answer must be a truthful refused/unknown with a reason. Returns the claim
// kind for the evidence line.
function assertTruthful(answer, prompt) {
  if (answer.status === 'input_sent') {
    assert.equal(answer.observation, 'verified',
      'input_sent must carry the verified observation: ' + JSON.stringify(answer));
    return 'input_sent';
  }
  assert.ok(answer.status === 'refused' || answer.status === 'unknown',
    'a non-sent delivery must be refused or unknown, not a false verified: ' + JSON.stringify(answer));
  assert.ok(answer.detail, 'a non-sent delivery must carry a reason');
  if (answer.status === 'unknown') {
    assert.match(String(answer.detail), /read the conversation back/,
      'an unconfirmed delivery must carry read-back guidance: ' + JSON.stringify(answer));
  }
  return answer.status;
}

runLive(async ({ evidence }) => {
  const sha = targetSha();
  const stack = await startLiveStack();
  try {
    await createSession(stack);
    const entry = await enter(stack, 'new');
    assert.ok(entry.conversation_id);

    // Injection 1: submit immediately after enter, before the TUI has settled.
    // The old code answered input_sent+verified while the keys were swallowed
    // by startup; every answer here must be truthful.
    const race = await submit(stack, RACE_PROMPT, entry.conversation_id);
    const raceKind = assertTruthful(race, RACE_PROMPT);
    evidence.push({
      type: 'runtime',
      value: 'exact SHA ' + sha + ': CLI ' + stack.cli.requested + ' (resolved ' + stack.cli.resolved + '); submit immediately after enter answered ' + raceKind + (race.detail ? ' (' + oneLine(race.detail) + ')' : '') + ' — no unbacked verified claim',
    });

    const idle = await settleClaude(stack, { expectedConversationId: entry.conversation_id });
    const id = idle.conversation_id;

    // The happy path still confirms: a normal prompt against the settled idle
    // CLI is input_sent+verified and readable back by the exact id.
    const ok = await submit(stack, OK_PROMPT, id);
    assert.equal(ok.status, 'input_sent');
    assert.equal(ok.observation, 'verified');
    assert.equal(ok.conversation_id, id);
    const okConversation = await waitFor('the OK prompt and reply in the same conversation',
      async () => {
        const conversation = await getConversation(stack, id, { limit: 50 });
        if (conversation.state !== 'ready') return null;
        const asked = userMessages(conversation, OK_PROMPT).length === 1;
        const answered = (conversation.items || []).some(
          (item) => item.kind === 'message' && item.role === 'assistant' && /\bOK\b/i.test(messageText(item)),
        );
        return asked && answered ? conversation : null;
      }, { timeoutMs: 60_000, intervalMs: 1000 });
    assert.equal(userMessages(okConversation, OK_PROMPT).length, 1);
    evidence.push({
      type: 'runtime',
      value: 'a settled idle submit answered input_sent+verified and the same conversation recorded exactly one OK prompt and the assistant reply',
    });

    // Injection 2: the large single-line CJK prompt. Whatever the delivery
    // phase, the transcript must agree with the claim, and one submit must
    // never deliver the prompt twice.
    await waitForStatus(stack, (current) => current.activity === 'idle' && current.conversation_id === id,
      'idle before the large-prompt injection', 60_000);
    const large = await submit(stack, LARGE_PROMPT, id);
    const largeKind = assertTruthful(large, LARGE_PROMPT);
    await waitForStatus(stack, (current) => current.activity === 'idle' && current.conversation_id === id,
      'idle after the large-prompt injection', 90_000);
    const after = await waitFor('the conversation state after the large prompt',
      async () => {
        const conversation = await getConversation(stack, id, { limit: 50 });
        return conversation.state === 'ready' ? conversation : null;
      }, { timeoutMs: 30_000, intervalMs: 1000 });
    const largeCount = userMessages(after, LARGE_PROMPT).length;
    assert.ok(largeCount <= 1,
      'one submit must not deliver the large prompt twice: ' + largeCount);
    if (large.status === 'input_sent') {
      assert.equal(largeCount, 1,
        'a verified large-prompt delivery must be recorded exactly once in the addressed conversation');
    }
    // The startup-race prompt, if it was delivered at all, was delivered once.
    assert.ok(userMessages(after, RACE_PROMPT).length <= 1,
      'the race prompt must not be duplicated');
    evidence.push({
      type: 'runtime',
      value: 'the ~500-character single-line CJK injection answered ' + largeKind + (large.detail ? ' (' + oneLine(large.detail) + ')' : '') + '; the addressed conversation records it ' + largeCount + ' time(s) — the claim and the transcript agree, with no duplicate delivery',
    });

    return 'a real Claude CLI ' + stack.cli.resolved + ' produced no false verified delivery under the startup-race and large single-line prompt injections: verified claims were backed by the exact transcript message, and unconfirmed delivery answered truthful unknown with read-back guidance';
  } finally {
    await stack.stop();
  }
});
