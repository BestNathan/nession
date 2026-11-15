import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadStableMcpRelease} from '../scripts/mcp-upstream.mjs';
const version='2026-07-28', sha='a'.repeat(40);
const body='---\ntitle: Key Changes\n---\n\nThis revision follows the previous revision, [2025-11-25].\n\n## Major changes\n\n1. Make HTTP stateless and safe by default.\n\n2. Replace the initialization handshake.\n';
const bytes=Buffer.from(body);
const blob=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
function api(path){
  if(path==='/releases/latest')return {tag_name:version,draft:false,prerelease:false};
  if(path==='/git/ref/tags/'+version)return {object:{type:'commit',sha}};
  if(path==='/contents/docs/specification/'+version+'/changelog.mdx?ref='+sha)
    return {encoding:'base64',sha:blob,content:bytes.toString('base64')};
  throw Error('Unexpected upstream API path: '+path);
}
test('stable upstream release is pinned to tag commit and verified Git blob',async()=>{
  const stable=await loadStableMcpRelease({api});
  assert.equal(stable.version,version);
  assert.equal(stable.sha,sha);
  assert.equal(stable.previous_version,'2025-11-25');
  assert.equal(stable.highlights.length,2);
  assert.equal(stable.changelog_blob_sha,blob);
  assert.equal(stable.changelog_sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(stable.source_url,
    'https://github.com/modelcontextprotocol/modelcontextprotocol/blob/'+sha+
    '/docs/specification/'+version+'/changelog.mdx');
});
test('draft, forged source and unavailable upstream fail closed',async()=>{
  await assert.rejects(loadStableMcpRelease({api:async p=>({...api(p),draft:true})}),/stable/);
  await assert.rejects(loadStableMcpRelease({api:async p=>p.startsWith('/contents/')?
    {...api(p),sha:'b'.repeat(40)}:api(p)}),/blob SHA mismatch/);
  await assert.rejects(loadStableMcpRelease({api:async()=>{throw Error('offline')}}),/offline/);
});
