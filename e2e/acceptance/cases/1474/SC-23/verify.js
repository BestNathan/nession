'use strict';
const assert=require('node:assert/strict');
const {optInCollector}=require('../../../../runner/collectors/opt-in-observations.cjs');
const {invokeScenario,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');
try{
 const disabled=optInCollector();
 assert.equal(disabled.process(),null);assert.deepEqual(disabled.snapshot().events,[]);
 const run=invokeScenario(1),r=run.records[0].data;
 const first=r.observations[0];
 const c=optInCollector({enabled:true,maximum:5});
 c.protocol({operation:'server.auth',success:true,elapsed_ms:1,authorization:'NEVER_PERSIST'});
 const proc=c.process({memory:process.memoryUsage(),cpu:process.cpuUsage(),command:'PRIVATE'});
 c.browser({...first.browser,cookie:'PRIVATE'});
 c.terminal({...first.backend,raw_terminal:'PRIVATE'});
 c.artifact({artifact_id:'case_1474',sha256:r.config_sha256,retention_days:14,url:'SECRET'});
 const snapshot=c.snapshot();
 assert.equal(snapshot.events.length,5);assert.equal(snapshot.evaluation,null);
 assert.ok(proc.rss_bytes>0);
 assert.ok(!JSON.stringify(snapshot).includes('PRIVATE')&&!JSON.stringify(snapshot).includes('SECRET'));
 assert.throws(()=>c.process(),/budget exceeded/);
 assert.throws(()=>optInCollector({enabled:true}).protocol({operation:'malicious',success:true,elapsed_ms:1}),/unsupported/);
 assert.throws(()=>optInCollector({enabled:true}).artifact({artifact_id:'x',sha256:r.config_sha256,retention_days:999}));
 assert.ok(r.observations.every(o=>Number.isFinite(Date.parse(o.at))));
 result('Real browser and terminal observations plus opt-in typed collector projection enforce bounds and nested secret omission',[
 {type:'collector',value:'five timestamped typed events; real Process RSS='+proc.rss_bytes},
 {type:'runtime',value:'source='+run.target+' observations='+r.observation_count+' backend SHA-256 present'},
 {type:'security',value:'default-disabled; invalid operation, excessive retention and event budget rejected; no URLs or raw content'}]);
}catch(e){fail(e);}
