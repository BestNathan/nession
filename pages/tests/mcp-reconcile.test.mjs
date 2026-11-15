import test from 'node:test';
import assert from 'node:assert/strict';
import {validMcpPublication,reconcileMcpPublication}
  from '../scripts/mcp-reconcile.mjs';
const SHA1='a'.repeat(40),SHA2='b'.repeat(40);
const catalog={
  schema_version:1,
  protocol_versions:['2025-03-26','2026-07-28'],
  upstream:{stable:{version:'2026-07-28',sha:'c'.repeat(40),changelog_blob_sha:'d'.repeat(40),changelog_sha256:'e'.repeat(64),
    release_url:'https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28',
    source_url:'https://github.com/modelcontextprotocol/modelcontextprotocol/blob/'+'c'.repeat(40)+'/docs/specification/2026-07-28/changelog.mdx',
    previous_version:'2025-11-25',highlights:['Stateless core']}},
  tools:[{name:'nession_server_list_agents',description:'List Agents',
    inputSchema:{type:'object',properties:{}}}],
};
test('first publication is a source-pinned bootstrap, identical repeated builds are no-ops',()=>{
  const initial=reconcileMcpPublication({catalog,mainSha:SHA1});
  assert.equal(initial.changed,true);
  assert.equal(initial.reason,'bootstrap');
  assert.equal(validMcpPublication(initial.document),true);
  const repeat=reconcileMcpPublication({catalog,mainSha:SHA2,previous:initial.document});
  assert.equal(repeat.changed,false);
  assert.equal(repeat.document,initial.document);
  assert.equal(repeat.document.source.sha,SHA1);
  assert.equal(JSON.stringify(repeat.document),JSON.stringify(initial.document));
});
test('semantic change publishes new exact source revision',()=>{
  const old=reconcileMcpPublication({catalog,mainSha:SHA1}).document;
  const changed={...catalog,tools:[{...catalog.tools[0],description:'New list semantics'}]};
  const result=reconcileMcpPublication({catalog:changed,mainSha:SHA2,previous:old});
  assert.equal(result.changed,true);
  assert.equal(result.reason,'semantic_change');
  assert.equal(result.document.source.sha,SHA2);
  assert.notEqual(result.document.semantic_sha256,old.semantic_sha256);
});
test('tampered digest, malformed data, and unknown source fail closed',()=>{
  const old=reconcileMcpPublication({catalog,mainSha:SHA1}).document;
  for(const previous of [
    {...old,semantic_sha256:'0'.repeat(64)},
    {...old,source:{...old.source,branch:'staging'}},
    {...old,tools:[{...catalog.tools[0],name:'forged'}]},
    {...old,protocol_versions:['not-a-date']},
  ]){
    assert.equal(validMcpPublication(previous),false);
    assert.throws(()=>reconcileMcpPublication({catalog,mainSha:SHA2,previous}),/fail closed/);
  }
  assert.throws(()=>reconcileMcpPublication({catalog,mainSha:'main'}),/pinned/);
});
