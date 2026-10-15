import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeProjection, validateProjection } from '../scripts/project.mjs';

const main='a'.repeat(40), met='b'.repeat(40), now='2026-10-14T12:00:00Z';
const base={
  repository:{schema_version:2,commit_sha:main,generated_at:now,repository:{source:{loc:250},coverage:{}},efficiency:{issues:{open:4}}},
  agent:{schema_version:1,kind:'agent_metrics_aggregate',generated_at:now,windows:{'7d':{runs:{total:3,by_agent_id:{'dev-qwen-01':2}},tokens:{total:{total:12000,observed_runs:2}},tools:{total:3,observed_runs:1},cost_usd:{charged:{total:null,observed_runs:0}}}}},
  registry:{instances:{'dev-qwen-01':{role:'developer',provider:'claude-code',environment:'super-sensitive'},'review-01':{role:'reviewer',provider:'cursor'}}},
  issues:[{number:6,title:'Issue <img src=x onerror=alert(1)>',state:'open',updated_at:now,html_url:'https://evil.com/steal',secret:'oops'}, {number:7,pull_request:{url:'x'},title:'A PR not an Issue'}],
  pulls:[{number:5,title:'PR',state:'open',updated_at:now,html_url:'https://example.com'}],
  refs:{metrics:{state:'present',sha:met},'agent-store':{state:'missing'}},
  meta:{generated_at:now,main_sha:main,metrics_sha:met},
};
test('strict sanitized/public schema only, source backed URLs',()=>{
  const p=validateProjection(makeProjection(base));
  const asText=JSON.stringify(p);
  assert.equal(p.schema_version,1);
  assert.equal(p.work.issues[0].url,'https://github.com/BestNathan/nession/issues/6');
  assert.equal(p.work.pulls[0].url,'https://github.com/BestNathan/nession/pull/5');
  assert.equal(p.work.issues.length,1);
  assert.ok(!asText.includes('onerror='));
  assert.ok(!asText.includes('super-sensitive'));
  assert.ok(!asText.includes('https://evil.com'));
  assert.ok(!asText.includes('secret'));
});
test('per Agent observations do not inherit global token/cost totals',()=>{
  const p=makeProjection(base);
  assert.equal(p.agents.summary.tokens_7d,12000);
  assert.equal(p.agents.summary.cost_7d,null);
  assert.equal(p.agents.roster.find(x=>x.id==='dev-qwen-01').observed_7d,2);
  assert.equal(p.agents.roster.find(x=>x.id==='review-01').observed_7d,null);
  assert.ok(!Object.hasOwn(p.agents.roster[0],'tokens'));
});
test('unknown source is unavailable, never zero or trusted integrity',()=>{
  const p=makeProjection({issues:null,pulls:null,registry:null,meta:{generated_at:now}});
  assert.equal(p.repository.current.loc,null);
  assert.equal(p.agents.summary.runs_7d,null);
  assert.equal(p.work.issues_status,'unavailable');
  assert.equal(p.work.issues.length,0);
  assert.ok(p.evidence.stores.every(s=>s.state==='unavailable'));
});
test('unverified and invalid branch identities never yield present status',()=>{
  const p=makeProjection({...base,refs:{metrics:{state:'present',sha:'tampered'},'agent-store':{state:'present',sha:met}}});
  assert.equal(p.evidence.stores[0].state,'unavailable');
  assert.equal(p.evidence.stores.find(s=>s.name==='agent-store').state,'present');
});
test('independent UI must not import product Web styles/components/tokens',async()=>{
  for(const path of ['../app.js','../styles.css','../index.html']){
    const contents=await readFile(new URL(path,import.meta.url),'utf8');
    assert.doesNotMatch(contents,/(?:from|import|href|src)\s*(?:\(|=)?\s*['"](?:\.\.\/)+web\//i);
    assert.doesNotMatch(contents,/web\/src\/|web\/public\/|design\/tokens\//);
  }
});

test('public 7d/30d workflow and provider aggregates derive only from source maps',()=>{
  const p=makeProjection({
    ...base,
    agent:{schema_version:1,kind:'agent_metrics_aggregate',generated_at:now,windows:{
      '7d':{runs:{total:8,by_issue:{'6':3,'99':2,'7':-2},by_provider:{cursor:6,'claude-code':2,evil_tag:NaN},by_workflow:{'issue-audit':4,'agent-provider-smoke':4}}},
      '30d':{runs:{total:12,by_provider:{cursor:9,'claude-code':3},by_workflow:{'issue-audit':7}}},
    }},
  });
  assert.equal(p.agents.summary.runs_7d,8);
  assert.equal(p.agents.summary.runs_30d,12);
  assert.deepEqual(p.agents.distribution['7d'].providers.items,[{name:'cursor',count:6},{name:'claude-code',count:2}]);
  assert.equal(p.agents.distribution['30d'].workflows.items[0].count,7);
  assert.equal(p.work.issues[0].observed_agent_runs_7d,3);
  assert.ok(!JSON.stringify(p).includes('evil_tag'));
});
test('absent source is not a fabricated zero or exact-SHA association',()=>{
  const p=makeProjection({...base,agent:{schema_version:1,kind:'agent_metrics_aggregate',windows:{'7d':{runs:{total:0,by_issue:{'6':0}}}}}});
  assert.equal(p.agents.summary.runs_7d,0);
  assert.equal(p.agents.summary.runs_30d,null);
  assert.equal(p.work.issues[0].observed_agent_runs_7d,0);
  assert.equal(p.agents.distribution['30d'].providers.available,false);
  const n=makeProjection({...base,agent:null});
  assert.equal(n.work.issues[0].observed_agent_runs_7d,null);
  assert.equal(n.agents.distribution['7d'].providers.available,false);
});
test('public source rollups reject private keys, fractions and invalid numbers',()=>{
  const by_provider=Object.fromEntries(Array.from({length:80},(_,i)=>['provider-'+i,i]));
  by_provider['secret:token']=9;by_provider['../web']=10;by_provider['badfraction']=2.3;
  const p=validateProjection(makeProjection({...base,agent:{schema_version:1,kind:'agent_metrics_aggregate',windows:{'7d':{runs:{by_provider}}}}}));
  assert.equal(p.agents.distribution['7d'].providers.items.length,12);
  assert.ok(p.agents.distribution['7d'].providers.items.every(x=>/^[a-z][a-z0-9_-]{0,47}$/.test(x.name)));
  assert.ok(!JSON.stringify(p).includes('secret:token'));
  assert.ok(!JSON.stringify(p).includes('../web'));
  assert.ok(!JSON.stringify(p).includes('badfraction'));
});

test('only exact PR HEAD and canonical GitHub CI/E2E workflow runs are projected',()=>{
 const sha='a'.repeat(40),meta={generated_at:now};
 const pr={number:5,title:'Proof',state:'open',updated_at:now,head:{sha,repo:{full_name:'BestNathan/nession'}}};
 const mk=(id,name,path,status='completed',conclusion='success')=>({
  id,run_attempt:2,name,path,event:'pull_request',head_sha:sha,
  status,conclusion,updated_at:now,
  repository:{full_name:'BestNathan/nession'},head_repository:{full_name:'BestNathan/nession'}
 });
 const ci=mk(43,'CI / Quality Gate','.github/workflows/ci-quality.yml');
 const e2e=mk(45,'E2E / Tests','.github/workflows/e2e-tests.yml','completed','failure');
 const forged=mk(999,'CI / Quality Gate','.github/workflows/ci-quality.yml');
 forged.head_sha='b'.repeat(40);
 const p=validateProjection(makeProjection({pulls:[pr],workflowRuns:[ci,e2e,forged],meta}));
 const evidence=p.work.pulls[0].workflow;
 assert.equal(evidence.head_sha,sha);
 assert.equal(evidence.ci.run_id,43);
 assert.equal(evidence.ci.attempt,2);
 assert.equal(evidence.e2e.status,'failure');
 assert.equal(evidence.e2e.url,'https://github.com/BestNathan/nession/actions/runs/45');
 assert.ok(!JSON.stringify(evidence).includes('999'));
});
test('wrong repo, workflow path, event, invalid attempts and unobserved CI never show Pass',()=>{
 const sha='a'.repeat(40),pr={number:5,title:'P',head:{sha,repo:{full_name:'BestNathan/nession'}}};
 const base={id:18,run_attempt:1,name:'CI / Quality Gate',
  path:'.github/workflows/ci-quality.yml',event:'pull_request',
  head_sha:sha,status:'completed',conclusion:'success',
  repository:{full_name:'BestNathan/nession'},head_repository:{full_name:'BestNathan/nession'}};
 const invalid=[
  {...base,id:0},{...base,run_attempt:0},{...base,event:'push'},
  {...base,path:'.github/workflows/deploy-pages.yml'},
  {...base,repository:{full_name:'foreign/repo'}},
  {...base,head_repository:{full_name:'foreign/repo'}},
 ];
 const p=makeProjection({pulls:[pr],workflowRuns:invalid});
 assert.equal(p.work.pulls[0].workflow.ci,null);
 assert.equal(p.work.pulls[0].workflow.e2e,null);
 assert.equal(makeProjection({pulls:[pr],workflowRuns:null}).work.workflow_runs_status,'unavailable');
 assert.equal(makeProjection({pulls:[{...pr,head:{...pr.head,repo:{full_name:'foreign/repo'}}}],workflowRuns:[base]}).work.pulls[0].workflow.head_sha,null);
});

test('Issue→PR uses only genuine same-repo GitHub Timeline cross-reference identities',()=>{
 const refs=n=>({event:'cross-referenced',source:{type:'issue',issue:{
  number:n,url:'https://api.github.com/repos/BestNathan/nession/issues/'+n,
  html_url:'https://github.com/BestNathan/nession/pull/'+n,
  repository:{full_name:'BestNathan/nession'},pull_request:{
   url:'https://api.github.com/repos/BestNathan/nession/pulls/'+n,
   html_url:'https://github.com/BestNathan/nession/pull/'+n},
 }}});
 const proof=refs(99),unrelated=refs(100);
 unrelated.source.issue.repository.full_name='other/repo';
 const forged=refs(101);
 forged.source.issue.html_url='https://evil.com/steal';
 const notPR=refs(102);delete notPR.source.issue.pull_request;
 const p=validateProjection(makeProjection({...base,issueTimelines:{'6':{
  status:'available',events:[proof,refs(99),unrelated,forged,notPR,{event:'referenced',source:proof.source}]
 }}}));
 assert.deepEqual(p.work.issues[0].pr_references,{status:'available',prs:[{
  number:99,url:'https://github.com/BestNathan/nession/pull/99',relation:'github_cross_reference'
 }]});
 assert.ok(!JSON.stringify(p).includes('evil.com'));
 assert.ok(!JSON.stringify(p).includes('other/repo'));
});
test('Timeline unavailable, truncated, excessive and malformed references never imply no history',()=>{
 const as=n=>({event:'cross-referenced',source:{type:'issue',issue:{
  number:n,url:'https://api.github.com/repos/BestNathan/nession/issues/'+n,
  html_url:'https://github.com/BestNathan/nession/pull/'+n,
  repository:{full_name:'BestNathan/nession'},
  pull_request:{url:'https://api.github.com/repos/BestNathan/nession/pulls/'+n,
   html_url:'https://github.com/BestNathan/nession/pull/'+n},
 } }});
 const items=Array.from({length:100},(_,i)=>as(100+i));
 const capped=makeProjection({...base,issueTimelines:{'6':{status:'truncated',events:items}}}).work.issues[0].pr_references;
 assert.equal(capped.status,'truncated');
 assert.equal(capped.prs.length,6);
 assert.equal(capped.prs[0].number,100);
 assert.equal(capped.prs[5].number,105);
 assert.deepEqual(makeProjection({...base,issueTimelines:null}).work.issues[0].pr_references,
  {status:'unavailable',prs:[]});
 const malformed=makeProjection({...base,issueTimelines:{'6':{status:'available',events:[as(-4)]}}}).work.issues[0].pr_references;
 assert.deepEqual(malformed,{status:'available',prs:[]});
});

test('source age follows metric measurement instead of site build time',()=>{
 const fresh=makeProjection({...base,meta:{...base.meta,generated_at:'2026-10-14T17:00:00Z'}});
 assert.equal(fresh.repository.freshness.state,'fresh');
 assert.equal(fresh.agents.freshness.state,'fresh');
 const old=makeProjection({...base,meta:{...base.meta,generated_at:'2026-10-15T03:00:00Z'}});
 assert.equal(old.repository.freshness.state,'stale');
 assert.equal(old.agents.freshness.state,'stale');
 const absent=makeProjection({...base,agent:null,repository:null});
 assert.equal(absent.agents.freshness.state,'unavailable');
 assert.equal(absent.repository.freshness.age_hours,null);
 const clockDrift=makeProjection({...base,meta:{...base.meta,generated_at:'2026-10-13T00:00:00Z'}});
 assert.equal(clockDrift.agents.freshness.state,'unavailable');
});
test('untrusted local address and private file paths are removed before publication',()=>{
 for(const text of ['192.168.12.100','/home/developer/private.conf','localhost','api_key=nonproduction_placeholder','gh'+'p_'+'Z'.repeat(24)]){
  const p=validateProjection(makeProjection({...base,issues:[{
   number:6,title:'Do not publish '+text,updated_at:now,
  }],registry:{instances:{'review-01':{role:'reviewer',provider:text}}}}));
  assert.equal(p.work.issues[0].title,'[redacted public text]');
  assert.equal(p.agents.roster[0].provider,'[redacted public text]');
  assert.doesNotMatch(JSON.stringify(p),new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 }
});
test('public release gate rejects arbitrary fields, unsafe links and invalid values',()=>{
 const initial=()=>validateProjection(makeProjection(base));
 const extra=initial();extra.work.issues[0].untrusted_field='unapproved';
 assert.throws(()=>validateProjection(extra),/disallowed public field/);
 const privateField=initial();privateField.agents.roster[0].transcript='unsafe';
 assert.throws(()=>validateProjection(privateField),/private field/);
 for(const link of ['https://elsewhere.example/pull/1','javascript:alert(1)']){
   const p=initial();p.work.issues[0].url=link;
   assert.throws(()=>validateProjection(p),/untrusted public URL/);
 }
 const token=initial();token.work.issues[0].title='api_key=placeholder';
 assert.throws(()=>validateProjection(token),/private field value/);
 const invalid=initial();invalid.agents.summary.runs_7d=Infinity;
 assert.throws(()=>validateProjection(invalid),/invalid public metric/);
 const huge=initial();huge.work.issues[0].title='x'.repeat(140000);
 assert.throws(()=>validateProjection(huge),/release limit/);
 const unsafe=initial();unsafe.work.issues[0].title='/home/person/secret.txt';
 assert.throws(()=>validateProjection(unsafe),/private field value/);
});
