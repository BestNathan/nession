// Published upstream MCP release metadata only. No drafts/SEPs and no
// current-main content substituted for an immutable stable release tag.
import {createHash} from 'node:crypto';
const SHA=/^[a-f0-9]{40}$/;
const VERSION=/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ROOT='https://github.com/modelcontextprotocol/modelcontextprotocol';

export async function loadStableMcpRelease({api}){
  const latest=await api('/releases/latest');
  const version=latest?.tag_name;
  if(!VERSION.test(version||'')||latest.draft!==false||latest.prerelease!==false)
    throw Error('Unverified upstream stable MCP release');
  const ref=await api('/git/ref/tags/'+version);
  let sha=ref?.object?.sha;
  if(!SHA.test(sha||''))throw Error('Unpinned upstream MCP tag');
  if(ref.object.type==='tag'){
    const annotated=await api('/git/tags/'+sha);
    if(annotated?.tag!==version||annotated.object?.type!=='commit'||
       !SHA.test(annotated.object?.sha||''))throw Error('Invalid annotated MCP release tag');
    sha=annotated.object.sha;
  }else if(ref.object.type!=='commit')
    throw Error('Unresolvable upstream MCP release tag');
  const path='docs/specification/'+version+'/changelog.mdx';
  const file=await api('/contents/'+path+'?ref='+sha);
  if(file?.encoding!=='base64'||!SHA.test(file.sha||'')||
     typeof file.content!=='string'||file.content.length>400_000)
    throw Error('Unverified pinned MCP changelog');
  const bytes=Buffer.from(file.content.replace(/\\s/g,''),'base64');
  if(bytes.length<50||bytes.length>250_000)
    throw Error('Invalid MCP changelog size');
  const gitBlob=createHash('sha1').update('blob '+bytes.length+'\\0').update(bytes).digest('hex');
  if(gitBlob!==file.sha)throw Error('Upstream changelog Git blob SHA mismatch');
  const markdown=bytes.toString('utf8');
  if(!markdown.includes('Key Changes'))throw Error('Unexpected upstream changelog content');
  const previous=/previous revision[^\\n]*\\[([0-9]{4}-[0-9]{2}-[0-9]{2})\\]/i.exec(markdown)?.[1]||null;
  const major=markdown.split(/^## Major changes\\s*$/m)[1]?.split(/^## /m)[0]||'';
  const highlights=[...major.matchAll(/^[0-9]+\\.\\s+(.+)$/gm)].slice(0,6)
    .map(m=>m[1].replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g,'$1')
      .replace(/[\x60*_<>]/g,'').trim().slice(0,300)).filter(Boolean);
  return {
    version,sha,previous_version:previous,
    changelog_blob_sha:file.sha,
    changelog_sha256:createHash('sha256').update(bytes).digest('hex'),
    source_url:ROOT+'/blob/'+sha+'/'+path,
    release_url:ROOT+'/releases/tag/'+version,
    highlights
  };
}
