// Canonical, deterministic MCP publication reconciliation (#3624).
// The last published projection is an untrusted input: validate it before
// preserving its exact bytes, and never advance a cursor on malformed input.
import {mcpSemanticDigest} from './mcp-semantic.mjs';
const SHA=/^[a-f0-9]{40}$/;
const VERSION=/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const REPO='BestNathan/nession';
const NAME=/^[a-z][a-z0-9_]{1,127}$/;

export function validMcpPublication(data){
  if(data?.schema_version!==1||data.status!=='available'||
     data.source?.repository!==REPO||data.source?.branch!=='main'||
     !SHA.test(data.source?.sha||'')||!DIGEST.test(data.semantic_sha256||'')||
     !Array.isArray(data.tools)||data.tools.length<1||data.tools.length>256||
     !Array.isArray(data.protocol_versions)||data.protocol_versions.length>20||
     !data.protocol_versions.every(v=>/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)))return false;
  const upstream=data.upstream?.stable;
  if(!upstream||!VERSION.test(upstream.version||'')||
     !SHA.test(upstream.sha||'')||!DIGEST.test(upstream.changelog_sha256||'')||
     !SHA.test(upstream.changelog_blob_sha||'')||
     ![null,undefined].includes(upstream.previous_version)&&
       !VERSION.test(upstream.previous_version)||
     !Array.isArray(upstream.highlights)||upstream.highlights.length>6||
     !upstream.highlights.every(s=>typeof s==='string'&&s.length<=300)||
     upstream.release_url!=='https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/'+upstream.version||
     upstream.source_url!=='https://github.com/modelcontextprotocol/modelcontextprotocol/blob/'+upstream.sha+
       '/docs/specification/'+upstream.version+'/changelog.mdx')
    return false;
  const names=new Set();
  for(const t of data.tools){
    if(!NAME.test(t?.name||'')||names.has(t.name)||
       typeof t.description!=='string'||t.description.length>4000||
       t.inputSchema?.type!=='object'||JSON.stringify(t.inputSchema).length>50000)
      return false;
    names.add(t.name);
  }
  return mcpSemanticDigest(data)===data.semantic_sha256;
}
export function reconcileMcpPublication({catalog,mainSha,previous=null}){
  if(!SHA.test(mainSha||''))throw Error('MCP publication requires pinned main SHA');
  const digest=mcpSemanticDigest(catalog);
  const fresh={
    schema_version:1,status:'available',tools:catalog.tools,
    protocol_versions:catalog.protocol_versions,
    upstream:catalog.upstream,
    semantic_sha256:digest,
    source:{repository:REPO,branch:'main',sha:mainSha}
  };
  if(!validMcpPublication(fresh))throw Error('Invalid generated MCP catalog');
  if(previous!==null){
    if(!validMcpPublication(previous))
      throw Error('Published MCP catalog is malformed: fail closed, no cursor advancement');
    if(previous.semantic_sha256===digest)
      return {document:previous,changed:false,reason:'unchanged'};
  }
  return {document:fresh,changed:true,reason:previous===null?'bootstrap':'semantic_change'};
}
