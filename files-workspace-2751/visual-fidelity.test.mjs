// Files #2751: mock-only product visual contract + deterministic flow regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('./product-fidelity.css',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script,'classic inline mock JS must be present');

test('1:1 product styling tracks current canonical Files fixture, not the reviewer shell',()=>{
  assert.match(html,/href="\.\/product-fidelity\.css"/);
  assert.match(css,/--nession-workspace-tree-width:\s*208px/);
  assert.match(css,/grid-template-columns:\s*var\(--nession-workspace-tree-width\) minmax\(0,1fr\)/);
  assert.match(css,/--nession-workspace-background:\s*var\(--nession-background\)/);
  assert.match(css,/\.np-device > #app/);
  assert.match(css,/\.np-device > #app \.phone-breadcrumb/);
  assert.doesNotMatch(css,/\.np-stage\s*\{/);
  assert.doesNotMatch(css,/#0e1013/);
  assert.match(html,/"hide":\["#app > \.top","#app > \.hint"\]/);
  assert.doesNotMatch(script,/fetch\("\.\.\/manifest\.json"/);
});

test('Web/ App use different product composition and App Back owns pushed depth',()=>{
  const listeners={};
  const app={
    innerHTML:'',
    clientWidth:390,clientHeight:844,
    addEventListener(type,fn){listeners[type]=fn},
    getBoundingClientRect(){return {left:100,top:50,width:390,height:844}}
  };
  const page={handlers:{},addEventListener(type,fn){this.handlers[type]=fn}};
  const document={
    getElementById(id){return id==='app'?app:null},
    querySelector(sel){return sel==='[data-np-root]'?page:null},
    addEventListener(type,fn){listeners['document-'+type]=fn}
  };
  runInNewContext(script,{document,window:{innerWidth:1440,innerHeight:950}});
  const click=(action,path)=>listeners.click({target:{
    dataset:{action,path},
    closest(){return this},
    getBoundingClientRect(){return {left:120,top:150,right:200,bottom:185}}
  }});
  assert.match(app.innerHTML,/class="content"/,'Web splits tree and editor');
  click('pick','src');
  click('new-file');
  assert.match(app.innerHTML,/Destination[^]*?<code>src\/</,'selected directory is creation target');
  click('close-form');
  page.handlers['np:resize']({detail:{width:390}});
  assert.match(app.innerHTML,/class="mobile-mock"/,'App shows a single navigation stack');
  click('enter','src');
  assert.match(app.innerHTML,/aria-label="Back to parent"/);
  click('mobile-open','src/App.tsx');
  assert.match(app.innerHTML,/aria-label="Back to Files"/);
  assert.ok(app.innerHTML.indexOf('aria-label="Back to Files"')<app.innerHTML.indexOf('App.tsx'),'App Back precedes file identity');
  click('mobile-back');
  assert.doesNotMatch(app.innerHTML,/aria-label="Back to Files"/);
  page.handlers['np:resize']({detail:{width:1180}});
  assert.match(app.innerHTML,/class="content"/);
  assert.doesNotMatch(app.innerHTML,/class="mobile-wrap"/);
});
