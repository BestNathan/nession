'use strict';
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {spawnSync}=require('node:child_process');
const {test,expect}=require('@playwright/test');
const project=path.resolve(__dirname,'../../../../../');
const dist=path.join(project,'pages/dist');
const available={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/favicon.svg':'favicon.svg','/data/site.json':'data/site.json'};
test('Nession Pages renders independently on the exact accepted main-merge source',async({page})=>{
 const sha=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
 expect(sha).toMatch(/^[a-f0-9]{40}$/);
 const runtimeFile=process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
 if(runtimeFile){
  const runtime=JSON.parse(fs.readFileSync(runtimeFile,'utf8'));
  expect(runtime.target_sha).toBe(sha);
  expect(runtime.profile).toBe('full-stack-local');
 }
 const generated=spawnSync(process.execPath,['pages/scripts/build.mjs'],{
  cwd:project,encoding:'utf8',timeout:30000,
  env:{...process.env,PAGES_OFFLINE:'1',SOURCE_MAIN_SHA:sha},
 });
 expect(generated.status,generated.stderr||generated.stdout).toBe(0);
 const doc=JSON.parse(fs.readFileSync(path.join(dist,'data/site.json'),'utf8'));
 expect(doc.schema_version).toBe(1);
 expect(doc.source.main_sha).toBe(sha);
 expect(doc.agents.roster.length).toBeGreaterThan(0);
 expect(doc.agents.summary.cost_7d).toBe(null);
 const server=http.createServer((req,res)=>{
  const file=available[(req.url||'/').split('?')[0]];
  if(!file){res.writeHead(404);res.end();return;}
  try{
   const p=path.join(dist,file);
   const type=file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':file.endsWith('.json')?'application/json':'text/html';
   res.writeHead(200,{'content-type':type});
   res.end(fs.readFileSync(p));
  }catch{res.writeHead(500);res.end();}
 });
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
 try{
  const addr=server.address();
  const origin='http://127.0.0.1:'+addr.port;
  await page.goto(origin+'/#/');
  await expect(page.getByRole('heading',{name:/An open space/})).toBeVisible();
  await page.goto(origin+'/#/agents');
  await expect(page.getByRole('heading',{name:'The agents behind the work.'})).toBeVisible();
  await page.goto(origin+'/#/repository');
  await expect(page.getByRole('heading',{name:'Built in the open.'})).toBeVisible();
  await page.goto(origin+'/#/evidence');
  await expect(page.getByText(/Integrity: not independently verified by this public site/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Evidence, not claims.'})).toBeVisible();
 }finally{await new Promise(ok=>server.close(ok));}
});
