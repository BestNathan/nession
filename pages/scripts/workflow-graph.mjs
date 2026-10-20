// Standalone public Pages workflow topology. Only checked-in workflow definitions
// may produce nodes or executable edges. No Actions status/SC verdict is inferred.
export const GROUPS = [
  {id:'intake',label:'01 / Intake',detail:'Issue auditing and trusted dispatch requests'},
  {id:'agent',label:'02 / Agent execution',detail:'Worker, isolated result claims and trusted reconciliation'},
  {id:'quality',label:'03 / Quality & E2E',detail:'Revision gates and independently ingested test evidence'},
  {id:'acceptance',label:'04 / Acceptance',detail:'Source verification and Success Criteria projection'},
  {id:'evidence',label:'05 / Stores & metrics',detail:'Readback, custody, audit and telemetry'},
  {id:'delivery',label:'06 / Delivery',detail:'Staging, production and public publication'},
];
const catalog = [
  ['agent-issue-audit','intake','Audit Issue contracts; does not attest implementation'],
  ['acceptance-agent-controller','intake','Manual, least-privilege Controller request'],
  ['agent-controller-dispatch','intake','Owner-authorized durable dispatch'],
  ['agent-develop','agent','Isolated Developer worker and artifacts'],
  ['store-agent-dispatch-reconcile','agent','Authenticate worker claim and dispatch ticket'],
  ['store-agent-development-ingest','agent','Authenticate Worker result before Store writes'],
  ['store-agent-controller-ingest','agent','Independent Controller request ingestion'],
  ['ci-quality','quality','Source and test gates on PR HEAD and main'],
  ['e2e-tests','quality','Full and selected E2E execution'],
  ['e2e-test-ingest','quality','Independently verify E2E evidence'],
  ['e2e-scenario-smoke','quality','Scenario reproduction smoke'],
  ['e2e-scenario-ingest','quality','Independent scenario evidence ingestion'],
  ['acceptance-cases','quality','Requirement-defined acceptance cases'],
  ['acceptance-case-ingest','quality','Independent case evidence ingestion'],
  ['ci-pages','quality','Standalone Pages quality gate'],
  ['acceptance-orchestrator','acceptance','PR/merged-SHA Acceptance coordination'],
  ['agent-sc-acceptance','acceptance','Reusable agent/structured SC evaluation'],
  ['acceptance-postrun-waker','acceptance','Re-evaluate after completed trusted main runs'],
  ['acceptance-verified-stage','acceptance','Authenticated staged-Issue evaluation'],
  ['store-agent-bootstrap','evidence','Initialize canonical agent orphan Store'],
  ['store-governance-audit','evidence','Run Store governance checks'],
  ['metrics-agent-telemetry','evidence','Ingest verified agent execution measurements'],
  ['metrics-repository','evidence','Measure repository health and throughput'],
  ['metrics-replay-request','evidence','Trusted replay request entrypoint'],
  ['release-staging','delivery','Build and publish staging artifacts'],
  ['release-production','delivery','Version-gated production release'],
  ['deploy-pages','delivery','Publish independently verified public Pages'],
];
export const WORKFLOW_IDS = Object.freeze(catalog.map(([id])=>id));
const REPO='BestNathan/nession';
const TYPES=new Set(['issues','issue_comment','pull_request','pull_request_target','push',
  'workflow_dispatch','workflow_call','workflow_run','repository_dispatch','schedule']);
