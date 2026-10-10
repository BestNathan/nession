'use strict';
const assert=require('node:assert/strict');
const {redactObservation}=require('../../../../runner/collectors/terminal-observation.cjs');
const {invokeScenario,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');
try{
  const run=invokeScenario(1);
  const x=run.records[0].data;
  const safe=redactObservation({at:new Date().toISOString(),stage:'after-reload',
    browser:{mounted:true,marker_count:7,viewport:null,token:'SECRET'},
    backend:{marker_count:7,bytes:11,sha256:'f'.repeat(64),private:'SECRET'},
    authorization:'SECRET',raw_terminal:'SECRET'});
  assert.equal(JSON.stringify(safe).includes('SECRET'),false);
  assert.throws(()=>redactObservation({...safe,backend:{...safe.backend,bytes:-1}}),/invalid or unbounded/);
  assert.throws(()=>redactObservation({...safe,backend:{...safe.backend,sha256:'INVALID'}}),/invalid backend hash/);
  for(const o of x.observations){
    assert.deepEqual(Object.keys(o).sort(),['at','backend','browser','stage']);
    assert.deepEqual(Object.keys(o.backend).sort(),['bytes','marker_count','sha256']);
    assert.deepEqual(Object.keys(o.browser).sort(),['marker_count','mounted','viewport']);
  }
  assert.ok(x.observation_count<=24);
  assert.match(x.evidence_scope,/no raw terminal or secret data/);
  result('Actual terminal observation records are bounded and projected through nested redaction; negative privacy fixtures reject unsafe data',[
    {type:'privacy',value:'observations='+x.observation_count+' counters/timestamps/backend digests only; no raw terminal'},
    {type:'negative',value:'nested secret-field projection; negative bytes and forged hash rejected'},
    {type:'input',value:'target='+run.target+' config_sha256='+x.config_sha256},
  ]);
}catch(e){fail(e);}
