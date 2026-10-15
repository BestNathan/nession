// Standalone static Pages origin for browser tests. Never serves the product web/.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const cwd=process.cwd();
const root=resolve(cwd,cwd.endsWith('/e2e')?'../pages':'pages');
const fixture={
 schema_version:1,generated_at:'2026-10-14T12:00:00Z',
 source:{repository:'BestNathan/nession',main_sha:'a'.repeat(40),metrics_sha:'b'.repeat(40)},
 repository:{available:true,sha:'a'.repeat(40),generated_at:'2026-10-14T12:00:00Z',freshness:{state:'stale',age_hours:10},current:{loc:250000,files:1200,tests:3000,rust_coverage:.85,web_coverage:.9,protocol_units:70,unit_pass:1},efficiency:{commits_7d:20,additions_7d:50,deletions_7d:12,merged_7d:5,open_issues:2,open_prs:1}},
 agents:{available:true,generated_at:'2026-10-14T12:00:00Z',freshness:{state:'unavailable',age_hours:null},distribution:{
    '7d':{providers:{available:true,items:[{name:'cursor',count:2},{name:'claude-code',count:1}]},workflows:{available:true,items:[{name:'issue-audit',count:3}]}},
    '30d':{providers:{available:true,items:[{name:'cursor',count:10},{name:'claude-code',count:4}]},workflows:{available:true,items:[{name:'issue-audit',count:14}]}}
  },roster:[{id:'dev-qwen-01',role:'developer',provider:'claude-code',observed_7d:3},{id:'review-cursor-01',role:'reviewer',provider:'cursor',observed_7d:null}],summary:{runs_7d:3,runs_30d:14,tokens_7d:45000,tokens_observed_runs:2,tools_7d:20,tools_observed_runs:3,cost_7d:null}},
 work:{issues_status:'available',pulls_status:'available',issues:[{number:1782,title:'<img src=x onerror=alert(1)>',url:'https://github.com/BestNathan/nession/issues/1782',state:'open',observed_agent_runs_7d:2,updated_at:'2026-10-14T12:00:00Z',pr_references:{status:'available',prs:[{number:1787,url:'https://github.com/BestNathan/nession/pull/1787',relation:'github_cross_reference'}]}}],pulls:[{number:1787,title:'Pages MVP',url:'https://github.com/BestNathan/nession/pull/1787',state:'open',updated_at:'2026-10-14T12:00:00Z',workflow:{head_sha:'a'.repeat(40),ci:{run_id:42,attempt:1,status:'success',url:'https://github.com/BestNathan/nession/actions/runs/42'},e2e:null}}]},
 evidence:{stores:[{name:'metrics',purpose:'Repository and Agent telemetry',state:'present',sha:'b'.repeat(40),url:'https://github.com/BestNathan/nession/tree/metrics'},{name:'agent-store',purpose:'Durable Agent checkpoints',state:'missing',sha:null,url:'https://github.com/BestNathan/nession/tree/agent-store'}]}
};
export async function startPagesFixture(){
 const allowed={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/favicon.svg':'favicon.svg'} as Record<string,string>;
 const server=createServer(async(req,res)=>{
  const path=(req.url||'/').split('?')[0];
  if(path==='/data/site.json'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(fixture));return;}
  if(!Object.hasOwn(allowed,path)){res.writeHead(404);res.end();return;}
  try {const name=allowed[path],content=await readFile(join(root,name));
   res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html'});
   res.end(content);
  }catch{res.writeHead(500);res.end();}
 });
 await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
 const port=server.address();if(!port||typeof port==='string')throw new Error('missing fixture port');
 return {origin:'http://127.0.0.1:'+port.port,close:()=>new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()))};
}
