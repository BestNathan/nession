import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';

const here=dirname(fileURLToPath(import.meta.url));
const css=readFileSync(join(here,'frame.css'),'utf8');
const js=readFileSync(join(here,'frame.js'),'utf8');

test('Web 1180: retain a scroll-reachable left edge and true content width',()=>{
  assert.match(css,/\.np-stage\{[^}]*justify-content:safe center;/);
  assert.doesNotMatch(css,/\.np-stage\{[^}]*justify-content:center;/);
  assert.match(css,/\.np-device\{[^}]*border:0;outline:1px/);
  assert.match(css,/\.np-device\{[^}]*contain:paint/,'position:fixed overlays must not use reviewer window geometry');
  assert.match(css,/\.np-page\{max-width:1460px/);
});

test('size selection notifies page-scoped consumers and updates actual CSS width',()=>{
  const pageEvents=[], buttons=[], callbacks=[];
  const label={textContent:''};
  const device={
    style:{setProperty(key,value){this[key]=value}},
    dispatchEvent(event) {
      if(event.bubbles) pageEvents.push({type:event.type,width:event.detail.width});
    }
  };
  for(const width of [1180,390,375]){
    const button={
      width, pressed:false,
      getAttribute(name){return name==='data-np-size'?String(width):name==='aria-pressed'?(this.pressed?'true':'false'):null},
      setAttribute(name,val){if(name==='aria-pressed')this.pressed=val==='true'},
      addEventListener(type,fn){assert.equal(type,'click');callbacks.push({width,fn})}
    };
    button.pressed=width===1180;buttons.push(button);
  }
  const page={
    querySelector(sel){return sel==='[data-np-device]'?device:sel==='[data-np-current-size]'?label:null},
    querySelectorAll(sel){return sel==='[data-np-size]'?buttons:[]}
  };
  const document={readyState:'complete',querySelectorAll(sel){return sel==='[data-np-root]'?[page]:[]}};
  class CustomEvent{constructor(type,options){this.type=type;this.detail=options.detail;this.bubbles=options.bubbles}}
  runInNewContext(js,{document,CustomEvent,window:{location:{reload(){}}}});
  assert.deepEqual(pageEvents,[{type:'np:resize',width:1180}]);
  callbacks.find(x=>x.width===390).fn();
  assert.equal(device.style['--np-device-width'],'390px');
  assert.equal(label.textContent,'390 CSS px · 1:1');
  assert.deepEqual(pageEvents.at(-1),{type:'np:resize',width:390});
  assert.equal(buttons.find(x=>x.width===390).pressed,true);
  assert.equal(buttons.find(x=>x.width===1180).pressed,false);
  callbacks.find(x=>x.width===1180).fn();
  assert.equal(device.style['--np-device-width'],'1180px');
  assert.deepEqual(pageEvents.at(-1),{type:'np:resize',width:1180});
});
