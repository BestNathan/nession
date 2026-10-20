// Independent Pages-only workflow definition graph. No runtime/API calls.
const NS='http://www.w3.org/2000/svg';
const summary=document.getElementById('workflow-summary');
const source=document.getElementById('workflow-source');
const graphHost=document.getElementById('workflow-graph');
const roster=document.getElementById('workflow-roster');
const detail=document.getElementById('workflow-detail');
const filter=document.getElementById('workflow-group');
const search=document.getElementById('workflow-search');
let model=null,selected=null;
const el=(tag,cls,text)=>{
  const e=document.createElement(tag);
  if(cls)e.className=cls;
  if(text!==undefined)e.textContent=String(text);
  return e;
};
const append=(p,...children)=>{p.append(...children);return p;};
function link(label,href){
  const a=el('a','workflow-link',label);
  // Both the build and browser restrict links to this exact public repository.
  if(/^https:\/\/github\.com\/BestNathan\/nession\/(?:blob\/(?:[a-f0-9]{40}|main)\/\.github\/workflows\/[a-z0-9-]+\.yml|actions(?:\/workflows\/[a-z0-9-]+\.yml)?)$/.test(href)){
    a.href=href;a.target='_blank';a.rel='noopener noreferrer';
  }
  return a;
}
const svg=(tag,attributes={})=>{
  const e=document.createElementNS(NS,tag);
  for(const [key,value] of Object.entries(attributes))e.setAttribute(key,String(value));
  return e;
};
const triggerLabels={
  issues:'Issue',issue_comment:'Issue comment',pull_request:'PR',
  pull_request_target:'Trusted PR event',push:'Push',
  workflow_dispatch:'Manual/API dispatch',workflow_call:'Reusable call',
  workflow_run:'Workflow completion',repository_dispatch:'Repository dispatch',
  schedule:'Scheduled'
};
function validate(p){
  if(p?.schema_version!==1||p.source?.repository!=='BestNathan/nession'||
    (p.source.main_sha!==null&&!/^[a-f0-9]{40}$/.test(p.source.main_sha))||
    !Array.isArray(p.groups)||p.groups.length!==6||
    !Array.isArray(p.nodes)||p.nodes.length>50||!Array.isArray(p.edges)||p.edges.length>150)
    throw new Error('Invalid workflow graph schema');
  const groups=new Set(p.groups.map(x=>x.id));
  const ids=new Set(p.nodes.map(x=>x.id));
  if(ids.size!==p.nodes.length||groups.size!==p.groups.length)throw new Error('Duplicate graph identity');
  for(const n of p.nodes){
    if(!/^[a-z0-9-]+$/.test(n.id)||!groups.has(n.group)||typeof n.name!=='string'||
      n.name.length>100||typeof n.description!=='string'||n.description.length>180||
      !Array.isArray(n.triggers)||n.triggers.some(t=>!triggerLabels[t])||
      n.url!=='https://github.com/BestNathan/nession/blob/'+(p.source.main_sha||'main')+
        '/.github/workflows/'+n.id+'.yml')throw new Error('Invalid node');
  }
  for(const e of p.edges)
    if(!ids.has(e.from)||!ids.has(e.to)||!['workflow_run','workflow_call'].includes(e.kind))
      throw new Error('Invalid edge');
  return p;
}
function select(id){
  selected=id;
  if(!model)return;
  const n=model.nodes.find(x=>x.id===id);
  detail.replaceChildren();
  if(!n)return;
  const heading=el('h3','',n.name);
  const group=model.groups.find(g=>g.id===n.group);
  append(detail,el('div','eyebrow',group.label),heading,el('p','',n.description));
  const triggerBox=el('div','workflow-detail-block');
  append(triggerBox,el('h4','','GitHub event triggers'));
  append(triggerBox,el('div','workflow-chips'));
  for(const trigger of n.triggers)
    triggerBox.lastChild.append(el('span','workflow-chip',triggerLabels[trigger]||trigger));
  detail.append(triggerBox);
  const incoming=model.edges.filter(x=>x.to===id);
  const outgoing=model.edges.filter(x=>x.from===id);
  const nodeById=new Map(model.nodes.map(x=>[x.id,x]));
  const groupList=(label,edges,getId)=>{
    const section=el('div','workflow-detail-block');
    section.append(el('h4','',label));
    if(!edges.length)section.append(el('p','','None declared between the curated workflows.'));
    for(const e of edges){
      const b=el('button','workflow-dependency',nodeById.get(getId(e)).name+' · '+e.kind);
      b.type='button';b.addEventListener('click',()=>{filter.value='all';search.value='';select(getId(e));draw();});
      section.append(b);
    }
    detail.append(section);
  };
  groupList('Subscribed upstream / callers',incoming,e=>e.from);
  groupList('Downstream consumers / reusable calls',outgoing,e=>e.to);
  detail.append(link('Open pinned workflow source ↗',n.url));
  detail.append(link('Inspect GitHub Actions runs ↗','https://github.com/BestNathan/nession/actions/workflows/'+n.id+'.yml'));
  detail.append(el('p','workflow-note','This source declaration is not evidence that a run executed, completed, or passed.'));
  graphHost.querySelectorAll('[data-workflow-id]').forEach(b=>{
    b.classList.toggle('selected',b.dataset.workflowId===id);
    b.classList.toggle('related',model.edges.some(e=>
      (e.from===id&&e.to===b.dataset.workflowId)||(e.to===id&&e.from===b.dataset.workflowId)));
    b.setAttribute('aria-pressed',String(b.dataset.workflowId===id));
  });
  roster.querySelectorAll('[data-workflow-id]').forEach(b=>
    b.setAttribute('aria-pressed',String(b.dataset.workflowId===id)));
  graphHost.querySelectorAll('[data-edge-key]').forEach(path=>{
    const edge=model.edges.find(e=>e.from+'>'+e.to+':'+e.kind===path.dataset.edgeKey);
    path.classList.toggle('active',!!edge&&(edge.from===id||edge.to===id));
  });
}
function draw(){
  if(!model)return;
  const term=search.value.trim().toLowerCase().slice(0,100);
  const group=filter.value;
  const shown=model.nodes.filter(n=>
    (group==='all'||n.group===group)&&
    (!term||[n.name,n.id,n.description,...n.triggers].join(' ').toLowerCase().includes(term)));
  const visible=new Set(shown.map(n=>n.id));
  graphHost.replaceChildren();roster.replaceChildren();
  const width=1960,columnWidth=276,cardWidth=244,left=34,startY=112,stepY=104;
  const maxItems=Math.max(1,...model.groups.map(g=>shown.filter(n=>n.group===g.id).length));
  const height=Math.max(390,startY+maxItems*stepY+54);
  graphHost.style.width=width+'px';
  graphHost.style.height=height+'px';
  const paths=svg('svg',{class:'workflow-lines',viewBox:'0 0 '+width+' '+height,
    width,height,'aria-hidden':'true'});
  const defs=svg('defs');
  for(const [kind,color] of [['workflow_run','#438870'],['workflow_call','#b87d55']]){
    const marker=svg('marker',{id:'workflow-arrow-'+kind,markerWidth:8,markerHeight:8,
      refX:7,refY:3,orient:'auto',markerUnits:'userSpaceOnUse'});
    marker.append(svg('path',{d:'M 0 0 L 7 3 L 0 6 z',fill:color}));
    defs.append(marker);
  }
  paths.append(defs);
  const positions=new Map();
  model.groups.forEach((g,index)=>{
    const x=left+index*320;
    append(graphHost,el('div','workflow-lane',g.label));
    const lane=graphHost.lastChild;
    lane.style.left=x+'px';lane.style.width=columnWidth+'px';
    lane.append(el('small','',g.detail));
    const entries=shown.filter(n=>n.group===g.id);
    if(!entries.length)lane.classList.add('workflow-lane-empty');
    entries.forEach((n,i)=>{
      const y=startY+i*stepY;
      positions.set(n.id,{x,y});
    });
  });
  for(const e of model.edges){
    if(!visible.has(e.from)||!visible.has(e.to))continue;
    const a=positions.get(e.from),b=positions.get(e.to);
    const sx=a.x+cardWidth,sy=a.y+35,tx=b.x,ty=b.y+35;
    let d;
    if(tx>sx){
      const bend=Math.max(46,Math.abs(tx-sx)*.5);
      d='M'+sx+' '+sy+' C'+(sx+bend)+' '+sy+' '+(tx-bend)+' '+ty+' '+tx+' '+ty;
    }else{
      const offset=42+Math.abs(a.y-b.y)*.06;
      d='M'+sx+' '+sy+' C'+(sx+offset)+' '+(sy-30)+' '+(tx-offset)+' '+(ty-30)+' '+tx+' '+ty;
    }
    const path=svg('path',{d,class:'workflow-edge '+e.kind,
      'marker-end':'url(#workflow-arrow-'+e.kind+')'});
    path.dataset.edgeKey=e.from+'>'+e.to+':'+e.kind;
    paths.append(path);
  }
  graphHost.prepend(paths);
  for(const n of shown){
    const pos=positions.get(n.id);
    const b=el('button','workflow-node');
    b.type='button';b.dataset.workflowId=n.id;
    b.style.left=pos.x+'px';b.style.top=pos.y+'px';b.style.width=cardWidth+'px';
    append(b,el('span','workflow-node-title',n.name),
      el('span','workflow-node-meta',n.triggers.slice(0,2).map(t=>triggerLabels[t]||t).join(' · ')));
    b.addEventListener('click',()=>select(n.id));
    graphHost.append(b);
    const item=el('button','workflow-roster-row');
    item.type='button';item.dataset.workflowId=n.id;
    append(item,el('span','workflow-roster-name',n.name),
      el('span','workflow-roster-group',model.groups.find(g=>g.id===n.group).label));
    item.addEventListener('click',()=>select(n.id));
    roster.append(item);
  }
  if(!shown.length){
    const message=el('p','workflow-no-match','No matching definitions in this bounded graph. Clear the filters to restore the full topology.');
    graphHost.append(message);
    roster.append(el('p','workflow-no-match','No matching workflows.'));
  }
  if(!visible.has(selected))selected=shown[0]?.id||null;
  if(selected)select(selected);
  else detail.replaceChildren(el('p','','No workflow is selected.'));
  summary.textContent=shown.length+' / '+model.nodes.length+' core workflows · '+
    model.edges.filter(e=>visible.has(e.from)&&visible.has(e.to)).length+
    ' / '+model.edges.length+' declared connections';
}
async function init(){
  try{
    const response=await fetch(new URL('data/workflows.json',document.baseURI),{cache:'no-cache'});
    if(!response.ok)throw new Error('Source projection unavailable');
    model=validate(await response.json());
    for(const group of model.groups){
      const opt=el('option','',group.label);opt.value=group.id;filter.append(opt);
    }
    const revision=model.source.main_sha;
    source.textContent='Built from checked-in GitHub Actions definitions · source '+
      (revision?revision.slice(0,12):'revision unavailable')+
      ' · generated '+new Date(model.source.generated_at).toLocaleString('en-US',{timeZone:'UTC'})+' UTC';
    search.addEventListener('input',draw);
    filter.addEventListener('change',draw);
    draw();
  }catch(error){
    console.error('Workflow projection unavailable',error);
    summary.textContent='Source topology unavailable; no graph or success status can be inferred.';
    source.textContent='Inspect the canonical .github/workflows files in the source repository.';
    graphHost.replaceChildren(el('p','workflow-no-match','Workflow definition source unavailable.'));
    detail.replaceChildren(link('Open GitHub Actions ↗','https://github.com/BestNathan/nession/actions'));
  }
}
init();