const shaPattern=/^[a-f0-9]{40}$/;
function workflowDefinition(source,id){
  if(typeof source!=='string'||source.length<20||source.length>200000)
    throw new Error('Invalid workflow source: '+id);
  const name=source.match(/^name:\s*([^\r\n]+)\s*$/m)?.[1]?.trim();
  if(!name||name.length>100||!/^[\w /.-]+$/.test(name))
    throw new Error('Invalid workflow name: '+id);
  const lines=source.split(/\r?\n/);
  const start=lines.findIndex(x=>/^on:\s*(?:#.*)?$/.test(x));
  if(start<0)throw new Error('Missing on mapping: '+id);
  const triggers=[];
  const runNames=[];
  let trigger=null,readingRunList=false;
  for(let i=start+1;i<lines.length;i++){
    const line=lines[i];
    if(line.trim()&&!/^\s/.test(line)&&!line.startsWith('#'))break;
    const key=line.match(/^  ([a-z_]+):(?:\s|$)/);
    if(key){
      trigger=key[1];readingRunList=false;
      if(TYPES.has(trigger))triggers.push(trigger);
      continue;
    }
    if(trigger==='workflow_run'){
      const field=line.match(/^    workflows:\s*(.*)$/);
      if(field){
        readingRunList=true;
        const value=field[1];
        for(const m of value.matchAll(/["']([^"']+)["']/g))runNames.push(m[1]);
        continue;
      }
      if(readingRunList){
        const item=line.match(/^      -\s*["']?([^"']+?)["']?\s*(?:#.*)?$/);
        if(item)runNames.push(item[1]);
        else if(/^    [a-z_]+:/.test(line))readingRunList=false;
      }
    }
  }
  if(!triggers.length)throw new Error('Missing recognized triggers: '+id);
  const called=[...source.matchAll(/\buses:\s*\.\/\.github\/workflows\/([a-z0-9-]+)\.yml\b/g)]
    .map(x=>x[1]);
  return {name,triggers:[...new Set(triggers)],runNames,called};
}
export function projectWorkflowGraph(definitions,sha,generatedAt=new Date().toISOString()){
  if(!definitions||typeof definitions!=='object')throw new Error('Definitions required');
  if(sha!==null&&!shaPattern.test(sha))throw new Error('Invalid source revision');
  if(!Number.isFinite(Date.parse(generatedAt)))throw new Error('Invalid timestamp');
  const nodes=catalog.map(([id,group,description])=>{
    const meta=workflowDefinition(definitions[id],id);
    return {id,name:meta.name,group,description,triggers:meta.triggers,
      url:'https://github.com/'+REPO+'/blob/'+(sha||'main')+'/.github/workflows/'+id+'.yml'};
  });
  const byName=new Map(nodes.map(x=>[x.name,x.id]));
  if(byName.size!==nodes.length)throw new Error('Ambiguous workflow names');
  const edges=[], seen=new Set();
  for(const {id} of nodes){
    const meta=workflowDefinition(definitions[id],id);
    for(const source of meta.runNames){
      const from=byName.get(source);
      if(from){
        const key=from+'>'+id+':workflow_run';
        if(!seen.has(key)){seen.add(key);edges.push({from,to:id,kind:'workflow_run'});}
      }
    }
    for(const used of meta.called){
      if(WORKFLOW_IDS.includes(used)){
        const key=id+'>'+used+':workflow_call';
        if(!seen.has(key)){seen.add(key);edges.push({from:id,to:used,kind:'workflow_call'});}
      }
    }
  }
  return validateWorkflowGraph({schema_version:1,source:{repository:REPO,main_sha:sha,
    generated_at:generatedAt},groups:GROUPS,nodes,edges});
}
export function validateWorkflowGraph(graph){
  if(graph?.schema_version!==1||graph.source?.repository!==REPO||
    (graph.source.main_sha!==null&&!shaPattern.test(graph.source.main_sha))||
    !Number.isFinite(Date.parse(graph.source.generated_at)))throw new Error('Invalid workflow projection source');
  if(!Array.isArray(graph.nodes)||graph.nodes.length!==WORKFLOW_IDS.length||
    !Array.isArray(graph.edges)||graph.edges.length>150)throw new Error('Invalid workflow projection size');
  for(let i=0;i<graph.nodes.length;i++){
    const n=graph.nodes[i],expected=catalog[i];
    if(n.id!==expected[0]||n.group!==expected[1]||n.description!==expected[2]||
      typeof n.name!=='string'||n.name.length>100||!/^[\w /.-]+$/.test(n.name)||
      !Array.isArray(n.triggers)||!n.triggers.length||n.triggers.some(t=>!TYPES.has(t))||
      n.url!=='https://github.com/'+REPO+'/blob/'+(graph.source.main_sha||'main')+
        '/.github/workflows/'+n.id+'.yml')throw new Error('Invalid workflow projection node: '+i);
  }
  const edgeKeys=new Set();
  for(const e of graph.edges){
    const key=e.from+'>'+e.to+':'+e.kind;
    if(!WORKFLOW_IDS.includes(e.from)||!WORKFLOW_IDS.includes(e.to)||
      !['workflow_run','workflow_call'].includes(e.kind)||edgeKeys.has(key))
      throw new Error('Invalid workflow projection edge');
    edgeKeys.add(key);
  }
  if(JSON.stringify(graph.groups)!==JSON.stringify(GROUPS))throw new Error('Invalid workflow groups');
  return graph;
}
