'use strict';
// #2683 SC-03: real Knowledge push -> trusted main-owned workflow_run Pages
// -> anonymous published Knowledge JSON, exact witness SHA and byte digest.
// Historical witnessed Run IDs are immutable; no simulated event or write.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');

const REPO='BestNathan/nession';
const API='https://api.github.com/repos/'+REPO;
const PUBLIC='https://bestnathan.github.io/nession/';
const SHA=/^[a-f0-9]{40}$/;
const SOURCE_SHA='a0d92aa9088c50fb1956463f466a1f25e2a1dc47';
const SIGNAL_RUN=41617084950;
const PAGES_RUN=41617110852;
const PUBLIC_SHA256='73b36102abbbf9d06c70ef2bfbe351710cfb833cacf3eacb03c6d11a7fd79fa2';
const ARTICLE='topics/workflows/nession-public-pages-source-publication-and-orphan-branch-signals.md';
const root=path.resolve(__dirname,'../../../../..');

function targetSha(){
  const target=String(process.env.NESSION_ACCEPTANCE_TARGET_SHA||'');
  assert.match(target,SHA,'Exact merged main target SHA required');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),target);
  return target;
}
async function read(url,json=false){
  const host=new URL(url).hostname;
  assert.ok(['api.github.com','bestnathan.github.io'].includes(host),
    'Only fixed read-only GitHub API or public Pages origins allowed');
  const headers={'User-Agent':'nession-2683-public-pages-proof','Cache-Control':'no-cache'};
  const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
  if(host==='api.github.com'&&token)headers.Authorization='Bearer '+token;
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(25000)});
  assert.equal(response.status,200,'HTTP '+response.status+' '+new URL(url).pathname);
  return json?response.json():response.text();
}
async function main(){
  const target=targetSha();
  const yml=fs.readFileSync(path.join(root,'.github/workflows/deploy-pages.yml'),'utf8');
  assert.ok(yml.includes("workflows: ['Prototype / Change Signal', 'Knowledge / Change Signal']"));
  assert.ok(yml.includes('branches: [prototype, knowledge]'));
  assert.ok(yml.includes("github.event.workflow_run.name == 'Knowledge / Change Signal'"));
  assert.ok(yml.includes("github.event.workflow_run.head_branch == 'knowledge'"));
  assert.ok(yml.includes('knowledge-ledger-contract.mjs check knowledge-store'));
  const [signal,publisher,ref,body,html]=await Promise.all([
    read(API+'/actions/runs/'+SIGNAL_RUN,true),
    read(API+'/actions/runs/'+PAGES_RUN,true),
    read(API+'/git/ref/heads/knowledge',true),
    read(PUBLIC+'data/knowledge.json?revision='+SOURCE_SHA),
    read(PUBLIC+'?revision='+SOURCE_SHA),
  ]);
  assert.equal(signal.id,SIGNAL_RUN);
  assert.equal(signal.name,'Knowledge / Change Signal');
  assert.equal(signal.event,'push');
  assert.equal(signal.head_branch,'knowledge');
  assert.equal(signal.head_repository?.full_name,REPO);
  assert.equal(signal.head_sha,SOURCE_SHA);
  assert.equal(signal.status,'completed');
  assert.equal(signal.conclusion,'success');
  assert.equal(publisher.id,PAGES_RUN);
  assert.equal(publisher.name,'Deploy / Public Pages');
  assert.equal(publisher.event,'workflow_run','Pages must be caused by signal, not schedule/manual/main push');
  assert.equal(publisher.head_branch,'main');
  assert.equal(publisher.head_repository?.full_name,REPO);
  assert.equal(publisher.status,'completed');
  assert.equal(publisher.conclusion,'success');
  assert.ok(new Date(publisher.created_at)>new Date(signal.created_at));
  assert.match(publisher.head_sha,SHA);
  const ancestry=await read(API+'/compare/'+publisher.head_sha+'...'+target,true);
  assert.ok(['ahead','identical'].includes(ancestry.status),
    'Publisher trusted main must be ancestor of exact Acceptance target');
  assert.equal(ref.ref,'refs/heads/knowledge');
  // This witnessed artifact is intentionally exact. If a later Knowledge push
  // publishes a different snapshot, this Case requires fresh deployment proof.
  assert.equal(ref.object.sha,SOURCE_SHA,'Current source advanced beyond pinned public witness');
  const digest=createHash('sha256').update(body).digest('hex');
  assert.equal(digest,PUBLIC_SHA256,'Anonymous HTTPS bytes differ from validated published artifact');
  const json=JSON.parse(body);
  assert.equal(json.schema_version,1);
  assert.equal(json.status,'available');
  assert.equal(json.source.branch,'knowledge');
  assert.equal(json.source.sha,SOURCE_SHA);
  assert.equal(json.articles.length,7);
  assert.ok(json.articles.some(article=>article.path===ARTICLE));
  assert.ok(html.includes('href="#/knowledge"'),'Public site must expose Knowledge native route');
  process.stdout.write(JSON.stringify({
    status:'pass',
    summary:'Real Knowledge push triggered main-owned Pages publication and public SHA-256 bytes match the validated 7-article artifact',
    evidence:[
      {type:'runtime',value:'Knowledge push Signal Run '+SIGNAL_RUN+' attempt '+signal.run_attempt+
        ' completed/success at '+SOURCE_SHA},
      {type:'runtime',value:'Trusted Pages Run '+PAGES_RUN+' attempt '+publisher.run_attempt+
        ' completed/success; event=workflow_run; main_sha='+publisher.head_sha},
      {type:'runtime',value:'Anonymous HTTPS data/knowledge.json: source '+json.source.sha+
        ', articles='+json.articles.length+', SHA-256='+digest+', native #/knowledge navigation present'},
      {type:'runtime',value:'Acceptance main SHA '+target+
        ' descends from publisher; public bytes match immutable witnessed publication'},
    ],
  })+'\n');
}
main().catch(error=>{
  process.stdout.write(JSON.stringify({
    status:'fail',summary:String(error?.message||error).slice(0,1800),
    evidence:[{type:'runtime',value:'GitHub signal/Pages Run or anonymous deployed Knowledge readback not verified'}],
  })+'\n');
  process.exitCode=1;
});
