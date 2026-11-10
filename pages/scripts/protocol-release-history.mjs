// Historical protocol schemas are pinned to official Release tag commit SHAs.
// Prefer an immutable Release asset; otherwise attempt the same Rust codegen
// on that exact tag through an optional, credential-free history producer.
// An unavailable tag is UNKNOWN, never an inferred absence.
import {createHash} from 'node:crypto';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const SEMVER=/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ASSET='nession-protocol-schema.json';
const MAX_RELEASES=30;
const MAX_BYTES=8_000_000;
const BASE='https://github.com/'+REPO+'/releases/download/';

export function sortedReleases(items){
  if(!Array.isArray(items))return [];
  const releases=[],seen=new Set();
  for(const item of items){
    if(item?.draft||item?.prerelease||!SEMVER.test(item?.tag_name||'')||
       seen.has(item.tag_name))continue;
    seen.add(item.tag_name);
    const asset=Array.isArray(item.assets)?
      item.assets.find(a=>a?.name===ASSET):null;
    releases.push({version:item.tag_name.slice(1),tag:item.tag_name,
      asset:asset&&typeof asset.browser_download_url==='string'?asset:null});
  }
  const nums=s=>s.split('.').map(Number);
  releases.sort((a,b)=>{
    const x=nums(a.version),y=nums(b.version);
    return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];
  });
  return releases.slice(-MAX_RELEASES);
}
async function resolveTag(api,tag){
  let result=await api('/git/ref/tags/'+encodeURIComponent(tag));
  let object=result?.object;
  if(object?.type==='tag') {
    result=await api('/git/tags/'+object.sha);
    object=result?.object;
  }
  return object?.type==='commit'&&SHA.test(object.sha||'')?object.sha:null;
}
function validProtocolSchema(schema){
  return schema?.$schema==='https://json-schema.org/draft/2020-12/schema'&&
    schema?.protocols&&typeof schema.protocols==='object'&&
    !Array.isArray(schema.protocols)&&schema?.$defs&&
    typeof schema.$defs==='object'&&!Array.isArray(schema.$defs);
}
function validSnapshot(data,version,tag,sha){
  return data?.schema_version===1&&data.source?.repository===REPO&&
    data.source?.tag===tag&&data.source?.sha===sha&&
    data.source?.version===version&&
    validProtocolSchema(data.schema);
}
async function fetchSnapshot(asset,version,tag,sha,fetcher){
  const url=BASE+encodeURIComponent(tag)+'/'+ASSET;
  if(asset.browser_download_url!==url)return null;
  const response=await fetcher(url,{headers:{accept:'application/octet-stream'},
    signal:AbortSignal.timeout(15000),redirect:'follow'});
  if(!response.ok)return null;
  const buf=Buffer.from(await response.arrayBuffer());
  if(buf.length<10||buf.length>MAX_BYTES)return null;
  const digest=asset.digest;
  if(typeof digest==='string'&&digest.startsWith('sha256:')&&
    createHash('sha256').update(buf).digest('hex')!==digest.slice(7))return null;
  let data;
  try{data=JSON.parse(buf.toString('utf8'));}catch{return null;}
  return validSnapshot(data,version,tag,sha)?data.schema:null;
}
export async function releaseProtocolHistory({api,fetcher=fetch,releases,snapshotAtTag=null}){
  const items=sortedReleases(releases);
  const result=[];
  for(const item of items){
    let sha=null, schema=null;
    try{
      // Resolve even when there is no Release asset. The tag commit, not the
      // Cargo workspace version or the moving main branch, owns this release.
      sha=await resolveTag(api,item.tag);
      if(sha&&item.asset)
        schema=await fetchSnapshot(item.asset,item.version,item.tag,sha,fetcher);
      if(sha&&!schema&&snapshotAtTag)
        schema=await snapshotAtTag({tag:item.tag,version:item.version,sha});
      if(schema&&!validProtocolSchema(schema))schema=null;
    }catch(error){console.warn('Optional Protocol release snapshot unavailable',
      item.tag,error.message);}
    result.push({version:item.version,tag:item.tag,
      sha, status:schema?'available':'unavailable',schema});
  }
  return result;
}
