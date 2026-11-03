// A bounded, read-only projection of the separately governed Knowledge orphan ref.
// The trusted workflow checks the canonical ledger contract before this builder.
// Browser rendering MUST treat all body text as untrusted, never as HTML.
import {readFile, lstat} from 'node:fs/promises';
import {resolve, join, sep} from 'node:path';

const SHA=/^[a-f0-9]{40}$/;
const TOPIC=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTICLE=/^topics\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([^/]+)\.md$/u;
const UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const SOURCE=/^https:\/\/github\.com\/BestNathan\/nession\/(?:blob\/[a-f0-9]{40}\/[^\s?#]+|(?:issues|pull)\/[1-9]\d*)$/;
const PRIVATE=/(?:\b(?:10|127)\.(?:\d{1,3}\.){2}\d{1,3}\b|\b192\.168\.(?:\d{1,3}\.)\d{1,3}\b|\/(?:Users|home|etc|root)\/|\b(?:gh[pousr]_|github_pat_|sk-)[a-z0-9_-]{16,}\b)/i;
const MAX_ARTICLES=200, MAX_EVENTS=2000, MAX_BODY=160_000;
const error=(reason)=>{throw new Error('public knowledge projection: '+reason);};
const slug=title=>title.normalize('NFKC').trim().toLowerCase()
  .replace(/[\s_]+/gu,'-').replace(/[^\p{L}\p{N}-]+/gu,'-')
  .replace(/-+/g,'-').replace(/^-|-$/g,'');
const validUtc=s=>typeof s==='string'&&UTC.test(s)&&Number.isFinite(Date.parse(s));
function plain(value,max=300){
  if(typeof value!=='string'||!value.trim()||value.length>max||PRIVATE.test(value))
    error('invalid or nonpublic text');
  return value;
}
function safePath(value){
  if(typeof value!=='string'||value.length>300||value.includes('..')||value.includes('\\')||
     !ARTICLE.test(value))error('invalid article path');
  return value;
}
function frontmatter(file,raw) {
  if(typeof raw!=='string'||raw.length>MAX_BODY||!raw.startsWith('---\n'))error('invalid article file '+file);
  const fence=raw.indexOf('\n---\n',4);
  if(fence<0)error('article frontmatter not closed '+file);
  const result={};
  for(const line of raw.slice(4,fence).split('\n')){
    const m=/^([a-z_]+):[ \t]*(.*)$/.exec(line);
    if(!m||Object.hasOwn(result,m[1])||
      !['title','description','topic','categories','sources','status','created_at','updated_at'].includes(m[1]))
      error('invalid article frontmatter '+file);
    const key=m[1],value=m[2];
    if(['categories','sources'].includes(key)||value.startsWith('"')){
      try {result[key]=JSON.parse(value);}catch {error('invalid frontmatter scalar '+file);}
    } else result[key]=value.trim();
  }
  for(const key of ['title','description','topic','categories','sources','status','created_at','updated_at'])
    if(!Object.hasOwn(result,key))error('missing frontmatter field '+key);
  const match=ARTICLE.exec(file);
  if(!match||result.topic!==match[1]||slug(result.title)!==match[2]||!TOPIC.test(result.topic))
    error('article path/title/topic mismatch '+file);
  plain(result.title,250); plain(result.description,600);
  if(!['verified','candidate'].includes(result.status)||
    !validUtc(result.created_at)||!validUtc(result.updated_at)||
    Date.parse(result.created_at)>Date.parse(result.updated_at))error('invalid article status/timestamps');
  if(!Array.isArray(result.categories)||result.categories.some(t=>!TOPIC.test(t))||
    new Set(result.categories).size!==result.categories.length)error('invalid category tags');
  if(!Array.isArray(result.sources)||result.sources.some(s=>typeof s!=='string'||!SOURCE.test(s)))
    error('invalid article source');
  if(result.status==='verified'&&!result.sources.some(s=>s.includes('/blob/')))
    error('verified article missing immutable source');
  const body=raw.slice(fence+5).trim();
  if(!body.startsWith('# ')||PRIVATE.test(body))error('invalid or sensitive article body '+file);
  return {...result,path:file,body};
}
function changelogEntries(content){
  if(typeof content!=='string'||content.length>500_000||!content.startsWith('# Knowledge Changelog\n\n'))
    error('invalid global changelog');
  const blocks=content.slice('# Knowledge Changelog\n\n'.length)
    .split(/(?=^## )/gm).filter(x=>x.trim());
  if(blocks.length>MAX_EVENTS)error('too many changelog events');
  return blocks.map(block=>{
    const [head,...lines]=block.trim().split('\n');
    const match=/^## (\S+) \| (create|update|delete|rename|move|migrate) \| (.+)$/.exec(head);
    if(!match||!validUtc(match[1]))error('invalid changelog timestamp/action');
    const meta={};
    for(const line of lines){
      if(!line.trim())continue;
      const m=/^- (Path|Previous path|Topic|Categories|Reason|Source): (.+)$/.exec(line);
      if(!m||Object.hasOwn(meta,m[1]))error('invalid changelog metadata');
      meta[m[1]]=m[2];
    }
    const path=safePath(meta.Path),topic=plain(meta.Topic,80),title=plain(match[3],250);
    if(ARTICLE.exec(path)[1]!==topic||!TOPIC.test(topic)||!SOURCE.test(meta.Source)||
      !meta.Source.match(/\/(?:issues|pull)\//))error('invalid changelog provenance');
    if(meta['Previous path'])safePath(meta['Previous path']);
    if(['rename','move'].includes(match[2])&&!meta['Previous path'])
      error('missing previous path');
    const categories=meta.Categories==='none'?[]:String(meta.Categories||'').split(',').map(s=>s.trim());
    if(categories.some(x=>!TOPIC.test(x)))error('invalid changelog categories');
    return {at:match[1],action:match[2],title,path,previous_path:meta['Previous path']||null,
      topic,categories,reason:plain(meta.Reason,1400),source:meta.Source};
  }).sort((a,b)=>b.at.localeCompare(a.at));
}
export function unavailableKnowledge(){
  return {schema_version:1,status:'unavailable',source:null,topics:[],categories:[],
    articles:[],changes:[]};
}
export function projectKnowledge({index,files,changelog,sha,generatedAt}){
  if(!SHA.test(sha)||!validUtc(generatedAt)||index?.schema_version!==2||
    !index.topics||typeof index.topics!=='object'||Array.isArray(index.topics)||
    !index.categories||typeof index.categories!=='object'||Array.isArray(index.categories))
    error('invalid index or pinned SHA');
  const summaries=Object.entries(index.topics).flatMap(([topic,entries])=>{
    if(!TOPIC.test(topic)||!Array.isArray(entries))error('invalid topics');
    return entries.map(entry=>({...entry,topic}));
  });
  if(summaries.length>MAX_ARTICLES||new Set(summaries.map(x=>x.path)).size!==summaries.length)
    error('duplicate or oversized article index');
  if(Object.keys(files).length!==summaries.length)error('article and index file set mismatch');
  const articles=summaries.map(summary=>{
    const path=safePath(summary.path);
    if(!Object.hasOwn(files,path))error('missing indexed article '+path);
    const data=frontmatter(path,files[path]);
    for(const key of ['title','description','status','updated_at'])
      if(data[key]!==summary[key])error('stale article index '+key);
    if(summary.topic!==data.topic||JSON.stringify(data.categories)!==JSON.stringify(summary.categories))
      error('index topic/category mismatch');
    return data;
  });
  const expected={};
  for(const entry of articles)for(const tag of entry.categories)(expected[tag]??=[]).push(entry.path);
  const cats=Object.keys(index.categories);
  if(JSON.stringify(cats.sort())!==JSON.stringify(Object.keys(expected).sort()))
    error('category index drift');
  for(const tag of cats){
    if(!Array.isArray(index.categories[tag])||
      JSON.stringify([...index.categories[tag]].sort())!==JSON.stringify(expected[tag].sort()))
      error('category path index drift');
  }
  const changes=changelogEntries(changelog);
  for(const article of articles){
    if(!changes.some(x=>x.path===article.path&&x.title===article.title&&x.at===article.updated_at))
      error('missing latest article changelog '+article.path);
  }
  return {schema_version:1,status:'available',
    source:{branch:'knowledge',sha,generated_at:generatedAt},
    topics:Object.keys(index.topics).sort(),categories:cats.sort(),
    articles:articles.sort((a,b)=>b.updated_at.localeCompare(a.updated_at)),
    changes};
}
async function readBounded(base,path,limit){
  const full=resolve(base,path);
  if(!full.startsWith(resolve(base)+sep))error('file escaped knowledge checkout');
  const stat=await lstat(full);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)error('invalid knowledge file '+path);
  return readFile(full,'utf8');
}
export async function loadKnowledge({directory,sha,generatedAt}){
  if(!directory)return unavailableKnowledge(); // offline CI: explicitly unavailable, never empty
  if(!SHA.test(sha))error('missing pinned knowledge SHA');
  const root=resolve(directory);
  const index=JSON.parse(await readBounded(root,'index.json',100_000));
  const paths=Object.values(index.topics||{}).flat().map(x=>safePath(x.path));
  if(paths.length>MAX_ARTICLES)error('too many articles');
  const files=Object.fromEntries(await Promise.all(paths.map(async p=>
    [p,await readBounded(root,p,MAX_BODY)])));
  const changelog=await readBounded(root,'CHANGELOG.md',500_000);
  return projectKnowledge({index,files,changelog,sha,generatedAt});
}
export function validatePublicKnowledge(value){
  if(value?.schema_version!==1||!['available','unavailable'].includes(value.status)||
    !Array.isArray(value.articles)||!Array.isArray(value.changes)||
    value.articles.length>MAX_ARTICLES||value.changes.length>MAX_EVENTS)return false;
  if(value.status==='unavailable')return value.source===null&&value.articles.length===0&&value.changes.length===0;
  if(value.source?.branch!=='knowledge'||!SHA.test(value.source.sha)||!validUtc(value.source.generated_at))
    return false;
  return value.articles.every(a=>ARTICLE.test(a.path)&&typeof a.body==='string'&&a.body.length<MAX_BODY&&
    ['verified','candidate'].includes(a.status));
}
