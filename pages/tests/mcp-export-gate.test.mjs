import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileMcpPublication} from '../scripts/mcp-reconcile.mjs';
import {canReusePublishedMcp,affectsMcpSource}
  from '../scripts/mcp-export-gate.mjs';

const oldSha='a'.repeat(40),newSha='b'.repeat(40);
const stable={
  version:'2026-07-28',sha:'c'.repeat(40),
  changelog_blob_sha:'d'.repeat(40),changelog_sha256:'e'.repeat(64),
  release_url:'https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28',
  source_url:'https://github.com/modelcontextprotocol/modelcontextprotocol/blob/'+'c'.repeat(40)+'/docs/specification/2026-07-28/changelog.mdx',
  previous_version:'2025-11-25',highlights:['Stateless core']
};
const previous=reconcileMcpPublication({
  catalog:{protocol_versions:['2025-03-26','2026-07-28'],
    upstream:{stable},
    tools:[{name:'nession_server_list_agents',description:'List agents',
      inputSchema:{type:'object',properties:{}},
      outputSchema:{type:'object',properties:{
        agents:{type:'array',description:'Registered Agents'}}}}]},mainSha:oldSha
}).document;
const compare={
  status:'ahead',ahead_by:5,total_commits:5,
  base_commit:{sha:oldSha},head_commit:{sha:newSha},
  files:[{filename:'README.md'},{filename:'docs/design/mcp.md'}]
};
const input={previous,stable,mainSha:newSha,comparison:compare};
test('unrelated bounded main changes skip MCP exporter and preserve prior source',()=>{
  assert.equal(canReusePublishedMcp(input),true);
  assert.equal(canReusePublishedMcp({...input,mainSha:oldSha,comparison:null}),true);
  assert.equal(previous.source.sha,oldSha);
});
test('all Tool, protocol, dependency and projection-owner edits demand reexport',()=>{
  for(const filename of [
    'crates/nession-mcp/src/tools/nession_server_list_agents.rs',
    'crates/nession-mcp/src/protocol.rs',
    'crates/nession-protocol/src/lib.rs','Cargo.lock','Cargo.toml',
    'rust-toolchain.toml','.cargo/config.toml','pages/scripts/build.mjs',
    'pages/scripts/build-data.mjs',
    'pages/scripts/mcp-semantic.mjs','pages/scripts/mcp-export-gate.mjs'
  ]){
    assert.equal(affectsMcpSource(filename),true,filename);
    assert.equal(canReusePublishedMcp({...input,
      comparison:{...compare,files:[{filename} ]}}),false,filename);
  }
  assert.equal(canReusePublishedMcp({...input,
    comparison:{...compare,files:[{
      filename:'docs/renamed.md',
      previous_filename:'crates/nession-mcp/src/tools/nession_agent_kill_session.rs'
    } ]}}),false);
});
test('changed stable official release, invalid previous data and unverifiable compare rebuild',()=>{
  for(const upstream of [
    {...stable,version:'2027-03-30'},
    {...stable,sha:'f'.repeat(40)},
    {...stable,changelog_sha256:'f'.repeat(64)}
  ])assert.equal(canReusePublishedMcp({...input,stable:upstream}),false);
  assert.equal(canReusePublishedMcp({...input,previous:{...previous,
    semantic_sha256:'0'.repeat(64)}}),false);
  for(const comparison of [
    null,{}, {...compare,status:'diverged'},
    {...compare,base_commit:{sha:newSha}},
    {...compare,head_commit:{sha:oldSha}},
    {...compare,total_commits:100},
    {...compare,total_commits:4},
    {...compare,ahead_by:100},
    {...compare,files:Array.from({length:300},(_,i)=>({filename:'docs/'+i+'.md'}))},
    {...compare,files:null},
    {...compare,files:[{filename:'doc.md',previous_filename:12}]}
  ])assert.equal(canReusePublishedMcp({...input,comparison}),false);
});
