'use strict';
// #1664 SC-04: durable exact-source dispatch history plus crash/replay
// negatives. Remain Pending until actual Publisher/PR-review reconciliation
// exists; a simulated Reviewer is not an authenticated GitHub review event.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../../../../..');
const OWNER='BestNathan', REPO='BestNathan/nession', ISSUE=1997;
const SHA=/^[a-f0-9]{40}$/, HASH=/^[a-f0-9]{64}$/;
const ACTION='dac10d570c30557fe629b8605ecb44d33335eb967e24a52931467ac7b93b5e31';
const FOLLOWUP='fea8efa4a19ca813a7e2195b2de90b0c8472665a866361ad4d0b518418736f47';
const V3_COMMIT='eb891ee2154d02ddb758d50f0f694e70a343ffdf';
const V3_CIPHER='7afed3f229d371b850fda3fcc77fb0f601f2c588ccab6210d878b2f7501321a0';
const CONTROLLER=39448482259, WORKER=39448549052, INGEST=39465467460;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function git(root,...args){
  return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024,
    stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();
}
function object(root,rel,revision='HEAD'){
  const bytes=execFileSync('git',['-C',root,'show',revision+':'+rel],{
    timeout:45000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  });
  return {bytes,parsed:JSON.parse(bytes.toString('utf8'))};
}
function state(store,version){
  const relative='workflows/issues/'+ISSUE+'/states/'+String(version).padStart(8,'0')+'.json';
  const q=object(store,relative).parsed;
  assert.equal(q.schema_version,1);
  assert.equal(q.issue,ISSUE);
  assert.equal(q.version,version);
  assert.ok(Array.isArray(q.outbox)&&q.outbox.length<128);
  return q;
}
function exactlyOne(state,id,status){
  const found=state.outbox.filter(x=>x.id===id);
  assert.equal(found.length,1,'Action ID must never duplicate');
  assert.equal(found[0].status,status);
  return found[0];
}
async function github(endpoint){
  const response=await fetch('https://api.github.com/repos/'+REPO+'/'+endpoint,{
    headers:{Accept:'application/vnd.github+json',
      'User-Agent':'nession-1664-sc04-source-case',
      'X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(15000),
  });
  assert.equal(response.status,200,'authenticated public GitHub source unavailable');
  return response.json();
}
async function sourceRun(id,name,pathName,event){
  const run=await github('actions/runs/'+id);
  assert.equal(run.id,id);
  assert.equal(run.repository?.full_name,REPO);
  assert.equal(run.head_repository?.full_name,REPO);
  assert.equal(run.name,name);
  assert.equal(run.path,pathName);
  assert.equal(run.event,event);
  assert.equal(run.head_branch,'main');
  assert.equal(run.status,'completed');
  assert.equal(run.conclusion,'success');
  assert.equal(run.run_attempt,1);
  assert.match(run.head_sha,SHA);
  return run;
}
function fixture(file){
  execFileSync(process.execPath,[file],{
    cwd:repo,timeout:100000,maxBuffer:1024*1024,
    stdio:['ignore','pipe','pipe'],
  });
}
async function main(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(target,SHA,'exact merged SHA required');
  assert.equal(git(repo,'rev-parse','HEAD'),target);
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-1664-sc04-'));
  try{
    const store=path.join(tmp,'agent-store');
    execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
      '--branch','agent-store','--','https://github.com/'+REPO+'.git',store],{
      timeout:90000,maxBuffer:1024*1024,
      stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    });
    assert.equal(git(store,'symbolic-ref','--short','HEAD'),'agent-store');
    const tip=git(store,'rev-parse','HEAD');
    assert.match(tip,SHA);
    const head=object(store,'workflows/issues/'+ISSUE+'/head.json').parsed;
    assert.ok(head.version>=16,'real source history was rolled back');
    assert.match(head.sha256,HASH);
    const latest=object(store,head.path);
    assert.equal(latest.parsed.version,head.version);
    assert.equal(digest(latest.bytes),head.sha256,'Store head must bind exact Git bytes');
    const [s13,s14,s15,s16]=[13,14,15,16].map(v=>state(store,v));
    assert.ok([s13,s14,s15,s16].every(s=>s.phase==='ready'));
    const pending=exactlyOne(s13,ACTION,'pending');
    const intent=exactlyOne(s14,ACTION,'dispatching');
    const dispatched=exactlyOne(s15,ACTION,'dispatched');
    const yielded=exactlyOne(s16,ACTION,'yielded');
    for(const x of [pending,intent,dispatched,yielded]){
      assert.equal(x.attempts,x===pending?0:1);
      assert.equal(x.task.role,'developer');
      assert.equal(x.task.agent_id,'dev-cursor-01');
      assert.equal(x.task.task,'implement');
      assert.equal(x.task.resume,true);
      assert.equal(x.task.continuation.ordinal,2);
      assert.equal(x.task.continuation.checkpoint_version,2);
      assert.equal(x.task.sha,'220266b9233ec97b1beacbc54e5cc7f82d3cece2');
    }
    assert.equal(intent.receipt.status,'prepared');
    assert.equal(intent.receipt.issuer_run_id,CONTROLLER);
    assert.match(intent.receipt.ticket_sha256,HASH);
    assert.equal(dispatched.receipt.status,'verified');
    assert.equal(dispatched.receipt.source_run_id,WORKER);
    assert.equal(yielded.receipt.status,'yielded');
    assert.equal(yielded.receipt.source_run_id,WORKER);
    assert.equal(yielded.receipt.source_attempt,1);
    assert.equal(yielded.receipt.checkpoint_version,3);
    assert.equal(yielded.receipt.checkpoint_commit_sha,V3_COMMIT);
    assert.equal(yielded.receipt.ciphertext_sha256,V3_CIPHER);
    const successor=exactlyOne(s16,FOLLOWUP,'pending');
    assert.equal(successor.attempts,0);
    assert.equal(successor.task.continuation.parent_action_id,ACTION);
    assert.equal(successor.task.continuation.ordinal,3);
    assert.equal(successor.task.continuation.checkpoint_version,3);
    assert.equal(successor.task.continuation.checkpoint_commit_sha,V3_COMMIT);
    assert.equal(successor.task.continuation.ciphertext_sha256,V3_CIPHER);
    const [controller,worker,ingest]=await Promise.all([
      sourceRun(CONTROLLER,'Agent / Controller Dispatch',
        '.github/workflows/agent-controller-dispatch.yml','issue_comment'),
      sourceRun(WORKER,'Agent / Development',
        '.github/workflows/agent-develop.yml','workflow_dispatch'),
      sourceRun(INGEST,'Store / Agent Development Ingest',
        '.github/workflows/store-agent-development-ingest.yml','issue_comment'),
    ]);
    assert.equal(controller.head_sha,worker.head_sha,'Controller→Worker SHA drift');
    assert.equal(controller.actor?.login,OWNER);
    assert.equal(ingest.actor?.login,OWNER);
    const command=await github('issues/comments/6296866239');
    assert.equal(command.user?.login,OWNER);
    assert.equal(command.issue_url,'https://api.github.com/repos/'+REPO+'/issues/'+ISSUE);
    assert.equal(command.body,
      '/nession ingest issue=1997 action='+ACTION+' worker_run='+WORKER);
    const artifacts=await github('actions/runs/'+WORKER+'/artifacts?per_page=100');
    assert.ok(artifacts.total_count===artifacts.artifacts.length);
    for(const [name,id] of [
      ['development-worker-39448549052-1',12275629206],
      ['development-worker-claim-39448549052-1',12276388775],
    ]){
      const found=artifacts.artifacts.filter(x=>x.name===name);
      assert.equal(found.length,1);
      assert.equal(found[0].id,id);
      assert.equal(found[0].workflow_run.id,WORKER);
      assert.equal(found[0].workflow_run.head_sha,worker.head_sha);
      assert.equal(found[0].expired,false);
      assert.match(found[0].digest,/^sha256:[a-f0-9]{64}$/);
    }
    // These are real disposable bare-Git CAS/transport/review-role fixtures,
    // not claims of a completed live Reviewer or Publisher.
    for(const file of [
      'scripts/lib/agent/orchestration/dispatch-intent-selftest.mjs',
      'scripts/lib/agent/orchestration/failed-dispatch-selftest.mjs',
      'scripts/lib/agent/orchestration/worker-reconcile-selftest.mjs',
      'scripts/lib/agent/orchestration/outbox-selftest.mjs',
    ])fixture(file);
    const evidence=[
      {type:'runtime',value:'exact source main SHA='+target+' agent-store tip='+tip},
      {type:'runtime',value:'#1997 immutable v13 pending → v14 dispatching → v15 dispatched → v16 yielded'},
      {type:'runtime',value:'Controller='+CONTROLLER+' Worker='+WORKER+' Ingest='+INGEST+
        ' original Run/attempt verified via independent GitHub metadata'},
      {type:'runtime',value:'exact v3 ciphertext digest='+V3_CIPHER+
        ' original v2 Action='+ACTION+' unique pending successor='+FOLLOWUP},
      {type:'runtime',value:'four executable CAS/replay/failure/role-transition negative suites passed'},
    ];
    const hasReviewer=s16.transitions.some(x=>x.kind==='reviewer');
    // A nonempty 'reviewer' event without an independently authenticated
    // PR-head/Issue-thread receipt is also Pending. There is no live Reviewer
    // from this controlled fixture yet; don't equate a unit test with that.
    console.log(JSON.stringify({
      status:'pending',
      summary:hasReviewer?
        'Durable dispatch and negatives verified, but real PR Review event, authenticated replay and Publisher receipts require independent verification.':
        'Durable dispatch and replay negatives verified. No real Publisher/PR review event exists at the observed fixture state; SC-04 remains Pending.',
      evidence,
    }));
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
main().catch(e=>{
  const summary=e instanceof Error?e.message:String(e);
  console.error(summary);
  console.log(JSON.stringify({status:'fail',summary,
    evidence:[{type:'runtime',value:'Source-aligned SC-04 contract or negative fixture failed'}]}));
  process.exitCode=1;
});
