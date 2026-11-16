// Protocol-only Documents UI. Every shape comes from the pinned Rust codegen
// JSON Schema; no hand-copied protocol fields or browser GitHub API calls.
const REPO='https://github.com/BestNathan/nession';
const ID=/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SHA=/^[a-f0-9]{40}$/;
const state={query:'',owner:'All'};
const el=(tag,cls='',value)=>{
  const n=document.createElement(tag);
  if(cls)n.className=cls;
  if(value!==undefined)n.textContent=String(value);
  return n;
};
const add=(parent,...items)=>{for(const item of items)if(item)parent.append(item);return parent;};
const local=(label,href,cls='')=>{const a=el('a',cls,label);a.href=href;return a;};
function external(label,href,cls=''){
  const a=local(label,href,cls);
  a.target='_blank';a.rel='noopener noreferrer';
  return a;
}
export function documentsHref(id,version){
  if(!ID.test(id||''))return '#/documents/protocol';
  return '#/documents/protocol?protocol='+encodeURIComponent(id)+
    (Number.isSafeInteger(version)&&version>0?'&v='+version:'');
}
export function documentsRoute(hash){
  const raw=String(hash||'').replace(/^#/,'');
  if(!/^\/documents(?:\/protocol)?(?:\?|$)/.test(raw))return null;
  const params=new URLSearchParams(raw.split('?')[1]||'');
  const id=params.get('protocol');
  const version=params.get('v');
  const validId=id===null||ID.test(id);
  const validVersion=version===null||/^[1-9][0-9]{0,3}$/.test(version);
  return {id:validId?id:null,version:validVersion&&version?Number(version):null,
    invalid:!validId||!validVersion};
}
export function validDocumentsSnapshot(data){
  if(data?.schema_version!==4||!['available','unavailable'].includes(data.status)||
    !Array.isArray(data.protocols)||data.protocols.length>400||
    !data.definitions||typeof data.definitions!=='object'||!Array.isArray(data.releases)||
    data.releases.length>30)return false;
  if(data.status==='unavailable')return data.source===null&&data.protocols.length===0;
  if(data.source?.repository!=='BestNathan/nession'||data.source?.branch!=='main'||
    !SHA.test(data.source.sha||'')||!data.protocols.length)return false;
  const ids=new Set();
  if(!data.releases.every(r=>/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(r?.version||'')&&
    r.tag==='v'+r.version&&['available','unavailable'].includes(r.status)))return false;
  return data.protocols.every(p=>{
    if(!ID.test(p?.id||'')||ids.has(p.id)||typeof p.owner!=='string'||
       !Array.isArray(p.versions)||!p.versions.length||p.versions.length>25||
       !Array.isArray(p.wires)||!p.wires.every(x=>typeof x==='string'))return false;
    ids.add(p.id);
    const versions=new Set();
    return p.versions.every(v=>{
      if(!Number.isSafeInteger(v.version)||v.version<1||versions.has(v.version))return false;
      versions.add(v.version);
      return ['request','response'].every(k=>v[k]===null||
        (v[k]&&typeof v[k].alias==='string'&&Array.isArray(v[k].fields)&&
          v[k].fields.length<=6000&&v[k].shape!==undefined&&
          v[k].fields.every(f=>typeof f.path==='string'&&typeof f.type==='string'&&
            ['verified','unknown','unreleased'].includes(f.since_status)&&
            (f.since_status==='verified'?
              /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(f.since||''):
              f.since===null))));
    });
  });
}
export function filterDocuments(items,{query='',owner='All'}={}){
  const term=query.trim().toLocaleLowerCase();
  return items.filter(p=>(owner==='All'||p.owner===owner)&&
    (!term||[p.id,p.owner,...p.versions.flatMap(v=>
      [v.request?.alias||'',v.response?.alias||'',
        ...v.request?.fields?.map(f=>f.path)||[],
        ...v.response?.fields?.map(f=>f.path)||[]])]
      .join(' ').toLocaleLowerCase().includes(term)));
}
function fieldTable(fields){
  const table=el('table','documents-field-table');
  const head=el('thead'),header=el('tr');
  for(const text of ['Field','Type','Required','Since Nession','Description']){
    header.append(el('th','',text));
  }
  head.append(header);table.append(head);
  const body=el('tbody');
  for(const f of fields){
    const row=el('tr');
    const label=f.variant?f.path+' ('+f.variant+')':f.path;
    const since=f.since_status==='verified'&&f.since?f.since:
      f.since_status==='unreleased'?'Unreleased':'Unknown';
    const sinceCell=el('td','documents-since '+(f.since_status||'unknown'),since);
    sinceCell.title=f.since_status==='verified'?
      'First verified as introduced in Nession '+f.since:
      f.since_status==='unreleased'?
      'Not present in the latest verified release; only present in main':
      'Historical Nession releases cannot establish the first supported version';
    add(row,el('td','documents-field-path',label),el('td','',f.type),
      el('td','',f.required?'Yes':'No'),sinceCell,
      el('td','documents-field-description',f.description||'—'));
    body.append(row);
  }
  table.append(body);return table;
}
function contractSection(selected,direction){
  const half=selected[direction];
  const section=el('section','documents-contract-section');
  const head=el('div','documents-contract-head');
  add(head,el('h3','',direction==='request'?'Request':'Response'),
    el('span','documents-alias mono',half?half.alias:'No response'));
  section.append(head);
  if(!half){
    section.append(el('p','documents-no-response',
      'This contract has no response payload. A one-way operation is explicitly represented by null.'));
    return section;
  }
  if(!half.fields.length){
    section.append(el('p','documents-no-response',
      'No named fields in this schema. The raw schema below remains authoritative.'));
    return section;
  }
  const summary=el('p','documents-field-summary',
    half.fields.length+' fields · Since Nession: earliest verified release, Unreleased or Unknown.');
  const scroll=el('div','documents-table-scroll');
  scroll.append(fieldTable(half.fields));
  add(section,summary,scroll);return section;
}
function reader(data,group,selected){
  const article=el('article','documents-reader knowledge-reader');
  add(article,local('← All protocols','#/documents/protocol','documents-back'),
    el('div','eyebrow',group.owner+' / PROTOCOL UNIT'),
    el('h2','',group.id));
  const meta=el('div','documents-meta mono');
  add(meta,el('span','','Wire: '+group.wires.join(', ')),
    el('span','','Contract versions: '+group.versions.map(v=>'v'+v.version).join(' · ')));
  article.append(meta);
  const versionBar=el('nav','documents-versions');
  versionBar.setAttribute('aria-label','Contract version');
  for(const v of group.versions){
    const a=local('v'+v.version,documentsHref(group.id,v.version),
      'documents-version'+(v.version===selected.version?' active':''));
    if(v.version===selected.version)a.setAttribute('aria-current','page');
    versionBar.append(a);
  }
  const note=el('p','documents-note',
    'Contract v1/v2 selects the protocol definition. Since Nession refers to the release version that first supports each field, where verified. Missing historical evidence is Unknown.');
  add(article,versionBar,note,
    contractSection(selected,'request'),
    contractSection(selected,'response'));
  const raw=el('details','documents-raw');
  const summary=el('summary','','Full JSON Schema for v'+selected.version+' (including $defs)');
  raw.append(summary);
  raw.addEventListener('toggle',()=>{
    if(!raw.open||raw.querySelector('pre'))return;
    const document={
      $schema:'https://json-schema.org/draft/2020-12/schema',
      protocol:group.id,version:selected.version,owner:group.owner,wires:group.wires,
      request:selected.request?{alias:selected.request.alias,shape:selected.request.shape}:null,
      response:selected.response?{alias:selected.response.alias,shape:selected.response.shape}:null,
      $defs:data.definitions
    };
    raw.append(add(el('pre'),el('code','',JSON.stringify(document,null,2))));
  });
  add(article,raw,external('View pinned codegen catalog ↗',
    REPO+'/blob/'+data.source.sha+'/crates/nession-protocol-codegen/src/catalog.rs',
    'documents-source'));
  return article;
}
// The Documents landing page intentionally shows domains, not a default reader.
export function renderDocumentsIndex(root,{protocolCount=null,mcpCount=null,
  protocolStatus='loading',mcpStatus='loading'}={}){
  add(root,el('div','eyebrow documents-kicker','NESSION / OPEN ENGINEERING'),
    el('h1','documents-heading','Documents'),
    el('p','documents-lede','Source-backed technical references. Choose a catalog to browse its contracts and inspect details.'));
  const grid=el('div','documents-index');
  const categories=[
    {href:'#/documents/protocol',eyebrow:'01 / NESSION',title:'Protocol reference',
      description:'Versioned Nession Protocol Units, request/response fields and verified Since Nession release boundaries.',
      count:protocolCount,label:'protocol units',status:protocolStatus,action:'Explore Protocol →'},
    {href:'#/documents/mcp',eyebrow:'02 / MODEL CONTEXT PROTOCOL',title:'MCP Tools',
      description:'Canonical Rust-registered Tools, input JSON Schemas and verified upstream MCP specification references.',
      count:mcpCount,label:'registered tools',status:mcpStatus,action:'Explore MCP →'}
  ];
  for(const category of categories){
    const card=local('',category.href,'documents-index-card');
    add(card,el('span','eyebrow',category.eyebrow),
      el('h2','',category.title),el('p','',category.description));
    const meta=el('div','documents-index-meta');
    const availability=category.status==='available'&&Number.isSafeInteger(category.count)
      ?category.count+' '+category.label:category.status==='loading'
        ?'Loading public catalog…':'Catalog unavailable';
    add(meta,el('span','documents-index-availability',availability),
      el('strong','',category.action));
    card.append(meta);grid.append(card);
  }
  root.append(grid);
}

export function renderDocuments(root,data,hash){
  const crumb=el('nav','documents-breadcrumb');
  crumb.setAttribute('aria-label','Documents breadcrumb');
  add(crumb,local('Documents','#/documents'),el('span','',' / Protocol'));
  add(root,crumb,
    el('h1','documents-heading','Protocol reference'),
    el('p','documents-lede',
      'Rust-generated Protocol Units with request/response schemas and source-verified release boundaries.'));
  if(!validDocumentsSnapshot(data)||data.status!=='available'){
    const box=el('div','panel documents-unavailable');
    add(box,el('h3','','Protocol catalog unavailable'),
      el('p','','The pinned Rust-generated schema could not be validated or loaded. This is not an empty protocol catalog.'),
      external('Protocol source ↗',REPO+'/tree/main/crates/nession-protocol','documents-source'));
    root.append(box);return;
  }
  const route=documentsRoute(hash)||{id:null,version:null,invalid:false};
  const selectedGroup=data.protocols.find(p=>p.id===route.id)||data.protocols[0];
  const selected=selectedGroup.versions.find(v=>v.version===route.version)||
    selectedGroup.versions.at(-1);
  const validRoute=!route.invalid&&(!route.id||
    data.protocols.some(p=>p.id===route.id)&&
      (!route.version||selectedGroup.versions.some(v=>v.version===route.version)));
  const exact=!!route.id&&validRoute;
  const snapshot=el('div','documents-snapshot mono');
  add(snapshot,el('span','','RUST CONTRACTS / MAIN'),
    el('strong','',data.source.sha.slice(0,12)),
    el('span','',data.protocols.length+' protocol units'),
    external('Architecture ↗',REPO+'/blob/'+data.source.sha+'/docs/architecture/protocol.md'));
  root.append(snapshot);
  const layout=el('div','documents-layout documents-workspace'+(exact?' reading':''));
  layout.dataset.section='protocol';
  const sidebar=el('aside','documents-browser-pane');
  sidebar.setAttribute('aria-label','Protocol catalog');
  const controls=el('div','documents-browser-controls');
  const filters=el('div','documents-filters');
  const categories=['All',...new Set(data.protocols.map(p=>p.owner))];
  const search=el('input','documents-search');
  search.type='search';search.placeholder='Search protocols or fields';search.value=state.query;
  search.setAttribute('aria-label','Search protocol units');
  const count=el('p','documents-count mono');
  const scroll=el('div','documents-list-scroll');
  scroll.setAttribute('role','region');
  scroll.setAttribute('aria-label','Protocol list');
  scroll.tabIndex=0;
  const entries=el('div','documents-results');
  scroll.append(entries);
  function repaint(){
    filters.replaceChildren();
    for(const category of categories){
      const b=el('button','documents-filter'+(state.owner===category?' active':''),category);
      b.type='button';b.setAttribute('aria-pressed',String(category===state.owner));
      b.addEventListener('click',()=>{state.owner=category;repaint();});
      filters.append(b);
    }
    entries.replaceChildren();
    const found=filterDocuments(data.protocols,state);
    count.textContent=found.length+' / '+data.protocols.length+' PROTOCOL UNITS';
    for(const p of found){
      const a=local('',documentsHref(p.id),'documents-entry'+
        (p.id===selectedGroup.id?' selected':''));
      add(a,el('div','eyebrow',p.owner),el('strong','',p.id),
        el('p','','v'+p.versions.map(v=>v.version).join(', v')+' · '+p.wires.join(', ')));
      if(p.id===selectedGroup.id)a.setAttribute('aria-current','page');
      entries.append(a);
    }
    if(!found.length)entries.append(el('p','documents-empty','No matching protocol units.'));
  }
  search.addEventListener('input',()=>{state.query=search.value;repaint();});
  add(controls,el('div','eyebrow','PROTOCOL OWNERS'),filters,search,count);
  add(sidebar,controls,scroll);
  repaint();
  const right=el('section','documents-reader-slot');
  right.setAttribute('role','region');
  right.setAttribute('aria-label','Protocol details');
  right.tabIndex=0;
  if(!validRoute){
    const box=el('article','panel');
    add(box,local('← All protocols','#/documents/protocol','documents-back'),
      el('h3','','Unknown protocol or version'),
      el('p','','This protocol or contract version is not present in the pinned generated catalog.'));
    right.append(box);
  }else{
    const article=reader(data,selectedGroup,selected);
    const observed=data.releases.filter(r=>r.status==='available').length;
    const note=el('p','documents-release-note',observed
      ?observed+' verified release snapshots inform Since Nession values; unavailable history remains Unknown.'
      :'Historical release snapshots are unavailable; Since Nession remains Unknown until verified.');
    article.insertBefore(note,article.querySelector('.documents-versions'));
    right.append(article);
  }
  add(layout,sidebar,right);
  root.append(layout);
}
