// Dependency-free, deterministic DOM-stub smoke for the interactive mock.
// Run from prototype checkout: node claude-memory-2689/smoke-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

const requiredIds = [
  'app','sessions-open','session-heading','rail-expand','terminal','terminal-lines',
  'terminal-dock','context-surface','context-trigger','intent-input','intent-send',
  'to-workspace','workspace','workspace-inner','to-terminal','capability-dock',
  'sessions-layer','session-list','sessions-close','reset'
];
for (const id of requiredIds) {
  assert.match(html, new RegExp('id="' + id + '"'), 'missing target ' + id);
}
for (const asset of ['./app.js', './styles.css']) assert.ok(html.includes(asset));
assert.doesNotMatch(html, /https?:\/\/[^"']+\.(js|css)/);
assert.ok(css.includes('.conversation-capsule'));
assert.ok(css.includes('.context-surface'));
assert.ok(css.includes('.capability-dock'));
assert.ok(css.includes('display:none;height:27px')); // mock footer never steals Terminal height
assert.ok(css.includes('@media(max-width:700px)'));

const nodes = {};
for (const id of requiredIds) {
  nodes[id] = {
    id, handlers:{}, hidden:false, innerHTML:'', textContent:'', dataset:{}, attrs:{},value:'',
    addEventListener(type,fn){this.handlers[type]=fn;},
    setAttribute(name,value){this.attrs[name]=value;},
  };
}
const timers = [];
const doc = {
  getElementById(id){assert.ok(nodes[id], 'unexpected getElementById: ' + id);return nodes[id];},
  addEventListener(){},
};
const global = {
  document:doc,
  window:{innerWidth:390},
  setTimeout(fn){timers.push(fn);return timers.length;},
};
runInNewContext(src,global,{filename:'app.js'});
const api=global.window.__nessionMemoryMock;
function flush(){while(timers.length)timers.shift()();}
function fakeClick(node, attr, value) {
  const el={dataset:{[attr]:value},hasAttribute(name){return name==='data-context-close' && attr==='contextClose';}};
  node.handlers.click({target:{closest(){return el;}}});
}
const state=()=>api.state();
let checks=0;
function check(test){test();checks++;}

check(()=>{
  assert.equal(state().page,'terminal');
  assert.equal(state().context,'closed');
  assert.equal(nodes['workspace'].hidden,true);
  assert.equal(nodes['terminal'].hidden,false);
  assert.ok(nodes['terminal-lines'].innerHTML.includes('Claude Code'));
});

check(()=>{
  nodes['context-trigger'].handlers.click();
  assert.equal(state().context,'list');
  assert.ok(nodes['context-surface'].innerHTML.includes('Claude Code'));
  fakeClick(nodes['context-surface'],'peek','claude');
  assert.equal(state().context,'peek');
  assert.equal(state().page,'terminal'); // choose entry NEVER opens Workspace
  assert.ok(nodes['context-surface'].innerHTML.includes('在 Workspace 查看 Memory'));
  fakeClick(nodes['context-surface'],'contextDeepen','claude');
  assert.equal(state().page,'workspace');
  assert.equal(state().tab,'memory');
  assert.ok(nodes['workspace-inner'].innerHTML.includes('MEMORY.md'));
});

check(()=>{
  api.openFile('architecture.md');
  assert.equal(state().file,'architecture.md');
  assert.equal(state().detail,true);
  flush();
  assert.equal(state().file,'architecture.md');
  assert.ok(nodes['workspace-inner'].innerHTML.includes('架构约束'));
});

check(()=>{
  api.setSession('worktree');
  assert.equal(state().page,'terminal');
  assert.equal(state().phase,'loading');
  flush();
  assert.equal(state().phase,'ready');
  assert.equal(state().repo,'BestNathan/nession');
  assert.equal(state().file,'architecture.md'); // same repo, same memory
});

check(()=>{
  api.openWorkspace();
  api.openFile('interaction.md');
  api.setSession('vol');
  flush(); // stale old read must not overwrite new Session
  assert.equal(state().repo,'BestNathan/vol');
  assert.equal(state().file,'MEMORY.md');
  assert.equal(state().phase,'ready');
  api.openWorkspace();
  assert.ok(nodes['workspace-inner'].innerHTML.includes('Vol · Memory'));
  assert.ok(!nodes['workspace-inner'].innerHTML.includes('架构约束'));
});

check(()=>{
  for (const [session,kind] of [['clean','empty'],['offline','unavailable'],['denied','denied'],['scratch','non_git_empty']]) {
    api.setSession(session);
    flush();
    api.openWorkspace();
    assert.equal(state().phase,kind);
    assert.ok(nodes['workspace-inner'].innerHTML.includes('state-view'));
    assert.ok(!nodes['workspace-inner'].innerHTML.includes('architecture.md'));
  }
});

check(()=>{
  api.reset();
  assert.equal(state().page,'terminal');
  assert.equal(state().repo,'BestNathan/nession');
  assert.equal(state().file,'MEMORY.md');
  assert.equal(state().phase,'ready');
});


check(()=>{
  api.openWorkspace();
  const rendered=nodes['workspace-inner'].innerHTML;
  assert.ok(rendered.includes('memory-prose'));
  assert.ok(rendered.includes('data-memory-href="architecture.md#session-boundary"'));
  assert.ok(rendered.includes('☑'));
  fakeClick(nodes['workspace-inner'],'memoryHref','architecture.md#session-boundary');
  assert.equal(state().file,'architecture.md');
  let scrolled=false;
  nodes['workspace-inner'].querySelectorAll=()=>[{
    getAttribute(name){return name==='data-memory-heading'?'session-boundary':null;},
    scrollIntoView(){scrolled=true;}
  }];
  flush();
  assert.equal(scrolled,true);
  assert.equal(state().scrolledFragment,'session-boundary');
  assert.ok(nodes['workspace-inner'].innerHTML.includes('FRONTMATTER'));
  assert.ok(nodes['workspace-inner'].innerHTML.includes('YAML'));
  assert.ok(nodes['workspace-inner'].innerHTML.includes('<table>'));
  assert.ok(nodes['workspace-inner'].innerHTML.includes('memory-code'));
  fakeClick(nodes['workspace-inner'],'action','toggle-raw');
  assert.equal(state().raw,true);
  assert.ok(nodes['workspace-inner'].innerHTML.includes('memory-raw'));
  fakeClick(nodes['workspace-inner'],'action','toggle-raw');
  assert.equal(state().raw,false);
});

check(()=>{
  const previous=state().file;
  api.followMemoryLink('missing.md');
  assert.equal(state().file,previous);
  assert.match(state().notice,/不在当前 Session/);
  api.followMemoryLink('../../private.md');
  assert.equal(state().file,previous);
  assert.match(state().notice,/阻止/);
  api.followMemoryLink('javascript:alert(1)');
  assert.equal(state().file,previous);
  assert.match(state().notice,/阻止/);
  api.followMemoryLink('MEMORY.md#topics');
  nodes['workspace-inner'].querySelectorAll=()=>[{
    getAttribute(){return 'topics';},
    scrollIntoView(){}
  }];
  flush();
  assert.equal(state().file,'MEMORY.md');
  assert.equal(state().scrolledFragment,'topics');
});

check(()=>{
  api.followMemoryLink('topics/recovery.md#retry-strategy');
  nodes['workspace-inner'].querySelectorAll=()=>state().loadedMore?[{
    getAttribute(){return 'retry-strategy';},
    scrollIntoView(){}
  }]:[];
  flush();
  assert.equal(state().file,'topics/recovery.md');
  assert.equal(state().loadedMore,false);
  assert.match(state().notice,/尚未加载/);
  assert.ok(nodes['workspace-inner'].innerHTML.includes('继续读取'));
  fakeClick(nodes['workspace-inner'],'action','load-more');
  assert.equal(state().loadedMore,true);
  assert.equal(state().scrolledFragment,'retry-strategy');
  assert.ok(nodes['workspace-inner'].innerHTML.includes('Retry strategy'));
  api.followMemoryLink('../architecture.md#session-boundary');
  flush();
  assert.equal(state().file,'architecture.md');
});

console.log('Memory #2689 + #2742 mock: ' + checks + ' state/interaction cases passed; static assets and DOM targets checked.');
console.log('Not a browser/visual verification, provider integration, or production Acceptance result.');
