#!/usr/bin/env node
// Dependency-free DOM-stub smoke for #2789. This is NOT Chromium / production evidence.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const script = readFileSync(join(dir, 'app.js'), 'utf8');
for (const rel of ['styles.css', 'app.js', '../prototype-frame-2758/frame.css', '../prototype-frame-2758/frame.js']) {
  assert.ok(existsSync(join(dir, rel)), 'missing asset: ' + rel);
}
assert.match(html, /data-nession-prototype-frame="v1"/);
assert.match(html, /data-nession-source-link/);
assert.match(html, /data-nession-gallery-link/);

const listeners = {}, fields = {};
const root = { className: '', _html: '', addEventListener(type, cb) { listeners[type] = cb; }, contains() { return true; }, querySelector(sel) { return fields[sel] || null; } };
Object.defineProperty(root, 'innerHTML', {
  get() { return this._html; },
  set(val) {
    this._html = val;
    const t = val.match(/<input id="n-title"[^>]*value="([^"]*)"/);
    if (t) fields['#n-title'] = { value: t[1], focus() {} };
    const d = val.match(/<textarea id="n-description"[^>]*>([\s\S]*?)<\/textarea>/);
    if (d) fields['#n-description'] = { value: d[1] };
    const tag = val.match(/<input id="n-new-tag"[^>]*value="([^"]*)"/);
    if (tag) fields['#n-new-tag'] = { value: tag[1], focus() {} };
  }
});
const device = { style: { setProperty(k, v) { device[k] = v; } } };
const page = { events: {}, addEventListener(type, cb) { this.events[type] = cb; } };
const fixtureNames = ['normal', 'legacy', 'offline', 'conflict', 'reused'];
const buttons = fixtureNames.map(f => ({ f, cb: null, addEventListener(type, cb) { this.cb = cb; }, getAttribute(n) { return n === 'data-fixture' ? this.f : null; }, setAttribute() {} }));
const document = { getElementById() { return root; }, querySelector(sel) { return sel === '[data-np-device]' ? device : page; }, querySelectorAll() { return buttons; } };
runInNewContext(script, { document });
let cases = 0;
function check(message, predicate) { cases++; assert.ok(predicate, message); }
function click(action, attrs = {}) { const el = { getAttribute(name) { return name === 'data-action' ? action : attrs[name] ?? null; } }; listeners.click({ target: { closest() { return el; } } }); }
function fixture(name) { buttons.find(b => b.f === name).cb(); }

check('initial title', root.innerHTML.includes('Terminal reconnect reliability'));
click('edit');
check('edit form', root.innerHTML.includes('data-testid="session-metadata-editor"'));
fields['#n-title'].value = 'Reconnect redesign';
fields['#n-description'].value = 'Precise connection recovery';
click('save');
check('new title', root.innerHTML.includes('Reconnect redesign'));
check('tmux name still present', root.innerHTML.includes('terminal-reconnect'));
click('edit');
fields['#n-title'].value = 'Draft should not save';
click('cancel');
check('cancel', !root.innerHTML.includes('Draft should not save'));
click('edit');
fields['#n-new-tag'].value = 'terminal';
click('add-tag');
check('duplicate tag rejection', root.innerHTML.includes('标签重复'));
fields['#n-title'].value = 'Unsaved state';
click('select', { 'data-index': '1' });
check('discard confirmation', root.innerHTML.includes('放弃未保存'));
click('stay');
check('stay restores editor', root.innerHTML.includes('n-title'));
click('select', { 'data-index': '1' });
click('discard');
check('discard switches session', root.innerHTML.includes('design-review'));
fixture('legacy');
check('empty title fallback', root.innerHTML.includes('data-testid="session-title">design-review'));
fixture('offline');
click('edit');
fields['#n-title'].value = 'Cannot save while offline';
click('save');
check('offline failure', root.innerHTML.includes('无法保存'));
check('offline draft preserved', root.innerHTML.includes('Cannot save while offline'));
fixture('conflict');
click('edit');
fields['#n-title'].value = 'Should not overwrite remote';
click('save');
check('stale revision conflict', root.innerHTML.includes('其他设备更新'));
check('explicit reload discard button', root.innerHTML.includes('放弃草稿并加载最新版本'));
click('refresh-conflict');
check('remote state loaded', root.innerHTML.includes('updated elsewhere'));
check('stale edit not applied', !root.innerHTML.includes('Should not overwrite remote'));
fixture('reused');
check('same name new instance resets metadata', !root.innerHTML.includes('Terminal reconnect reliability') && root.innerHTML.includes('terminal-reconnect'));
page.events['np:resize']({ detail: { width: 390 } });
check('App 390 1:1 height', device['--np-device-height'] === '844px');
check('App header', root.innerHTML.includes('n-app-top'));
click('terminal');
check('App Terminal return', root.innerHTML.includes('Last login'));
click('workspace');
check('App Workspace reentry', root.innerHTML.includes('data-testid="session-details"'));
console.log('Session Metadata prototype mock assertions: ' + cases + '/' + cases + ' passed.');
