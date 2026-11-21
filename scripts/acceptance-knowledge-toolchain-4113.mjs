// #4118: bounded, immutable GitHub readback for the delivered #4113 Knowledge.
// The generic protected Publisher/Pages chain is attested by the existing
// acceptance-knowledge-publisher-evidence.mjs owner. This module checks only
// the source-specific article/index/link/log content it actually published.
// No arbitrary Issue text, URL or untrusted checkout may select these inputs.
import assert from 'node:assert/strict';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const TITLE='Nession native Toolchain OCI release to GHCR';
const ARTICLE='topics/workflows/nession-native-toolchain-oci-release-to-ghcr.md';
const WORKFLOW='topics/workflows/nession-github-actions-workflow-domains-and-trust-boundaries.md';
const INDEX='index.json';
const CHANGELOG='CHANGELOG.md';
const EXPECTED_ARTICLES=28;
export const TOOLCHAIN_KNOWLEDGE_WITNESS=Object.freeze({
  issue:4113,comment:7027306185,publisher:44652376521,
  signal:44652491628,pages:44652511337,
  implemented:'3d8a56e6d2b77d87cc22efc1e7d510a71b243043',
  sourceImplementation:'06ff007d55092878d27e2606a29abcac6c8cb70b',
  published:'2fccee52ef60b0d0a3114edae5b8c7c885f19b34',
  previous:'bf25061262e4c06bac387836b21c181702ef53b7',
  publicDigest:'b353f1b43a1e372dec7b19f3ed31b5617e5a1346f8d797ae5baccc47a0506a7a',
});
export const TOOLCHAIN_KNOWLEDGE_PATHS=Object.freeze([ARTICLE,WORKFLOW,INDEX,CHANGELOG]);

function deny(ok,message){if(!ok)throw Error('toolchain Knowledge acceptance: '+message);}
function readGitHubFile(file, expectedPath){
  deny(file?.type==='file'&&file.path===expectedPath&&file.encoding==='base64'&&
    Number.isSafeInteger(file.size)&&file.size>0&&file.size<=200000&&
    typeof file.content==='string'&&file.content.length<300000&&
    /^[\sA-Za-z0-9+/=]+$/.test(file.content), 'invalid GitHub committed content '+expectedPath);
  const text=Buffer.from(file.content.replace(/\s/g,''),'base64').toString('utf8');
  deny(Buffer.byteLength(text,'utf8')===file.size,'GitHub content size mismatch '+expectedPath);
  return text;
}
function exactlyOnce(haystack,needle) {
  return haystack.split(needle).length===2;
}
function isDescendant(compare,from,to){
  return compare?.base_commit?.sha===from&&compare?.merge_base_commit?.sha===from&&
    ['ahead','identical'].includes(compare.status)&&
    (compare.head_commit?.sha===to||compare.commits?.at(-1)?.sha===to);
}

/**
 * Only after a fully authenticated Publisher/Signal/Pages chain: verify the
 * actual immutable Knowledge commit's four data files through GitHub's own
 * committed-content API and its parent/change list. Ledger format/link and
 * public projection are independently validated by the protected publisher
 * and Pages jobs; do not duplicate those validators here.
 */
