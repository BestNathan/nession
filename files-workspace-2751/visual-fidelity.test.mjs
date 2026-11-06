// Files #2751: current product information architecture + mock flow regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('./product-fidelity.css',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script,'classic inline mock JS must be present');

test('only Workspace and capability owners draw their Nession screen regions',()=>{
  assert.match(html,/href="\.\/product-fidelity\.css"/);
  assert.match(script,/function webSidebar\(/);
  assert.match(script,/function webShell\(/);
  assert.match(script,/data-testid="workspace-shell"/);
  assert.match(script,/data-testid="workspace-tool-content"/);
  assert.match(script,/data-testid="app-page-header"/);
  assert.match(css,/--nession-workspace-tree-width:\s*208px/);
  assert.match(css,/\.ia-web-layout/);
  assert.match(css,/\.ia-session-sidebar/);
  assert.match(css,/\.ia-workspace-shell/);
  assert.match(css,/\.ia-app-page-header/);
  assert.match(css,/--nession-workspace-background:\s*var\(--nession-background\)/);
  assert.doesNotMatch(script,/function workspaceHeader\(/);
  assert.doesNotMatch(script,/function header\(/);
  assert.doesNotMatch(script,/fetch\("\.\.\/manifest\.json"/);
  assert.doesNotMatch(css,/\.np-stage\s*\{/);
});

test('WebLayout + WorkspaceShell + AppPageHeader own navigation through every depth',()=>{
  const listeners={};
  const app={innerHTML:'',clientWidth:1180,clientHeight:844,
    addEventListener(type,fn){listeners[type]=fn},
    getBoundingClientRect(){return {left:100,top:50,width:1180,height:844}}
  };
  const page={handlers:{},addEventListener(type,fn){this.handlers[type]=fn}};
  const document={
    getElementById(id){return id==='app'?app:null},
    querySelector(sel){return sel==='[data-np-root]'?page:null},
    addEventListener(type,fn){listeners['document-'+type]=fn}
  };
  runInNewContext(script,{document,window:{innerWidth:1440,innerHeight:950}});
  const click=(action,path)=>listeners.click({target:{
    dataset:{action,path},closest(){return this},
    getBoundingClientRect(){return {left:120,top:150,right:200,bottom:185}}
  }});
  assert.match(app.innerHTML,/data-testid="web-layout"/);
  assert.match(app.innerHTML,/data-testid="sidebar"/);
  assert.match(app.innerHTML,/data-testid="workspace-shell"/);
  assert.match(app.innerHTML,/data-testid="files-web-browser"/);
  assert.doesNotMatch(app.innerHTML,/class="workspace-header"/);
  click('sidebar-collapse');
  assert.match(app.innerHTML,/data-collapsed="true"/);
  click('sidebar-expand');
  assert.doesNotMatch(app.innerHTML,/data-collapsed="true"/);
  click('pick','src');
  click('new-file');
  assert.match(app.innerHTML,/Destination[^]*?<code>src\/</,'selected dir is creation target');
  click('close-form');
  click('open-terminal');
  assert.match(app.innerHTML,/data-testid="terminal-surface"/);
  assert.match(app.innerHTML,/class="ia-terminal-conversation"/);
  assert.match(app.innerHTML,/aria-label="Open Workspace"/);
  click('toggle-terminal-context');
  assert.match(app.innerHTML,/aria-label="Open Files capability"/);
  click('open-files');
  assert.match(app.innerHTML,/data-testid="workspace-shell"/);
  click('open-terminal');
  click('open-workspace');
  assert.match(app.innerHTML,/data-testid="workspace-shell"/);
  page.handlers['np:resize']({detail:{width:390}});
  assert.doesNotMatch(app.innerHTML,/data-testid="sidebar"/,'App does not miniaturize Web sidebar');
  assert.match(app.innerHTML,/data-testid="app-page-header"/);
  assert.match(app.innerHTML,/aria-label="Directory path"/);
  assert.doesNotMatch(app.innerHTML,/class="phone-top"/,'no duplicate App header');
  click('enter','src');
  assert.match(app.innerHTML,/<h1>src<\/h1>/);
  click('mobile-open','src/App.tsx');
  assert.match(app.innerHTML,/<h1>App.tsx<\/h1>/);
  assert.equal((app.innerHTML.match(/data-action="shell-back"/g)||[]).length,1);
  assert.doesNotMatch(app.innerHTML,/data-action="mobile-back"/);
  click('shell-back');
  assert.match(app.innerHTML,/data-testid="files-app-directory"/);
  click('search-files');
  assert.match(app.innerHTML,/data-testid="files-app-search"/);
  click('shell-back');
  assert.match(app.innerHTML,/data-testid="files-app-directory"/);
  click('shell-back');
  assert.match(app.innerHTML,/<h1>Files<\/h1>/);
  click('shell-back');
  assert.match(app.innerHTML,/data-testid="terminal-surface"/);
  page.handlers['np:resize']({detail:{width:1180}});
  assert.match(app.innerHTML,/data-testid="web-layout"/);
});
