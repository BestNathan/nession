'use strict';
/**
 * Staging source-aligned Scenario Case helper. Executes the SAME canonical
 * observation-only CLI as Scenario Smoke; does not assign verdict to the
 * Scenario record. The separate Case may evaluate the observed evidence.
 */
const assert = require('node:assert/strict');
const {spawnSync,execFileSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const repo=path.resolve(__dirname,'../../..');
const scenario='terminal-attach-resume';
function expectedIdentity(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(target,/^[a-f0-9]{40}$/,'Case target must be exact SHA');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),target);
  assert.equal(process.env.GITHUB_REF_NAME,'staging','require staging merge execution');
  const runtime=JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE,'utf8'));
  assert.equal(runtime.target_sha,target,'parent Case Runtime exact-SHA mismatch');
  assert.equal(runtime.profile,'full-stack-local');
  return {target,runtime};
}
function invokeScenario(repeat){
  const {target,runtime}=expectedIdentity();
  assert.ok(Number.isInteger(repeat)&&repeat>=1&&repeat<=2);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-1498-scenario-'));
  try{
    const p=spawnSync(process.execPath,[path.join(repo,'e2e/run'),'scenario',scenario,
      '--sha',target,'--repeat',String(repeat),'--output',dir],{
      cwd:repo,encoding:'utf8',timeout:105000,maxBuffer:2*1024*1024,
      env:{...process.env,CI:'true'},
    });
    assert.equal(p.error,undefined,'Scenario failed to start '+String(p.error));
    assert.equal(p.status,0,'real Scenario failed: '+String(p.stderr||p.stdout).slice(-1000));
    const names=fs.readdirSync(dir).filter(n=>/^scenario-[0-9]+-[12]\.json$/.test(n));
    assert.equal(names.length,repeat,'Scenario output count mismatch');
    const records=names.map(name=>({file:path.join(dir,name),
      data:JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))}))
      .sort((a,b)=>a.data.run_index-b.data.run_index);
    for(let i=0;i<repeat;i++){
      const x=records[i].data;
      assert.equal(x.schema_version,1);
      assert.equal(x.kind,'e2e_scenario_observation');
      assert.equal(x.scenario,scenario);
      assert.equal(x.target_sha,target);
      assert.equal(x.scenario_revision,target);
      assert.equal(x.run_index,i+1);
      assert.equal(x.status,'Completed');
      assert.equal(x.evaluation,null,'observational execution cannot assert Pass');
      assert.equal(x.error,null);
      assert.equal(x.session_created,true);
      assert.ok(x.observation_count>=2&&x.observation_count<=24);
      assert.equal(x.observation_count,x.observations.length);
      assert.match(x.config_sha256,/^[a-f0-9]{64}$/);
      assert.ok(x.observations.some(o=>o.stage==='before-reload'));
      assert.ok(x.observations.some(o=>o.stage==='after-reload'));
      for(const o of x.observations){
        assert.ok(Number.isFinite(Date.parse(o.at)));
        assert.ok(Number.isSafeInteger(o.browser.marker_count)&&o.browser.marker_count>=0);
        assert.ok(Number.isSafeInteger(o.backend.marker_count)&&o.backend.marker_count>=0);
        assert.match(o.backend.sha256,/^[a-f0-9]{64}$/);
      }
    }
    return {target,runtime,records,dir};
  }catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
}
function comparePair(records){
  assert.equal(records.length,2);
  const result=spawnSync(process.execPath,[path.join(repo,'e2e/run'),'compare',
    records[0].file,records[1].file],{cwd:repo,encoding:'utf8',timeout:8000,maxBuffer:1024*1024});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,'canonical compare Error: '+result.stderr);
  const comparison=JSON.parse(result.stdout);
  assert.equal(comparison.status,'Completed');
  assert.equal(comparison.evaluation,null);
  assert.equal(comparison.scenario,scenario);
  assert.equal(comparison.config_comparable,true);
  assert.match(comparison.limitations,/nondeterministic/);
  for(const side of ['left','right']){
    assert.ok(comparison[side].sample_count>=2);
    assert.ok(Number.isSafeInteger(comparison[side].final_browser_marker_count));
  }
  return comparison;
}
function result(summary,evidence){
  assert.ok(evidence.length>0);
  console.log(JSON.stringify({status:'pass',summary,evidence}));
}
function fail(error){
  const reason=error instanceof Error?error.message:String(error);
  console.error(reason);
  console.log(JSON.stringify({status:'fail',summary:reason,
    evidence:[{type:'scenario',value:'real staging Scenario Case evidence incomplete'}]}));
  process.exitCode=1;
}
module.exports={repo,scenario,expectedIdentity,invokeScenario,comparePair,result,fail};
