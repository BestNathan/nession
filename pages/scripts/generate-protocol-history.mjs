// Run in a credential-free step BEFORE the Pages publisher receives GITHUB_TOKEN.
// The publisher only reads our SHA-keyed JSON cache. This script is not a
// release writer: immutable GitHub Release assets remain the preferred source.
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sortedReleases,releaseProtocolHistory} from './protocol-release-history.mjs';
import {taggedProtocolSchema} from './protocol-git-history.mjs';

if(process.env.GITHUB_TOKEN||process.env.GH_TOKEN||
   process.env.GH_ENTERPRISE_TOKEN||process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  throw Error('Historical tag codegen must run without GitHub credentials');

const repoRoot=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const repo='BestNathan/nession';
async function api(path){
  const response=await fetch('https://api.github.com/repos/'+repo+path,{
    headers:{accept:'application/vnd.github+json',
      'x-github-api-version':'2022-11-28',
      'user-agent':'nession-protocol-tag-schema'},
    signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('GitHub read-only API: HTTP '+response.status);
  return response.json();
}
let releases=[];
try{
  const all=await api('/releases?per_page=100');
  // A bounded recent window keeps a Pages refresh predictable. Previously
  // generated older SHA caches can still be read by the publisher.
  const targets=new Set(sortedReleases(all).filter(r=>!r.asset)
    .slice(-8).map(r=>r.tag));
  releases=await releaseProtocolHistory({
    api,releases:all.filter(item=>targets.has(item.tag_name)),
    snapshotAtTag:async({tag,sha})=>taggedProtocolSchema({
      tag,sha,repoRoot,cacheDir:process.env.PAGES_PROTOCOL_CACHE_DIR})});
}catch(error){
  // Optional historical gaps are Unknown; never block current-main canonical
  // Protocol generation because GitHub API or a legacy tag is unavailable.
  console.warn('Historical Protocol reconstruction unavailable:',error.message);
}
console.log('Historical Protocol source snapshots:',
  releases.map(r=>r.tag+':'+(r.status==='available'?'verified':'unknown')).join(' '));
