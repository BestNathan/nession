#!/usr/bin/env node
// Dependency-free contract smoke tests for the standalone mock HTML.
// Usage: node smoke-test.mjs
// This is a JavaScript state/event harness, NOT a real browser E2E and NOT acceptance evidence.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, 'prototype must embed its executable script');
const els = new Map(), listeners = new Map();
let holdIntent = false;
const pending = [];
function el(id) {
  if (els.has(id)) return els.get(id);
  const cls = new Set();
  const x = {
    id, value: '', textContent: '', innerHTML: '', dataset: {}, style: {}, parentElement: null, disabled: false,
    classList: {
      add: key => cls.add(key),
      remove: key => cls.delete(key),
      toggle: (key, yes) => { if (yes === undefined) yes = !cls.has(key); if (yes) cls.add(key); else cls.delete(key); }
    },
    addEventListener: (event, fn) => {
      const key = id + ':' + event;
      listeners.set(key, [...(listeners.get(key) || []), fn]);
    },
    appendChild(child) { child.parentElement = x; return child; },
    focus() {}, setAttribute() {}, removeAttribute() {}, setSelectionRange() {},
    get scrollHeight() { return 44; }, get selectionStart() { return x.value.length; }
  };
  els.set(id, x);
  return x;
}
const document = {
  getElementById: el,
  addEventListener(event, fn) { listeners.set(event, [...(listeners.get(event) || []), fn]); }
};
const fakeTimer = (callback, millis) => {
  if (holdIntent && millis === 420) pending.push(callback);
  else callback();
  return 1;
};
runInNewContext(source, {
  document, setTimeout: fakeTimer, clearTimeout() {}, confirm: () => true,
  structuredClone: value => JSON.parse(JSON.stringify(value))
}, { timeout: 3000 });

function dispatch(type, target, owner) {
  for (const fn of listeners.get((owner ? owner + ':' : '') + type) || []) {
    fn({ target, preventDefault() {}, key: '', isComposing: false });
  }
}
function click(dataset) {
  const b = { dataset, hasAttribute: () => false };
  dispatch('click', { closest: () => b });
}
function inspect() {
  dispatch('click', el('inspectButton'), 'inspectButton');
}
function state() {
  return JSON.parse(el('debugState').textContent);
}
function space() {
  return JSON.parse(el('debugActionSpace').textContent);
}
function decision() {
  return JSON.parse(el('debugDecision').textContent);
}
async function ask(question, settle = true) {
  el('questionInput').value = question;
  dispatch('submit', el('questionForm'), 'questionForm');
  if (settle) for (let i = 0; i < 15; i++) await Promise.resolve();
}
let count = 0;
function check(label, condition) {
  assert.ok(condition, label);
  count++;
  process.stdout.write('✓ ' + label + '\n');
}

inspect();
await ask('查看 Agent 列表');
check('opens exactly one Agent Scene', state().scenes.length === 1);
const stableId = state().scenes[0].sceneId;
check('root entry candidates present', space().entry.some(a => a.actionId === 'session.list.show'));
check('root never exposes a SessionCreate leaf', !space().all.some(a => a.actionId === 'session.create.open'));
check('AgentList loaded exposes row actions, not a global create action',
  space().view.some(a => a.actionId === 'agent.select') &&
  !space().entry.some(a => a.actionId === 'session.create.open'));
dispatch('input', { id: 'agentSearch', value: 'mac', selectionStart: 3 });
check('filtered snapshot order is the visible list', state().visibleSelection.orderedResourceIds.join(',') === 'agent-mac-02');
await ask('选择第二个');
check('out-of-range ordinal clarifies and does not create Scene',
  state().scenes.length === 1 && decision().chosen === 'clarification.required');
await ask('选择第一个');
check('first visible Agent is selected', state().selectedAgentId === 'agent-mac-02');
check('selected Agent creates a contextual next action',
  space().view.some(a => a.candidateId === 'agent:selected:create' && a.eligibility === 'enabled'));