export function attestToolchainKnowledgeReadback({
  ref,sourceToCurrent,commit,files,publishedSha,previousSha,publicDigest,publicArticles,
}){
  const w=TOOLCHAIN_KNOWLEDGE_WITNESS;
  deny(publishedSha===w.published&&previousSha===w.previous&&
    publicDigest===w.publicDigest&&publicArticles===EXPECTED_ARTICLES,
    'unrecognized immutable publication or public Pages digest');
  deny(ref?.ref==='refs/heads/knowledge'&&SHA.test(ref.object?.sha)&&
    (ref.object.sha===w.published||
      isDescendant(sourceToCurrent,w.published,ref.object.sha)),
    'protected Knowledge head is neither the exact publication nor a verified descendant');
  deny(commit?.sha===w.published&&commit.parents?.length===1&&
    commit.parents[0].sha===w.previous&&
    Array.isArray(commit.files)&&commit.files.length===4,
    'published Knowledge commit is not a single direct child with four data changes');
  const expected=new Map([[ARTICLE,'added'],[WORKFLOW,'modified'],
    [INDEX,'modified'],[CHANGELOG,'modified']]);
  for(const change of commit.files){
    deny(expected.get(change.filename)===change.status&&expected.delete(change.filename),
      'Knowledge commit changed unrelated path/status: '+change.filename);
  }
  deny(expected.size===0,'Knowledge commit missing required file');
  deny(files&&Object.keys(files).length===4,'incomplete committed Knowledge readback');
  const article=readGitHubFile(files[ARTICLE],ARTICLE);
  const workflow=readGitHubFile(files[WORKFLOW],WORKFLOW);
  const index=JSON.parse(readGitHubFile(files[INDEX],INDEX));
  const changelog=readGitHubFile(files[CHANGELOG],CHANGELOG);

  const fm=article.match(/^---\n([\s\S]*?)\n---\n/);
  deny(fm&&exactlyOnce(fm[1],'title: "'+TITLE+'"')&&
    /^topic: workflows$/m.test(fm[1])&&/^status: verified$/m.test(fm[1]),
    'article title, topic or verified status differs');
  const src=fm[1].match(/^sources: (.+)$/m);
  deny(src,'article sources missing');
  const sources=JSON.parse(src[1]);
  deny(Array.isArray(sources)&&sources.includes(
    'https://github.com/'+REPO+'/blob/'+w.sourceImplementation+'/scripts/toolchains/README.md')&&
    sources.includes('https://github.com/'+REPO+'/issues/4092')&&
    sources.includes('https://github.com/'+REPO+'/pull/4094'),
    'article sources are not bound to delivered EROFS Toolchain implementation');
  const date=fm[1].match(/^updated_at: (\S+)$/m)?.[1];
  deny(date==='2026-11-20T01:08:30Z'&&
    article.includes('ghcr.io/bestnathan/nession-toolchain-jq:1.8.1-r1')&&
    article.includes('sha256:8edf29ce84b0e144ee6288ca92ef76bb507e968cb705484bc96f5a4f93635e59')&&
    article.includes('44586296125')&&
    article.includes('Linux AMD64 only'),
    'published toolchain version, GHCR release receipt or platform constraints differ');
  deny(article.includes('](nession-github-actions-workflow-domains-and-trust-boundaries.md)')&&
    workflow.includes('](nession-native-toolchain-oci-release-to-ghcr.md)'),
    'cross-linked Knowledge articles are not reciprocal');
  const records=index?.topics?.workflows;
  deny(index.schema_version===2&&Array.isArray(records)&&
    records.filter(x=>x.path===ARTICLE).length===1,
    'published topic index has missing or duplicate toolchain article');
  const entry=records.find(x=>x.path===ARTICLE);
  deny(entry.title===TITLE&&entry.status==='verified'&&entry.updated_at===date&&
    entry.categories?.includes('toolchain')&&entry.categories?.includes('erofs')&&
    Array.isArray(index.categories?.toolchain)&&
    index.categories.toolchain.filter(p=>p===ARTICLE).length===1&&
    index.categories.erofs?.includes(ARTICLE),
    'published category index or metadata differs from article');

  const titleChange='## '+date+' | create | '+TITLE;
  const relatedChange='## '+date+' | update | Nession GitHub Actions workflow domains and trust boundaries';
  deny(exactlyOnce(changelog,titleChange)&&exactlyOnce(changelog,relatedChange)&&
    changelog.includes('- Path: '+ARTICLE)&&
    changelog.includes('- Source: https://github.com/'+REPO+'/issues/4113'),
    'published changelog is missing/mismatched or duplicates this transaction');

  return Object.freeze({
    article_path:ARTICLE,
    knowledge_commit_sha:w.published,
    protected_knowledge_ref_sha:ref.object.sha,
    content_readback:'exact_immutable_GitHub_commit',
    verified_article_sources:true,
    verified_topic_and_category_index:true,
    verified_reciprocal_links:true,
    verified_global_changelog:true,
    exact_four_file_commit:true,
  });
}

