// Deterministic MCP catalog identity: semantic Tool definitions only.
// Source SHA and generated timestamps are deliberately excluded.
import {createHash} from 'node:crypto';
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(
    Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export function mcpSemanticDigest(catalog){
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
export function mcpChanged(previous,next){
  return previous!==next;
}
