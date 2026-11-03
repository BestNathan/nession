/**
 * Pure, platform-independent direction-pad interaction engine.
 * Input adapters own DOM events; this engine owns gesture state and the key clock.
 * It never reads xterm state, never writes ANSI bytes, and never mutates the DOM.
 */
export const DIRECTION_CONFIG = Object.freeze({
  holdMs: 380, pendingTravelPx: 12, enterPx: 24, exitPx: 17,
  speedEdges: [48, 76, 108], speedHysteresisPx: 5,
  axisSwitchRatio: 1.28, rates: [1, 2, 4, 8]
});

export function createDirectionGesture({onState, onArrow, now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  config = DIRECTION_CONFIG} = {}) {
  if(typeof onState !== 'function' || typeof onArrow !== 'function') throw new Error('Gesture state and arrow callbacks are required');
  let state = initial();
  let holdTimer = null, repeatTimer = null, lastKeyAt = 0, generation = 0;
  function initial() {
    return {phase: 'idle', fingerId: null, originX: 0, originY: 0, x: 0, y: 0,
      direction: null, gear: -1, rate: 0, count: 0, reason: 'ready'};
  }
  function snapshot() { return {...state}; }
  function publish() { onState(snapshot()); }
  function clearHold() { if(holdTimer !== null) clearTimer(holdTimer); holdTimer = null; }
  function clearRepeat() { if(repeatTimer !== null) clearTimer(repeatTimer); repeatTimer = null; }
  function cancel(reason = 'cancel') {
    const hadGesture = state.phase !== 'idle';
    generation++; clearHold(); clearRepeat();
    state = {...initial(), count: state.count, reason};
    if(hadGesture) publish();
    return hadGesture;
  }
  function start(fingerId, x, y) {
    if(state.phase !== 'idle' || fingerId === null || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const token = ++generation;
    state = {...initial(), fingerId, originX:x, originY:y, x, y, count:state.count, phase:'pending', reason:'hold pending'};
    publish();
    holdTimer = setTimer(() => {
      if(token !== generation || state.phase !== 'pending') return;
      holdTimer = null;
      state = {...state, phase:'armed', reason:'armed: touch captured'};
      publish();
    }, config.holdMs);
    return true;
  }
  function direction(dx, dy, previous) {
    const ax=Math.abs(dx), ay=Math.abs(dy);
    if(previous) {
      const vertical=previous==='up'||previous==='down';
      if(vertical && ay*config.axisSwitchRatio >= ax && dy!==0) return dy<0?'up':'down';
      if(!vertical && ax*config.axisSwitchRatio >= ay && dx!==0) return dx<0?'left':'right';
    }
    return ax>=ay?(dx<0?'left':'right'):(dy<0?'up':'down');
  }
  function gearFor(distance, previousGear) {
    let gear=Math.max(0,previousGear);
    // Schmitt trigger on EACH boundary, including multi-band jumps.
    while(gear < config.speedEdges.length && distance >= config.speedEdges[gear]+config.speedHysteresisPx) gear++;
    while(gear > 0 && distance < config.speedEdges[gear-1]-config.speedHysteresisPx) gear--;
    return gear;
  }
  function emitCurrent() {
    if(state.phase!=='moving'||!state.direction)return;
    lastKeyAt=now();
    state={...state,count:state.count+1};
    onArrow(state.direction, snapshot());
    publish();
  }
  function schedule() {
    clearRepeat();
    if(state.phase!=='moving'||!state.direction)return;
    const token=generation;
    const delay=Math.max(0,lastKeyAt+1000/state.rate-now());
    repeatTimer=setTimer(() => {
      repeatTimer=null;
      if(token!==generation||state.phase!=='moving'||!state.direction)return;
      const remaining=lastKeyAt+1000/state.rate-now();
      if(remaining>2) { schedule(); return; }
      emitCurrent(); schedule(); // one key per tick, no catch-up bursts
    },delay);
  }
  function move(fingerId,x,y) {
    if(state.phase==='idle'||state.fingerId!==fingerId) return {owned:false,active:false};
    if(!Number.isFinite(x)||!Number.isFinite(y)) return {owned:false,active:false};
    const dx=x-state.originX,dy=y-state.originY,dist=Math.hypot(dx,dy);
    if(state.phase==='pending') {
      if(dist>config.pendingTravelPx) {cancel('pre-arm movement: native gesture');return {owned:false,active:false};}
      state={...state,x,y};publish();return {owned:false,active:true};
    }
    const prior=state.direction;
    const threshold=prior?config.exitPx:config.enterPx;
    const nextDir=dist<threshold?null:direction(dx,dy,prior);
    const nextGear=nextDir?gearFor(dist,nextDir===prior?state.gear:0):-1;
    const nextRate=nextDir?config.rates[nextGear]:0;
    const change=nextDir!==prior, rateChange=nextRate!==state.rate;
    state={...state,x,y,phase:nextDir?'moving':'armed',direction:nextDir,gear:nextGear,rate:nextRate,
      reason:nextDir?nextDir+' @ '+nextRate+'/s':'center: paused'};
    if(change){
      clearRepeat();
      if(nextDir){emitCurrent();schedule();}
    } else if(rateChange && nextDir){schedule();}
    else if(!nextDir)clearRepeat();
    publish();
    return {owned:true,active:true, direction:nextDir,rate:nextRate};
  }
  function end(fingerId,reason='release') {
    if(state.phase==='idle'||state.fingerId!==fingerId)return false;
    cancel(reason);return true;
  }
  return {start,move,end,cancel,snapshot,config};
}
