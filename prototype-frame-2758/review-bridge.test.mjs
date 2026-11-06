import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';

const source=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'review-bridge.js'),'utf8');
const rule=(condition,cssText)=>({
  type:4,conditionText:condition,media:{mediaText:condition},cssRules:[{cssText}]
});

test('fixed-size product viewport owns responsive rules, not the reviewer window',()=>{
  const width=rule('(max-width: 700px)','.product { display: block }');
  const height=rule('(max-height: 710px)','.product .dock { bottom: 0 }');
  const reduced=rule('(prefers-reduced-motion: reduce)','.product { transition: none }');
  const frame=rule('(max-width: 780px)','.np-page { padding: 14px }');
  const css=[];
  const device={
    style:{},
    product:null,
    prepend(node){this.product=node},
    addEventListener(type,fn){this[type]=fn}
  };
  const product={id:'old-product'};
  const fixtures={appendChild(){}},legacy={appendChild(){}};
  const page={
    contains(){return false},
    querySelector(sel){return {
      '[data-np-device]':device,
      '[data-np-fixtures]':fixtures,
      '[data-np-legacy]':legacy
    }[sel]||null}
  };
  const config={textContent:JSON.stringify({surface:'#old-product',external:[],extra:[],proxy:[],hide:[]})};
  const document={
    readyState:'complete',
    styleSheets:[
      {href:null,cssRules:[width,height,reduced]},
      {href:'https://example.test/prototype-frame-2758/frame.css',cssRules:[frame]}
    ],
    body:{children:[page]},
    head:{appendChild(el){css.push(el.textContent)}},
    getElementById(id){return id==='np-review-config'?config:null},
    querySelector(sel){return sel==='[data-np-root]'?page:sel==='#old-product'?product:null},
    querySelectorAll(){return []},
    createElement(tag){return {tagName:tag,textContent:''}}
  };
  let windowResizes=0;
  const window={dispatchEvent(){windowResizes++}};
  class Event{constructor(type){this.type=type}}
  runInNewContext(source,{document,window,Event,console});
  assert.strictEqual(device.product,product,'original business DOM remains mounted');
  assert.equal(device.style.containerType,'size');
  assert.equal(width.media.mediaText,'not all','original width rule must not act on reviewer');
  assert.equal(height.media.mediaText,'not all','original height rule must not act on reviewer');
  assert.equal(reduced.media.mediaText,'(prefers-reduced-motion: reduce)','a11y rules stay browser-scoped');
  assert.equal(frame.media.mediaText,'(max-width: 780px)','frame rules stay browser-scoped');
  assert.equal(css.length,1);
  assert.match(css[0],/@container \(max-width: 700px\)/);
  assert.match(css[0],/@container \(max-height: 710px\)/);
  assert.doesNotMatch(css[0],/\.np-page|prefers-reduced-motion/);
  assert.equal(windowResizes,1);
});

test('business mock separation and asset ownership remain explicit',()=>{
  const root=dirname(dirname(fileURLToPath(import.meta.url)));
  const files=readFileSync(join(root,'files-workspace-2751/index.html'),'utf8');
  const git=readFileSync(join(root,'git-github-1290/app.js'),'utf8');
  const gitHtml=readFileSync(join(root,'git-github-1290/index.html'),'utf8');
  const reviewCss=readFileSync(join(root,'prototype-frame-2758/review-bridge.css'),'utf8');
  assert.match(files,/previewRoot\.addEventListener\("np:resize"/);
  assert.doesNotMatch(files,/fetch\("../manifest\.json"/);
  assert.match(files,/"#app > \.hint"/);
  assert.match(files,/context-menu\{position:absolute/);
  assert.match(git,/getElementById\('np-git-fixture-controls'\)/);
  assert.match(gitHtml,/id="np-git-fixture-controls"/);
  assert.match(reviewCss,/\.np-device > #app > \.frame > \.workspace/);
  assert.match(reviewCss,/\.np-fixtures #np-git-fixture-controls \.fixture-panel/);
});
