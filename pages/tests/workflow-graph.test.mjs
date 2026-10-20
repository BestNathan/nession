import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WORKFLOW_IDS, projectWorkflowGraph, validateWorkflowGraph } from '../scripts/workflow-graph.mjs';

const path=new URL('../../.github/workflows/',import.meta.url);
async function definitions(){
  return Object.fromEntries(await Promise.all(WORKFLOW_IDS.map(async id=>
    [id,await readFile(new URL(id+'.yml',path),'utf8')])));
}
const sha='a'.repeat(40);
test('all displayed workflows come from real checked-in main YAML and pinned public links',async()=>{
  const projection=projectWorkflowGraph(await definitions(),sha,'2026-10-20T00:00:00.000Z');
  assert.equal(projection.nodes.length,WORKFLOW_IDS.length);
  assert.equal(projection.source.main_sha,sha);
  assert.equal(new Set(projection.nodes.map(x=>x.name)).size,WORKFLOW_IDS.length);
  for(const entry of projection.nodes){
    assert.ok(entry.triggers.length>0);
    assert.equal(entry.url,'https://github.com/BestNathan/nession/blob/'+sha+
      '/.github/workflows/'+entry.id+'.yml');
  }
  assert.deepEqual(validateWorkflowGraph(projection),projection);
});
test('edges require declarative workflow_run or workflow_call, never shared triggers',async()=>{
  const p=projectWorkflowGraph(await definitions(),sha);
  function edge(from,to,kind='workflow_run'){
    return p.edges.some(x=>x.from===from&&x.to===to&&x.kind===kind);
  }
  assert.ok(edge('e2e-tests','e2e-test-ingest'));
  assert.ok(edge('acceptance-cases','acceptance-case-ingest'));
  assert.ok(edge('agent-develop','store-agent-dispatch-reconcile'));
  assert.ok(edge('agent-develop','store-agent-development-ingest'));
  assert.ok(edge('ci-quality','acceptance-orchestrator'));
  assert.ok(edge('deploy-pages','acceptance-postrun-waker'));
  // These can run because of the same GitHub event, but are not
  // explicit workflow-to-workflow dependencies.
  assert.equal(edge('ci-quality','e2e-tests'),false);
  assert.equal(edge('agent-issue-audit','agent-develop'),false);
  assert.equal(edge('release-staging','release-production'),false);
});
test('missing or changed workflow sources fail closed',async()=>{
  const defs=await definitions();
  delete defs['ci-quality'];
  assert.throws(()=>projectWorkflowGraph(defs,sha),/Invalid workflow source/);
  const complete=await definitions();
  complete['e2e-tests']=complete['e2e-tests'].replace(/^on:\s*$/m,'events:');
  assert.throws(()=>projectWorkflowGraph(complete,sha),/Missing on mapping/);
  const valid=await definitions();
  assert.throws(()=>projectWorkflowGraph(valid,'not-a-commit'),/Invalid source revision/);
});
test('public projection rejects forged routes, injected fields and duplicate topology',async()=>{
  const p=projectWorkflowGraph(await definitions(),sha);
  p.nodes[0].url='https://example.invalid/private';
  assert.throws(()=>validateWorkflowGraph(p),/Invalid workflow projection node/);
  const q=projectWorkflowGraph(await definitions(),sha);
  q.edges.push({...q.edges[0]});
  assert.throws(()=>validateWorkflowGraph(q),/Invalid workflow projection edge/);
});
