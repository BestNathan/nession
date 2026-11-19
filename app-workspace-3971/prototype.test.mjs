import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
const css=fs.readFileSync(path.join(dir,'styles.css'),'utf8');
const js=fs.readFileSync(path.join(dir,'app.js'),'utf8');
test('shared review frame and single product shell owners',()=>{
  assert.match(html,/data-nession-prototype-frame="v1"/);
  assert.match(html,/\.\.\/prototype-frame-2758\/frame\.(css|js)/);
  assert.equal((html.match(/id="app-header"/g)||[]).length,1);
  assert.equal((html.match(/id="capsule-zone"/g)||[]).length,1);
  assert.equal((html.match(/id="app-content"/g)||[]).length,1);
  assert.match(html,/data-nession-source-link/);
  assert.match(html,/data-nession-gallery-link/);
});
test('semantic surfaces and shared icon/actions',()=>{
  for(const role of ['surface','surface-head','row-item','field-list','reader','cap-capsule']){
    assert.match(css,new RegExp('\\.'+role+'(?=[\\s\\.{:,])'));
  }
  for(const action of ["case 'browse'","case 'stack'","case 'more'","case 'back'","case 'cap'","case 'guard-discard'"]){
    assert.ok(js.includes(action),action);
  }
  assert.match(js,/aria-label/);
  assert.match(css,/width:44px;height:44px/);
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