export function selfTestToolchainKnowledgeReadback(){
  const w=TOOLCHAIN_KNOWLEDGE_WITNESS,at='2026-11-20T01:08:30Z';
  const article='---\ntitle: "'+TITLE+'"\ntopic: workflows\nstatus: verified\n'+
    'updated_at: '+at+'\nsources: '+JSON.stringify([
      'https://github.com/'+REPO+'/blob/'+w.sourceImplementation+'/scripts/toolchains/README.md',
      'https://github.com/'+REPO+'/issues/4092',
      'https://github.com/'+REPO+'/pull/4094',
    ])+'\n---\n\n# '+TITLE+'\n'+
    'ghcr.io/bestnathan/nession-toolchain-jq:1.8.1-r1\n'+
    'sha256:8edf29ce84b0e144ee6288ca92ef76bb507e968cb705484bc96f5a4f93635e59\n'+
    '44586296125\nLinux AMD64 only\n'+
    '[Workflow](nession-github-actions-workflow-domains-and-trust-boundaries.md)\n';
  const workflow='[Toolchain](nession-native-toolchain-oci-release-to-ghcr.md)';
  const index=JSON.stringify({schema_version:2,topics:{workflows:[{
    path:ARTICLE,title:TITLE,status:'verified',updated_at:at,
    categories:['toolchain','erofs'],
  }]},categories:{toolchain:[ARTICLE],erofs:[ARTICLE]}});
  const changelog='## '+at+' | update | Nession GitHub Actions workflow domains and trust boundaries\n'+
    '- Source: https://github.com/'+REPO+'/issues/4113\n'+
    '## '+at+' | create | '+TITLE+'\n- Path: '+ARTICLE+'\n'+
    '- Source: https://github.com/'+REPO+'/issues/4113\n';
  const file=(path,text)=>({path,type:'file',encoding:'base64',
    size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')});
  const files={[ARTICLE]:file(ARTICLE,article),[WORKFLOW]:file(WORKFLOW,workflow),
    [INDEX]:file(INDEX,index),[CHANGELOG]:file(CHANGELOG,changelog)};
  const original={
    ref:{ref:'refs/heads/knowledge',object:{sha:w.published}},
    commit:{sha:w.published,parents:[{sha:w.previous}],files:[
      {filename:ARTICLE,status:'added'},{filename:WORKFLOW,status:'modified'},
      {filename:INDEX,status:'modified'},{filename:CHANGELOG,status:'modified'}]},
    files,publishedSha:w.published,previousSha:w.previous,
    publicDigest:w.publicDigest,publicArticles:28,
  };
  const prove=p=>attestToolchainKnowledgeReadback({...original,...p});
  assert.equal(prove({}).verified_reciprocal_links,true);
  const mutate=(path,from,to)=>({...files,[path]:file(path,
    Buffer.from(files[path].content,'base64').toString('utf8').replace(from,to))});
  const wrong='f'.repeat(40);
  for(const patch of [
    {ref:{ref:'refs/heads/knowledge',object:{sha:wrong}}},
    {ref:{ref:'refs/heads/knowledge',object:{sha:wrong}},
      sourceToCurrent:{base_commit:{sha:wrong},merge_base_commit:{sha:wrong},status:'ahead',head_commit:{sha:wrong}}},
    {publishedSha:wrong},{previousSha:wrong},{publicDigest:'a'.repeat(64)},{publicArticles:27},
    {commit:{...original.commit,parents:[{sha:wrong}]}},
    {commit:{...original.commit,files:original.commit.files.slice(1)}},
    {commit:{...original.commit,files:[...original.commit.files,{filename:'secrets',status:'added'}]}},
    {files:mutate(ARTICLE,'status: verified','status: candidate')},
    {files:mutate(ARTICLE,'jq:1.8.1-r1','jq:1.8.2-r1')},
    {files:mutate(ARTICLE,'44586296125','44586296126')},
    {files:mutate(ARTICLE,'/pull/4094','/pull/9999')},
    {files:mutate(WORKFLOW,'nession-native-toolchain-oci-release-to-ghcr.md','missing.md')},
    {files:mutate(INDEX,'"toolchain":["'+ARTICLE+'"]','"toolchain":[]')},
    {files:mutate(CHANGELOG,' | create | ',' | modify | ')},
    {files:{...files,[ARTICLE]:{...files[ARTICLE],size:1}}},
  ])assert.throws(()=>prove(patch));
  return true;
}
if(process.argv[2]==='self-test'){
  selfTestToolchainKnowledgeReadback();
  console.log('toolchain knowledge immutable readback positive/negative fixtures passed');
}
