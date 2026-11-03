/**
 * Prototype-only browser adapter for the pure direction gesture engine.
 * One touch ID is the owner. Event arbitration, input clock and drawing are
 * separate: no DOM event handler schedules keys or changes direction itself.
 */
import {createDirectionGesture} from './gesture-engine.mjs';
const el=id=>document.getElementById(id);
const term=el('term'),guide=el('guide'),originDot=el('originDot');
const symbol={up:'↑',down:'↓',left:'←',right:'→'};
const code=Array.from({length:80},(_,i)=>{
 const samples=['function greet(name) {','  const message = "hello";','  console.log(message);','  return message;','}','', 'export default greet;','// navigation stays continuous across the buffer'];
 return i===0?'// agent.ts · mobile gesture lab':i===79?'// end of mock buffer':samples[(i-1)%samples.length];
});
let row=26,col=6,log=[],observer=false,offline=false;
let lock=null,lastTouchAt=0,suppressClickUntil=0,exclusiveMoves=0,leakedMoves=0;
let path='—',lastEvent='—',visualAnchor=null,mouseDown=false;
const stableRows=[];
let caretNode=null;
function view(){
 const lines=el('lines');
 if(!stableRows.length){
  // A native TouchEvent targets the same element that received touchstart.
  // NEVER detach/reparent/replace that element while its finger is held.
  for(let j=0;j<11;j++){
   const entry=document.createElement('div');entry.className='line';
   const number=document.createElement('span');number.className='num';
   const content=document.createElement('span');content.className='line-content';
   entry.append(number,content);lines.append(entry);
   stableRows.push({entry,number,content});
  }
  caretNode=document.createElement('span');
  caretNode.className='cursor direction-caret';
  caretNode.style.pointerEvents='none';lines.append(caretNode);
 }
 const first=Math.max(0,Math.min(code.length-11,row-1-5));
 stableRows.forEach(({entry,number,content},j)=>{
  const i=first+j;
  entry.classList.toggle('on',i===row-1);
  number.textContent=String(i+1);
  content.textContent=code[i]; // stable elements, only text updates
 });
 const current=stableRows[row-1-first];
 if(current){
  const fontSize=parseFloat(getComputedStyle(current.content).fontSize)||12;
  const charWidth=fontSize*.60;
  caretNode.style.left=(current.content.offsetLeft+(col-1)*charWidth)+'px';
  caretNode.style.top=(current.entry.offsetTop+4)+'px';
 }
 el('pos').textContent='NORMAL · '+row+':'+col+' / '+code.length+' lines (mock TUI)';
}
function onArrow(dir,state){
 log.push(symbol[dir]);if(log.length>64)log.shift();
 if(dir==='up')row=Math.max(1,row-1);
 if(dir==='down')row=Math.min(code.length,row+1);
 if(dir==='left')col=Math.max(1,col-1);
 if(dir==='right')col=Math.min(code[row-1].length+1,col+1);
 col=Math.min(col,code[row-1].length+1);
 view();
}
function onState(s){
 const owned=s.phase==='armed'||s.phase==='moving';
 if(owned&&!lock){
  lock={top:term.scrollTop,left:term.scrollLeft};
  const r=term.getBoundingClientRect();
  const x0=s.originX-r.left,y0=s.originY-r.top;
  const wheelX=Math.max(95,Math.min(r.width-95,x0)),wheelY=Math.max(95,Math.min(r.height-127,y0));
  visualAnchor={x:wheelX,y:wheelY,offset:Math.hypot(wheelX-x0,wheelY-y0)>11};
  guide.style.left=wheelX+term.scrollLeft+'px';guide.style.top=wheelY+term.scrollTop+'px';
  originDot.style.left=x0+term.scrollLeft+'px';originDot.style.top=y0+term.scrollTop+'px';
  if(navigator.vibrate)navigator.vibrate(10);
 }
 if(!owned&&lock){
  term.scrollTop=lock.top;term.scrollLeft=lock.left;lock=null;visualAnchor=null;
 }
 term.classList.toggle('direction-owned',owned);
 document.body.classList.toggle('direction-owned',owned);
 guide.classList.toggle('show',owned);
 guide.classList.toggle('moving',s.phase==='moving');
 guide.querySelectorAll('.arrow').forEach(x=>x.classList.toggle('active',x.dataset.dir===s.direction));
 guide.querySelectorAll('.speed-pip').forEach((x,i)=>x.classList.toggle('on',s.gear>=i&&s.gear>=0));
 originDot.classList.toggle('show',owned&&!!visualAnchor?.offset);
 el('centerMain').textContent=s.direction?s.rate+'/s':'·';
 el('centerSub').textContent=s.direction?'KEYS · '+s.count:owned?'STOP':'READY';
 el('gestureHint').textContent=s.direction?symbol[s.direction]+' · '+s.rate+' 次/秒':'回中心停止 · 松手结束';
 el('phase').textContent=s.phase.toUpperCase();
 el('dir').textContent=s.direction?symbol[s.direction]:'—';
 el('rate').textContent=s.direction?s.rate+'/s':'—';
 el('repeatClock').textContent=s.direction?'Running · independent of finger move':'Stopped';
 el('count').textContent=String(s.count);el('log').textContent=log.join(' ')||'No keys';
 el('inputPath').textContent=path;el('lastTouchEvent').textContent=lastEvent;
 el('touchOwner').textContent=owned?'Direction pad':'Free';
 el('exclusiveMoves').textContent=String(exclusiveMoves);el('leakedMoves').textContent=String(leakedMoves);
 el('tip').textContent=observer?'Observer mode: input disabled':offline?'Offline: input disabled':'按住终端 → 方向盘 → 拖动';
}
const engine=createDirectionGesture({onState,onArrow});
const state=()=>engine.snapshot();
const owned=()=>state().phase==='armed'||state().phase==='moving';
function stop(reason){lastEvent=reason;engine.cancel(reason);onState(state());mouseDown=false;}
function claim(e){if(e.cancelable)e.preventDefault();e.stopImmediatePropagation()}
const touchById=(list,id)=>Array.from(list).find(t=>t.identifier===id);
// Permanently installed before the first touch, passive until arming.
// Window capture follows the originating finger past terminal viewport bounds.
window.addEventListener('touchstart',e=>{
 lastTouchAt=Date.now();
 if(state().phase!=='idle'){
  if(e.touches.length!==1)stop('multi-touch cancel');
  return;
 }
 if(observer||offline||e.touches.length!==1||!term.contains(e.target))return;
 const t=e.changedTouches[0];if(!t)return;
 const r=term.getBoundingClientRect();
 if(t.clientX<r.left+28||t.clientX>r.right-28)return;
 path='touch';lastEvent='touchstart';engine.start(t.identifier,t.clientX,t.clientY);
},{capture:true,passive:true});
window.addEventListener('touchmove',e=>{
 const s=state();if(s.phase==='idle')return;
 lastTouchAt=Date.now();
 if(e.touches.length!==1){stop('multi-touch cancel');return}
 const t=touchById(e.touches,s.fingerId);
 if(!t){stop('finger lost');return}
 if(s.phase==='pending'){
  engine.move(s.fingerId,t.clientX,t.clientY);
  return; // native swipes and terminal scrolling continue freely
 }
 if(!e.cancelable){stop('native scroll took over');return}
 claim(e);exclusiveMoves++;
 lastEvent='touchmove · owned';
 engine.move(s.fingerId,t.clientX,t.clientY);
},{capture:true,passive:false});
window.addEventListener('touchend',e=>{
 const s=state();if(s.phase==='idle'||!touchById(e.changedTouches,s.fingerId))return;
 lastTouchAt=Date.now();
 if(owned()){claim(e);suppressClickUntil=Date.now()+700;}
 lastEvent='touchend';engine.end(s.fingerId,'released');onState(state());
},{capture:true,passive:false});
window.addEventListener('touchcancel',e=>{
 const s=state();if(s.phase==='idle'||!touchById(e.changedTouches,s.fingerId))return;
 lastTouchAt=Date.now();if(owned())e.stopImmediatePropagation();stop('touchcancel');
},{capture:true,passive:false});
window.addEventListener('click',e=>{
 if(Date.now()<suppressClickUntil&&e.detail>0&&term.contains(e.target)){
  claim(e);suppressClickUntil=0;
 }
},true);
window.addEventListener('contextmenu',e=>{if(owned()&&term.contains(e.target))claim(e)},true);
term.addEventListener('touchmove',()=>{if(owned()){leakedMoves++;onState(state())}},{passive:true});
term.addEventListener('scroll',()=>{if(lock){
 if(term.scrollTop!==lock.top)term.scrollTop=lock.top;
 if(term.scrollLeft!==lock.left)term.scrollLeft=lock.left;
}},{passive:true});
// Desktop mouse is solely for prototype inspection, not mobile gesture input.
term.addEventListener('mousedown',e=>{
 if(e.button!==0||Date.now()-lastTouchAt<1200||!matchMedia('(hover: hover) and (pointer: fine)').matches)return;
 if(owned()||state().phase!=='idle')return;
 mouseDown=true;path='desktop mouse';lastEvent='mousedown';engine.start('mouse',e.clientX,e.clientY);
});
window.addEventListener('mousemove',e=>{
 if(!mouseDown)return;
 if(e.buttons!==1){engine.end('mouse');mouseDown=false;return}
 engine.move('mouse',e.clientX,e.clientY);
});
window.addEventListener('mouseup',()=>{if(mouseDown){mouseDown=false;lastEvent='mouseup';engine.end('mouse');onState(state())}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('page hidden')});
window.addEventListener('pagehide',()=>stop('pagehide'));
window.addEventListener('blur',()=>stop('window blur'));
el('reset').onclick=()=>{stop('reset');row=26;col=6;log=[];exclusiveMoves=0;leakedMoves=0;view();onState(state())};
el('observer').onclick=function(){observer=!observer;this.setAttribute('aria-pressed',String(observer));stop('observer change')};
el('offline').onclick=function(){offline=!offline;this.setAttribute('aria-pressed',String(offline));el('conn').textContent=offline?'○ Offline':'● Connected';stop('connection change')};
window.__nessionMock={state:()=>({...state(),row,col,inputPath:path,lastTouchEvent:lastEvent,owner:owned()?'direction':'free',exclusiveMoves,leakedMoves,scrollTop:term.scrollTop}),cancel:stop};
view();onState(state());
