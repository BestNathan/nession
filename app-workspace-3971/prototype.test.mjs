import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
const css=fs.readFileSync(path.join(dir,'styles.css'),'utf8');
const tokens=fs.readFileSync(path.join(dir,'tokens.css'),'utf8');
const review=fs.readFileSync(path.join(dir,'review.css'),'utf8');
const js=fs.readFileSync(path.join(dir,'app.js'),'utf8');
test('shared review frame and single product shell owners',()=>{
  assert.match(html,/data-nession-prototype-frame="v1"/);
  assert.match(html,/\.\.\/prototype-frame-2758\/frame\.(css|js)/);
  assert.equal((html.match(/id="app-header"/g)||[]).length,1);
  assert.equal((html.match(/id="capsule-zone"/g)||[]).length,1);
  assert.equal((html.match(/id="app-content"/g)||[]).length,1);
  assert.match(html,/data-nession-source-link/);
  assert.match(html,/data-nession-gallery-link/);
  assert.match(html,/href="\.\/tokens\.css"/);
  assert.match(html,/href="\.\/review\.css"/);
  assert.match(html,/data-aw-theme="light"/);
  assert.match(html,/data-aw-theme="dark"/);
  for(const scenario of ['claude','git','sandbox','files']) {
    assert.match(html,new RegExp('data-scenario="'+scenario+'"'));
  }
  assert.match(html,/跨能力的统一关系/);
});
test('semantic surfaces and shared icon/actions',()=>{
  for(const role of ['surface','surface-head','row-item','field-list','reader','cap-capsule']){
    assert.match(css,new RegExp('\\.'+role+'(?=[\\s\\.{:,])'));
  }
  for(const action of ["case 'browse'","case 'stack'","case 'more'","case 'back'","case 'cap'","case 'guard-discard'"]){
    assert.ok(js.includes(action),action);
  }
  assert.match(js,/aria-label/);
  assert.match(css,/width:var\(--aw-hit\);height:var\(--aw-hit\)/);
});
test('gesture rules include content-owned guards and real forward history only',()=>{
  assert.match(js,/gestureExclusion=/);
  assert.match(js,/state\.cursor<state\.history\.length-1/);
  assert.match(js,/state\.dirty&&active\(\)\.kind==='edit'/);
  assert.match(js,/touchcancel/);
  assert.match(js,/abs\(m\.dx\)>75/);
  assert.match(js,/sessionNo/);
});
test('review and side effects remain mock-only',()=>{
  assert.doesNotMatch(js,/\bfetch\(|\bWebSocket\(|\beval\(/);
  assert.doesNotMatch(html,/cdn\.jsdelivr\.net|unpkg\.com/);
  assert.match(html,/synthetic fixtures/);
});

test('App tokens are canonical scoped snapshot; presentation has no second palette or type ramp',()=>{
  assert.match(tokens,/main a5f5813d56df2cdad0181610ce6999ce085e173e/);
  assert.match(tokens,/--nession-typography-title-size: 17px/);
  assert.match(tokens,/--nession-typography-primary-size: 16px/);
  assert.match(tokens,/--nession-typography-body-size: 14px/);
  assert.match(tokens,/--nession-typography-secondary-size: 13px/);
  assert.match(tokens,/--nession-typography-metadata-size: 12px/);
  assert.match(tokens,/--nession-typography-caption-size: 11\.5px/);
  assert.match(tokens,/--nession-control-md: 44px/);
  assert.match(tokens,/--nession-row-lg: 56px/);
  assert.match(tokens,/--nession-icon-md: 20px/);
  assert.match(tokens,/--nession-rhythm-section-stack: 20px/);
  assert.match(tokens,/--nession-rhythm-text-stack: 4px/);
  assert.match(css,/\.row-text\{[^}]*gap:var\(--nession-rhythm-text-stack\)/);
  assert.doesNotMatch(css,/\.row-meta\{[^}]*margin-top/);
  assert.match(tokens,/\.product\[data-theme="dark"\]/);
  assert.match(tokens,/--aw-canvas: var\(--nession-surface\)/);
  assert.match(tokens,/--aw-surface: var\(--nession-card\)/);
  const presentationRules=css.replace(/\/\*[\s\S]*?\*\//g,'');
  const reviewRules=review.replace(/\/\*[\s\S]*?\*\//g,'');
  assert.doesNotMatch(presentationRules,/oklch\(|#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(presentationRules,/font-size:\s*\d+(?:\.\d+)?px/);
  assert.doesNotMatch(presentationRules,/font-weight:\s*\d{3}/);
  assert.doesNotMatch(presentationRules,/--np-/);
  assert.match(reviewRules,/--np-/);
  assert.doesNotMatch(reviewRules,/--aw-|--nession-/);
  assert.doesNotMatch(js,/style="/);
});
test('Every presentation token reference resolves in the product token snapshot',()=>{
  const names=new Set([...tokens.matchAll(/(--(?:aw|nession)-[a-z0-9-]+)\s*:/g)].map(x=>x[1]));
  const refs=[...css.matchAll(/var\((--(?:aw|nession)-[a-z0-9-]+)/g)].map(x=>x[1]);
  assert.ok(refs.length>70,'styles consume the shared token file');
  assert.deepEqual([...new Set(refs.filter(x=>!names.has(x)))],[]);
});
