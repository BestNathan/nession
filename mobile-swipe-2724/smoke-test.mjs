#!/usr/bin/env node
// Run: node mobile-swipe-2724/smoke-test.mjs
// Actual index.html inline JS + minimal fake DOM. Not a browser/device receipt.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, 'inline script exists');
let clock=0, nextId=0;const timers=new Map();
const delay=(fn,ms)=>{const id=++nextId;timers.set(id,{at:clock+ms,fn});return id};
function advance(ms){clock+=ms;for(let k=0;k<30;k++){const due=[...timers].filter(([,v])=>v.at<=clock);if(!due.length)break;for(const [id,v] of due){timers.delete(id);v.fn()}}}
function makeElement(id){const classes=new Set();return {id,style:{},classList:{toggle:(key,force)=>{const on=force===undefined?!classes.has(key):force;if(on)classes.add(key);else classes.delete(key)},add:key=>classes.add(key),remove:key=>classes.delete(key),contains:key=>classes.has(key)},getBoundingClientRect:()=>({left:0,right:390,width:390}),get scrollHeight(){return 1700},clientWidth:390,scrollTop:0,textContent:'',innerHTML:'',disabled:false,setAttribute(){},setPointerCapture(){},closest:()=>null}}
const dom=new Map(),get=id=>{if(!dom.has(id))dom.set(id,makeElement(id));return dom.get(id)};
const listeners=new Map();get('phone').addEventListener=(name,fn)=>listeners.set(name,[...(listeners.get(name)||[]),fn]);
runInNewContext(source,{document:{getElementById:get},window:{matchMedia:()=>({matches:false})},performance:{now:()=>clock},setTimeout:delay,clearTimeout:id=>timers.delete(id)});
const run=(name,e)=>{for(const fn of listeners.get(name)||[])fn(e)};
const work={closest:q=>q.includes('.terminal-body')?{}:null};
const fire=(name,x,y,target=work)=>run(name,{pointerId:1,isPrimary:true,target,clientX:x,clientY:y,cancelable:true,preventDefault(){},stopPropagation(){}});
const tap=id=>{assert.equal(typeof get(id).onclick,'function');get(id).onclick()};
const route=()=>get('sPage').textContent.toLowerCase();
const swipe=(x0,x1,y0=300,y1=300)=>{fire('pointerdown',x0,y0);advance(30);fire('pointermove',x1,y1);advance(90);fire('pointerup',x1,y1);advance(250)};
let checks=0;const check=(label,ok)=>{assert.ok(ok,label);checks++};
check('initial Terminal',route().startsWith('terminal'));
swipe(10,120);check('left edge -> Sessions',route().startsWith('sessions'));
swipe(380,265);check('Sessions -> Terminal',route().startsWith('terminal'));
swipe(380,265);check('right edge -> Workspace',route().startsWith('workspace'));
swipe(10,120);check('Workspace -> Terminal',route().startsWith('terminal'));
swipe(180,300);check('center content drag not page',route().startsWith('terminal'));
swipe(10,18,300,392);check('vertical edge drag not page',route().startsWith('terminal'));
swipe(10,41);check('short drag cancels',route().startsWith('terminal'));
tap('modePeek');check('Peek expands',get('peek').classList.contains('on'));tap('modePeek');
tap('simDetail');check('detail entered',route().startsWith('detail'));
swipe(10,130);check('detail denies shell swipe',route().startsWith('detail'));
tap('makeDirty');tap('detailBack');check('dirty confirmation',get('dialog').classList.contains('on'));
tap('keepEditing');check('keep edit stays',route().startsWith('detail'));
tap('detailBack');tap('discard');check('discard returns Workspace',route().startsWith('workspace'));
tap('modeNoSession');check('no Session root',route().includes('no session'));
swipe(380,270);check('no Session swipe denied',route().includes('no session'));
tap('sessionSelect');check('select enters Terminal',route().startsWith('terminal'));
fire('pointerdown',180,300);advance(400);check('hold claims direction',get('sPhase').textContent==='direction');
fire('pointerup',190,340);check('pointer direction releases',get('sPhase').textContent==='idle');
// Native mobile path: Touch Events are independent of touch-generated
// Pointer Events. The whole contact is tracked by identifier, not target.
const touch=(x,y,id=42)=>({identifier:id,clientX:x,clientY:y});
const native=(name,changed,ongoing,target=work)=>{
  const e={target,changedTouches:changed,touches:ongoing,cancelable:true,
    preventDefault(){this.prevented=true},stopPropagation(){this.stopped=true}};
  run(name,e);return e;
};
const tStart=(x,y,id=42)=>native('touchstart',[touch(x,y,id)],[touch(x,y,id)]);
const tMove=(x,y,id=42)=>native('touchmove',[touch(x,y,id)],[touch(x,y,id)]);
const tEnd=(x,y,id=42,cancel=false)=>native(cancel?'touchcancel':'touchend',[touch(x,y,id)],[]);
const settled=()=>advance(260);
tStart(10,330);tMove(35,330);
check('native touch locks horizontal owner',get('sOwner').textContent==='App shell');
const claimed=tMove(98,330);
check('owned native touch blocks browser scroll',claimed.prevented&&claimed.stopped);
tMove(5,330);
check('reverse across origin does not prematurely settle',get('sPhase').textContent==='navigation');
check('reverse clamps preview to zero',get('sDistance').textContent==='0 px');
const recovered=tMove(130,330);
check('continue drag after reversal is still owned',recovered.prevented&&get('sPhase').textContent==='navigation');
run('pointercancel',{pointerId:42,pointerType:'touch'});
check('touch-generated pointercancel does not abort Touch Events',get('sPhase').textContent==='navigation');
run('lostpointercapture',{pointerId:42,pointerType:'touch'});
check('touch-generated capture loss does not abort',get('sPhase').textContent==='navigation');
tEnd(130,330);settled();
check('native touchend commits Sessions',route().startsWith('sessions'));
tStart(380,300);tMove(300,300);tEnd(300,300);settled();
check('native reverse route returns Terminal',route().startsWith('terminal'));
tStart(380,290);tMove(250,290);tEnd(250,290,true);settled();
check('native touchcancel snaps back',route().startsWith('terminal'));
check('native cancellation trace includes reason',get('trace').textContent.includes('native touchcancel'));
tStart(10,310);tMove(100,310);
check('navigation started before multi-touch',get('sPhase').textContent==='navigation');
native('touchstart',[touch(140,340,43)],[touch(100,310),touch(140,340,43)]);settled();
check('multi-touch cancels owned nav',route().startsWith('terminal'));
tStart(200,320);const vertical=tMove(205,410);
check('vertical touch remains native',!vertical.prevented&&!vertical.stopped);
tEnd(205,410);
tStart(185,320);advance(400);
check('native long press claims direction',get('sPhase').textContent==='direction');
const claimedDirection=tMove(225,350);
check('native direction blocks scroll',claimedDirection.prevented&&claimedDirection.stopped);
tEnd(225,350);
check('native direction releases',get('sPhase').textContent==='idle');
console.log('PASS '+checks+'/'+checks+' mock checks; browser/iOS/xterm unverified');
