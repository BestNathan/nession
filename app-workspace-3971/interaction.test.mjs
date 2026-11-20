import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const source=fs.readFileSync(path.join(dir,'app.js'),'utf8');

function harness({deferTimers=false}={}){
  class Element {
    constructor(id){
      Object.assign(this,{id,innerHTML:'',textContent:'',hidden:false,scrollTop:0,style:{},dataset:{},listeners:{}});
    }
    addEventListener(name,handler){this.listeners[name]=handler;}
    querySelector(){return null;}
    focus(){}
    getBoundingClientRect(){return {left:0,right:390};}
    closest(){return null;}
  }
  const keys=['#product','#terminal','#workspace','#app-header','#app-content','#capsule-zone',
    '#app-overlay','#app-toast','#page-frame','#workspace-underlay','#inspector','#review'];
  const nodes=Object.fromEntries(keys.map(k=>[k,new Element(k)]));
  const fixtures=['normal','empty','error','session','terminal'].map(kind=>{
    const el=new Element(kind);el.dataset.fixture=kind;el.setAttribute=()=>{};return el;
  });
  const themes=['light','dark'].map(kind=>{
    const el=new Element(kind);el.dataset.awTheme=kind;el.setAttribute=(key,value)=>{el[key]=value;};return el;
  });
  const scenarios=['claude','git','sandbox','files'].map(kind=>{
    const el=new Element(kind);el.dataset.scenario=kind;el.setAttribute=(key,value)=>{el[key]=value;};return el;
  });
  const document={
    querySelector:s=>nodes[s]||null,
    querySelectorAll:s=>s==='[data-fixture]'?fixtures:s==='[data-aw-theme]'?themes:s==='[data-scenario]'?scenarios:[],
    addEventListener(){},
  };
  let t=100000;
  class Clock extends Date{static now(){return t+=1000;}}
  const timers=[];
  const schedule=cb=>{
    if(deferTimers){timers.push(cb);return timers.length;}
    cb();return 1;
  };
  vm.runInNewContext(source,{
    document,Element,Date:Clock,setTimeout:schedule,clearTimeout(){},
    navigator:{clipboard:{writeText:async()=>{}}},
  },{timeout:3000,filename:'app-workspace-3971/app.js'});
  function click(action,id=''){
    const button={dataset:{action,id},closest(){return this;}};
    nodes['#product'].listeners.click({target:button,preventDefault(){}});
  }
  function drag(dx,{excluded=false,startX=140}={}){
    const target=new Element('canvas');
    target.closest=selector=>selector==='#app-content'?nodes['#app-content']:excluded&&selector.includes('data-swipe-owner')?target:null;
    const base={target,pointerId:5,pointerType:'mouse',clientX:startX,clientY:300};
    nodes['#product'].listeners.pointerdown(base);
    nodes['#product'].listeners.pointermove({...base,clientX:startX+dx,clientY:302});
    nodes['#product'].listeners.pointerup({...base,clientX:startX+dx,clientY:302});
  }
  function press({startX=140}={}){
    const target=new Element('canvas');
    target.closest=selector=>selector==='#app-content'?nodes['#app-content']:null;
    const base={target,pointerId:5,pointerType:'mouse',clientX:startX,clientY:300};
    nodes['#product'].listeners.pointerdown(base);
    return {
      move:dx=>nodes['#product'].listeners.pointermove({...base,clientX:startX+dx,clientY:302}),
      end:dx=>nodes['#product'].listeners.pointerup({...base,clientX:startX+dx,clientY:302}),
    };
  }
  const flush=()=>{const pending=timers.splice(0);pending.forEach(cb=>cb());};
  return {nodes,fixtures,themes,scenarios,click,drag,press,flush,state:()=>JSON.parse(nodes['#inspector'].textContent)};
}
test('Claude current work is primary with one host Header and four Capsule choices',()=>{
  const x=harness();
  assert.match(x.nodes['#app-header'].innerHTML,/Claude Code/);
  assert.match(x.nodes['#app-content'].innerHTML,/Current conversation/);
  assert.equal((x.nodes['#capsule-zone'].innerHTML.match(/class="cap-item/g)||[]).length,4);
  assert.match(x.nodes['#app-header'].innerHTML,/aria-label="Browse resources"/);
  assert.match(x.nodes['#app-header'].innerHTML,/aria-label="Navigation stack/);
});
test('Browse, deep Raw, swipe Pop/Forward and ancestor jump share one stack',()=>{
  const x=harness();x.click('browse');x.click('resource','transcripts');
  x.click('push','transcript');x.click('push','record');x.click('push','raw');
  assert.equal(x.state().index,4);
  assert.match(x.nodes['#app-header'].innerHTML,/Raw JSON/);
  x.drag(120);assert.equal(x.state().index,3);assert.equal(x.state().forward,1);
  x.drag(-120);assert.equal(x.state().index,4);
  x.click('stack');x.click('ancestor','1');assert.equal(x.state().index,1);
  assert.equal(x.state().forward,3);
});
test('Inner reveal resists past 125px and the next contact catches the settle up (#4185)',()=>{
  const x=harness({deferTimers:true});
  x.click('browse');x.click('resource','transcripts');x.click('push','transcript');
  assert.equal(x.state().index,2);

  const first=x.press();
  first.move(125);
  assert.equal(x.nodes['#page-frame'].style.transform,'translateX(125px)');
  first.move(200);
  const amount=Number((x.nodes['#page-frame'].style.transform.match(/translateX\((-?[\d.]+)px/)||[])[1]);
  assert.ok(amount>125,'reveal must keep moving past the former 125px cap');
  assert.ok(amount<180,'reveal must stay inside the absolute 180px bound');
  first.end(200);
  assert.equal(x.state().index,2,'the pending Pop must not run before the settle finishes');

  // The next contact arrives while the settle is pending and finishes it.
  const second=x.press();
  assert.equal(x.state().index,1,'the caught-up settle applies its Pop immediately');
  second.move(-120);
  assert.equal(x.nodes['#page-frame'].style.transform,'translateX(-120px)');
  second.end(-120);
  x.flush();
  assert.equal(x.state().index,2,'the caught-up contact forwards to the recorded destination');
});

test('Files editor owns interactive content and dirty leave protection',()=>{
  const x=harness();x.click('cap','files');x.click('push','file');x.click('push','edit');
  x.drag(120,{excluded:true});assert.equal(x.state().index,2);
  x.nodes['#product'].listeners.input({target:{id:'editor-input',value:'changed'}});
  x.click('back');assert.equal(x.state().overlay,'guard');
  x.click('guard-cancel');assert.equal(x.state().index,2);
  x.click('back');x.click('guard-discard');
  assert.equal(x.state().index,1);assert.equal(x.state().dirty,false);
});
test('Capabilities share grouped surfaces, root swipe returns to Terminal, Session resets',()=>{
  const x=harness();x.click('cap','git');
  assert.match(x.nodes['#app-content'].innerHTML,/Staged changes/);
  x.click('cap','sandbox');assert.match(x.nodes['#app-content'].innerHTML,/Filesystem/);
  x.click('cap','claude');x.drag(120);
  assert.equal(x.state().surface,'workspace','root central drag must not steal shell navigation');
  x.drag(120,{startX:34});
  assert.equal(x.state().surface,'terminal');assert.equal(x.nodes['#workspace'].hidden,true);
  x.click('open-workspace');assert.equal(x.state().surface,'workspace');
  x.fixtures[3].listeners.click();assert.equal(x.state().index,0);
  assert.match(x.state().session,/staging-build/);
});

test('Light/Dark changes the product token scope without changing capability navigation',()=>{
  const x=harness();
  assert.equal(x.state().capability,'claude');
  x.themes[1].listeners.click();
  assert.equal(x.nodes['#product'].dataset.theme,'dark');
  assert.equal(x.state().theme,'dark');
  assert.equal(x.themes[1]['aria-pressed'],'true');
  x.click('cap','git');
  assert.equal(x.state().capability,'git');
  assert.equal(x.state().theme,'dark');
  x.themes[0].listeners.click();
  assert.equal(x.nodes['#product'].dataset.theme,'light');
  assert.equal(x.state().capability,'git');
});

test('Review presets share the Host and preserve dirty editor leave protection',()=>{
  const x=harness();
  assert.equal(x.scenarios[0]['aria-pressed'],'true');
  x.scenarios[1].listeners.click();
  assert.equal(x.state().capability,'git');
  assert.match(x.nodes['#app-content'].innerHTML,/Staged changes/);
  x.scenarios[2].listeners.click();
  assert.equal(x.state().capability,'sandbox');
  assert.equal(x.state().index,1);
  assert.match(x.nodes['#app-header'].innerHTML,/Resource policy/);
  x.scenarios[3].listeners.click();
  assert.equal(x.state().capability,'files');
  assert.equal(x.state().index,2);
  x.nodes['#product'].listeners.input({target:{id:'editor-input',value:'changed'}});
  x.scenarios[0].listeners.click();
  assert.equal(x.state().overlay,'guard');
  assert.equal(x.state().capability,'files');
  x.click('guard-cancel');
  assert.equal(x.state().index,2);
  x.scenarios[0].listeners.click();x.click('guard-discard');
  assert.equal(x.state().capability,'claude');
  assert.equal(x.state().index,0);
  assert.equal(x.state().dirty,false);
});
