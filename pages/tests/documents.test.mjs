import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {describeFields,fieldSince,projectProtocolSchema,loadDocuments,
  validPublicDocuments,unavailableDocuments} from '../scripts/documents-project.mjs';
import {releaseProtocolHistory,sortedReleases}
  from '../scripts/protocol-release-history.mjs';
import {taggedProtocolSchema} from '../scripts/protocol-git-history.mjs';
import {documentsHref,documentsRoute,validDocumentsSnapshot,
  filterDocuments,renderDocuments} from '../documents.js';
import {NAV_ITEMS} from '../navigation.js';

const SHA='a'.repeat(40), OLD_SHA='b'.repeat(40);
const AT='2026-11-10T10:00:00.000Z';
const draft='https://json-schema.org/draft/2020-12/schema';
const primitive={type:'string'};
function fixture({snapshot=false,legacy=false}={}){
  const success={type:'object',required:['state','status'],properties:{
    state:{const:'ok'},status:{$ref:'#/$defs/RepoStatus'},
    ...(!legacy?{snapshot:{type:'string'}}:{})
  }};
  const root={type:'object',properties:{data:{$ref:'#/$defs/RepoStatus'}}};
  return {$schema:draft,
    protocols:{
      'git.status@v1':{owner:'git',version:1,wires:['git.status'],
        request:{alias:'StatusRequest',shape:root},
        response:{alias:'StatusResponse',shape:{
          oneOf:[{$ref:'#/$defs/StatusOk'},{
            type:'object',required:['state','message'],properties:{
              state:{const:'error'},message:primitive
            }}]
        }}},
      ...(!legacy?{'git.status@v2':{owner:'git',version:2,wires:['git.status'],
        request:{alias:'StatusRequestV2',shape:root},
        response:{alias:'StatusResponseV2',shape:success}}}:{}),
      'server.agent.announce@v1':{owner:'core',version:1,
        wires:['server.agent.announce'],request:{
          alias:'Announce',shape:{type:'object',properties:{agentId:primitive}}},
        response:null}
    },$defs:{
      RepoStatus:{type:'object',properties:{
        branch:primitive,
        ...(snapshot?{latest:primitive}:{})
      }},
      StatusOk:success
    }};
}
const release=(version,schema,status='available')=>({
  version,tag:'v'+version,sha:OLD_SHA,status,schema
});
test('Rust generated JSON Schema projects every protocol/contract and both halves',()=>{
  const doc=projectProtocolSchema(fixture(),{sha:SHA,generatedAt:AT});
  assert.equal(doc.schema_version,4);
  assert.equal(doc.status,'available');
  assert.equal(doc.protocols.length,2);
  const status=doc.protocols.find(p=>p.id==='git.status');
  assert.deepEqual(status.versions.map(v=>v.version),[1,2]);
  assert.equal(status.versions[0].response.fields.some(f=>f.path==='status.branch'),true);
  assert.equal(doc.protocols.find(p=>p.id==='server.agent.announce').versions[0].response,null);
  assert.equal(validPublicDocuments(doc),true);
  assert.equal(validDocumentsSnapshot(doc),true);
  assert.deepEqual(projectProtocolSchema(fixture(),{sha:null,generatedAt:AT}),
    unavailableDocuments(AT));
});
test('a nested referenced response field preserves its response variant',()=>{
  const doc=projectProtocolSchema(fixture(),{sha:SHA,generatedAt:AT});
  const rows=doc.protocols.find(p=>p.id==='git.status').versions[0].response.fields;
  assert.ok(rows.some(f=>f.path==='status.branch'&&f.variant.includes('state=ok')));
  assert.ok(rows.some(f=>f.path==='message'&&f.variant.includes('state=error')));
  assert.equal(rows.some(f=>f.path==='status.branch'&&f.variant.includes('state=error')),false);
  assert.deepEqual(describeFields(null,{}),[]);
});
test('a single Since Nession value has a verified introduction boundary',()=>{
  const current=fixture({snapshot:true});
  const old=fixture({legacy:true});
  const newer=fixture();
  const doc=projectProtocolSchema(current,{sha:SHA,generatedAt:AT,
    sourceVersion:'0.35.0',releases:[
      release('0.35.0',old),release('0.36.0',newer),
      {version:'0.37.0',tag:'v0.37.0',sha:null,status:'unavailable',schema:null}
    ]});
  const git=doc.protocols.find(p=>p.id==='git.status');
  const branch=git.versions[0].response.fields.find(f=>f.path==='status.branch');
  const latest=git.versions[0].response.fields.find(f=>f.path==='status.latest');
  const snapshot=git.versions[1].response.fields.find(f=>f.path==='snapshot');
  assert.deepEqual({since:branch.since,status:branch.since_status},
    {since:null,status:'unknown'});
  assert.deepEqual({since:latest.since,status:latest.since_status},
    {since:null,status:'unknown'});
  assert.deepEqual({since:snapshot.since,status:snapshot.since_status},
    {since:null,status:'unknown'}); // latest v0.37 has no trusted snapshot
  assert.equal(snapshot.releases,undefined); // no per-release matrix
  assert.equal(git.support,undefined);
  assert.equal(validPublicDocuments(doc),true);
  assert.equal(validDocumentsSnapshot(doc),true);
  assert.equal(doc.source.source_version,'0.35.0');
});
test('projected fields carry only an introduction version, not release rows',()=>{
  const doc=projectProtocolSchema(fixture(),{sha:SHA,generatedAt:AT,
    releases:[release('0.35.0',fixture({legacy:true})),
      release('0.36.0',fixture())]});
  const git=doc.protocols.find(p=>p.id==='git.status');
  const f=git.versions[1].response.fields.find(x=>x.path==='snapshot');
  assert.equal(f.since,'0.36.0');
  assert.equal(f.since_status,'verified');
  assert.equal(f.releases,undefined);
  assert.equal(git.support,undefined);
});
test('release introduction is verified only with immediately preceding absence',()=>{
  assert.deepEqual(fieldSince(['absent','supported','supported'],
    ['0.35.0','0.36.0','0.37.0']),{since:'0.36.0',since_status:'verified'});
  assert.deepEqual(fieldSince(['unknown','supported','supported'],
    ['0.35.0','0.36.0','0.37.0']),{since:null,since_status:'unknown'});
  assert.deepEqual(fieldSince(['supported','supported'],
    ['0.35.0','0.36.0']),{since:null,since_status:'unknown'});
  assert.deepEqual(fieldSince(['absent','unknown','supported'],
    ['0.35.0','0.36.0','0.37.0']),{since:null,since_status:'unknown'});
  assert.deepEqual(fieldSince(['absent','absent'],
    ['0.35.0','0.36.0']),{since:null,since_status:'unreleased'});
});
test('the main Protocol Reference excludes fields only found in old releases',()=>{
  const old=fixture({snapshot:true});
  const main=fixture();
  const doc=projectProtocolSchema(main,{sha:SHA,generatedAt:AT,
    releases:[release('0.36.0',old)]});
  const field=doc.protocols.find(p=>p.id==='git.status')
    .versions[0].response.fields.find(f=>f.path==='status.latest');
  assert.equal(field,undefined);
});
test('unknown version and malformed catalog reject instead of fabricating data',()=>{
  assert.throws(()=>projectProtocolSchema({$schema:draft,protocols:{},$defs:{}},
    {sha:SHA,generatedAt:AT}),/Empty/);
  const malformed=fixture();
  malformed.protocols['git.status@v1'].version=9;
  assert.throws(()=>projectProtocolSchema(malformed,{sha:SHA,generatedAt:AT}),
    /Invalid canonical protocol entry/);
  const doc=projectProtocolSchema(fixture(),{sha:SHA,generatedAt:AT});
  doc.protocols[0].id='../../secret';
  assert.equal(validPublicDocuments(doc),false);
  assert.equal(validDocumentsSnapshot(doc),false);
});
test('only explicitly valid pinned source files become public Protocol catalogs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nession-protocol-pages-'));
  const path=join(dir,'schema.json');
  try{
    await writeFile(path,JSON.stringify(fixture()));
    const result=await loadDocuments({schemaPath:path,sha:SHA,generatedAt:AT});
    assert.equal(result.protocols.length,2);
    const unavailable=await loadDocuments({schemaPath:path,generatedAt:AT});
    assert.equal(unavailable.status,'unavailable');
    await writeFile(path,'not JSON');
    await assert.rejects(loadDocuments({schemaPath:path,sha:SHA,generatedAt:AT}));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('tagged release assets must be source pinned and cannot be inferred from main',async()=>{
  const history=sortedReleases([
    {tag_name:'v0.36.0',assets:[]},{tag_name:'v0.35.0',assets:[]},
    {tag_name:'v0.34.3',draft:true,assets:[]}]);
  assert.deepEqual(history.map(r=>r.version),['0.35.0','0.36.0']);
  const missing=await releaseProtocolHistory({releases:[
    {tag_name:'v0.35.0',assets:[]}
  ],api:async()=>({object:{type:'commit',sha:OLD_SHA}})});
  assert.equal(missing[0].status,'unavailable');
  assert.equal(missing[0].sha,OLD_SHA);
  const reconstructed=await releaseProtocolHistory({releases:[
    {tag_name:'v0.36.0',assets:[]}],
    api:async()=>({object:{type:'commit',sha:OLD_SHA}}),
    snapshotAtTag:async({tag,version,sha})=>{
      assert.equal(tag,'v0.36.0');
      assert.equal(version,'0.36.0');
      assert.equal(sha,OLD_SHA);
      return fixture();
    }});
  assert.equal(reconstructed[0].status,'available');
  assert.equal(projectProtocolSchema(fixture(),{sha:SHA,generatedAt:AT,
    releases:[release('0.35.0',fixture({legacy:true})),...reconstructed]})
    .protocols.find(p=>p.id==='git.status').versions[1]
    .response.fields.find(row=>row.path==='snapshot').since,'0.36.0');
  const raw=JSON.stringify({schema_version:1,source:{repository:'BestNathan/nession',
    tag:'v0.36.0',sha:OLD_SHA,version:'0.36.0'},schema:fixture()});
  const url='https://github.com/BestNathan/nession/releases/download/v0.36.0/nession-protocol-schema.json';
  const assets=[{name:'nession-protocol-schema.json',browser_download_url:url,
    digest:'sha256:'+createHash('sha256').update(raw).digest('hex')}];
  const result=await releaseProtocolHistory({releases:[
    {tag_name:'v0.36.0',assets}],
    api:async()=>({object:{type:'commit',sha:OLD_SHA}}),
    fetcher:async()=>({ok:true,arrayBuffer:async()=>Buffer.from(raw)})});
  assert.equal(result[0].status,'available');
  const poisoned=raw.replace('"sha":"'+OLD_SHA+'"','"sha":"'+SHA+'"');
  const bad=await releaseProtocolHistory({releases:[
    {tag_name:'v0.36.0',assets}],
    api:async()=>({object:{type:'commit',sha:OLD_SHA}}),
    fetcher:async()=>({ok:true,arrayBuffer:async()=>Buffer.from(poisoned)})});
  assert.equal(bad[0].status,'unavailable');
});
test('Git Tag codegen uses a SHA-verified isolated worktree and a SHA cache',async()=>{
  const base=await mkdtemp(join(tmpdir(),'nession-pages-tag-test-'));
  const calls=[];
  let env=null,compiles=0;
  const command=async(program,args,opts={})=>{
    calls.push([program,...args]);
    if(program==='git'&&args.includes('rev-parse'))return OLD_SHA;
    if(program==='git'&&args.includes('cat-file'))return '';
    if(program==='git'&&args.includes('add')){
      const dest=args.at(-2); // git worktree add --detach <path> <sha>
      assert.ok(dest);
      await mkdir(dest,{recursive:true});
      await writeFile(join(dest,'Cargo.toml'),
        '[workspace]\\nmembers = ["crates/nession-protocol-codegen"]\\n');
      return '';
    }
    if(program==='git'&&args.includes('remove'))return '';
    if(program==='cargo'){
      compiles++;
      env=opts.env;
      assert.ok(opts.cwd.endsWith('/checkout'));
      assert.deepEqual(args.slice(0,5),
        ['run','--locked','--quiet','-p','nession-protocol-codegen']);
      return JSON.stringify(fixture());
    }
    throw Error('unexpected command: '+[program,...args].join(' '));
  };
  try{
    const input={tag:'v0.36.0',sha:OLD_SHA,repoRoot:base,
      cacheDir:join(base,'cache'),command};
    const first=await taggedProtocolSchema(input);
    assert.deepEqual(first,fixture());
    assert.equal(compiles,1);
    assert.equal(env.GITHUB_TOKEN,undefined);
    assert.equal(env.GH_TOKEN,undefined);
    assert.notEqual(env.HOME,process.env.HOME);
    assert.equal(calls.some(call=>call.includes('worktree')),true);
    assert.deepEqual(await taggedProtocolSchema({...input,command:async()=>{
      throw Error('cache should avoid git/cargo work');
    }}),fixture());
    assert.equal(compiles,1);
    assert.equal(await taggedProtocolSchema({...input,tag:'../../evil'}),null);
    assert.equal(await taggedProtocolSchema({
      ...input,sha:SHA,command:async(program,args)=>{
        if(program==='git'&&args.includes('rev-parse'))return OLD_SHA;
        return '';
      }}),null);
  }finally{await rm(base,{recursive:true,force:true});}
});
test('missing historical codegen does not fabricate a field introduction',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nession-protocol-old-tag-'));
  try{
    const result=await taggedProtocolSchema({
      tag:'v0.35.0',sha:OLD_SHA,repoRoot:dir,cacheDir:join(dir,'cache'),
      command:async(program,args)=>{
        if(program==='git'&&args.includes('rev-parse'))return OLD_SHA;
        if(program==='git'&&args.includes('cat-file'))
          throw Error('missing historical generator');
        throw Error('must not compile a missing generator');
      }});
    assert.equal(result,null);
    const doc=projectProtocolSchema(fixture(),{sha:SHA,generatedAt:AT,
      releases:[{version:'0.35.0',tag:'v0.35.0',sha:OLD_SHA,
        status:'unavailable',schema:null},
        release('0.36.0',fixture())]});
    const field=doc.protocols.find(p=>p.id==='git.status').versions[1]
      .response.fields.find(row=>row.path==='snapshot');
    assert.equal(field.since_status,'unknown');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('deep links and search work with contract versions and paths',()=>{
  assert.equal(documentsHref('git.status',2),'#/documents?protocol=git.status&v=2');
  assert.equal(documentsHref('../../secret'),'#/documents');
  assert.deepEqual(documentsRoute('#/documents?protocol=git.status&v=2'),
    {id:'git.status',version:2,invalid:false});
  assert.equal(documentsRoute('#/documents?protocol=../../secret').invalid,true);
  const doc=projectProtocolSchema(fixture(),{sha:SHA,generatedAt:AT});
  assert.equal(filterDocuments(doc.protocols,{query:'branch'}).length,1);
  assert.equal(filterDocuments(doc.protocols,{owner:'git'}).length,1);
  assert.ok(NAV_ITEMS.some(x=>x.route==='/documents'));
});
class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.nodes=[];this.attrs={};this.text='';}
  set textContent(value){this.text=String(value);this.nodes=[];}
  get textContent(){return this.text+this.nodes.map(x=>x.textContent||'').join('');}
  set className(value){this.classes=value;}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(){}
  append(...nodes){this.nodes.push(...nodes);}
  replaceChildren(...nodes){this.text='';this.nodes=nodes;}
  querySelector(tag){return descendants(this).find(x=>x.tagName===tag.toUpperCase())||null;}
}
function descendants(node){return [node,...(node.nodes||[]).flatMap(descendants)];}
test('Protocol reference renders one since-version column, not a matrix',()=>{
  const original=globalThis.document;
  globalThis.document={createElement:t=>new Element(t),
    createTextNode:s=>({textContent:s})};
  try{
    const data=projectProtocolSchema(fixture(),{sha:SHA,generatedAt:AT,
      releases:[{version:'0.35.0',tag:'v0.35.0',sha:null,status:'unavailable',schema:null}]});
    const ui=new Element('main');
    renderDocuments(ui,data,documentsHref('git.status',1));
    const elements=descendants(ui);
    assert.ok(elements.some(x=>x.tagName==='TABLE'));
    assert.ok(elements.some(x=>x.tagName==='TH'&&x.textContent==='Since Nession'));
    assert.equal(elements.filter(x=>x.tagName==='TH'&&x.textContent==='0.35.0').length,0);
    assert.ok(elements.some(x=>x.tagName==='TD'&&x.textContent==='Unknown'));
    assert.equal(elements.some(x=>x.tagName==='TD'&&x.textContent==='?'),false);
    assert.ok(elements.some(x=>x.tagName==='DETAILS'));
    assert.equal(elements.some(x=>x.tagName==='SCRIPT'),false);
  }finally{globalThis.document=original;}
});
