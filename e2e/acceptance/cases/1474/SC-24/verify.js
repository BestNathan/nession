'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {pinnedRun,SOURCES,fetchJson,report,fail}=require('../../../shared/trusted-run-store-proof.cjs');
const hash=buf=>crypto.createHash('sha256').update(buf).digest('hex');
const gitBlob=buf=>crypto.createHash('sha1').update('blob '+buf.length+'\0').update(buf).digest('hex');
async function latestTrustedTest(){
 const response=await fetchJson('/actions/workflows/e2e.yml/runs?event=push&branch=staging&per_page=30');
 assert.ok(Array.isArray(response.workflow_runs));
 for(const run of response.workflow_runs){
  if(run.event!=='push'||run.head_branch!=='staging'||run.conclusion!=='success'||run.status!=='completed')continue;
  const date=run.created_at.slice(0,10);
  const rel='runs/'+date+'/'+run.id+'-'+run.run_attempt+'/test/playwright.json';
  let file;try{file=await fetchJson('/contents/'+rel+'?ref=acceptance-results');}catch(e){
   if(/ 404 /.test(String(e)))continue;throw e;
  }
  assert.equal(file.encoding,'base64');
  const bytes=Buffer.from(file.content.replace(/\s/g,''),'base64');
  assert.equal(file.sha,gitBlob(bytes));
  const r=JSON.parse(bytes.toString('utf8'));
  assert.equal(r.schema_version,1);assert.equal(r.mode,'test');assert.equal(r.kind,'e2e_test_run');
  assert.equal(r.evaluation,null);assert.equal(r.status,'Completed');
  assert.equal(r.target_sha,run.head_sha);
  assert.equal(r.run_id,run.id);assert.equal(r.run_attempt,run.run_attempt);
  assert.equal(r.source.workflow_id,run.workflow_id);
  assert.equal(r.source.event,'push');assert.equal(r.source.head_branch,'staging');
  assert.match(r.evidence.sha256,/^[a-f0-9]{64}$/);
  assert.match(r.evidence.durability,/time-limited/i);
  const irel='indexes/by-sha/'+r.target_sha+'/test/'+run.id+'-'+run.run_attempt+'-playwright.json';
  const ifile=await fetchJson('/contents/'+irel+'?ref=acceptance-results');
  const index=JSON.parse(Buffer.from(ifile.content.replace(/\s/g,''),'base64').toString('utf8'));
  assert.equal(index.record,rel);assert.equal(index.mode,'test');
  assert.equal(index.record_sha256,hash(bytes));
  assert.equal(index.source_tree_sha,r.source_tree_sha);
  return {record:r,blob:file.sha,rel};
 }
 throw new Error('no authenticated successful staging-push Test Run ingested to orphan branch; trusted main consumer must run first');
}
async function main(){
 assert.equal(process.env.GITHUB_REF_NAME,'staging');
 const [scenario,acceptance,test]=await Promise.all([
  pinnedRun(SOURCES.scenario),pinnedRun(SOURCES.acceptance),latestTrustedTest()]);
 assert.equal(scenario.item.evaluation,null);
 assert.equal(acceptance.item.result,'Pass');
 report('Test, Acceptance and Scenario all have authentic immutable Git orphan records with mode indexes, bounded evidence and checksum provenance',[
  {type:'test',value:'run='+test.record.run_id+' SHA='+test.record.target_sha+' Git blob='+test.blob},
  {type:'case',value:'run='+acceptance.run.id+' immutable Case source SHA='+acceptance.item.target_sha},
  {type:'scenario',value:'run='+scenario.run.id+' immutable Scenario SHA='+scenario.item.target_sha},
  {type:'retention',value:'compact results on acceptance-results; time-limited large evidence held only in external Actions artifacts'}
 ]);
}
main().catch(fail);