click({ createAgent: 'agent-tokyo-04' });
check('offline Agent cannot launch create', state().scenes[0].activeView === 'agent.list');
holdIntent = true;
await ask('查看 Session 列表', false);
check('inference may remain pending while the UI stays live', pending.length === 1);
click({ agentSelect: 'agent-dev-01' });
holdIntent = false;
pending.shift()();
for (let i = 0; i < 15; i++) await Promise.resolve();
check('stale model result is discarded after later user click', decision().type === 'discarded' && state().scenes.length === 1);
click({ createAgent: 'agent-mac-02' });
check('inline create maintains the same Scene ID', state().scenes[0].sceneId === stableId && state().scenes.length === 1);
dispatch('input', { id: 'formName', value: 'contract-smoke' });
check('incomplete/complete form changes legal submit eligibility',
  space().view.some(a => a.actionId === 'session.create.submit' && a.eligibility === 'enabled'));
dispatch('submit', { id: 'createSessionForm' });
check('confirmed Session ID and owning Scene stored',
  state().lastConfirmedOutcome?.resource?.id === 'agent-mac-02:contract-smoke' &&
  state().lastConfirmedOutcome.ownerSceneId === stableId);
check('confirmed result exposes open Session handoff candidate',
  space().eligible.some(a => a.actionId === 'session.open'));
await ask('打开刚创建的 Session');
check('result handoff enters Standard mode, preserving Scene',
  state().mode === 'standard' && state().scenes.length === 1);
dispatch('click', el('modeAI'), 'modeAI');
check('returning to AI mode restores original Scene',
  state().mode === 'ai' && state().scenes[0].sceneId === stableId);
await ask('查看 Session 列表');
check('independent SessionList opens a second Scene', state().scenes.length === 2);
await ask('查看 Session 列表');
check('repeated SessionList reuses existing Scene', state().scenes.length === 2);
await ask('一些不相关的输入');
check('unknown intent clarifies without allocating a Scene', state().scenes.length === 2);
// Restart the workspace and drive a high-level goal through newly exposed steps.
dispatch('click', el('resetButton'), 'resetButton');

await ask('在北京节点创建一个名叫 dev-test 的 Session');
const g = state().pendingGoal;
check('high-level goal enters Agent Scene, not a root SessionCreate action',
  state().scenes.length === 1 && state().scenes[0].rootCapabilityId === 'agent.list');
check('goal selects only a visible Agent row then its exposed Create action',
  g?.steps?.[0]?.candidateId === 'agent:select:agent-bj-03' &&
  g?.steps?.[1]?.candidateId === 'agent:selected:create');
check('goal pauses at explicit form commit barrier with prefilled name',
  g?.status === 'awaiting_user_commit' &&
  state().scenes[0].activeView === 'session.create' &&
  state().scenes[0].viewInstances[1].draft.hasName);
check('nested Agent row actions retract when Create View is active',
  !space().view.some(c => c.actionId === 'agent.select' || c.actionId === 'session.create.open') &&
  space().view.some(c => c.actionId === 'session.create.submit' && c.eligibility === 'enabled'));
check('goal did not auto-create any Session',
  !state().lastConfirmedOutcome?.resource?.id?.endsWith('dev-test'));
holdIntent = true;
await ask('查看 Session 列表', false);
check('late intent pending while form remains editable', pending.length === 1);
dispatch('input', {id:'formName', value:'dev-test-manual'});
holdIntent = false;
pending.shift()();
for (let i = 0; i < 15; i++) await Promise.resolve();
check('form edit invalidates an older focus-changing System One decision',
  decision().type === 'discarded' && state().scenes.length === 1);
dispatch('submit', {id:'createSessionForm'});
check('only explicit user submit creates the confirmed result',
  state().lastConfirmedOutcome?.resource?.id === 'agent-bj-03:dev-test-manual');
check('success retracts Create submit and reveals result-specific handoff',
  !space().view.some(c => c.actionId === 'session.create.submit') &&
  space().view.some(c => c.actionId === 'session.open' && c.target.resource?.id === 'agent-bj-03:dev-test-manual'));
