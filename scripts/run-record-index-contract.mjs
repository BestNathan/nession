// A single versioned index envelope, independent of mode-specific payloads.
// Compact immutable source records may retain their historical JSON shape.
import assert from 'node:assert/strict';
const hex40=/^[0-9a-f]{40}$/;
const hex64=/^[0-9a-f]{64}$/;
const modes=new Set(['test','acceptance','scenario','benchmark']);
const scalar=(x)=>Number.isSafeInteger(x)&&x>0;
export function validateRunIndex(raw){
  assert.ok(raw&&typeof raw==='object'&&!Array.isArray(raw));
  assert.equal(raw.schema_version,1,'unsupported Run index schema version');
  assert.ok(modes.has(raw.mode),'unsupported Run mode');
  assert.match(raw.execution_id,hex64);
  assert.match(raw.record,/^runs\/\d{4}-\d\d-\d\d\/\d+-\d+\//);
  assert.ok(raw.source&&typeof raw.source==='object');
  const source=raw.source;
  assert.equal(source.repository,'BestNathan/nession');
  assert.ok(scalar(source.run_id)&&scalar(source.run_attempt)&&scalar(source.workflow_id));
  const target=source.head_sha??source.target_sha;
  assert.match(target,hex40);
  if(raw.target_sha!==undefined)assert.equal(raw.target_sha,target,'index source SHA disagrees');
  const segment='/' + source.run_id + '-' + source.run_attempt + '/';
  assert.ok(raw.record.includes(segment),'index record path not bound to source attempt');
  if(raw.mode==='acceptance'){
    assert.ok(scalar(raw.issue));
    assert.match(raw.criterion,/^SC-\d{2,}$/);
    assert.ok(['staging','post-merge'].includes(raw.stage));
    assert.equal(source.head_branch,raw.stage==='staging'?'staging':'main');
    assert.match(raw.case_tree_sha,hex40);
    assert.match(raw.contract_sha256,hex64);
    assert.ok(raw.record.endsWith('/'+raw.issue+'/'+raw.criterion+'.json'));
  }else if(raw.mode==='scenario'){
    assert.match(source.scenario_tree_sha,hex40);
    assert.ok(raw.record.includes('/scenario/'));
  }else{
    // Test and Benchmark are schema-reserved modes. They may be indexed only
    // from authenticated run ownership; fixtures cannot attest real ingestion.
    assert.ok(typeof raw.suite==='string'&&/^[a-z0-9_-]{1,72}$/.test(raw.suite));
    assert.match(raw.source_tree_sha,hex40);
    assert.ok(raw.record.includes('/'+raw.mode+'/'));
  }
  return raw;
}
export function makeRunIndex(item){
  return validateRunIndex({...item});
}
export function selfTest(){
  const src={repository:'BestNathan/nession',run_id:100,run_attempt:2,
    workflow_id:5,target_sha:'a'.repeat(40),scenario_tree_sha:'b'.repeat(40)};
  const base={schema_version:1,mode:'scenario',source:src,
    record:'runs/2026-10-09/100-2/scenario/demo-1.json',execution_id:'c'.repeat(64)};
  assert.equal(makeRunIndex(base).mode,'scenario');
  assert.throws(()=>makeRunIndex({...base,record:'runs/2026-10-09/101-2/scenario/demo-1.json'}),/not bound/);
  assert.throws(()=>makeRunIndex({...base,target_sha:'d'.repeat(40)}),/disagrees/);
  assert.throws(()=>makeRunIndex({...base,mode:'arbitrary'}),/unsupported/);
  const caseSource={repository:'BestNathan/nession',run_id:100,run_attempt:2,
    workflow_id:5,head_sha:'a'.repeat(40),head_branch:'staging'};
  const accept={schema_version:1,mode:'acceptance',source:caseSource,
    record:'runs/2026-10-09/100-2/1499/SC-02.json',
    execution_id:'c'.repeat(64),target_sha:'a'.repeat(40),
    issue:1499,criterion:'SC-02',stage:'staging',
    case_tree_sha:'b'.repeat(40),contract_sha256:'d'.repeat(64)};
  assert.equal(makeRunIndex(accept).mode,'acceptance');
  assert.throws(()=>makeRunIndex({...accept,stage:'post-merge'}),/Expected values/);
  for(const mode of ['test','benchmark']){
    const candidate={...base,mode,suite:'sample_'+mode,
      source_tree_sha:'b'.repeat(40),record:'runs/2026-10-09/100-2/'+mode+'/sample.json'};
    assert.equal(makeRunIndex(candidate).mode,mode);
    assert.throws(()=>makeRunIndex({...candidate,suite:'../../secret'}),/assertion|match|regular expression|expected/i);
  }
  console.log('shared Run index v1: acceptance/scenario/test/benchmark positive and negative fixtures passed');
}
if(process.argv[1]?.endsWith('run-record-index-contract.mjs')&&process.argv[2]==='self-test')selfTest();
