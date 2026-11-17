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
  return data?.schema_version===2&&data?.status==='available'&&
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
      t.inputSchema?.type==='object'&&JSON.stringify(t.inputSchema).length<=50000&&
      t.outputSchema?.type==='object'&&!Array.isArray(t.outputSchema)&&
      t.outputSchema.properties&&typeof t.outputSchema.properties==='object'&&
      !Array.isArray(t.outputSchema.properties)&&
      Object.keys(t.outputSchema.properties).length>0&&
      JSON.stringify(t.outputSchema).length<=50000);
}
// A bounded, read-only renderer for public JSON Schema. Only local refs resolve;
// ambiguous unions remain explicit rather than invented field contracts.
const MAX_FIELDS=160;
const MAX_DEPTH=9;
const has=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
function localSchemaRef(root,ref){
  if(typeof ref!=='string'||!/^#\/(?:\$defs|definitions)\//.test(ref))return null;
  let value=root;
  for(const segment of ref.slice(2).split('/')){
    const key=segment.replace(/~1/g,'/').replace(/~0/g,'~');
    if(!value||typeof value!=='object'||!has(value,key))return null;
    value=value[key];
  }
  return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
}
function deref(root,node,refs){
  let item=node;
  const trail=new Set(refs);
  let depth=0;
  while(item&&typeof item==='object'&&typeof item.$ref==='string'&&depth++<MAX_DEPTH){
    const ref=item.$ref;
    if(trail.has(ref))return {node:item,refs:trail,unresolved:true};
    const resolved=localSchemaRef(root,ref);
    if(!resolved)return {node:item,refs:trail,unresolved:true};
    trail.add(ref);
    const overlay={...item};
    delete overlay.$ref;
    item={...resolved,...overlay};
  }
  return {node:item,refs:trail,unresolved:false};
}
function fieldType(root,node,refs=new Set(),depth=0){
  if(!node||typeof node!=='object')return 'unknown';
  if(depth>MAX_DEPTH)return 'recursive';
  const resolved=deref(root,node,refs);
  if(resolved.unresolved)return 'unresolved reference';
  const item=resolved.node;
  const explicit=Array.isArray(item.type)?item.type.join(' | '):item.type;
  if(typeof explicit==='string')return explicit;
  for(const key of ['anyOf','oneOf']){
    if(Array.isArray(item[key])){
      const types=[...new Set(item[key].slice(0,20).map(v=>
        fieldType(root,v,resolved.refs,depth+1)))];
      return types.join(' | ')||'union';
    }
  }
  if(Array.isArray(item.enum))return 'enum';
  if(item.properties&&typeof item.properties==='object')return 'object';
  return 'unknown';
}
export function mcpSchemaFields(schema){
  if(!schema||typeof schema!=='object'||Array.isArray(schema))return [];
  const fields=[];
  function walk(node,prefix='',depth=0,refs=new Set()){
    if(depth>MAX_DEPTH||fields.length>=MAX_FIELDS)return;
    const parsed=deref(schema,node,refs);
    if(parsed.unresolved)return;
    const item=parsed.node;
    const props=item?.properties;
    if(props&&typeof props==='object'&&!Array.isArray(props)){
      const required=new Set(Array.isArray(item.required)?item.required:[]);
      for(const [name,property] of Object.entries(props)){
        if(fields.length>=MAX_FIELDS)break;
        if(!property||typeof property!=='object'||name.length>128)continue;
        const path=prefix?prefix+'.'+name:name;
        if(path.length>240)continue;
        const p=deref(schema,property,parsed.refs);
        const resolved=p.node;
        const desc=(typeof property.description==='string'?property.description:
          typeof resolved?.description==='string'?resolved.description:'').slice(0,2500);
        const type=fieldType(schema,property,parsed.refs);
        const values=Array.isArray(resolved?.enum)&&resolved.enum.length<=16
          ?resolved.enum.map(x=>JSON.stringify(x)).join(', ').slice(0,500):'';
        fields.push({path,type,required:required.has(name),description:desc,values});
        if(!p.unresolved){
          walk(resolved,path,depth+1,p.refs);
          if(resolved?.items&&typeof resolved.items==='object')
            walk(resolved.items,path+'[]',depth+1,p.refs);
        }
      }
    }else if(!prefix&&item?.items&&typeof item.items==='object'){
      walk(item.items,'[]',depth+1,parsed.refs);
    }
  }
  walk(schema);
  return fields;
}
function renderFields(schema,kind){
  const section=el('section','','documents-mcp-contract');
  const heading=el('div','','documents-mcp-section-head');
  heading.append(el('h3',kind+' fields'),
    el('span',kind==='Input'?'Registered parameters':'Declared structured result','documents-mcp-section-note'));
  section.append(heading);
  if(!schema){
    section.append(el('p','No structured output schema is declared by this Nession Tool. Output field names, types and meanings cannot yet be verified from the Tool registry.','documents-mcp-missing'));
    return section;
  }
  const fields=mcpSchemaFields(schema);
  if(!fields.length){
    section.append(el('p',kind==='Input'
      ?'This Tool declares no named input parameters.'
      :'This output schema has no named object fields. Inspect the raw schema for its exact shape.',
    'documents-mcp-missing'));
  }else{
    const list=el('div','','documents-mcp-fields');
    for(const field of fields){
      const row=el('div','','documents-mcp-field');
      const meta=el('div','','documents-mcp-field-meta');
      meta.append(el('code',field.path,'documents-mcp-field-name'),
        el('span',field.type,'documents-mcp-type'));
      meta.append(el('span',field.required?'Required':'Optional',
        'documents-mcp-required'+(field.required?' is-required':'')));
      row.append(meta,
        el('p',field.description||'Description not declared in the source JSON Schema.','documents-mcp-field-description'));
      if(field.values)row.append(el('p','Allowed: '+field.values,'documents-mcp-values'));
      list.append(row);
    }
    section.append(list);
  }
  const raw=el('details','','documents-raw documents-mcp-raw');
  raw.append(el('summary',kind+' JSON Schema'));
  const pre=el('pre');
  pre.append(el('code',JSON.stringify(schema,null,2)));
  raw.append(pre);
  section.append(raw);
  return section;
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
  const crumb=el('nav','','documents-breadcrumb');
  crumb.setAttribute('aria-label','Documents breadcrumb');
  crumb.append(link('Documents','#/documents'),el('span',' / MCP'));
  root.append(crumb,
    el('h1','MCP Tools','documents-heading'),
    el('p','Canonical Nession MCP Tool contracts and independently pinned official upstream specifications.','documents-lede'));
  if(!validMcpSnapshot(data)){
    root.append(el('p','MCP catalog unavailable or unverified. Previous support cannot be inferred from a failed source check.','documents-unavailable'));
    return;
  }
  const route=mcpToolRoute(hash)||{name:null,invalid:false};
  const selected=!route.invalid&&(route.name?
    data.tools.find(t=>t.name===route.name):data.tools[0]);
  const exact=route.name!==null||route.invalid;
  const layout=el('div','','documents-mcp-layout documents-workspace'+(exact?' reading':''));
  layout.dataset.section='mcp';
  const aside=el('aside','','documents-mcp-side documents-browser-pane');
  aside.setAttribute('aria-label','MCP Tool catalog');
  const controls=el('div','','documents-browser-controls');
  const search=el('input','','documents-search');
  search.type='search';search.placeholder='Search MCP Tools or fields';
  search.setAttribute('aria-label','Search MCP Tools');
  search.value=state.query;
  const counter=el('p','','documents-count mono');
  controls.append(el('div','MCP TOOL REGISTRY','eyebrow'),search,counter);
  const results=el('div','','documents-results documents-list-scroll');
  results.setAttribute('role','region');
  results.setAttribute('aria-label','MCP Tool list');
  results.tabIndex=0;
  aside.append(controls,results);
  function repaint(){
    results.replaceChildren();
    const q=state.query.trim().toLocaleLowerCase();
    const found=data.tools.filter(t=>!q||[
      t.name,t.description,JSON.stringify(t.inputSchema),
      JSON.stringify(t.outputSchema)].join(' ').toLocaleLowerCase().includes(q));
    counter.textContent=found.length+' / '+data.tools.length+' REGISTERED TOOLS';
    for(const tool of found){
      const a=link('', '#/documents/mcp?tool='+encodeURIComponent(tool.name),
        'documents-entry'+(selected?.name===tool.name?' selected':''));
      a.append(el('strong',tool.name),
        el('span',tool.name.startsWith('nession_server_')?'Server':
          tool.name.startsWith('nession_agent_')?'Agent':'Tool','eyebrow'));
      if(selected?.name===tool.name)a.setAttribute('aria-current','page');
      results.append(a);
    }
    if(!found.length)results.append(el('p','No matching MCP Tools.','documents-empty'));
  }
  search.addEventListener('input',()=>{state.query=search.value;repaint();});
  repaint();
  const slot=el('section','','documents-reader-slot');
  slot.setAttribute('role','region');
  slot.setAttribute('aria-label','MCP Tool details');
  slot.tabIndex=0;
  const right=el('article','','documents-mcp-reader documents-reader');
  right.append(link('← All MCP Tools','#/documents/mcp','documents-back'));
  const detail=el('div','','documents-mcp-tool-detail');
  if(!selected){
    detail.append(el('h2','Unknown MCP Tool'),
      el('p','This Tool is not registered in the pinned catalog.'));
  }else{
    detail.append(el('div','REGISTERED MCP TOOL','eyebrow'),
      el('h2',selected.name),
      el('p',selected.description,'documents-mcp-method-description'));
    const compact=el('div','','documents-mcp-inline-meta mono');
    compact.append(el('span','Nession MCP · '+data.protocol_versions.join(', ')),
      link('Pinned Tool source ↗',REPO+'/blob/'+data.source.sha+
        '/crates/nession-mcp/src/tools/'+selected.name+'.rs','documents-source',true));
    detail.append(compact);
    detail.append(renderFields(selected.inputSchema,'Input'),
      renderFields(selected.outputSchema,'Output'));
  }
  right.append(detail);
  const stable=data.upstream.stable;
  const spec=el('details','','documents-mcp-spec');
  spec.append(el('summary','Protocol & provenance · MCP '+stable.version));
  const info=el('div','','documents-mcp-spec-content');
  info.append(el('p','Official stable MCP '+stable.version+
    ' · previous '+(stable.previous_version||'not verified')+
    ' · Nession supports '+data.protocol_versions.join(', ')));
  const refs=el('div','','documents-mcp-spec-links');
  refs.append(link('Official stable release ↗',stable.release_url,'documents-source',true),
    link('Pinned changelog ↗',stable.source_url,'documents-source',true),
    link('Rust registry ↗',REPO+'/blob/'+data.source.sha+
      '/crates/nession-mcp/src/tools/mod.rs','documents-source',true));
  info.append(refs,el('p','Published source '+data.source.sha.slice(0,12)+' · '+
    data.tools.length+' registered Tools','documents-mcp-spec-source'));
  if(stable.highlights.length){
    const list=el('ul','','documents-mcp-highlights');
    for(const item of stable.highlights)list.append(el('li',item));
    info.append(el('h4','Official stable revision highlights'),list);
  }
  spec.append(info);right.append(spec);slot.append(right);
  layout.append(aside,slot);
  root.append(layout);
}
