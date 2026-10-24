#!/usr/bin/env node
// Validates the curated orphan knowledge ledger without requiring credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const idOk = s => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
const revOk = s => typeof s === 'string' && /^v[0-9]{4}$/.test(s);
const shaOk = s => typeof s === 'string' && /^[a-f0-9]{40}$/i.test(s);
const hashOk = s => typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s);
const utcOk = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(s) && Number.isFinite(Date.parse(s));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function scan(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const visit = (p, prefix) => {
    for (const ent of fs.readdirSync(p, {withFileTypes:true})) {
      if (ent.isSymbolicLink()) throw Error('symlink not permitted: '+ent.name);
      const rel = prefix ? prefix+'/'+ent.name : ent.name, file = path.join(p,ent.name);
      if (ent.isDirectory()) visit(file,rel);
      else if (ent.isFile()) out.push(rel);
      else throw Error('unsupported filesystem object: '+rel);
    }
  };
  visit(dir,''); return out.sort();
}
function command(root,...args) {
  const p=spawnSync('git',['-C',root,...args],{encoding:'utf8'});
  if (p.status!==0) throw Error('git '+args.join(' ')+': '+(p.stderr||p.stdout).trim());
  return p.stdout.trim();
}
function verify(root,base=null) {
  const bad=[];
  const problem=x=>bad.push(x);
  const load=p=>{
    try{return JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));}
    catch(e){problem('bad JSON or missing '+p+': '+e.message);return null;}
  };
  try {
    const schema=load('schema/v1.json'), index=load('index.json');
    if (schema?.schema_version!==1) problem('unsupported ledger schema');
    if (index?.schema_version!==1 || !Array.isArray(index?.entries)) return [...bad,'invalid index shape'];
    if (!utcOk(index.updated_at)) problem('index missing UTC updated_at');
    const eventNames=scan(path.join(root,'events')).filter(x=>x.endsWith('.json'));
    const events=[];
    for(const filename of eventNames){
      const e=load('events/'+filename);if(!e)continue;
      if(e.schema_version!==1 || !idOk(e.id) || !['create','verify','revise','supersede','retract'].includes(e.action)) problem('invalid event: '+filename);
      if(!utcOk(e.recorded_at) || filename.slice(0,10)!==e.recorded_at?.slice(0,10).replaceAll('-','/')) problem('invalid event UTC date: '+filename);
      if(!e.actor || !e.reason || typeof e.source_issue!=='string' || !e.source_issue.startsWith('https://github.com/')) problem('event missing lineage: '+filename);
      events.push({...e,eventPath:'events/'+filename});
    }
    const entries=scan(path.join(root,'entries')), meta=new Map(), byId=new Map();
    for(const filename of entries.filter(x=>x.endsWith('.json'))){
      const match=/^([a-z0-9]+(?:-[a-z0-9]+)*)\/(v[0-9]{4})\.json$/.exec(filename);
      if(!match){problem('invalid revision path: '+filename);continue;}
      const [,id,rev]=match, m=load('entries/'+filename), doc='entries/'+id+'/'+rev+'.md';
      if(!m)continue;
      if(!fs.existsSync(path.join(root,doc))){problem('missing Markdown '+doc);continue;}
      const digest=sha256(fs.readFileSync(path.join(root,doc)));
      if(m.schema_version!==1 || m.id!==id || m.revision!==rev || !['candidate','verified','superseded','retracted'].includes(m.status) || !hashOk(m.content_sha256) || m.content_sha256!==digest) problem('revision/hash mismatch: '+filename);
      if(!utcOk(m.created_at)||!utcOk(m.recorded_at)||(m.verified_at!==null&&!utcOk(m.verified_at))||(m.effective_at!==null&&!utcOk(m.effective_at))) problem('invalid revision UTC: '+filename);
      if(!m.title || !m.category || !Array.isArray(m.tags)||!Array.isArray(m.sources)) problem('incomplete revision metadata: '+filename);
      if(m.status==='verified'){
        if(!utcOk(m.verified_at)||!m.sources?.length) problem('verified without proof: '+filename);
        for(const s of m.sources||[]) if(!shaOk(s.sha)||typeof s.url!=='string'||!s.url.startsWith('https://github.com/')||!s.url.includes('/'+s.sha+'/')) problem('unversioned source: '+filename);
      }
      const matching=events.filter(e=>e.id===id&&e.new_revision===rev&&e.content_sha256===digest);
      if(matching.length!==1 || matching[0].recorded_at!==m.recorded_at) problem('missing/ambiguous revision event: '+filename);
      meta.set(id+'@'+rev,{...m,doc,metadata:'entries/'+filename});
      if(!byId.has(id))byId.set(id,[]);
      byId.get(id).push(rev);
    }
    for(const filename of entries.filter(x=>x.endsWith('.md'))) if(!entries.includes(filename.replace(/\.md$/,'.json'))) problem('Markdown missing metadata: '+filename);
    for(const e of events){
      if(e.id==='knowledge-ledger-bootstrap' && e.new_revision===null) continue;
      if(!meta.has(e.id+'@'+e.new_revision)) problem('orphaned event '+e.eventPath);
      if(e.new_revision==='v0001' && e.previous_revision!==null) problem('first event has predecessor '+e.eventPath);
      if(e.new_revision!=='v0001' && !meta.has(e.id+'@'+e.previous_revision)) problem('revision missing predecessor '+e.eventPath);
    }
    const ids=new Set();
    for(const e of index.entries){
      if(!idOk(e.id)||!revOk(e.revision)||ids.has(e.id)){problem('duplicate/invalid index id');continue;}
      ids.add(e.id);
      const m=meta.get(e.id+'@'+e.revision);
      if(!m || m.doc!==e.path || m.metadata!==e.metadata_path || m.status!==e.status || m.content_sha256!==e.content_sha256 || m.title!==e.title || m.category!==e.category) problem('index mismatch '+e.id);
      if(e.revision!==byId.get(e.id)?.sort().at(-1)) problem('stale index '+e.id);
    }
    for(const [id,versions] of byId){
      if(!ids.has(id))problem('missing index entry '+id);
      const sorted=versions.sort();
      for(let i=0;i<sorted.length;i++)if(sorted[i]!=='v'+String(i+1).padStart(4,'0'))problem('revision gap '+id);
    }
    for(const filename of scan(path.join(root,'receipts')).filter(x=>x.endsWith('.json'))){
      const r=load('receipts/'+filename);if(!r)continue;
      if(r.schema_version!==1 || !shaOk(r.commit_sha) || !hashOk(r.content_sha256) || !utcOk(r.written_at) || r.branch!=='refs/heads/knowledge'||!events.some(e=>e.eventPath===r.event_path)||typeof r.record_path!=='string'||!fs.existsSync(path.join(root,r.record_path))||sha256(fs.readFileSync(path.join(root,r.record_path)))!==r.content_sha256) {
        problem('invalid receipt '+filename);continue;
      }
      // The receipt must refer to a real ancestor commit containing the exact
      // event and content bytes. A string matching a SHA shape is not proof.
      try {
        command(root,'merge-base','--is-ancestor',r.commit_sha,'HEAD');
        const atCommit=command(root,'show',r.commit_sha+':'+r.record_path);
        if(sha256(Buffer.from(atCommit+'\n'))!==r.content_sha256)problem('receipt historical bytes mismatch '+filename);
        command(root,'cat-file','-e',r.commit_sha+':'+r.event_path);
      }catch(e){problem('receipt ancestry/source mismatch '+filename+': '+e.message);}
    }
    // Reject high-confidence secret formats in the entire public ledger.
    // This is a defense-in-depth filter, never a substitute for secret scanning.
    for(const group of ['entries','events','receipts']){
      for(const filename of scan(path.join(root,group))){
        const content=fs.readFileSync(path.join(root,group,filename),'utf8');
        if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}/.test(content))
          problem('public ledger contains secret-like material '+group+'/'+filename);
      }
    }
    if(base){
      if(!shaOk(base))throw Error('trusted audit baseline must be an exact commit SHA');
      command(root,'merge-base','--is-ancestor',base,'HEAD');
      // Check EACH first-parent commit, not only base..HEAD final diff.
      // A malicious fast-forward edit followed by a restore must still fail.
      const chain=command(root,'rev-list','--reverse','--first-parent',base+'..HEAD').split('\n').filter(Boolean);
      let parent=base;
      for(const commit of chain){
        const parents=command(root,'rev-list','--parents','-n','1',commit).split(' ');
        if(parents.length!==2||parents[1]!==parent)problem('nonlinear/orphan history graft '+commit);
        const diff=command(root,'diff','--name-status','--no-renames',parent,commit).split('\n').filter(Boolean);
        let addedEvent=false,addedEntry=false,indexModified=false;
        for(const line of diff){
          const [action,filename]=line.split('\t');
          if(action==='M'&&filename==='index.json'){indexModified=true;continue;}
          if(action==='A'&&/^(entries\/|events\/|schema\/|receipts\/)/.test(filename)){
            if(filename.startsWith('events/'))addedEvent=true;
            if(filename.startsWith('entries/'))addedEntry=true;
            continue;
          }
          problem('forbidden historical mutation '+commit+': '+line);
        }
        if(indexModified&&(!addedEntry||!addedEvent))
          problem('index advanced without new entry/event in same commit '+commit);
        parent=commit;
      }
    }
  }catch(e){problem('contract error: '+e.message);}
  return bad;
}
function selfTest(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-knowledge-'));
  const put=(p,s)=>{const f=path.join(dir,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};
  const stamp='2026-10-24T03:00:00Z',id='sample-knowledge',rev='v0001',md='# Test sourced fact\n',hash=sha256(md);
  const meta={schema_version:1,id,revision:rev,title:'Fact',category:'engineering',tags:['test'],status:'verified',created_at:stamp,recorded_at:stamp,verified_at:stamp,effective_at:null,sources:[{url:'https://github.com/BestNathan/nession/blob/'+ 'a'.repeat(40) +'/AGENTS.md',sha:'a'.repeat(40)}],content_sha256:hash};
  const event={schema_version:1,id,action:'create',recorded_at:stamp,actor:'fixture',reason:'regression',source_issue:'https://github.com/BestNathan/nession/issues/2325',previous_revision:null,new_revision:rev,content_sha256:hash};
  const index={schema_version:1,updated_at:stamp,entries:[{id,title:'Fact',category:'engineering',revision:rev,status:'verified',path:'entries/'+id+'/'+rev+'.md',metadata_path:'entries/'+id+'/'+rev+'.json',content_sha256:hash}]};
  const writeJson=(p,obj)=>put(p,JSON.stringify(obj,null,2)+'\n');
  const ep='entries/'+id+'/'+rev,ev='events/2026/10/24/test.json';
  try{
    writeJson('schema/v1.json',{schema_version:1});put(ep+'.md',md);writeJson(ep+'.json',meta);writeJson(ev,event);writeJson('index.json',index);
    assert.deepEqual(verify(dir),[],'good ledger');
    put(ep+'.md','bad');assert.ok(verify(dir).some(s=>s.includes('revision/hash mismatch')),'tampered content');
    put(ep+'.md',md);writeJson('index.json',{...index,entries:[{...index.entries[0],revision:'v0002'}]});assert.ok(verify(dir).some(s=>s.includes('index')),'stale pointer');
    writeJson('index.json',index);fs.rmSync(path.join(dir,ev));assert.ok(verify(dir).some(s=>s.includes('revision event')),'missing event');
    writeJson(ev,{...event,recorded_at:'2026-10-25T03:00:00Z'});assert.ok(verify(dir).some(s=>s.includes('event UTC date')),'event timestamp mismatch');
    writeJson(ev,event);assert.deepEqual(verify(dir),[],'restored baseline');
    command(dir,'init','-q');command(dir,'config','user.name','Fixture');command(dir,'config','user.email','fixture@example.invalid');
    command(dir,'add','.');command(dir,'commit','-qm','baseline');const base=command(dir,'rev-parse','HEAD');
    put(ep+'.md','tamper');command(dir,'add','.');command(dir,'commit','-qm','illegal edit');
    assert.ok(verify(dir,base).some(s=>s.includes('forbidden historical mutation')),'destructive fast-forward');
    put(ep+'.md',md);command(dir,'add','.');command(dir,'commit','-qm','restore corrupted bytes');
    assert.ok(verify(dir,base).some(s=>s.includes('forbidden historical mutation')),'history edit then restoration still rejected');
    console.log('knowledge-ledger-contract: history-path and content integrity fixtures passed');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
const [action,root,base]=process.argv.slice(2);
if(action==='self-test') selfTest();
else if(action==='check' && root){const errors=verify(path.resolve(root),base||null);if(errors.length){for(const e of errors)console.error(e);process.exitCode=1;}else console.log('knowledge-ledger-contract: PASS');}
else{console.error('usage: knowledge-ledger-contract.mjs self-test | check <knowledge-worktree> [<base-sha>]');process.exitCode=2;}
