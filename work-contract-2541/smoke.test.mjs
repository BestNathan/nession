import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function mount() {
  const events = new Map();
  const fixtureHandlers = new Map();
  const classes = new Set();
  const product = {
    innerHTML: '',
    scrollTop: 0,
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    addEventListener(name, handler) { events.set('product:' + name, handler); },
    contains() { return true; },
  };
  const fixtureButtons = ['normal', 'changed', 'denied', 'unavailable', 'feishu'].map((id) => ({
    id,
    getAttribute(name) { return name === 'data-fixture' ? this.id : null; },
    setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value; },
    addEventListener(name, handler) { fixtureHandlers.set(this.id, handler); },
  }));
  const page = {
    querySelector(selector) {
      return selector === '[data-np-device]' ? {
        style: { getPropertyValue() { return '1180px'; } },
      } : null;
    },
    querySelectorAll(selector) { return selector === '[data-fixture]' ? fixtureButtons : []; },
    addEventListener(name, handler) { events.set('page:' + name, handler); },
  };
  const document = {
    getElementById(name) { return name === 'contract-product' ? product : null; },
    querySelector(selector) { return selector === '[data-np-root]' ? page : null; },
  };
  runInNewContext(script, { document });

  return {
    html() { return product.innerHTML; },
    hasClass(name) { return classes.has(name); },
    act(name, value = null) {
      events.get('product:click')({
        target: { closest() {
          return { getAttribute(prop) {
            return prop === 'data-action' ? name : prop === 'data-value' ? value : null;
          } };
        } },
      });
    },
    fixture(name) {
      const button = fixtureButtons.find((candidate) => candidate.id === name);
      assert.ok(button, 'known fixture');
      fixtureHandlers.get(name).call(button);
      return button;
    },
    type(value) { events.get('product:input')({ target: { id:'work-reply-body', value } }); },
    submit() { events.get('product:submit')({ target: { id:'work-reply' }, preventDefault(){} }); },
    resize(width) { events.get('page:np:resize')({ detail:{ width } }); },
  };
}

test('published definition and criteria are separate from trusted verification', () => {
  const ui = mount();
  assert.match(ui.html(), /Definition v1/);
  ui.act('criteria');
  ui.act('criterion', 'SC-01');
  assert.match(ui.html(), /Checked \[x\]/);
  assert.match(ui.html(), /Trusted verification:/);
  assert.match(ui.html(), /Pending/);
  assert.doesNotMatch(ui.html(), /Trusted verification:\s*Pass/);
});

test('thread appends activity without amending immutable definition', () => {
  const ui = mount();
  ui.act('tab', 'thread');
  ui.type('Check scrollback and TUI keyboard.');
  ui.submit();
  assert.match(ui.html(), /Check scrollback and TUI keyboard/);
  assert.match(ui.html(), /Contract v1 unchanged/);
  assert.match(ui.html(), /Local draft/);
});

test('untrusted comments are HTML-escaped, not executed as markup', () => {
  const ui = mount();
  ui.act('tab','thread');
  ui.type('<img src=x onerror=alert(1)>');
  ui.submit();
  assert.ok(ui.html().includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!ui.html().includes('<img src=x'));
});

test('source edit produces an unadopted candidate and explicit comparison', () => {
  const ui = mount();
  ui.fixture('changed');
  assert.match(ui.html(), /Published v1/);
  assert.match(ui.html(), /Source changed/);
  ui.act('source');
  assert.match(ui.html(), /Not published/);
  ui.act('compare');
  assert.match(ui.html(), /Version comparison/);
  assert.match(ui.html(), /Hide comparison/);
  ui.act('compare');
  assert.doesNotMatch(ui.html(), /Version comparison/);
});

test('explicit confirmation adopts v2 but revision v1 and execution pin survive', () => {
  const ui = mount();
  ui.fixture('changed');
  ui.act('source');
  ui.act('confirm');
  assert.match(ui.html(), /Confirm adoption/);
  ui.act('adopt');
  assert.match(ui.html(), /Revision v2/);
  assert.match(ui.html(), /Revision v1/);
  ui.act('revision', '1');
  assert.match(ui.html(), /Definition v1/);
  assert.match(ui.html(), /Published v2/);
  assert.match(ui.html(), /Execution.*Pinned to v1/s);
});

test('denied, unavailable and native-block provider remain scoped read-only fixtures', () => {
  const ui = mount();
  ui.fixture('denied');
  assert.match(ui.html(), /Source access denied/);
  ui.act('source');
  assert.match(ui.html(), /Access denied/);
  ui.fixture('unavailable');
  assert.match(ui.html(), /Source temporarily unavailable/);
  ui.fixture('feishu');
  assert.match(ui.html(), /Feishu document/);
  ui.act('source');
  assert.match(ui.html(), /feishu:example-tenant:doc:demo-42/);
});

test('Web/App widths and contextual back/reopen do not invent a global Work route', () => {
  const ui = mount();
  ui.resize(390);
  assert.ok(ui.hasClass('is-mobile'));
  ui.resize(1180);
  assert.ok(!ui.hasClass('is-mobile'));
  ui.act('back');
  assert.match(ui.html(), /Continue your work/);
  ui.act('open');
  assert.match(ui.html(), /Contract definition/);
});
