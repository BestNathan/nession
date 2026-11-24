import test from 'node:test';
import assert from 'node:assert/strict';
import {mcpSchemaFields,mcpToolRoute} from '../src/features/documents/mcp/model.ts';
import {validMcpSnapshot} from '../src/data/validation.ts';
import {McpPage} from '../src/features/documents/mcp/McpPage.tsx';
import {UiStateProvider} from '../src/app/ui-state.tsx';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const SHA='a'.repeat(40);
const tool={name:'nession_agent_list_sessions',description:'List sessions',
  inputSchema:{type:'object',properties:{agent_id:{type:'string'}},required:['agent_id']},
  outputSchema:{type:'object',required:['sessions'],properties:{
    sessions:{type:'array',description:'The Agent live Sessions',items:{
      type:'object',properties:{name:{type:'string',description:'Session name'}}}},
    stale_agents:{type:'array',description:'Agents that did not answer'}}}};
const valid={schema_version:2,status:'available',semantic_sha256:'f'.repeat(64),protocol_versions:['2025-03-26','2026-07-28'],
  source:{repository:'BestNathan/nession',branch:'main',sha:SHA},upstream:{stable:{version:'2026-07-28',sha:'c'.repeat(40),changelog_blob_sha:'d'.repeat(40),changelog_sha256:'e'.repeat(64),
    release_url:'https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28',
    source_url:'https://github.com/modelcontextprotocol/modelcontextprotocol/blob/'+'c'.repeat(40)+'/docs/specification/2026-07-28/changelog.mdx',
    previous_version:'2025-11-25',highlights:['Stateless core']}},tools:[tool]};
test('MCP source-generated catalog accepts pinned registered Tool schemas',()=>{
  assert.equal(validMcpSnapshot(valid),true);
});
test('MCP catalog fails closed for missing, malformed and unpinned sources',()=>{
  assert.equal(validMcpSnapshot(null),false);
  assert.equal(validMcpSnapshot({...valid,source:{sha:'main'}}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[]}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[{...tool,inputSchema:{}}]}),false);
});

test('MCP field renderer exposes exact nested paths, required flags, local refs and descriptions',()=>{
  const schema={type:'object',required:['identity','options'],properties:{
    identity:{type:'string',description:'Exact node identity'},
    options:{$ref:'#/$defs/Options'},
    tags:{type:'array',description:'Labels',items:{$ref:'#/$defs/Tag'}}
  },$defs:{
    Options:{type:'object',description:'Execution preferences',required:['limit'],properties:{
      limit:{type:'integer',description:'Maximum returned sessions'},
      target:{anyOf:[{type:'string'},{type:'null'}],description:'Optional destination'} }},
    Tag:{type:'object',properties:{label:{type:'string',description:'Tag name'}}}
  }};
  const rows=mcpSchemaFields(schema);
  assert.deepEqual(rows.map(x=>x.path),[
    'identity','options','options.limit','options.target','tags','tags[].label']);
  assert.equal(rows.find(x=>x.path==='identity').required,true);
  assert.equal(rows.find(x=>x.path==='options.limit').required,true);
  assert.equal(rows.find(x=>x.path==='options.target').required,false);
  assert.equal(rows.find(x=>x.path==='options.target').type,'string | null');
  assert.equal(rows.find(x=>x.path==='tags[].label').description,'Tag name');
  assert.equal(rows.find(x=>x.path==='options.limit').description,'Maximum returned sessions');
});
test('MCP renderer rejects remote/missing references and bounds cyclic local references',()=>{
  const bad={type:'object',properties:{
    remote:{$ref:'https://example.com/private.json#/secret'},
    missing:{$ref:'#/$defs/DoesNotExist'},
    self:{$ref:'#/$defs/Cycle'}
  },$defs:{Cycle:{$ref:'#/$defs/Cycle'}}};
  const rows=mcpSchemaFields(bad);
  assert.equal(rows.length,3);
  assert.equal(rows.every(x=>x.type==='unresolved reference'),true);
  const huge={type:'object',properties:Object.fromEntries(
    Array.from({length:250},(_,i)=>['field'+i,{type:'string'}]))};
  assert.equal(mcpSchemaFields(huge).length,160);
  assert.deepEqual(mcpSchemaFields(null),[]);
});
test('outputSchema is mandatory, non-placeholder and never inferred from examples',()=>{
  assert.equal(validMcpSnapshot(valid),true);
  assert.equal(validMcpSnapshot({...valid,tools:[{...tool,outputSchema:undefined}]}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[{...tool,outputSchema:null}]}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[{...tool,outputSchema:'guess'}]}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[{...tool,outputSchema:{type:'object'}}]}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[{...tool,outputSchema:{
    type:'object',properties:{}}}]}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[{...tool,outputSchema:{type:'object',
    description:'x'.repeat(51000)}}]}),false);
  assert.equal(mcpSchemaFields(tool.outputSchema).map(x=>x.path).join(','),
    'sessions,sessions[].name,stale_agents');
  assert.equal(mcpSchemaFields({type:'object',properties:{
    sessions:{type:'array',description:'Returned sessions'}
  }})[0].description,'Returned sessions');
});
