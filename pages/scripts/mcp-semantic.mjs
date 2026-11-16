// Deterministic MCP catalog identity: semantic Tool definitions only.
// Source SHA and generated timestamps are deliberately excluded.
// #3735: both `inputSchema` and `outputSchema` are mandatory Nession Tool
// contracts and both contribute to the semantic identity.
import {createHash} from 'node:crypto';
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(
    Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
function validToolSchema(schema){
  return schema&&typeof schema==='object'&&!Array.isArray(schema)&&
    schema.type==='object'&&JSON.stringify(schema).length<=50000;
}
function toolIdentity(t){
  if(typeof t?.name!=='string'||!t.name||
    typeof t.description!=='string'||
    t.inputSchema?.type!=='object'||
    !validToolSchema(t.outputSchema)||
    !t.outputSchema.properties||typeof t.outputSchema.properties!=='object'||
    Array.isArray(t.outputSchema.properties)||
    Object.keys(t.outputSchema.properties).length===0)
    throw Error('Invalid MCP Tool contract');
  return {name:t.name,description:t.description,
    inputSchema:canonical(t.inputSchema),outputSchema:canonical(t.outputSchema)};
}
export function mcpSemanticDigest(catalog){
  if(!Array.isArray(catalog?.tools)||!catalog.tools.length)
    throw Error('Missing canonical MCP Tools');
  const names=new Set();
  const tools=catalog.tools.map(t=>{
    const identity=toolIdentity(t);
    if(names.has(identity.name))throw Error('Invalid or duplicate MCP Tool');
    names.add(identity.name);
    return identity;
  }).sort((a,b)=>a.name.localeCompare(b.name));
  const protocol_versions=[...(catalog.protocol_versions||[])].sort();
  // Official immutable stable release identity contributes to the same
  // source-derived manifest; preview drafts never count as stable changes.
  const stable=catalog.upstream?.stable;
  const upstream=stable?{
    version:stable.version,sha:stable.sha,
    changelog_sha256:stable.changelog_sha256
  }:null;
  const payload=JSON.stringify(canonical({tools,protocol_versions,upstream}));
  return createHash('sha256').update(payload).digest('hex');
}
// The pre-#3735 identity, kept only to validate a legacy published snapshot so
// the first strict publication can migrate it without trusting malformed bytes.
export function legacyMcpSemanticDigestV1(catalog){
  if(!Array.isArray(catalog?.tools)||!catalog.tools.length)
    throw Error('Missing canonical MCP Tools');
  const names=new Set();
  const tools=catalog.tools.map(t=>{
    if(typeof t?.name!=='string'||!t.name||
      typeof t.description!=='string'||t.inputSchema?.type!=='object'||
      names.has(t.name))throw Error('Invalid or duplicate MCP Tool');
    names.add(t.name);
    return {name:t.name,description:t.description,inputSchema:canonical(t.inputSchema)};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  const protocol_versions=[...(catalog.protocol_versions||[])].sort();
  const stable=catalog.upstream?.stable;
  const upstream=stable?{
    version:stable.version,sha:stable.sha,
    changelog_sha256:stable.changelog_sha256
  }:null;
  const payload=JSON.stringify(canonical({tools,protocol_versions,upstream}));
  return createHash('sha256').update(payload).digest('hex');
}
export function mcpChanged(previous,next){
  return previous!==next;
}
