// #2254 proposed AI Conversation presentation contract: quiet entry and
// external mock controls, not a shipped Nession production conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('./product-ia.css',import.meta.url),'utf8');
const app=readFileSync(new URL('./app.mjs',import.meta.url),'utf8');

test('product conversation begins as composer-only; scenarios belong to reviewer frame',()=>{
  const start=html.indexOf('<div class="app is-empty" id="app">');
  const end=html.indexOf('<script type="module"',start);
  assert.ok(start>=0&&end>start);
  const section=html.slice(start,end);
  const close=section.indexOf('</div>\n<!-- Scenario shortcuts');
  assert.ok(close>0);
  const product=section.slice(0,close);
  const external=section.slice(close);
  assert.match(product, /class="composer-shell"/);
  assert.match(product, /id="composer"/);
  assert.match(product, /id="prompt"/);
  assert.match(product, /id="feed"/);
  assert.doesNotMatch(product, /class="welcome"/);
  assert.match(external, /class="welcome"/);
  assert.match(external, /data-prompt="查看在线 Agent"/);
  assert.match(html,/href="\.\/product-ia\.css"/);
  assert.ok(html.includes('"external":[".topbar",".welcome","#inspector",".composer-caption"]'));
  assert.match(css,/\.np-fixtures \.welcome/);
  assert.match(css,/\.np-fixtures \.inspector/);
  assert.match(css, /#app\.is-empty \.composer-shell/);
});

test('the proposed text-native UI retains its real mock runtime and parser entry points',()=>{
  assert.match(html,/type="module" src="\.\/app\.mjs"/);
  assert.match(app,/import \{parseText, directiveText, referenceText\} from "\.\/content-parser\.mjs"/);
  assert.match(app,/function routeUser\(/);
  assert.match(app,/function submitText\(/);
  assert.match(app,/function assistantStream\(/);
  assert.match(app,/\$\("composer"\)\.addEventListener\("submit"/);
  assert.match(app,/document\.querySelectorAll\("\[data-prompt\]"\)/);
  assert.match(app,/state\.instances\.clear\(\)/);
});
