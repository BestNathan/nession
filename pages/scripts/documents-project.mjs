// The public Documents catalog is curated at the Pages build boundary.
// These are current first-party technical sources, never an arbitrary directory scan.
import {readFile, lstat} from 'node:fs/promises';
import {join} from 'node:path';

const SHA=/^[a-f0-9]{40}$/;
const GH='https://github.com/BestNathan/nession';
export const DOCUMENT_CATALOG=Object.freeze([
  {path:'docs/architecture/protocol.md',title:'Protocol Architecture',category:'Protocols',
    description:'Protocol Units, Kernel, wire envelopes, manifests and version negotiation.'},
  {path:'docs/architecture/protocol-identity.md',title:'Protocol Identity',category:'Protocols',
    description:'Canonical naming and semantic ownership of protocol operations.'},
  {path:'docs/architecture/mcp.md',title:'MCP Access Layer',category:'Interfaces',
    description:'MCP tools, Server / Agent boundaries, hosting and authentication.'},
  {path:'docs/architecture/terminal-engine.md',title:'Terminal Engine',category:'Runtime',
    description:'Terminal controller, transport, rendering and ownership boundaries.'},
  {path:'docs/architecture/agent-tmux-control-transport.md',title:'Agent / tmux Transport',category:'Runtime',
    description:'Control-mode transport architecture for persistent terminal sessions.'},
  {path:'docs/architecture/agent-process-discovery.md',title:'Agent Process Discovery',category:'Runtime',
    description:'How agent processes are discovered and represented.'},
  {path:'docs/architecture/session-env-binding.md',title:'Session ENV Binding',category:'Runtime',
    description:'Environment binding and its session lifecycle boundaries.'},
  {path:'docs/architecture/ai-conversation.md',title:'AI Conversation Architecture',category:'Workspace',
    description:'Conversation models and structured UI architecture.'},
]);

export function unavailableDocuments(generatedAt){
  return {schema_version:1,status:'unavailable',generated_at:generatedAt,
    source:null,documents:[]};
}
export function validPublicDocuments(data){
  if(data?.schema_version!==1||!['available','unavailable'].includes(data.status)||
    !Array.isArray(data.documents)||data.documents.length>DOCUMENT_CATALOG.length)return false;
  if(data.status==='unavailable')return data.source===null&&data.documents.length===0;
  if(data.source?.branch!=='main'||data.source?.repository!=='BestNathan/nession'||
    !SHA.test(data.source.sha||'')||data.documents.length!==DOCUMENT_CATALOG.length)return false;
  return data.documents.every((doc,index)=>{
    const expected=DOCUMENT_CATALOG[index];
    return doc?.path===expected.path&&doc.title===expected.title&&
      doc.category===expected.category&&doc.description===expected.description&&
      typeof doc.body==='string'&&doc.body.length>0&&doc.body.length<=160000&&
      doc.source===GH+'/blob/'+data.source.sha+'/'+expected.path;
  });
}
export async function loadDocuments({directory,sha,generatedAt}){
  // Offline and incomplete source snapshots are explicit, never presented as an
  // empty or current documentation set.
  if(!SHA.test(sha||''))return unavailableDocuments(generatedAt);
  const documents=await Promise.all(DOCUMENT_CATALOG.map(async entry=>{
    const path=join(directory,entry.path);
    const stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>160000)
      throw Error('Unsafe public Documents source: '+entry.path);
    const body=await readFile(path,'utf8');
    if(!body.trim()||body.length>160000||body.includes('\0'))
      throw Error('Invalid public Documents source: '+entry.path);
    return {...entry,body,source:GH+'/blob/'+sha+'/'+entry.path};
  }));
  const projection={schema_version:1,status:'available',generated_at:generatedAt,
    source:{repository:'BestNathan/nession',branch:'main',sha},documents};
  if(!validPublicDocuments(projection))throw Error('Invalid public Documents projection');
  return projection;
}
