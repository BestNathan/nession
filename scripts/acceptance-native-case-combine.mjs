#!/usr/bin/env node
// The trusted owner of one dual-native SC verdict. Neither raw OS result may
// enter Acceptance ingestion alone; exact-SHA peers are combined fail-closed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {validateCaseRecord} from './acceptance-case-ingest.mjs';

const keys=['execution_id','run_id','run_attempt','issue','criterion','stage',
 'target_sha','contract_sha256','case_revision','case_tree_sha','criterion_text',
 'runtime_profile','result_policy'];
function selected(file) {
  const cases=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.ok(Array.isArray(cases),'selected Case list missing');
  return cases.filter(x=>x.platform==='both').map(x=>{
    assert.ok(Number.isSafeInteger(x.issue)&&x.issue>0);
    assert.match(x.criterion,/^SC-\d{2,}$/);
    return x.issue+'-'+x.criterion;
  });
}
const output=(root,id)=>path.join(root,id+'.case.json');
const raw=(root,os,id)=>path.join(root,'native-proofs',os,id+'.native.json');
export function combine(left,right) {
  left=validateCaseRecord(left);
  right=validateCaseRecord(right);
  for(const key of keys)assert.deepEqual(left[key],right[key],key+' differs across native Case runs');
  const merged=[
    ...left.verifiers.map(x=>({...x,summary:'Linux: '+x.summary,
      evidence:[...(x.evidence||[]),{type:'runtime',value:'platform=Linux'}]})),
    ...right.verifiers.map(x=>({...x,summary:'macOS: '+x.summary,
      evidence:[...(x.evidence||[]),{type:'runtime',value:'platform=macOS'}]})),
  ];
  const result=merged.some(x=>x.result==='Error')?'Error':
    merged.some(x=>x.result==='Fail')?'Fail':
    merged.some(x=>x.result==='Pending')?'Pending':'Pass';
  const combined={...right,result,verifiers:merged,
    infrastructure_status:left.infrastructure_status==='ready'&&right.infrastructure_status==='ready'?'ready':'error',
    infrastructure_error:[left.infrastructure_error,right.infrastructure_error].filter(Boolean).join('; ')||null};
  validateCaseRecord(combined);
  return combined;
}
function detach(selection,root){
  for(const id of selected(selection)){
    const dest=raw(root,'linux',id);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.renameSync(output(root,id),dest);
    console.log('Unpaired Linux proof retained: '+id);
  }
}
function finish(selection,linuxRoot,macRoot){
  for(const id of selected(selection)){
    const destination=output(macRoot,id),saved=raw(macRoot,'macos',id);
    fs.mkdirSync(path.dirname(saved),{recursive:true});
    fs.renameSync(destination,saved); // never leave an unpaired macOS Pass
    const linux=JSON.parse(fs.readFileSync(raw(linuxRoot,'linux',id),'utf8'));
    const mac=JSON.parse(fs.readFileSync(saved,'utf8'));
    const paired=combine(linux,mac);
    fs.writeFileSync(destination,JSON.stringify(paired,null,2)+'\n',{flag:'wx'});
    console.log('Paired Linux/macOS Case '+id+': '+paired.result);
  }
}
function example(result){
  return {schema_version:1,kind:'acceptance_case_result',
    execution_id:'a'.repeat(64),run_id:123,run_attempt:1,issue:3232,
    criterion:'SC-05',criterion_text:'native service manager',
    stage:'staging',target_sha:'b'.repeat(40),case_revision:'b'.repeat(40),
    case_tree_sha:'c'.repeat(40),contract_sha256:'d'.repeat(64),
    runtime_profile:'full-stack-local',result_policy:'all-pass',result,
    infrastructure_status:'ready',started_at:'2026-11-11T10:00:00.000Z',
    finished_at:'2026-11-11T10:00:01.000Z',
    verifiers:[{type:'runtime',entry:'verify.cjs',result,summary:'native check',
      evidence:result==='Pass'?[{type:'runtime',value:'real pid 123'}]:[]}],
  };
}
function test(){
  assert.equal(combine(example('Pass'),example('Pass')).result,'Pass');
  assert.equal(combine(example('Pending'),example('Pass')).result,'Pending');
  assert.equal(combine(example('Pass'),example('Fail')).result,'Fail');
  const bad=example('Pass');bad.target_sha='f'.repeat(40);bad.case_revision=bad.target_sha;
  assert.throws(()=>combine(example('Pass'),bad),/target_sha/);
  const tmp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||'/tmp','nession-native-pair-'));
  try {
    const selectFile=path.join(tmp,'selection.json');
    const linux=path.join(tmp,'linux'),mac=path.join(tmp,'mac');
    fs.mkdirSync(linux);fs.mkdirSync(mac);
    fs.writeFileSync(selectFile,JSON.stringify([{issue:3232,criterion:'SC-05',platform:'both'}]));
    fs.writeFileSync(output(linux,'3232-SC-05'),JSON.stringify(example('Pass')));
    fs.writeFileSync(output(mac,'3232-SC-05'),JSON.stringify(example('Pass')));
    detach(selectFile,linux);
    assert.ok(!fs.existsSync(output(linux,'3232-SC-05')));
    finish(selectFile,linux,mac);
    assert.equal(JSON.parse(fs.readFileSync(output(mac,'3232-SC-05'),'utf8')).result,'Pass');
    fs.rmSync(output(mac,'3232-SC-05'));
    fs.writeFileSync(output(mac,'3232-SC-05'),JSON.stringify(example('Pass')));
    fs.rmSync(raw(linux,'linux','3232-SC-05'));
    assert.throws(()=>finish(selectFile,linux,mac),/ENOENT/);
    assert.ok(!fs.existsSync(output(mac,'3232-SC-05')),
      'A missing Linux proof must never leave macOS Pass eligible for ingestion');
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
  console.log('Native pair positive/negative tests passed');
}
const [action,...args]=process.argv.slice(2);
if(action==='self-test')test();
else if(action==='detach-linux'&&args.length===2)detach(...args);
else if(action==='combine-macos'&&args.length===3)finish(...args);
else throw Error('usage: native-case-combine self-test|detach-linux SELECT ROOT|combine-macos SELECT LINUX MACOS');
