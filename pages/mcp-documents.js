// Public source-generated MCP Documents. No runtime MCP calls, credentials,
// dynamic HTML or copied Tool definitions.
const REPO='https://github.com/BestNathan/nession';
const UPSTREAM='https://github.com/modelcontextprotocol/modelcontextprotocol';
const NAME=/^[a-z][a-z0-9_]{1,127}$/;
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const state={query:''};
function el(tag,value='',cls=''){
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  node.textContent=value;
  return node;
}
function link(value,href,cls='',external=false){
  const node=el('a',value,cls);
  node.href=href;
  if(external){node.target='_blank';node.rel='noopener noreferrer';}
  return node;
}
export function validMcpSnapshot(data){
  const stable=data?.upstream?.stable;
  return data?.schema_version===1&&data?.status==='available'&&
    DIGEST.test(data.semantic_sha256||'')&&
    data.source?.repository==='BestNathan/nession'&&data.source?.branch==='main'&&
    SHA.test(data.source?.sha||'')&&
    Array.isArray(data.protocol_versions)&&data.protocol_versions.length>0&&
    data.protocol_versions.every(v=>/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v))&&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(stable?.version||'')&&
    SHA.test(stable?.sha||'')&&DIGEST.test(stable?.changelog_sha256||'')&&
    stable.release_url===UPSTREAM+'/releases/tag/'+stable.version&&
    stable.source_url===UPSTREAM+'/blob/'+stable.sha+
      '/docs/specification/'+stable.version+'/changelog.mdx'&&
    Array.isArray(stable.highlights)&&stable.highlights.length<=6&&
    stable.highlights.every(h=>typeof h==='string'&&h.length<=300)&&
    Array.isArray(data.tools)&&data.tools.length>0&&data.tools.length<=256&&
    new Set(data.tools.map(t=>t.name)).size===data.tools.length&&
    data.tools.every(t=>NAME.test(t?.name||'')&&
      typeof t.description==='string'&&t.description.length<=4000&&
      t.inputSchema?.type==='object'&&JSON.stringify(t.inputSchema).length<=50000);
}
export function mcpToolRoute(hash){
  const raw=String(hash||'').replace(/^#/,'');
  if(!/^\/documents\/mcp(?:\?|$)/.test(raw))return null;
  const query=raw.split('?')[1]||'';
  const params=new URLSearchParams(query);
  if([...params.keys()].some(k=>k!=='tool')||params.getAll('tool').length>1)
    return {name:null,invalid:true};
  const name=params.get('tool');
  return {name,invalid:name!==null&&!NAME.test(name)};
}
export function renderMcpDocuments(root,data,hash='#/documents/mcp'){
  root.append(el('div','NESSION / OPEN ENGINEERING / DOCUMENTS / MCP','eyebrow'),
    el('h1','MCP Tools','documents-heading'),
    el('p','Current Nession MCP Tools from its registered Rust handlers, alongside the independently verified upstream stable specification. Source snapshots are read-only; upstream features are not automatically Nession capabilities.','documents-lede'),
    link('← Protocol reference','#/documents','documents-mcp-back'));
  if(!validMcpSnapshot(data)){
    root.append(el('p','MCP catalog unavailable or unverified. Previous support cannot be inferred from a failed source check.','documents-unavailable'));
    return;
  }
  const stable=data.upstream.stable;
  const upstream=el('section','','documents-mcp-upstream panel');
  upstream.append(el('div','OFFICIAL SPECIFICATION / STABLE','eyebrow'),
    el('h2','MCP '+stable.version),
    el('p','Previous revision: '+(stable.previous_version||'Unknown')+
      ' · Nession advertises: '+data.protocol_versions.join(', ')));
  upstream.append(link('Official stable release ↗',stable.release_url,'documents-source',true),
    link('Pinned changelog ↗',stable.source_url,'documents-source',true));
  if(stable.highlights.length){
    const h=el('h3','Major changes in this upstream release');
    const list=el('ul','','documents-mcp-highlights');
    for(const item of stable.highlights)list.append(el('li',item));
    upstream.append(h,list);
  }
  root.append(upstream);
  const meta=el('div','','documents-snapshot mono');
  meta.append(el('span','NESSION MCP / PINNED SOURCE'),
    el('strong',data.source.sha.slice(0,12)),
    el('span',data.tools.length+' registered Tools'));
  meta.append(link('Rust registry ↗',REPO+'/blob/'+data.source.sha+
    '/crates/nession-mcp/src/tools/mod.rs','documents-source',true));
  root.append(meta);
  const route=mcpToolRoute(hash)||{name:null,invalid:false};
  const selected=!route.invalid&&(route.name?
    data.tools.find(t=>t.name===route.name):data.tools[0]);
  const layout=el('div','','documents-mcp-layout');
  const aside=el('aside','','documents-mcp-side');
  const search=el('input','','documents-search');
  search.type='search';
  search.placeholder='Search MCP Tools or fields';
  search.setAttribute('aria-label','Search MCP Tools');
  search.value=state.query;
  const counter=el('p','','documents-count mono');
  const results=el('div','','documents-results');
  aside.append(search,counter,results);
  function repaint(){
    results.replaceChildren();
    const q=state.query.trim().toLocaleLowerCase();
    const found=data.tools.filter(t=>!q||[
      t.name,t.description,JSON.stringify(t.inputSchema)].join(' ').toLocaleLowerCase().includes(q));
    counter.textContent=found.length+' / '+data.tools.length+' REGISTERED TOOLS';
    for(const tool of found){
      const a=link(tool.name,'#/documents/mcp?tool='+encodeURIComponent(tool.name),
        'documents-entry'+(selected?.name===tool.name?' selected':''));
      if(selected?.name===tool.name)a.setAttribute('aria-current','page');
      a.append(el('span',tool.name.startsWith('nession_server_')?'Server':
        tool.name.startsWith('nession_agent_')?'Agent':'Tool','eyebrow'));
      results.append(a);
    }
    if(!found.length)results.append(el('p','No matching MCP Tools.','documents-empty'));
  }
  search.addEventListener('input',()=>{state.query=search.value;repaint();});
  repaint();
  const right=el('article','','documents-mcp-reader documents-reader');
  if(!selected){
    right.append(el('h2','Unknown MCP Tool'),
      el('p','This Tool is not registered in the pinned catalog.'));
  }else{
    right.append(el('div','REGISTERED TOOL / INPUT CONTRACT','eyebrow'),
      el('h2',selected.name),el('p',selected.description));
    const details=el('details','','documents-raw');
    details.append(el('summary','Input JSON Schema'));
    const pre=el('pre');pre.append(el('code',JSON.stringify(selected.inputSchema,null,2)));
    details.append(pre);right.append(details);
    right.append(link('View pinned Tool source ↗',
      REPO+'/blob/'+data.source.sha+'/crates/nession-mcp/src/tools/'+selected.name+'.rs',
      'documents-source',true));
  }
  layout.append(aside,right);
  root.append(layout);
}
