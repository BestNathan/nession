// Build-time public projection of the *existing* Rust-generated JSON Schema.
// Do not parse Rust/TypeScript or maintain a second protocol registry here.
import {readFile, lstat} from 'node:fs/promises';
const SHA=/^[a-f0-9]{40}$/;
const ID=/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const ENTRY=/^([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)@v([1-9][0-9]*)$/;
const DRAFT='https://json-schema.org/draft/2020-12/schema';
const REPO='BestNathan/nession';
const MAX_SOURCE_BYTES=8_000_000;
const MAX_PROTOCOLS=400;
const MAX_DEFS=2500;
const MAX_FIELDS=6000;

export function unavailableDocuments(generatedAt){
  return {schema_version:3,status:'unavailable',generated_at:generatedAt,
    source:null,definitions:{},releases:[],protocols:[]};
}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const plain= x=>object(x)&&Object.getPrototypeOf(x)===Object.prototype;
const validHalf=x=>x===null||(object(x)&&typeof x.alias==='string'&&
  /^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(x.alias)&&
  (object(x.shape)||typeof x.shape==='boolean'));
const str=x=>typeof x==='string'&&x.length<=180;
const localRef=ref=>typeof ref==='string'&&ref.startsWith('#/$defs/')?
  ref.slice('#/$defs/'.length).replace(/~1/g,'/').replace(/~0/g,'~'):null;
const branchName=(node,index)=>{
  if(object(node?.properties)){
    for(const k of ['state','type','kind','status']){
      const prop=node.properties[k];
      if(typeof prop?.const==='string')return k+'='+prop.const;
      if(Array.isArray(prop?.enum)&&prop.enum.length===1&&typeof prop.enum[0]==='string')
        return k+'='+prop.enum[0];
    }
  }
  return 'variant '+(index+1);
};
function describeType(schema){
  if(!object(schema))return schema===true?'any':'never';
  if(typeof schema.type==='string')return schema.type;
  if(Array.isArray(schema.type))return schema.type.join(' | ');
  if(Array.isArray(schema.enum))return 'enum ('+schema.enum.map(String).slice(0,8).join(', ')+')';
  if(schema.const!==undefined)return 'const '+String(schema.const);
  if(schema.$ref)return 'object';
  if(schema.properties)return 'object';
  if(schema.items)return 'array';
  if(schema.oneOf)return 'union';
  if(schema.anyOf)return 'union';
  return 'any';
}
export function describeFields(half,definitions){
  if(!half)return [];
  const rows=[],seen=new Set();
  function add(row){
    if(!row.path||rows.length>=MAX_FIELDS)return;
    const key=row.variant+'|'+row.path;
    if(seen.has(key))return;
    seen.add(key);rows.push(row);
  }
  function walk(schema,path='',variant='',required=false,stack=[],depth=0){
    if(depth>16||rows.length>=MAX_FIELDS||schema===false||schema===true||!object(schema))return;
    if(schema.$ref){
      const key=localRef(schema.$ref);
      if(!key||!Object.hasOwn(definitions,key)||stack.includes(key))return;
      walk(definitions[key],path,variant,required,[...stack,key],depth+1);
      return;
    }
    // allOf is an intersection (e.g. serde flatten). oneOf/anyOf are
    // alternatives: don't claim a field exists in every response variant.
    for(const item of schema.allOf||[])walk(item,path,variant,required,stack,depth+1);
    const choices=schema.oneOf||schema.anyOf;
    if(Array.isArray(choices)){
      const substantive=choices.filter(v=>v!==null&&v!==false&&
        !(object(v)&&(v.type==='null'||Array.isArray(v.type)&&v.type.every(t=>t==='null'))));
      if(substantive.length===1)walk(substantive[0],path,variant,required,stack,depth+1);
      else substantive.forEach((choice,index)=>{
        // Resolve an immediate ref when finding a tagged variant label.
        const key=localRef(choice?.$ref);
        const resolved=key&&Object.hasOwn(definitions,key)?definitions[key]:choice;
        const tag=branchName(resolved,index);
        walk(choice,path,[variant,tag].filter(Boolean).join(' / '),required,stack,depth+1);
      });
    }
    if(object(schema.properties)){
      const requiredSet=new Set(Array.isArray(schema.required)?schema.required:[]);
      for(const [name,value] of Object.entries(schema.properties)){
        const fieldPath=path?path+'.'+name:name;
        const isRequired=requiredSet.has(name);
        add({path:fieldPath,variant,type:describeType(value),required:isRequired});
        walk(value,fieldPath,variant,isRequired,stack,depth+1);
      }
    }
    if(schema.items){
      const arrayPath=path+'[]';
      walk(schema.items,arrayPath,variant,false,stack,depth+1);
    }
    if(object(schema.additionalProperties)){
      walk(schema.additionalProperties,path+'{}',variant,false,stack,depth+1);
    }
  }
  walk(half.shape);
  return rows;
}
function supports(versions,direction){
  const fields=new Map();
  for(const v of versions){
    for(const f of v[direction]?.fields||[]){
      const key=f.variant+'|'+f.path;
      if(!fields.has(key))fields.set(key,{path:f.path,variant:f.variant,versions:[],
        descriptions:[],type:f.type,required:f.required});
      const current=fields.get(key);
      current.versions.push(v.version);
      current.descriptions.push({version:v.version,type:f.type,required:f.required});
    }
  }
  return [...fields.values()].sort((a,b)=>a.path.localeCompare(b.path)||a.variant.localeCompare(b.variant));
}
const SEMVER=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
function decorateReleaseHistory(result,snapshots){
  // Each verified release includes a schema generated from *its own tag*.
  // Missing snapshots must remain unknown, even if later code has that field.
  const verified=snapshots.map(s=>{
    if(!SEMVER.test(s?.version||'')||s.tag!=='v'+s.version||
       !['available','unavailable'].includes(s.status))throw Error('Invalid release metadata');
    if(s.status==='unavailable')return {...s,projected:null};
    if(!SHA.test(s.sha||'')||!s.schema)throw Error('Unpinned release contract');
    const projected=projectProtocolSchema(s.schema,{sha:s.sha,generatedAt:result.generated_at});
    return {...s,projected};
  });
  const history=verified.map(s=>({version:s.version,tag:s.tag,
    sha:s.sha||null,status:s.status}));
  const seen=new Set();
  for(const release of history){
    if(seen.has(release.version))throw Error('Duplicate released Nession version');
    seen.add(release.version);
  }
  result.releases=history;
  for(const unit of result.protocols){
    for(const contract of unit.versions){
      for(const direction of ['request','response']){
        const fields=contract[direction]?.fields||[];
        // Include historical fields that later main contracts removed, but
        // never claim they still exist in current source.
        const currentSet=new Set(fields.map(f=>f.variant+'|'+f.path));
        for(const release of verified){
          const oldUnit=release.projected?.protocols.find(p=>p.id===unit.id);
          const oldContract=oldUnit?.versions.find(v=>v.version===contract.version);
          for(const old of oldContract?.[direction]?.fields||[]){
            const key=old.variant+'|'+old.path;
            if(!currentSet.has(key)){
              fields.push({...old,historical:true});
              currentSet.add(key);
            }
          }
        }
        fields.sort((a,b)=>a.path.localeCompare(b.path)||a.variant.localeCompare(b.variant));
        for(const field of fields){
          const releaseSupport=verified.map(release=>{
            if(!release.projected)return {version:release.version,status:'unknown'};
            const oldUnit=release.projected.protocols.find(p=>p.id===unit.id);
            const oldContract=oldUnit?.versions.find(v=>v.version===contract.version);
            if(!oldContract||!oldContract[direction])
              return {version:release.version,status:'contract-not-declared'};
            const found=oldContract[direction].fields.find(f=>
              f.path===field.path&&f.variant===field.variant);
            return found?{version:release.version,status:'supported',type:found.type,
              required:found.required}:{version:release.version,status:'not-supported'};
          });
          field.releases=releaseSupport;
          field.firstObserved=releaseSupport.find(r=>r.status==='supported')?.version||null;
        }
      }
    }
  }
}
export function projectProtocolSchema(schema,{sha,generatedAt,releases=[],sourceVersion=null}={}){
  if(!SHA.test(sha||''))return unavailableDocuments(generatedAt);
  if(!plain(schema)||schema.$schema!==DRAFT||!plain(schema.protocols)||
     !plain(schema.$defs)||Object.keys(schema.$defs).length>MAX_DEFS)
    throw Error('Invalid canonical protocol JSON Schema');
  const entries=Object.entries(schema.protocols);
  if(entries.length===0||entries.length>MAX_PROTOCOLS)throw Error('Empty or unbounded protocol catalog');
  const groups=new Map();
  for(const [key,data] of entries){
    const match=ENTRY.exec(key);
    if(!match||!object(data)||data.version!==Number(match[2])||
      !str(data.owner)||!Array.isArray(data.wires)||data.wires.length<1||
      data.wires.length>8||!data.wires.every(x=>str(x)&&ID.test(x))||
      !validHalf(data.request)||!validHalf(data.response))
      throw Error('Invalid canonical protocol entry: '+key);
    const id=match[1],version=Number(match[2]);
    if(!Number.isSafeInteger(version)||version>1000)throw Error('Invalid contract version');
    if(!groups.has(id))groups.set(id,{id,owner:data.owner,wires:data.wires,versions:[]});
    const group=groups.get(id);
    if(group.owner!==data.owner||JSON.stringify(group.wires)!==JSON.stringify(data.wires))
      throw Error('Inconsistent protocol ownership/wires: '+id);
    const decorate=half=>half?{alias:half.alias,shape:half.shape,
      fields:describeFields(half,schema.$defs)}:null;
    group.versions.push({version,request:decorate(data.request),
      response:decorate(data.response)});
  }
  const protocols=[...groups.values()].sort((a,b)=>a.id.localeCompare(b.id));
  for(const group of protocols){
    group.versions.sort((a,b)=>a.version-b.version);
    group.support={request:supports(group.versions,'request'),
      response:supports(group.versions,'response')};
  }
  const result={schema_version:3,status:'available',generated_at:generatedAt,
    source:{repository:REPO,branch:'main',sha,source_version:sourceVersion},
    definitions:schema.$defs,releases:[],protocols};
  if(releases.length)decorateReleaseHistory(result,releases);
  if(!validPublicDocuments(result))throw Error('Invalid projected Protocol Reference');
  return result;
}
export function validPublicDocuments(data){
  if(data?.schema_version!==3||!['available','unavailable'].includes(data.status)||
     !Array.isArray(data.protocols)||!object(data.definitions)||
     !Array.isArray(data.releases)||data.releases.length>30)return false;
  if(!data.releases.every(r=>SEMVER.test(r?.version||'')&&r.tag==='v'+r.version&&
    ['available','unavailable'].includes(r.status)&&
    (r.sha===null||SHA.test(r.sha||''))))return false;
  if(data.status==='unavailable')return data.source===null&&data.protocols.length===0;
  if(data.source?.repository!==REPO||data.source?.branch!=='main'||
     !SHA.test(data.source?.sha||'')||
     !data.protocols.length||data.protocols.length>MAX_PROTOCOLS||
     Object.keys(data.definitions).length>MAX_DEFS)return false;
  const ids=new Set();
  return data.protocols.every(p=>{
    if(!ID.test(p?.id||'')||ids.has(p.id)||!str(p.owner)||!Array.isArray(p.wires)||
       !p.wires.length||!p.wires.every(str)||!Array.isArray(p.versions)||
       !p.versions.length||p.versions.length>25||
       !object(p.support)||!Array.isArray(p.support.request)||!Array.isArray(p.support.response)||
       p.support.request.length>MAX_FIELDS||p.support.response.length>MAX_FIELDS)return false;
    ids.add(p.id);
    const versions=new Set();
    return p.versions.every(v=>{
      if(!Number.isSafeInteger(v.version)||v.version<1||versions.has(v.version))return false;
      versions.add(v.version);
      return ['request','response'].every(direction=>{
        const half=v[direction];
        return half===null||(validHalf(half)&&Array.isArray(half.fields)&&
          half.fields.length<=MAX_FIELDS&&half.fields.every(row=>
            str(row.path)&&str(row.variant)&&str(row.type)&&typeof row.required==='boolean'&&
            (row.releases===undefined||(Array.isArray(row.releases)&&
              row.releases.length===data.releases.length&&row.releases.every(v=>
                SEMVER.test(v.version)&&
                ['supported','not-supported','contract-not-declared','unknown'].includes(v.status))))));
      });
    });
  });
}
export async function loadDocuments({schemaPath,sha,generatedAt,releases=[],sourceVersion=null}){
  if(!SHA.test(sha||'')||!schemaPath)return unavailableDocuments(generatedAt);
  const stat=await lstat(schemaPath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<10||stat.size>MAX_SOURCE_BYTES)
    throw Error('Invalid pinned Protocol Schema source');
  const source=await readFile(schemaPath,'utf8');
  const schema=JSON.parse(source);
  return projectProtocolSchema(schema,{sha,generatedAt,releases,sourceVersion});
}
