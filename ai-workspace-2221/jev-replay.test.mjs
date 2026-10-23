#!/usr/bin/env node
// Dependency-free smoke of the *archived* Jev replay and its independent modal controller.
// Run: node ai-workspace-2221/jev-replay.test.mjs
// Fake DOM test, NOT a Chromium/browser E2E and NOT a new model inference.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
const root = dirname(fileURLToPath(import.meta.url));
const source = name => readFileSync(join(root,name),'utf8');
const data = source('jev-replay-data.js');
const ui = source('jev-replay.js');
const html = source('index.html');
const css = source('jev-replay.css');

class FakeNode {
  constructor(id=''){
    this.id=id;this.innerHTML='';this.children=[];this.listeners={};this.dataset={};
    this.attributes={};this.style={};this.focused=false;
    const names=new Set();
    this.classList={add:x=>names.add(x),remove:x=>names.delete(x),contains:x=>names.has(x)};
  }
  setAttribute(k,v){this.attributes[k]=String(v);}
  getAttribute(k){return this.attributes[k];}
  hasAttribute(k){return this.attributes[k]!=null;}
  addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
  appendChild(node){this.children.push(node);return node;}
  insertBefore(node){this.children.push(node);return node;}
  focus(){this.focused=true;}
  closest(){return this;}
  querySelectorAll(){return [];}
}
function harness(hash='') {
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,new FakeNode(id));return nodes.get(id)};
  const globals={};
  const listeners={};
  const win={addEventListener:(event,fn)=>(listeners[event]??=[]).push(fn)};
  const location={hash,pathname:'/ai-workspace-2221/index.html',search:''};
  const history={replaceState(_a,_b,url){location.hash='';location.lastReplace=url;}};
  const document={
    activeElement:node('focusAnchor'),
    getElementById:node,
    querySelector:sel=>sel==='.top-actions'?node('top-actions'):null,
    createElement:()=>new FakeNode(),
    addEventListener:(event,fn)=>(listeners['doc:'+event]??=[]).push(fn)
  };
  // In a real DOM, appended nodes become retrievable by getElementById().
  for (const parent of [node('top-actions'),node('app')]) {
    for (const method of ['appendChild','insertBefore']) {
      const base=parent[method].bind(parent);
      parent[method]=child=>{nodes.set(child.id,child);return base(child);};
    }
  }
  runInNewContext(data,{window:win});
  runInNewContext(ui,{window:win,document,location,history}, {timeout:2500});
  const fire=(target,event='click',payload={})=>{
    for(const fn of target.listeners[event]||[])fn({target,preventDefault(){},...payload});
  };
  const press=(dataset={},id='')=>{
    const btn=new FakeNode(id);btn.dataset=dataset;
    fire(node('jevReplayOverlay'),'click',{target:{closest:()=>btn}});
  };
  const ready=()=>node('jevReplayOverlay').classList.contains('jr-open');
  return {node,win,location,history,document,fire,press,ready,listeners};
}
let checked=0;
const check=(message,value)=>{assert.ok(value,message);checked++;console.log('✓ '+message);};
check('HTML includes the replay CSS + two JS assets in execution order',
 html.includes('./jev-replay.css') &&
 html.indexOf('./jev-replay-data.js') < html.indexOf('./jev-replay.js') &&
 html.includes('./jev-replay.js'));
check('replay CSS has responsive mobile dialog rules',
 css.includes('@media(max-width:620px)') && css.includes('.jr-overlay'));
const h=harness();
const all=h.win.NESSION_JEV_REPLAY.suites;
check('all 32 recorded decisions in 3 suites',
 all.length===3 && all.reduce((n,s)=>n+s.cases.length,0)===32);
check('same archived outcomes as documented: 10/12, 3/5, 4/5, 10/10',
 all[0].cases.filter(c=>c.result.hit).length===10 &&
 all[1].cases.filter(c=>c.variant==='baseline' && c.result.hit).length===3 &&
 all[1].cases.filter(c=>c.variant==='progressive' && c.result.hit).length===4 &&
 all[2].cases.filter(c=>c.result.hit).length===10);
check('real outputs are mapped only to current fixture candidates or none',
 all.every(s=>s.cases.every(c=>{
  const allowed=new Set(['none',...c.actions.map(a=>a.id)]);
  return allowed.has(c.result.selected) &&
    allowed.has(c.result.expected) &&
    c.result.hit===(c.result.selected===c.result.expected);
 })));
check('no embedded bearer token/Secret value in replay fixtures',
 !data.includes('Authorization: Bearer') && !data.includes('Bearer ') &&
 !data.includes('process.env.TYPESAFE_API_KEY'));
check('test launch button is attached to Workspace topbar',
 h.node('top-actions').children.some(c=>c.id==='jevReplayButton'));
h.fire(h.node('jevReplayButton'));
check('click opens a real dialog surface',h.ready() && h.node('jevReplayOverlay').getAttribute('aria-hidden')==='false');
check('initial decision list and Source/Run links render',
 h.node('jrList').innerHTML.includes('root-goal') &&
 h.node('jrFooter').innerHTML.includes('39907128502'));
h.press({jrStage:'2'});
check('action stage shows Agent and Session entry candidates',
 h.node('jrDetail').innerHTML.includes('entry:agents') &&
 h.node('jrDetail').innerHTML.includes('entry:sessions'));
h.press({jrStage:'3'});
check('archived model selected none for the original root goal',
 h.node('jrDetail').innerHTML.includes('none · 无匹配动作'));
h.press({jrSuite:'comparison'});
check('A/B comparison includes both variants for same five cases',
 h.node('jrExtra').innerHTML.includes('严格匹配 vs 渐进推进') &&
 h.node('jrList').innerHTML.includes('baseline') &&
 h.node('jrList').innerHTML.includes('progressive'));
h.press({jrFilter:'progressive'});
check('variant filter shows only progressive cases',
 !h.node('jrList').innerHTML.includes('baseline ·') &&
 h.node('jrList').innerHTML.includes('progressive ·'));
h.press({jrFilter:'all'});
h.press({jrCompare:'root-specific',jrVariant:'baseline'});
check('A/B strict-result cell opens archived failing root case',
  h.node('jrRightHeader').innerHTML.includes('与期望不一致') &&
  h.node('jrDetail').innerHTML.includes('none'));
h.press({jrCompare:'root-specific',jrVariant:'progressive'});
check('A/B progressive-result cell opens passing decision for same user goal',
  h.node('jrRightHeader').innerHTML.includes('模型选择命中') &&
  h.node('jrDetail').innerHTML.includes('entry:agents'));
h.press({jrSuite:'relevance'});
check('relevance suite shows recorded 10/10 results and unrelated questions',
 h.node('jrList').innerHTML.includes('写一首关于秋天的诗') &&
 h.node('jrTabs').innerHTML.includes('10/10'));
h.press({jrCase:'nonsense-poem'});
h.press({jrStage:'4'});
check('relevance-gated poetry case correctly selects none',
 h.node('jrDetail').innerHTML.includes('none') &&
 h.node('jrRightHeader').innerHTML.includes('模型选择命中'));
h.press({},'jrClose');
check('close hides replay and restores aria-hidden',
 !h.ready() && h.node('jevReplayOverlay').getAttribute('aria-hidden')==='true');
const direct=harness('#jev-replay');
check('direct deep link #jev-replay opens modal on initial load',direct.ready());
console.log('\nPASS: '+checked+' archived replay schema + UI-controller checks (fake DOM).');
