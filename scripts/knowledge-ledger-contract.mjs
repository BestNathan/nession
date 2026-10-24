#!/usr/bin/env node
// Canonical v2 project knowledge contract. One current Markdown per complete title,
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
export function parseKnowledge(content,filename,{requireVerifiedSource=true}={}) {
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
  if(requireVerifiedSource&&data.status==='verified'&&!data.sources.some(s=>/^https:\/\/github\.com\/BestNathan\/nession\/blob\/[a-f0-9]{40}\//.test(s)))fail(filename+': verified assertion needs exact-SHA canonical source');
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
export function validateArticleLinks(root, articleFiles=paths(root,'topics').filter(f=>f.endsWith('.md'))) {
  const articleSet=new Set(articleFiles),incoming=new Map(articleFiles.map(f=>[f,0])),headingCache=new Map();
  const slugHeading=(s)=>s.toLowerCase().normalize('NFKC').trim()
    .replace(/[\`*_~]/g,'').replace(/[^\p{L}\p{N}\s-]/gu,'').replace(/\s+/g,'-').replace(/-+/g,'-');
    const headingsFor=(file)=>{if(!headingCache.has(file)){const text=fs.readFileSync(path.join(root,file),'utf8');const hs=new Set(text.split('\n').filter(line=>/^#{1,6}\s+/.test(line)).map(line=>slugHeading(line.replace(/^#{1,6}\s+/,'').replace(/\s+#+\s*$/,''))));headingCache.set(file,hs);}return headingCache.get(file);};
  for(const file of articleFiles) {
    const content=fs.readFileSync(path.join(root,file),'utf8');
    const headings=new Set([...content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map(m=>slugHeading(m[1])));
    const links=[...content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g)].map(m=>m[1].replace(/^<|>$/g,''));
    for(const raw of links) {
      if(/^(?:https?:|mailto:|tel:|data:|\/\/)/i.test(raw))continue;
      const [pathname,fragmentRaw]=raw.split('#',2);
      let target;
      try { target=decodeURIComponent(pathname||''); }
      catch { fail(file+': malformed local link '+raw); }
      const targetFile=target?path.posix.normalize(path.posix.join(path.posix.dirname(file),target)):file;
      if(targetFile==='..'||targetFile.startsWith('../')||targetFile.startsWith('/'))
        fail(file+': local link escapes knowledge root: '+raw);
      if(!fs.existsSync(path.join(root,targetFile))||!fs.statSync(path.join(root,targetFile)).isFile())
        fail(file+': broken local link '+raw+' -> '+targetFile);
      if(fragmentRaw) {
        let fragment;
        try { fragment=decodeURIComponent(fragmentRaw); }
        catch { fail(file+': malformed link fragment '+raw); }
        if(!headingsFor(targetFile).has(fragment.toLowerCase()))
          fail(file+': broken local heading anchor '+raw);
      }
      if(articleSet.has(targetFile)&&targetFile!==file)incoming.set(targetFile,(incoming.get(targetFile)||0)+1);
    }
  }
  for(const file of articleFiles)if((incoming.get(file)||0)===0)
    fail('orphan article has no incoming cross-link: '+file);
  return {articles:articleFiles.length,localLinks:'valid',orphans:0};
}
function assertIndexCurrent(root) {
  const expected=indexFor(root),actual=JSON.parse(fs.readFileSync(path.join(root,'index.json'),'utf8'));
  if(JSON.stringify(actual)!==JSON.stringify(expected))fail('index.json differs from topic/category-derived index');
  return expected;
}
function latestEventForArticle(entry,events) {
  const latest=events.filter(e=>e.path===entry.path).at(-1);
  if(!latest||latest.action==='delete'||latest.title!==entry.title)
    fail('current article missing changelog event: '+entry.path);
  if(latest.topic!==entry.path.split('/')[1]||
     JSON.stringify([...latest.categories].sort())!==JSON.stringify([...entry.categories].sort()))
    fail('article metadata differs from latest changelog event: '+entry.path);
  if(['create','update','rename','move'].includes(latest.action)&&latest.at!==entry.updated_at)
    fail('article timestamp differs from latest changelog event: '+entry.path);
  return latest;
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
  const expected=assertIndexCurrent(root);
  validateArticleLinks(root);
  const changeText=fs.readFileSync(path.join(root,'CHANGELOG.md'),'utf8'),events=logEntries(changeText);
  for(const list of Object.values(expected.topics))for(const entry of list)latestEventForArticle(entry,events);
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
  const roots=git(root,'rev-list','--max-parents=0',current).split('\n').filter(Boolean);
  if(roots.length!==1||roots[0]!=='c91b60925b94792827198a31de739eeb50700cc3')fail('orphan root changed');
  if(baseline) {
    if(!SHA.test(baseline))fail('expected baseline must be an exact SHA');
    git(root,'merge-base','--is-ancestor',baseline,current);
  }
  // V2_HEAD contains the last abbreviation-based article. The next commit is
  // a one-time, append-only title correction. Subsequent commits are ordinary
  // changes to current Markdown and MUST append the shared changelog.
  const commits=git(root,'rev-list','--reverse','--first-parent',TITLE_BASE+'..HEAD').split('\n').filter(Boolean);
  if(!commits.length)fail('title-derived filename migration is missing');
  let parent=TITLE_BASE;
  for(const [i,commit] of commits.entries()){
    const parents=git(root,'rev-list','--parents','-n','1',commit).split(' ');
    if(parents.length!==2||parents[1]!==parent)fail('nonlinear knowledge history');
    const diff=git(root,'diff','--name-status','--no-renames',parent,commit).split('\n')
      .filter(Boolean).map(x=>{const [status,file]=x.split('\t');return {status,file};});
    const before=git(root,'show',parent+':CHANGELOG.md')+'\n';
    const after=git(root,'show',commit+':CHANGELOG.md')+'\n';
    if(!after.startsWith(before)||after===before)fail('global CHANGELOG was rewritten or not appended');
    const added=logEntries(after).slice(logEntries(before).length);
    const articles=diff.filter(c=>c.file.startsWith('topics/'));
    const used=new Set();
    for(const e of added){
      const current=articles.find(c=>c.file===e.path);
      const previous=e.previous&&articles.find(c=>c.file===e.previous);
      if(e.action==='rename'||e.action==='move'){
        if(!current||current.status!=='A'||!previous||previous.status!=='D')
          fail('renaming requires a deleted/added Markdown path pair');
        if(e.action==='rename'&&ENTRY.exec(e.previous)[1]!==e.topic)
          fail('use move if topic changed');
        if(e.action==='move'&&ENTRY.exec(e.previous)[1]===e.topic)
          fail('use rename if topic did not change');
      }else{
        const status={create:'A',update:'M',delete:'D'}[e.action];
        if(!status||!current||current.status!==status||e.previous)
          fail('CHANGELOG action differs from Git tree: '+e.path);
      }
      for(const filename of [e.path,e.previous].filter(Boolean)){
        if(used.has(filename))fail('duplicate change event for '+filename);
        used.add(filename);
      }
      if(e.action!=='delete'){
        const atCommit=git(root,'show',commit+':'+e.path)+'\n';
        // Historical snapshots remain immutable evidence: validate their schema and every source they do contain,
        // but enforce the current verified-source policy only on the live tree via indexFor(root).
        const data=parseKnowledge(atCommit,e.path,{requireVerifiedSource:false});
        if(data.title!==e.title||data.updated_at!==e.at||
           JSON.stringify([...data.categories].sort())!==JSON.stringify([...e.categories].sort()))
          fail('article and appended CHANGELOG event disagree: '+e.path);
      }
    }
    if(!articles.length||used.size!==articles.length)
      fail('each article mutation requires a matching global log event');
    for(const change of diff){
      if(change.file.startsWith('topics/'))continue;
      if(change.file==='CHANGELOG.md'&&change.status==='M')continue;
      if(change.file==='index.json'&&change.status==='M')continue;
      if(i===0&&change.status==='M'&&['schema/v2.json','README.md'].includes(change.file))continue;
      fail('forbidden knowledge commit modification: '+change.status+' '+change.file);
    }
    if(i===0){
      if(added.length!==1||added[0].action!=='rename'||
         added[0].previous!=='topics/engineering/repository-instruction-architecture.md')
        fail('first post-v2 commit must correct the shortened article title filename');
      if(!diff.some(c=>c.file==='schema/v2.json'&&c.status==='M'))
        fail('full-title filename migration must update schema/v2.json');
    }
    parent=commit;
  }
  return {topics:Object.keys(expected.topics).length,knowledge:Object.values(expected.topics).reduce((s,x)=>s+x.length,0),events:events.length,head:current};
}
function fixture() {
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'nession-knowledge-title-'));
  const put=(file,text)=>{const p=path.join(d,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
  const at='2026-10-24T03:00:00Z';
  const slugHeadingForFixture=(s)=>s.toLowerCase().replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-');
  const title='Nession instruction architecture and knowledge ownership',slug=titleSlug(title);
  const file='topics/engineering/'+slug+'.md';
  const article='---\ntitle: "'+title+'"\ndescription: Full descriptive name\ntopic: engineering\ncategories: ["architecture", "knowledge"]\nsources: ["https://github.com/BestNathan/nession/blob/'+'a'.repeat(40)+'/AGENTS.md"]\nstatus: verified\ncreated_at: '+at+'\nupdated_at: '+at+'\n---\n\n# '+title+'\n\nCurrent knowledge.\n';
  try {
    assert.equal(slug,'nession-instruction-architecture-and-knowledge-ownership');
    assert.equal(titleSlug('终端 tmux 控制模式'),'终端-tmux-控制模式');
    put(file,article);
    const idx=indexFor(d);
    assert.equal(idx.topics.engineering[0].title,title);
    assert.deepEqual(idx.categories.knowledge,[file]);
    const secondTitle='Knowledge link fixture',secondSlug=titleSlug(secondTitle);
    const secondFile='topics/engineering/'+secondSlug+'.md';
    put(secondFile,article.replaceAll(title,secondTitle).replaceAll(slug,secondSlug)
      .replace('# '+secondTitle,'# '+secondTitle)+'\nSee [architecture](./'+slug+'.md#'+slugHeadingForFixture(title)+').\n');
    put(file,article+'\nSee [related fixture](./'+secondSlug+'.md).\n');
    assert.equal(validateArticleLinks(d,[file,secondFile]).orphans,0);
    assert.throws(()=>validateArticleLinks(d,[file]),/orphan article/);
    put(secondFile,fs.readFileSync(path.join(d,secondFile),'utf8').replace('./'+slug+'.md#'+slugHeadingForFixture(title),'./missing.md'));
    assert.throws(()=>validateArticleLinks(d,[file,secondFile]),/broken local link/);
    put(secondFile,fs.readFileSync(path.join(d,secondFile),'utf8').replace('./missing.md','./'+slug+'.md#not-a-real-heading'));
    assert.throws(()=>validateArticleLinks(d,[file,secondFile]),/broken local heading anchor/);
    put(secondFile,fs.readFileSync(path.join(d,secondFile),'utf8').replace('./'+slug+'.md#not-a-real-heading','./'+slug+'.md'));
    const updatedIdx=indexFor(d);
    put('index.json',JSON.stringify(updatedIdx));
    assert.doesNotThrow(()=>assertIndexCurrent(d));
    put('index.json','{}');
    assert.throws(()=>assertIndexCurrent(d),/index.json differs/);
    const missingVerifiedSource=article.replace('sources: ["https://github.com/BestNathan/nession/blob/'+'a'.repeat(40)+'/AGENTS.md"]','sources: []');
    assert.throws(()=>parseKnowledge(missingVerifiedSource,file),/verified assertion needs exact-SHA/);
    assert.doesNotThrow(()=>parseKnowledge(missingVerifiedSource,file,{requireVerifiedSource:false}));
    assert.throws(()=>parseKnowledge(article,'topics/engineering/repository-instruction-architecture.md'),/complete title/);
    assert.throws(()=>parseKnowledge(article.replace('title:', 'id: short\n'+'title:'),file),/unknown field/);
    assert.throws(()=>parseKnowledge(article.replace('"architecture", "knowledge"','"architecture", "architecture"'),file),/duplicate/);
    const log=HEADER+'## '+at+' | create | '+title+'\n- Path: '+file+'\n- Topic: engineering\n- Categories: architecture, knowledge\n- Reason: Initial article\n- Source: https://github.com/BestNathan/nession/issues/2325\n';
    assert.equal(logEntries(log)[0].title,title);
    const currentEntry={path:file,title,topic:'engineering',categories:['architecture','knowledge'],updated_at:at};
    assert.equal(latestEventForArticle(currentEntry,logEntries(log)).action,'create');
    assert.throws(()=>latestEventForArticle(currentEntry,[]),/missing changelog event/);
    assert.throws(()=>logEntries(log.replace(slug+'.md','short.md')),/full title/);
    console.log('knowledge-ledger-contract: full title slug, Unicode, no synthetic IDs, topic/category index, global log fixtures passed');
  }finally{fs.rmSync(d,{recursive:true,force:true});}
}
const [cmd,root,base]=process.argv.slice(2);
try {
  if(cmd==='self-test')fixture();
  else if(cmd==='index'&&root){const file=path.join(path.resolve(root),'index.json');fs.writeFileSync(file,JSON.stringify(indexFor(path.resolve(root)),null,2)+'\n');console.log('knowledge topic/category index refreshed');}
  else if(cmd==='check'&&root){const r=verify(path.resolve(root),base||null);console.log('knowledge-ledger-contract: PASS '+JSON.stringify(r));}
  else fail('usage: self-test | index <ledger-worktree> | check <ledger-worktree> [<expected-base-sha>]');
}catch(error){console.error(error.message);process.exitCode=1;}
