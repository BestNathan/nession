'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {repo,invokeScenario,comparePair,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');
const {pinnedRun,SOURCES}=require('../../../shared/trusted-run-store-proof.cjs');
async function main(){
 const run=invokeScenario(2);
 const [a,b]=run.records.map(x=>x.data);
 assert.equal(a.config_sha256,b.config_sha256);
 const same=comparePair(run.records);
 assert.equal(same.evaluation,null);assert.equal(same.config_comparable,true);
 assert.match(same.limitations,/nondeterministic/);
 const historical=await pinnedRun(SOURCES.scenario);
 assert.notEqual(historical.item.target_sha,run.target);
 assert.equal(historical.item.config_sha256,a.config_sha256,'cross-SHA input parameters changed');
 const file=path.join(run.dir,'authenticated-historical.json');
 fs.writeFileSync(file,JSON.stringify(historical.item));
 const p=spawnSync(process.execPath,[path.join(repo,'e2e/run'),'compare',file,run.records[0].file],{cwd:repo,encoding:'utf8',timeout:8000});
 assert.equal(p.status,0,'cross-SHA comparison must complete: '+p.stderr);
 const x=JSON.parse(p.stdout);
 assert.equal(x.status,'Completed');assert.equal(x.evaluation,null);
 assert.equal(x.config_comparable,true);
 assert.ok(x.differences.some(d=>d.field==='target_sha'));
 assert.match(x.limitations,/not synchronized/);
 assert.match(x.limitations,/nondeterministic/);
 result('Two real repeated runs compared with authenticated different-SHA orphan evidence and explicit clock nondeterminism limitations',[
 {type:'repeat',value:'source='+run.target+' runs=2 samples='+a.observation_count+','+b.observation_count},
 {type:'historical',value:'source='+historical.item.target_sha+' run='+historical.run.id+' immutable git blob='+historical.blob},
 {type:'uncertainty',value:'unsynchronized clocks and nondeterministic scheduling; comparison evaluation=null'}]);
}
main().catch(fail);
