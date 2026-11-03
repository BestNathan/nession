import assert from 'node:assert/strict';
import {createDirectionGesture} from './gesture-engine.mjs';
let ms=0, next=0, pending=new Map();
const schedule=(fn,delay)=>{const id=++next;pending.set(id,{at:ms+delay,fn});return id};
const clear=id=>pending.delete(id);
function tick(delta){const end=ms+delta;for(let i=0;i<1000;i++){
 const tasks=[...pending.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at);
 if(!tasks.length){ms=end;return}
 const [id,t]=tasks[0];pending.delete(id);ms=t.at;t.fn();
}throw Error('runaway');}
let states=[],events=[];
const engine=createDirectionGesture({onState:s=>states.push({...s,ts:ms}),onArrow:(dir,s)=>events.push({dir,rate:s.rate,at:ms}),now:()=>ms,setTimer:schedule,clearTimer:clear});
const check=(dir,rate)=>{assert.equal(engine.snapshot().direction,dir);assert.equal(engine.snapshot().rate,rate)};
assert(engine.start(1,200,300));
tick(379);assert.equal(engine.snapshot().phase,'pending');tick(1);assert.equal(engine.snapshot().phase,'armed');
engine.move(1,228,300);check('right',1);assert.equal(events.length,1);
tick(250);engine.move(1,260,300);check('right',2);tick(250);engine.move(1,290,300);check('right',4);tick(125);engine.move(1,318,300);check('right',8);
const before=events.length;for(let i=0;i<18;i++){tick(40);engine.move(1, i%2 ? 310:325,300)}
assert(events.length>before+3,'continuous motion must not starve the repeat clock');
const beforeReverse=events.length;engine.move(1,200,178);check('up',8);assert.equal(events.length,beforeReverse+1,'direction must emit immediately');
engine.move(1,200,300);check(null,0);const held=events.length;tick(1000);assert.equal(events.length,held,'center must stop repeats');
engine.move(1,200,330);check('down',1);const still=events.length;tick(2100);assert(events.length>=still+2,'holding still must repeat');
assert(engine.end(1));assert.equal(engine.snapshot().phase,'idle');const released=events.length;tick(1500);assert.equal(events.length,released,'release must stop');
assert.equal(engine.end(1),false);
assert(engine.start(2,200,300));engine.move(2,235,300);assert.equal(engine.snapshot().phase,'idle','pre-arm swipe must surrender');
assert(engine.start(3,200,300));tick(380);engine.move(3,240,300);engine.cancel('touchcancel');const cancelled=events.length;tick(1200);assert.equal(events.length,cancelled);
assert(engine.start(4,200,300));tick(380);engine.move(4,240,300);engine.cancel('pagehide');assert.equal(engine.snapshot().phase,'idle');
console.log('Pure gesture state-machine tests passed: '+events.length+' arrows, '+states.length+' snapshots');
