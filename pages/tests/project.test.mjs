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
