// #2654 – deterministic Environment Web/App semantic-owner regression.
// Synthetic DOM only: it is not a Chromium or production runtime verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./product-ia.css', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'prototype script exists');

test('Web/App product shell ownership is real markup, mock controls remain external', () => {
  assert.match(html, /data-testid="web-layout"/);
  assert.match(html, /data-testid="sidebar"/);
  assert.match(html, /data-testid="shell-main"/);
  assert.match(html, /data-testid="workspace-shell"/);
  assert.match(html, /data-testid="workspace-tool-content"/);
  assert.match(html, /data-testid="workspace-tool-bar"/);
  assert.match(html, /data-testid="app-page-header"/);
  assert.match(html, /data-testid="terminal-surface"/);
  assert.match(html, /data-testid="env-web-layout"/);
  assert.match(html, /href="\.\/product-ia\.css"/);
  assert.match(html, /"external":\["\.mock-controls","\.foot"\]/);
  assert.doesNotMatch(html, /<header class="top">/);
  assert.doesNotMatch(html, /<div class="brand">nession/);
  assert.equal((html.match(/id="back"/g) || []).length, 1, 'shell owns only App back');
  assert.ok(
    html.indexOf('class="mock-controls"') > html.indexOf('data-testid="terminal-surface"'),
    'scenario controls belong outside product'
  );
  assert.match(css, /--nession-workspace-tree-width:208px/);
  assert.match(css, /@container \(max-width:430px\)/);
  assert.doesNotMatch(css, /\.np-stage\s*\{/);
});

test('session/profile/binding and Terminal→Workspace/App depth preserve flow', () => {
  const listeners = {};
  const root = { dataset: {} };
  function element(id) {
    const obj = {
      id, innerHTML: '', textContent: '', value: '', hidden: false,
      disabled: false, dataset: {}, attributes: {},
      addEventListener(type, fn) { listeners[id + '-' + type] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() {},
    };
    obj.classList = {
      classes: new Set(),
      add(cls) { this.classes.add(cls); },
      remove(cls) { this.classes.delete(cls); },
      contains(cls) { return this.classes.has(cls); },
    };
    return obj;
  }
  const ids = {};
  for (const id of [
    'workspace','ia-depth-title','back','main','profileCount',
    'sessionNav','search','profileNav','content','stateSelect',
    'toggleSession','toggleAgent'
  ]) ids[id] = element(id);
  ids.stateSelect.value = 'in_sync';
  const selectors = {
    '.shell': root,
    '.ia-terminal-root': element('term'),
    '.ia-workspace-shell': element('work'),
    '.ia-terminal-peek': element('peek'),
    '.ia-session-sidebar': element('side'),
    '[data-np-root]': {
      addEventListener(type, fn) { listeners['page-' + type] = fn; }
    }
  };
  const document = {
    getElementById(id) {
      assert.ok(ids[id], 'unknown ID: ' + id);
      return ids[id];
    },
    querySelector(selector) {
      assert.ok(selectors[selector], 'unknown selector: ' + selector);
      return selectors[selector];
    },
    addEventListener(type, fn) { listeners[type] = fn; }
  };
  runInNewContext(script, { document });
  const click = (id = '', data = {}) => listeners.click({
    target: { closest() { return { id, dataset: data, matches() { return false; } }; } }
  });

  assert.equal(root.dataset.surface, 'workspace');
  assert.equal(root.dataset.experience, 'web');
  assert.match(ids.content.innerHTML, /dev-session/);
  click('', {open:'server:base.env'});
  assert.equal(ids['ia-depth-title'].textContent, 'base.env');
  assert.ok(ids.workspace.classList.contains('detail'));
  click('back');
  assert.ok(!ids.workspace.classList.contains('detail'));
  click('manage');
  assert.equal(ids['ia-depth-title'].textContent, 'Manage binding');
  click('apply');
  assert.match(ids.content.innerHTML, /Waiting for next shell prompt/);
  click('prompt');
  assert.match(ids.content.innerHTML, /Environment in sync/);
  click('', {ia:'collapse'});
  assert.ok(selectors['.ia-session-sidebar'].classList.contains('collapsed'));
  click('', {ia:'expand'});
  assert.ok(!selectors['.ia-session-sidebar'].classList.contains('collapsed'));
  click('', {ia:'terminal'});
  assert.equal(root.dataset.surface, 'terminal');
  assert.equal(selectors['.ia-terminal-root'].hidden, false);
  click('', {ia:'toggle-capabilities'});
  assert.equal(selectors['.ia-terminal-peek'].hidden, false);
  click('', {ia:'workspace'});
  assert.equal(root.dataset.surface, 'workspace');
  listeners['page-np:resize']({detail:{width:390}});
  assert.equal(root.dataset.experience, 'app');
  click('', {open:'session'});
  assert.ok(ids.workspace.classList.contains('detail'));
  assert.equal(ids.back.attributes['aria-label'], 'Back to Environment');
  click('back');
  assert.ok(!ids.workspace.classList.contains('detail'));
  click('back');
  assert.equal(root.dataset.surface, 'terminal');
  click('toggleAgent');
  assert.match(ids.content.innerHTML, /Agent is unreachable/);
  listeners['page-np:resize']({detail:{width:1180}});
  assert.equal(root.dataset.experience, 'web');
});
