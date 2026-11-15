// Public, source-generated MCP catalog. No runtime MCP calls or credentials.
const REPO='https://github.com/BestNathan/nession';
function el(tag,text='',cls=''){
  const node=document.createElement(tag);
  node.className=cls;
  node.textContent=text;
  return node;
}
export function validMcpSnapshot(data){
  return data?.schema_version===1&&data?.status==='available'&&
    /^[a-f0-9]{64}$/.test(data.semantic_sha256||'')&&
    data.source?.repository==='BestNathan/nession'&&data.source?.branch==='main'&&
    /^[a-f0-9]{40}$/.test(data.source?.sha||'')&&
    Array.isArray(data.tools)&&data.tools.length>0&&data.tools.length<=256&&
    new Set(data.tools.map(t=>t.name)).size===data.tools.length&&
    data.tools.every(t=>/^[a-z][a-z0-9_]{1,127}$/.test(t?.name||'')&&
      typeof t.description==='string'&&t.description.length<=4000&&
      t.inputSchema?.type==='object'&&
      JSON.stringify(t.inputSchema).length<=50000);
}
export function renderMcpDocuments(root,data){
  root.append(el('div','NESSION / DOCUMENTS / MCP','eyebrow'),
    el('h1','MCP Tools','documents-heading'),
    el('p','Current MCP capabilities exported from the registered Rust Tool handlers at a pinned Nession main revision. This is a source catalog, not a live endpoint.','documents-lede'));
  const back=el('a','← Protocol reference','documents-mcp-back');
  back.href='#/documents';root.append(back);
  if(!validMcpSnapshot(data)){
    root.append(el('p','MCP catalog unavailable; no supported Tool count can be inferred.','documents-unavailable'));
    return;
  }
  const source=el('a','View pinned MCP registry ↗','documents-source');
  source.href=REPO+'/blob/'+data.source.sha+'/crates/nession-mcp/src/tools/mod.rs';
  source.target='_blank';source.rel='noopener noreferrer';
  root.append(el('p',data.tools.length+' registered Tools · main '+data.source.sha.slice(0,12),'documents-release-note'),source);
  const list=el('div','','documents-layout');
  for(const tool of data.tools){
    const section=el('section','','panel');
    section.append(el('h2',tool.name),el('p',tool.description));
    const details=el('details','','documents-raw');
    details.append(el('summary','Input JSON Schema'));
    const pre=el('pre');pre.append(el('code',JSON.stringify(tool.inputSchema,null,2)));
    details.append(pre);section.append(details);list.append(section);
  }
  root.append(list);
}