dispatch('click', el('resetButton'), 'resetButton');
await ask('创建 Session');
check('target-free create opens Agent entry but pauses for selection',
  state().scenes.length === 1 &&
  state().pendingGoal.status === 'awaiting_selection' &&
  !space().view.some(c => c.actionId === 'session.create.open'));
click({agentSelect:'agent-mac-02'});
check('manual Agent selection resumes goal but waits for missing form input',
  state().pendingGoal.status === 'awaiting_input' &&
  state().scenes[0].activeView === 'session.create');
dispatch('input', {id:'formName',value:'manual-goal'});
check('valid user input makes goal commit-ready but does not auto-submit',
  state().pendingGoal.status === 'awaiting_user_commit' &&
  !state().lastConfirmedOutcome?.resource?.id?.endsWith('manual-goal'));


dispatch('click', el('resetButton'), 'resetButton');
check('reset removes prior Pending Goal and confirmed mock result',
  state().scenes.length === 0 && state().pendingGoal === null && state().lastConfirmedOutcome === null);
await ask('在北京节点单独创建一个名叫 independent-dev 的 Session');
check('independent placement is only resolved after Agent View exposes Create',
  state().scenes.length === 2 &&
  state().scenes[0].rootCapabilityId === 'agent.list' &&
  state().scenes[1].rootCapabilityId === 'session.create' &&
  state().pendingGoal?.steps?.some(x => x.candidateId === 'agent:selected:create'));
check('standalone Scene starts with bound target and user commit barrier',
  state().scenes[1].activeView === 'session.create' &&
  state().pendingGoal?.status === 'awaiting_user_commit' &&
  space().view.some(x => x.actionId === 'session.create.submit' && x.eligibility === 'enabled'));
check('inactive Agent Scene row actions do not leak into the standalone View',
  !space().view.some(x => x.actionId === 'agent.select'));

dispatch('click', el('resetButton'), 'resetButton');
await ask('创建 Session');
check('root goal uses intermediate-step Jev routing instructions',
  el('debugQuestionPlan').textContent.includes('推动目标前进的下一步') &&
  el('debugQuestionPlan').textContent.includes('agent.list.show'));
check('missing target pauses before form, without exposing future leaf',
  state().pendingGoal.status === 'awaiting_selection' &&
  !space().view.some(x => x.actionId === 'session.create.open'));
click({agentSelect:'agent-dev-01'});
check('after visible row selection goal waits for missing name',
  state().pendingGoal.status === 'awaiting_input');
const goalId=state().pendingGoal.goalId,ownerScene=state().activeSceneId;
await ask('名称叫 followup-test');
check('slot-only utterance updates current form without resetting goal or invoking model',
  state().pendingGoal.goalId === goalId &&
  state().pendingGoal.status === 'awaiting_user_commit' &&
  state().scenes.length === 1 &&
  decision().judgment === 'slot.update' && decision().modelCalled === false);
check('slot update retains explicit commit barrier; no backend outcome',
  !state().lastConfirmedOutcome?.resource?.id?.endsWith('followup-test') &&
  space().view.some(x => x.actionId === 'session.create.submit' && x.eligibility === 'enabled'));
await ask('查看 Session 列表');
check('unrelated user intent suspends existing goal, preserves its owning Scene',
  state().pendingGoal.goalId === goalId &&
  state().pendingGoal.status === 'suspended' &&
  state().scenes.length === 2);
click({focus:ownerScene});
await ask('继续');
check('resume restores original Scene form and goal without replaying earlier steps',
  state().pendingGoal.goalId === goalId &&
  state().pendingGoal.status === 'awaiting_user_commit' &&
  state().scenes.find(x=>x.sceneId===ownerScene)?.activeView === 'session.create');
check('automated step receipts pin View revision and action-space fingerprint',
  state().pendingGoal.steps.every(x=>x.step==='prefill' || x.fingerprint !== undefined) &&
  state().pendingGoal.steps.some(x=>x.sourceViewInstanceId));

console.log('\nPASS: ' + count + ' local mock state/event checks. Browser and real-provider acceptance remain pending.');
