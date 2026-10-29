// A single versioned index envelope, independent of mode-specific payloads.
// Compact immutable source records may retain their historical JSON shape.
import assert from 'node:assert/strict';
const hex40=/^[0-9a-f]{40}$/;
const hex64=/^[0-9a-f]{64}$/;
const modes=new Set(['test','acceptance','scenario','benchmark','deployment']);
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
  const segment='/' + source.run_id + '-' + source.run_attempt + '/';
  assert.ok(raw.record.includes(segment),'index record path not bound to source attempt');
  if(raw.mode==='deployment'){
    // A deployment attestation is produced by a trusted main workflow, but
    // targets the deployed source SHA. Both SHAs are pinned independently.
    assert.match(source.head_sha,hex40);
    assert.equal(source.head_branch,'main','deployment identity index must come from trusted main');
    assert.match(raw.target_sha,hex40);
    assert.match(String(raw.gitops_revision??''),hex40,'deployment index GitOps revision is invalid');
    assert.match(raw.environment_id,/^[a-z][a-z0-9-]{0,62}$/,'deployment index environment is invalid');
    assert.ok(raw.record.endsWith('/deployment/'+raw.environment_id+'.json'),
      'deployment record path must end with /deployment/<environment>.json');
    return raw;
  }
  const target=source.head_sha??source.target_sha;
  assert.match(target,hex40);
  // Deployed acceptance proof is bound by the deployment attestation instead
  // of the dispatched run's head: a workflow_dispatch reports the ref tip,
  // which is not the deployed source SHA (#2614).
  const deployedAcceptance = raw.mode === 'acceptance' && raw.deployment !== undefined;
  if (!deployedAcceptance && raw.target_sha !== undefined) {
    assert.equal(raw.target_sha,target,'index source SHA disagrees');
  }
  if(raw.mode==='acceptance'){
    assert.ok(scalar(raw.issue));
    assert.match(raw.criterion,/^SC-\d{2,}$/);
    assert.ok(['staging','post-merge'].includes(raw.stage));
    assert.equal(source.head_branch,raw.stage==='staging'?'staging':'main');
    if (deployedAcceptance) {
      const deployment = raw.deployment;
      assert.ok(deployment && typeof deployment === 'object', 'deployed acceptance index requires a deployment binding');
      assert.match(deployment.source_sha,hex40,'deployed acceptance index source SHA is invalid');
      assert.equal(deployment.source_sha,raw.target_sha,'deployed acceptance index source SHA disagrees');
      assert.match(deployment.gitops_revision,hex40,'deployed acceptance index GitOps revision is invalid');
      assert.match(deployment.environment_id,/^[a-z][a-z0-9-]{0,62}$/,'deployed acceptance index environment is invalid');
      assert.match(deployment.attestation_execution_id,hex64,'deployed acceptance index attestation is invalid');
    }
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
  const deploySource={repository:'BestNathan/nession',run_id:100,run_attempt:2,
    workflow_id:5,head_sha:'a'.repeat(40),head_branch:'main'};
  const deploy={schema_version:1,mode:'deployment',source:deploySource,
    target_sha:'b'.repeat(40),environment_id:'staging-01',gitops_revision:'c'.repeat(40),
    record:'runs/2026-10-09/100-2/deployment/staging-01.json',execution_id:'d'.repeat(64)};
  assert.equal(makeRunIndex(deploy).mode,'deployment');
  assert.notEqual(deploy.target_sha,deploySource.head_sha);
  assert.throws(()=>makeRunIndex({...deploy,source:{...deploySource,head_branch:'staging'}}),
    /trusted main/);
  assert.throws(()=>makeRunIndex({...deploy,environment_id:'Staging_01'}),/environment is invalid/);
  assert.throws(()=>makeRunIndex({...deploy,gitops_revision:'short'}),/GitOps revision/);
  assert.throws(()=>makeRunIndex({...deploy,record:'runs/2026-10-09/100-2/deployment/staging.json'}),
    /deployment record path/);

  // A deployed acceptance record is dispatched from main, so the run head is
  // the ref tip; the deployment attestation binds the target SHA instead
  // (#2614). The binding fields are mandatory and must agree with the record.
  const deployedAcceptance={...accept,stage:'post-merge',
    source:{...caseSource,head_sha:'e'.repeat(40),head_branch:'main'},
    target_sha:'b'.repeat(40),
    deployment:{environment_id:'staging',source_sha:'b'.repeat(40),
      gitops_revision:'f'.repeat(40),attestation_execution_id:'1'.repeat(64)}};
  const deployedIndex=makeRunIndex(deployedAcceptance);
  assert.equal(deployedIndex.target_sha,'b'.repeat(40));
  assert.notEqual(deployedIndex.source.head_sha,deployedIndex.target_sha);
  assert.throws(()=>makeRunIndex({...deployedAcceptance,deployment:{
    ...deployedAcceptance.deployment,source_sha:'a'.repeat(40)}}),/source SHA disagrees/);
  assert.throws(()=>makeRunIndex({...deployedAcceptance,deployment:{
    ...deployedAcceptance.deployment,gitops_revision:'short'}}),/GitOps revision/);
  assert.throws(()=>makeRunIndex({...deployedAcceptance,deployment:{
    ...deployedAcceptance.deployment,environment_id:'Staging_01'}}),/environment is invalid/);
  assert.throws(()=>makeRunIndex({...deployedAcceptance,deployment:{
    ...deployedAcceptance.deployment,attestation_execution_id:'short'}}),/attestation is invalid/);
  // Without the binding, the branch-head equality still applies.
  const {deployment: _binding, ...unbound}=deployedAcceptance;
  void _binding;
  assert.throws(()=>makeRunIndex(unbound),/source SHA disagrees/);
  console.log('shared Run index v1: acceptance/scenario/test/benchmark/deployment fixtures passed');
}
if(process.argv[1]?.endsWith('run-record-index-contract.mjs')&&process.argv[2]==='self-test')selfTest();
