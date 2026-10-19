import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {projectLineage,validateLineageProjection} from '../scripts/lineage.mjs';
import {makeProjection,validateProjection} from '../scripts/project.mjs';

// The browser is intentionally an anonymous static snapshot reader. Its
// source may display canonical verified edges, but it must never create them
// from Issue Timeline mentions, Agent metrics, or arbitrary network calls.
const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const detail=app.slice(app.indexOf('function renderLineageDetail('),
  app.indexOf('function renderWorkDetail('));
const sha='a'.repeat(40),ref='b'.repeat(40);
const e={
 issue:6,pr_number:7,pr_head_sha:sha,role:'developer',agent_id:'dev-cursor-01',
 run_id:21,attempt:2,action_id:'c'.repeat(64),slice_id:null,
 origin:{
   repository:'BestNathan/nession',source_ref_sha:ref,producer_run_id:21,
   producer_attempt:2,result_digest:'d'.repeat(64),writer_receipt_digest:'e'.repeat(64),
   source_url:'https://github.com/BestNathan/nession/actions/runs/21',
 },verification:'authenticated_at_attestation',
};
const projection=(attested)=>validateLineageProjection(projectLineage({
 issueNumbers:[6],pulls:[{number:7,head_sha:sha}],attested,
}));
test('both Work detail routes use the identical exact-source lineage panel',()=>{
 assert.match(app,/function renderLineageDetail\(kind, number\)/);
 assert.match(app,/renderLineageDetail\(kind,number\);/);
 assert.match(detail,/kind==='issue'\?e\.issue===number:e\.pr_number===number/);
 assert.match(detail,/source\?\.edges/);
 assert.match(detail,/e\.run_id.*e\.attempt/);
 assert.match(detail,/e\.source_url/);
 assert.match(detail,/e\.source_ref_sha/);
 assert.match(detail,/Logical Slice: Unlinked/);
 assert.match(detail,/Acceptance SC: Unknown/);
 assert.match(detail,/historical PR HEAD/);
 assert.match(detail,/Lineage window is truncated/);
 assert.doesNotMatch(detail,/innerHTML|\bfetch\(|\bXMLHttpRequest\b|cross.reference|agent_run_source/);
 assert.ok(app.includes("if (parsed.protocol === 'https:' && parsed.hostname === 'github.com')"));
});
test('missing producer remains explicitly Unlinked and no edge is inferred',()=>{
 const absent=validateProjection(makeProjection({}));
 assert.equal(absent.work.lineage.status,'unavailable');
 assert.deepEqual(absent.work.lineage.edges,[]);
 assert.match(detail,/Authenticated Producer and Publisher source unavailable/);
 assert.match(detail,/Unknown \/ Unlinked/);
 assert.match(detail,/No matching authenticated edges in this bounded source window/);
});
test('a candidate historical edge cannot become current proof after PR HEAD drift',()=>{
 const attested={status:'verified',source_ref_sha:ref,records:[e]};
 const valid=projection(attested);
 assert.equal(valid.edges.length,1);
 assert.equal(valid.edges[0].run_id,21);
 assert.equal(valid.edges[0].attempt,2);
 assert.equal(valid.edges[0].slice_id,null);
 const moved=projectLineage({issueNumbers:[6],
   pulls:[{number:7,head_sha:'f'.repeat(40)}],attested});
 assert.equal(moved.edges.length,0);
 const fake=projectLineage({issueNumbers:[6],
   pulls:[{number:7,head_sha:sha}],
   attested:{...attested,records:[{...e,origin:{...e.origin,producer_run_id:72}}]}});
 assert.equal(fake.status,'unavailable');
 assert.match(detail,/does not prove current HEAD, merge approval/);
});
