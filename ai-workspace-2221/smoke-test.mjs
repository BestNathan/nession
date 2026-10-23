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
  space().contextual.some(a => a.candidateId === 'agent:selected:create' && a.eligibility === 'enabled'));
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
  space().contextual.some(a => a.actionId === 'session.create.submit' && a.eligibility === 'enabled'));
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
console.log('\nPASS: ' + count + ' local mock state/event checks. Browser and real-provider acceptance remain pending.');
