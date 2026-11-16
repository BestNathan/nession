import test from 'node:test';
import assert from 'node:assert/strict';
import {validLegacyMcpPublicationV1,validMcpPublication,reconcileMcpPublication}
  from '../scripts/mcp-reconcile.mjs';
import {legacyMcpSemanticDigestV1} from '../scripts/mcp-semantic.mjs';
const SHA1='a'.repeat(40),SHA2='b'.repeat(40);
const stable={version:'2026-07-28',sha:'c'.repeat(40),changelog_blob_sha:'d'.repeat(40),changelog_sha256:'e'.repeat(64),
  release_url:'https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28',
  source_url:'https://github.com/modelcontextprotocol/modelcontextprotocol/blob/'+'c'.repeat(40)+'/docs/specification/2026-07-28/changelog.mdx',
  previous_version:'2025-11-25',highlights:['Stateless core']};
const outputSchema={type:'object',required:['agents'],properties:{
  agents:{type:'array',description:'Registered Agents'}}};
const tool={name:'nession_server_list_agents',description:'List Agents',
  inputSchema:{type:'object',properties:{}},outputSchema};
const catalog={
  schema_version:2,
  protocol_versions:['2025-03-26','2026-07-28'],
  upstream:{stable},
  tools:[tool],
};
test('first publication is a source-pinned bootstrap, identical repeated builds are no-ops',()=>{
  const initial=reconcileMcpPublication({catalog,mainSha:SHA1});
  assert.equal(initial.changed,true);
  assert.equal(initial.reason,'bootstrap');
  assert.equal(initial.document.schema_version,2);
  assert.equal(validMcpPublication(initial.document),true);
  const repeat=reconcileMcpPublication({catalog,mainSha:SHA2,previous:initial.document});
  assert.equal(repeat.changed,false);
  assert.equal(repeat.document,initial.document);
  assert.equal(repeat.document.source.sha,SHA1);
  assert.equal(JSON.stringify(repeat.document),JSON.stringify(initial.document));
});
test('semantic change publishes new exact source revision',()=>{
  const old=reconcileMcpPublication({catalog,mainSha:SHA1}).document;
  const changed={...catalog,tools:[{...tool,description:'New list semantics'}]};
  const result=reconcileMcpPublication({catalog:changed,mainSha:SHA2,previous:old});
  assert.equal(result.changed,true);
  assert.equal(result.reason,'semantic_change');
  assert.equal(result.document.source.sha,SHA2);
  assert.notEqual(result.document.semantic_sha256,old.semantic_sha256);
});
test('an output contract change is a semantic change',()=>{
  const old=reconcileMcpPublication({catalog,mainSha:SHA1}).document;
  const changed={...catalog,tools:[{...tool,outputSchema:{
    type:'object',required:['agents'],properties:{
      agents:{type:'array',description:'Registered Agents now listed by status'}}}}]};
  const result=reconcileMcpPublication({catalog:changed,mainSha:SHA2,previous:old});
  assert.equal(result.changed,true);
  assert.notEqual(result.document.semantic_sha256,old.semantic_sha256);
});
test('a structurally valid pre-#3735 publication migrates by rebuilding',()=>{
  const legacyTool={name:tool.name,description:tool.description,inputSchema:tool.inputSchema};
  const legacy={schema_version:1,status:'available',
    protocol_versions:catalog.protocol_versions,upstream:{stable},
    tools:[legacyTool],source:{repository:'BestNathan/nession',branch:'main',sha:SHA1},
    semantic_sha256:legacyMcpSemanticDigestV1({
      tools:[legacyTool],protocol_versions:catalog.protocol_versions,upstream:{stable}})};
  assert.equal(validLegacyMcpPublicationV1(legacy),true);
  assert.equal(validMcpPublication(legacy),false);
  const result=reconcileMcpPublication({catalog,mainSha:SHA2,previous:legacy});
  assert.equal(result.changed,true);
  assert.equal(result.reason,'schema_migration');
  assert.equal(result.document.schema_version,2);
  assert.equal(result.document.source.sha,SHA2);
  assert.equal(result.document.tools[0].outputSchema.type,'object');
  // The migration is a rebuild, never reuse of the legacy bytes.
  assert.equal(JSON.stringify(result.document)===JSON.stringify(legacy),false);
});
test('a malformed legacy publication cannot masquerade as migration state',()=>{
  const legacyTool={name:tool.name,description:tool.description,inputSchema:tool.inputSchema};
  const legacy={schema_version:1,status:'available',
    protocol_versions:catalog.protocol_versions,upstream:{stable},
    tools:[legacyTool],source:{repository:'BestNathan/nession',branch:'main',sha:SHA1},
    semantic_sha256:legacyMcpSemanticDigestV1({
      tools:[legacyTool],protocol_versions:catalog.protocol_versions,upstream:{stable}})};
  for(const previous of [
    {...legacy,semantic_sha256:'0'.repeat(64)},
    {...legacy,source:{...legacy.source,branch:'staging'}},
    {...legacy,tools:[]},
    {...legacy,tools:[{...legacyTool,name:'forged'}]},
  ]){
    assert.equal(validLegacyMcpPublicationV1(previous),false);
    assert.throws(()=>reconcileMcpPublication({catalog,mainSha:SHA2,previous}),/fail closed/);
  }
});
test('a placeholder output contract cannot be published',()=>{
  for(const broken of [
    {...catalog,tools:[{...tool,outputSchema:undefined}]},
    {...catalog,tools:[{...tool,outputSchema:{type:'object'}}]},
    {...catalog,tools:[{...tool,outputSchema:{type:'object',properties:{}}}]},
  ])assert.throws(()=>reconcileMcpPublication({catalog:broken,mainSha:SHA1}),
    /Invalid MCP Tool contract|Invalid generated MCP catalog/);
});
test('tampered digest, malformed data, and unknown source fail closed',()=>{
  const old=reconcileMcpPublication({catalog,mainSha:SHA1}).document;
  for(const previous of [
    {...old,semantic_sha256:'0'.repeat(64)},
    {...old,source:{...old.source,branch:'staging'}},
    {...old,tools:[{...tool,name:'forged'}]},
    {...old,protocol_versions:['not-a-date']},
    {...old,tools:[{...tool,outputSchema:{type:'object'}}]},
  ]){
    assert.equal(validMcpPublication(previous),false);
    assert.throws(()=>reconcileMcpPublication({catalog,mainSha:SHA2,previous}),/fail closed/);
  }
  assert.throws(()=>reconcileMcpPublication({catalog,mainSha:'main'}),/pinned/);
});
