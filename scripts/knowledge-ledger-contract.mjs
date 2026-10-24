#!/usr/bin/env node
// Canonical v2 project knowledge contract. One current Markdown per knowledge ID,
// topic-first navigation, category tags and ONE append-only global CHANGELOG.
// Git commits, not per-article vNNNN files, preserve historical snapshots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LEGACY_CHECKPOINT = '56a85f84f39ca806c58a4f410a0c4a72bade51a3';
const ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const ENTRY=/^topics\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([^/]+)\.md$/u;
const TITLE_BASE='8e5ab335212841898dac7a4be719ceed60750591';
const SHA=/^[a-f0-9]{40}$/;
const ACTIONS=new Set(['create','update','delete','rename','move','migrate']);
const HEADER='# Knowledge Changelog\n\n';
const fail=(message)=>{throw Error('knowledge-ledger: '+message);};
export function titleSlug(title) {
  if(typeof title!=='string'||!title.trim())fail('nonempty title required');
  const slug=title.normalize('NFKC').trim().toLowerCase()
    .replace(/[\s_]+/gu,'-').replace(/[^\p{L}\p{N}-]+/gu,'-')
    .replace(/-+/g,'-').replace(/^-|-$/g,'');
  if(!slug||Buffer.byteLength(slug+'.md')>255)
    fail('title must form a complete valid filename; revise the title, never truncate or invent an ID');
  return slug;
}
function utc(s) { return typeof s==='string' && UTC.test(s) && Number.isFinite(Date.parse(s)); }
function git(root,...args) {
  const p=spawnSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:2*1024*1024,env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1'}});
  if(p.status!==0)fail('git '+args[0]+' failed: '+(p.stderr||p.stdout).trim());
  return p.stdout.trimEnd();
}
function paths(root,part) {
  const start=path.join(root,part),out=[];
  if(!fs.existsSync(start))return out;
  function visit(dir,prefix) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const rel=prefix?prefix+'/'+entry.name:entry.name,full=path.join(dir,entry.name);
      if(entry.isSymbolicLink())fail('symlink is forbidden: '+rel);
      if(entry.isDirectory())visit(full,rel);
      else if(entry.isFile())out.push(part+'/'+rel);
      else fail('unsupported file type: '+rel);
    }
  }
  visit(start,'');return out.sort();
}
function scalar(input) {
  const v=input.trim();
  if(v.startsWith('"')) {
    try { const x=JSON.parse(v);if(typeof x!=='string')fail('invalid YAML quoted scalar');return x; }
    catch { fail('invalid quoted scalar '+v); }
  }
  if(v.startsWith("'")&&v.endsWith("'"))return v.slice(1,-1).replaceAll("''","'");
  if(!v || /[{}\[\]&#*!|>]/.test(v))fail('unsupported frontmatter scalar '+v);
  return v;
}
// Deliberate safe YAML subset: Skill-like scalar fields and JSON-compatible
// inline string arrays; both are ordinary YAML. No anchors, tags or nesting.
export function parseKnowledge(content,filename) {
  if(!content.startsWith('---\n'))fail(filename+': missing YAML frontmatter');
  const end=content.indexOf('\n---\n',4);
  if(end<0)fail(filename+': missing frontmatter closing fence');
  const front=content.slice(4,end).split('\n'),data={};
  for(const line of front) {
    const m=/^([a-z_]+):[ \t]*(.*)$/.exec(line);
    if(!m)fail(filename+': invalid YAML line '+line);
    const [,key,raw]=m;
    if(Object.hasOwn(data,key))fail(filename+': repeated field '+key);
    if(!['title','description','topic','categories','sources','status','created_at','updated_at'].includes(key))fail(filename+': unknown field '+key);
    if(key==='categories'||key==='sources') {
      let a;try{a=JSON.parse(raw);}catch{fail(filename+': '+key+' must be a YAML/JSON inline list');}
      if(!Array.isArray(a)||a.some(x=>typeof x!=='string'))fail(filename+': malformed '+key);
      data[key]=a;
    }else data[key]=scalar(raw);
  }
  for(const k of ['title','description','topic','categories','sources','status','created_at','updated_at'])
    if(!Object.hasOwn(data,k))fail(filename+': missing '+k);
  const match=ENTRY.exec(filename);
  if(!match||match[1]!==data.topic||match[2]!==titleSlug(data.title)||!ID.test(data.topic))
    fail(filename+': filename must match the complete title-derived slug and primary topic');
  if(!data.title.trim()||!data.description.trim())fail(filename+': blank title/description');
  if(!['verified','candidate'].includes(data.status))fail(filename+': unsupported status');
  if(!utc(data.created_at)||!utc(data.updated_at)||Date.parse(data.created_at)>Date.parse(data.updated_at))fail(filename+': invalid UTC times');
  const categories=new Set();
  for(const tag of data.categories) {
    if(!ID.test(tag)||categories.has(tag))fail(filename+': duplicate/invalid category '+tag);
    categories.add(tag);
  }
  if(data.status==='verified'&&!data.sources.some(s=>/^https:\/\/github\.com\/BestNathan\/nession\/blob\/[a-f0-9]{40}\//.test(s)))fail(filename+': verified assertion needs exact-SHA canonical source');
  for(const s of data.sources) {
    if(!/^https:\/\/github\.com\/BestNathan\/nession\/blob\/[a-f0-9]{40}\//.test(s)&&
       !/^https:\/\/github\.com\/BestNathan\/nession\/(?:issues|pull)\/[1-9]\d*$/.test(s))
      fail(filename+': source needs exact SHA or Issue/PR URL: '+s);
  }
  const body=content.slice(end+5).trim();
  if(!body||!body.startsWith('# '))fail(filename+': Markdown needs a titled body');
  return data;
}
export function indexFor(root) {
  const byTopic={},byCategory={};
  for(const file of paths(root,'topics')) {
    if(!ENTRY.test(file))fail('invalid topic knowledge filename '+file);
    const data=parseKnowledge(fs.readFileSync(path.join(root,file),'utf8'),file);
    const summary={title:data.title,description:data.description,path:file,
      status:data.status,categories:data.categories,updated_at:data.updated_at};
    (byTopic[data.topic]??=[]).push(summary);
    for(const category of data.categories)(byCategory[category]??=[]).push(file);
  }
  for(const list of Object.values(byTopic))list.sort((a,b)=>a.path.localeCompare(b.path));
  for(const list of Object.values(byCategory))list.sort();
  return {schema_version:2,topics:Object.fromEntries(Object.entries(byTopic).sort(([a],[b])=>a.localeCompare(b))),
    categories:Object.fromEntries(Object.entries(byCategory).sort(([a],[b])=>a.localeCompare(b)))};
}
export function logEntries(text) {
  if(!text.startsWith(HEADER))fail('CHANGELOG.md must start with canonical header');
  const rest=text.slice(HEADER.length);
  if(!rest.trim())return [];
  const blocks=rest.split(/(?=^## )/gm).filter(x=>x.trim());
  const events=[],seen=new Set();
  for(const block of blocks) {
    const lines=block.trimEnd().split('\n');
    const m=/^## (\S+) \| (create|update|delete|rename|move|migrate) \| (.+)$/.exec(lines[0]);
    if(!m||!utc(m[1])||!m[3].trim())fail('invalid change event heading '+lines[0]);
    const [,at,action,title]=m,meta={};
    for(const line of lines.slice(1)) {
      if(!line.trim())continue;
      const mm=/^- (Path|Previous path|Topic|Categories|Reason|Source): (.+)$/.exec(line);
      if(!mm||Object.hasOwn(meta,mm[1]))fail('invalid change log metadata '+line);
      meta[mm[1]]=mm[2];
    }
    for(const key of ['Path','Topic','Categories','Reason','Source'])if(!meta[key])fail('missing log field '+key);
    const entry=ENTRY.exec(meta.Path);
    if(!entry||entry[1]!==meta.Topic)fail('incorrect CHANGELOG topic/path');
    const legacy=action==='migrate'&&title==='repository-instruction-architecture'&&
      meta.Path==='topics/engineering/repository-instruction-architecture.md';
    if(!legacy&&entry[2]!==titleSlug(title))fail('CHANGELOG filename differs from full title');
    if(['rename','move'].includes(action)&&!meta['Previous path'])fail('rename/move needs Previous path');
    if(meta['Previous path']&&!ENTRY.test(meta['Previous path']))fail('invalid Previous path');
    if(!/^https:\/\/github\.com\/BestNathan\/nession\/(?:issues|pull)\/[1-9]\d*$/.test(meta.Source))
      fail('change log Source must link owning Issue or PR');
    const categories=meta.Categories==='none'?[]:meta.Categories.split(',').map(x=>x.trim());
    if(categories.some(x=>!ID.test(x)))fail('invalid change log categories');
    const key=at+'|'+action+'|'+meta.Path;
    if(seen.has(key))fail('duplicate change event '+key);
    if(events.length&&Date.parse(at)<Date.parse(events.at(-1).at))fail('CHANGELOG events must be chronological');
    seen.add(key);
    events.push({at,action,title,path:meta.Path,previous:meta['Previous path']||null,topic:meta.Topic,categories,reason:meta.Reason,source:meta.Source});
  }
  return events;
}
function verify(root,baseline=null) {
  for(const entry of fs.readdirSync(root)){
    if(!['.git','README.md','topics','index.json','CHANGELOG.md','schema'].includes(entry))
      fail('legacy/unexpected active knowledge path: '+entry);
  }
  const schemas=paths(root,'schema');
  if(schemas.length!==1||schemas[0]!=='schema/v2.json')fail('exactly one schema/v2.json must be active');
  const schema=JSON.parse(fs.readFileSync(path.join(root,'schema/v2.json'),'utf8'));
  if(schema.schema_version!==2||schema.filename!=='title-slug'||schema.primary_index!=='topic')
    fail('missing complete-title filename schema contract');
  const expected=indexFor(root),actual=JSON.parse(fs.readFileSync(path.join(root,'index.json'),'utf8'));
  if(JSON.stringify(actual)!==JSON.stringify(expected))fail('index.json differs from topic/category-derived index');
  const changeText=fs.readFileSync(path.join(root,'CHANGELOG.md'),'utf8'),events=logEntries(changeText);
  for(const list of Object.values(expected.topics))for(const entry of list){
    const history=events.filter(e=>e.path===entry.path);
    const latest=history.at(-1);
    if(!latest||latest.action==='delete'||latest.title!==entry.title)fail('current article has no full-title CHANGELOG event: '+entry.path);
    if(latest.topic!==entry.path.split('/')[1]||
       JSON.stringify([...latest.categories].sort())!==JSON.stringify([...entry.categories].sort()))
      fail('current topic/category metadata differs from latest changelog event: '+entry.path);
    if(['create','update','rename','move'].includes(latest.action)&&latest.at!==entry.updated_at)
      fail('current updated_at must match last change event timestamp: '+entry.path);
  }
  for(const file of paths(root,'topics').concat(['CHANGELOG.md'])) {
    const text=fs.readFileSync(path.join(root,file),'utf8');
    if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[a-zA-Z0-9_]{20,}|gh[pousr]_[a-zA-Z0-9]{30,}/.test(text))
      fail('public knowledge contains secret-like text: '+file);
  }
  // Immutable pre-v2 history is anchored by an exact commit in trusted main.
  // There is exactly one migration commit; after it, articles are mutable but
  // every change must have a same-commit global changelog event.
  const current=git(root,'rev-parse','HEAD');
  if(!SHA.test(current))fail('invalid checkout');
  git(root,'merge-base','--is-ancestor',LEGACY_CHECKPOINT,current);
  git(root,'merge-base','--is-ancestor',TITLE_BASE,current);
  const roots=command(root,'rev-list','--max-parents=0',current).split('\n').filter(Boolean);
  if(roots.length!==1||roots[0]!=='c91b60925b94792827198a31de739eeb50700cc3')fail('orphan root changed');
  if(baseline) {
    if(!SHA.test(baseline))fail('expected baseline must be an exact SHA');
    git(root,'merge-base','--is-ancestor',baseline,current);
  }
  const commits=git(root,'rev-list','--reverse','--first-parent',LEGACY_CHECKPOINT+'..HEAD').split('\n').filter(Boolean);
  if(!commits.length)fail('schema v2 migration has not occurred');
  let parent=LEGACY_CHECKPOINT;
  for(const [i,commit] of commits.entries()) {
    const parents=git(root,'rev-list','--parents','-n','1',commit).split(' ');
    if(parents.length!==2||parents[1]!==parent)fail('nonlinear knowledge history: '+commit);
    const changes=git(root,'diff','--name-status','--no-renames',parent,commit).split('\n').filter(Boolean)
      .map(s=>{const [status,file]=s.split('\t');return {status,file};});
    if(i===0) {
      if(!changes.some(x=>x.file==='schema/v2.json'&&x.status==='A')||
         !changes.some(x=>x.file==='CHANGELOG.md'&&x.status==='A')||
         !changes.some(x=>x.file.startsWith('topics/')&&x.status==='A'))
        fail('first descendant must be one-time v2 migration');
    } else {
      const prev=git(root,'show',parent+':CHANGELOG.md')+'\n';
      const next=git(root,'show',commit+':CHANGELOG.md')+'\n';
      if(!next.startsWith(prev)||next===prev)fail('global changelog must only append in every knowledge commit');
      const added=logEntries(next).slice(logEntries(prev).length);
      const modified=changes.filter(x=>x.file.startsWith('topics/'));
      const deletedIds=new Set(modified.filter(x=>x.status==='D'&&ENTRY.test(x.file))
        .map(x=>ENTRY.exec(x.file)[2]));
      for(const {file,status} of modified) {
        if(!ENTRY.test(file)||!['A','M','D'].includes(status))fail('unrecognized topic mutation '+file);
        const match=added.filter(e=>e.path===file);
        const action=match[0]?.action,id=ENTRY.exec(file)[2];
        if(match.length!==1||
          (status==='A'&&action!=='create'&&!(action==='move'&&deletedIds.has(id)))||
          (status==='M'&&action!=='update')||
          (status==='D'&&action!=='delete'))
          fail('knowledge modification needs one matching changelog event: '+file);
      }
      if(added.length!==modified.length)fail('changelog entries must map 1:1 to changed knowledge files');
      for(const change of changes)if(!change.file.startsWith('topics/')&&
         !(change.file==='CHANGELOG.md'&&change.status==='M')&&
         !(change.file==='index.json'&&change.status==='M'))
        fail('forbidden post-migration path change: '+change.file);
      if(!modified.length)fail('no knowledge files changed in changelog commit');
    }
    parent=commit;
  }
  return {topics:Object.keys(expected.topics).length,knowledge:Object.values(expected.topics).reduce((s,x)=>s+x.length,0),events:events.length,head:current};
}
function fixture() {
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-v2-'));
  const put=(file,text)=>{const p=path.join(d,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
  const at='2026-10-24T03:00:00Z';
  const record='---\nid: terminal-architecture\ntitle: Terminal architecture\ndescription: Session and terminal architecture\ntopic: terminal\ncategories: ["architecture", "protocol"]\nsources: ["https://github.com/BestNathan/nession/blob/'+'a'.repeat(40)+'/AGENTS.md"]\nstatus: verified\ncreated_at: '+at+'\nupdated_at: '+at+'\n---\n\n# Terminal architecture\n\nA stable sourced description.\n';
  try {
    put('topics/terminal/terminal-architecture.md',record);
    put('CHANGELOG.md',HEADER+'## '+at+' | create | terminal-architecture\n- Path: topics/terminal/terminal-architecture.md\n- Topic: terminal\n- Categories: architecture, protocol\n- Reason: Initial recorded knowledge\n- Source: https://github.com/BestNathan/nession/issues/2325\n');
    put('index.json',JSON.stringify(indexFor(d),null,2)+'\n');
    assert.equal(indexFor(d).topics.terminal[0].id,'terminal-architecture');
    assert.equal(indexFor(d).categories.architecture[0],'terminal-architecture');
    assert.equal(logEntries(fs.readFileSync(path.join(d,'CHANGELOG.md'),'utf8')).length,1);
    assert.throws(()=>parseKnowledge(record.replace('topic: terminal','topic: web'),'topics/terminal/terminal-architecture.md'),/topic\/id/);
    assert.throws(()=>parseKnowledge(record.replace('["architecture", "protocol"]','["architecture", "architecture"]'),'topics/terminal/terminal-architecture.md'),/category/);
    assert.throws(()=>parseKnowledge(record.replace('sources: ["https:','sources: ["http:'),'topics/terminal/terminal-architecture.md'),/source/);
    assert.throws(()=>logEntries(HEADER+'## '+at+' | create | invalid\n- Path: foo\n'),/topic\/id|field/);
    console.log('knowledge-ledger-contract: v2 topic index, category tags, frontmatter and global log fixtures passed');
  }finally{fs.rmSync(d,{recursive:true,force:true});}
}
const [cmd,root,base]=process.argv.slice(2);
try {
  if(cmd==='self-test')fixture();
  else if(cmd==='index'&&root){const file=path.join(path.resolve(root),'index.json');fs.writeFileSync(file,JSON.stringify(indexFor(path.resolve(root)),null,2)+'\n');console.log('knowledge topic/category index refreshed');}
  else if(cmd==='check'&&root){const r=verify(path.resolve(root),base||null);console.log('knowledge-ledger-contract: PASS '+JSON.stringify(r));}
  else fail('usage: self-test | index <ledger-worktree> | check <ledger-worktree> [<expected-base-sha>]');
}catch(error){console.error(error.message);process.exitCode=1;}
