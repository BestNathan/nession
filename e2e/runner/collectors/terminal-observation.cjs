'use strict';
// Common Runner collector: only bounded counters, timing and digests escape.
// Neither the caller nor the record may persist raw terminal/WS/private data.
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const sha=(raw)=>createHash('sha256').update(raw).digest('hex');
function countMarkers(raw,marker){
  assert.match(marker,/^[a-zA-Z0-9_-]+$/,'unsafe observation marker');
  return (raw.match(new RegExp(marker+'[0-9]+','g'))||[]).length;
}
function readTmux(socket,session,marker){
  assert.match(session,/^[a-zA-Z0-9_-]+$/,'unsafe tmux session');
  const data=execFileSync('tmux',['-S',socket,'capture-pane','-p','-S','-400','-t','='+session+':'],{
    encoding:'utf8',timeout:8000,maxBuffer:1048576,
  });
  return {marker_count:countMarkers(data,marker),sha256:sha(data),bytes:Buffer.byteLength(data)};
}
async function sampleBrowser(page,marker){
  assert.match(marker,/^[a-zA-Z0-9_-]+$/,'unsafe browser marker');
  return page.evaluate((prefix)=>{
    const host=document.querySelector('.xterm')?.parentElement;
    const term=host&&host.xtermInstance;
    if(!term)return {mounted:false,marker_count:0,viewport:null};
    const buffer=term.buffer.active;
    let markers=0;
    for(let i=0;i<buffer.length;i++){
      const raw=buffer.getLine(i)?.translateToString()??'';
      if(raw.includes(prefix))markers++;
    }
    return {mounted:true,marker_count:markers,viewport:{baseY:buffer.baseY,viewportY:buffer.viewportY}};
  },marker);
}
function safeCount(value,label){
  assert.ok(Number.isSafeInteger(value)&&value>=0&&value<=1000000,label+' invalid or unbounded');
  return value;
}
function redactObservation(input){
  assert.ok(input&&typeof input==='object');
  assert.ok(['before-reload','after-reload'].includes(input.stage));
  assert.ok(Number.isFinite(Date.parse(input.at)),'observation timestamp missing');
  assert.equal(typeof input.browser?.mounted,'boolean');
  const viewport=input.browser.viewport===null?null:{
    baseY:safeCount(input.browser.viewport?.baseY,'baseY'),
    viewportY:safeCount(input.browser.viewport?.viewportY,'viewportY'),
  };
  assert.match(input.backend?.sha256,/^[a-f0-9]{64}$/,'invalid backend hash');
  return {
    at:input.at,stage:input.stage,
    browser:{mounted:input.browser.mounted,marker_count:safeCount(input.browser.marker_count,'browser count'),viewport},
    backend:{marker_count:safeCount(input.backend.marker_count,'backend count'),
      sha256:input.backend.sha256,bytes:safeCount(input.backend.bytes,'backend bytes')},
  };
}
module.exports={countMarkers,readTmux,sampleBrowser,redactObservation};
