import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {makeProjection} from '../scripts/project.mjs';

const app=(await readFile(new URL('../app.js',import.meta.url),'utf8'))
  .replace(/^import .*;\s*\n/,'').replace(/\ninit\(\);\s*$/,'');
const now='2026-11-03T06:00:00Z';
class TestElement {
  constructor(tag){
    this.tagName=tag.toUpperCase();this.nodes=[];this.text='';this.dataset={};this.attrs={};
    this.classes=new Set();
    this.classList={add:(...names)=>names.forEach(n=>this.classes.add(n))};
  }
  set className(s){this.classes=new Set(s.split(/\s+/));}
  get className(){return [...this.classes].join(' ');}
  set textContent(s){this.text=String(s);this.nodes=[];}
  get textContent(){return this.text+this.nodes.map(x=>typeof x==='string'?x:x.textContent).join('');}
  append(...items){this.nodes.push(...items);}
  replaceChildren(...items){this.text='';this.nodes=items;}
  setAttribute(k,v){this.attrs[k]=v;}
  removeAttribute(k){delete this.attrs[k];}
  querySelector(selector){
    if(!selector.startsWith('.'))return null;
    const queue=[this],name=selector.slice(1);
    while(queue.length){
      const e=queue.shift();
      if(e.classes.has(name))return e;
      queue.push(...e.nodes.filter(x=>x instanceof TestElement));
    }
    return null;
  }
}
function harness(hash='#/work',fetcher=async()=>{throw Error('fixture offline');}){
  const main=new TestElement('main'),fresh=new TestElement('span'),errors=[];
  const doc={
    getElementById:id=>id==='main'?main:id==='freshness'?fresh:null,
    createElement:tag=>new TestElement(tag),
    createTextNode:t=>({textContent:t}),
    querySelectorAll:()=>[],
    baseURI:'https://bestnathan.github.io/nession/',
    title:'Nession',
  };
  const context=vm.createContext({
    document:doc,location:{hash},window:{addEventListener(){}},
    URL,AbortSignal,Date,Intl,fetch:fetcher,
    renderKnowledge(root){root.append(new TestElement('section'));root.append(new TestElement('p'));root.nodes.at(-1).textContent='Knowledge independent';},
    validKnowledgeSnapshot:()=>true,
    console:{error:(...args)=>errors.push(args),warn(){}},
  });
  vm.runInContext(app,context,{filename:'pages/app.js'});
  return {context,main,fresh,doc,errors,run:x=>vm.runInContext(x,context)};
}
test('site-dependent deep links never render before site.json has resolved',()=>{
  const h=harness();
  h.run('render()');
  assert.match(h.main.textContent,/Loading public engineering snapshot/);
  assert.doesNotMatch(h.main.textContent,/could not be rendered/);
  assert.equal(h.doc.title,'Collaboration — Nession');
  h.run("location.hash='#/agents'; render()");
  assert.match(h.main.textContent,/Loading public engineering snapshot/);
  h.run("location.hash='#/repository'; render()");
  assert.match(h.main.textContent,/Loading public engineering snapshot/);
  h.run("location.hash='#/evidence'; render()");
  assert.match(h.main.textContent,/Loading public engineering snapshot/);
  assert.equal(h.errors.length,0);
});
test('a failed site source produces a truthful unavailable state, not a renderer exception',async()=>{
  const h=harness('#/work');
  await h.run('init()'); // site, prototypes, and Knowledge fetches reject
  assert.match(h.main.textContent,/Engineering snapshot unavailable/);
  assert.doesNotMatch(h.main.textContent,/could not be rendered/);
  assert.match(h.fresh.textContent,/Engineering snapshot unavailable/);
  h.run("location.hash='#/work'; render()");
  assert.match(h.main.textContent,/Engineering snapshot unavailable/);
  assert.equal(h.errors.length,0);
});
test('Knowledge and Prototypes remain independent of an unavailable site snapshot',()=>{
  const h=harness('#/prototypes');
  h.run("siteSnapshotStatus='unavailable'; render()");
  assert.match(h.main.textContent,/Loading published prototypes/);
  assert.doesNotMatch(h.main.textContent,/Engineering snapshot unavailable/);
  h.run("location.hash='#/knowledge'; render()");
  assert.match(h.main.textContent,/Knowledge independent/);
  assert.doesNotMatch(h.main.textContent,/Engineering snapshot unavailable/);
  assert.equal(h.errors.length,0);
});
test('recovered, valid source renders public Issues and PRs after pending startup',()=>{
  const h=harness('#/work');
  const site=makeProjection({issues:[{number:42,title:'Public sample Issue',state:'open',updated_at:now}],
    pulls:[{number:43,title:'Public sample PR',state:'open',updated_at:now}],
    registry:null,workflowRuns:[],meta:{generated_at:now,main_sha:'a'.repeat(40)}});
  h.run('render()');
  assert.match(h.main.textContent,/Loading public engineering snapshot/);
  h.run('snapshot='+JSON.stringify(site)+"; siteSnapshotStatus='available'; render()");
  assert.match(h.main.textContent,/Public sample Issue/);
  assert.match(h.main.textContent,/Public sample PR/);
  assert.doesNotMatch(h.main.textContent,/could not be rendered/);
  assert.equal(h.errors.length,0);
});
test('missing or failed Knowledge data cannot prevent independent site initialization',async()=>{
  const site=makeProjection({issues:[{number:55,title:'Visible public issue',state:'open',updated_at:now}],
    pulls:[],workflowRuns:[],meta:{generated_at:now,main_sha:'a'.repeat(40)}});
  const h=harness('#/work',async url=>{
    if(url.pathname.endsWith('/data/site.json'))return {ok:true,json:async()=>site};
    throw Error('independent fixture unavailable');
  });
  await h.run('init()');
  assert.match(h.main.textContent,/Visible public issue/);
  assert.match(h.fresh.textContent,/Generated/);
  assert.doesNotMatch(h.main.textContent,/could not be rendered/);
  assert.equal(h.errors.length,0);
});
test('Knowledge loads separately even if the public site source is unavailable',async()=>{
  const h=harness('#/knowledge',async url=>{
    if(url.pathname.endsWith('/data/knowledge.json'))
      return {ok:true,json:async()=>({schema_version:1,status:'available',source:{sha:'a'.repeat(40)}})};
    throw Error('other snapshots unavailable');
  });
  await h.run('init()');
  // The Knowledge view uses its own loader, regardless of site.json availability.
  assert.match(h.main.textContent,/Knowledge independent/);
  assert.equal(h.errors.length,0);
});
test('source fetch is bounded and app schedules a rerender after success or failure',()=>{
  assert.match(app,/let siteSnapshotStatus\s*=\s*'loading'/);
  assert.match(app,/signal:AbortSignal\.timeout\(15000\)/);
  assert.match(app,/siteSnapshotStatus='available';/);
  assert.match(app,/siteSnapshotStatus='unavailable';/);
  assert.match(app,/if\(needsSite&&!snapshot\)/);
  assert.match(app,/async function loadKnowledgeCatalog\(\)/);
  assert.match(app,/data\/knowledge\.json/);
  assert.match(app,/window\.addEventListener\('hashchange',render\)/);
});
