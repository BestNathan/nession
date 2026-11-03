import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {projectKnowledge,unavailableKnowledge,validatePublicKnowledge} from '../scripts/knowledge-project.mjs';
import {knowledgeHref,knowledgeRoute,validKnowledgeSnapshot,filterKnowledge} from '../knowledge.js';

const SHA='a'.repeat(40),AT='2026-10-29T19:22:00Z';
const X='topics/terminal/terminal-facts.md',Y='topics/engineering/knowledge-ownership.md';
const source='https://github.com/BestNathan/nession/blob/'+SHA+'/docs/architecture/terminal.md';
const issue='https://github.com/BestNathan/nession/issues/2664';
function article(path,title,topic,tags,body,status='verified',sources=[source]){
 return ['---','title: '+JSON.stringify(title),
   'description: "Source-grounded information about '+title+'"',
   'topic: '+topic,'categories: '+JSON.stringify(tags),
   'status: '+status,'created_at: '+AT,'updated_at: '+AT,
   'sources: '+JSON.stringify(sources),'---','',
   '# '+title,'',body,''].join('\n');
}
function event(path,title,topic,tags){
 return '## '+AT+' | create | '+title+'\n- Path: '+path+
 '\n- Topic: '+topic+'\n- Categories: '+tags.join(', ')+
 '\n- Reason: Published sourced knowledge\n- Source: '+issue+'\n';
}
function fixture(){
 const a={title:'Terminal facts',description:'Source-grounded information about Terminal facts',
   path:X,status:'verified',categories:['terminal'],updated_at:AT};
 const b={title:'Knowledge ownership',description:'Source-grounded information about Knowledge ownership',
   path:Y,status:'verified',categories:['knowledge'],updated_at:AT};
 return {sha:SHA,generatedAt:AT,
  index:{schema_version:2,topics:{engineering:[b],terminal:[a]},
    categories:{knowledge:[Y],terminal:[X]}},
  files:{[X]:article(X,a.title,'terminal',['terminal'],'See [Knowledge ownership](../engineering/knowledge-ownership.md).'),
    [Y]:article(Y,b.title,'engineering',['knowledge'],'Safe and **sourced** project understanding.')},
  changelog:'# Knowledge Changelog\n\n'+event(Y,b.title,'engineering',['knowledge'])+
    '\n'+event(X,a.title,'terminal',['terminal'])};
}
test('published index projects sourced articles, actual paths and one global changelog',()=>{
 const result=projectKnowledge(fixture());
 assert.equal(result.status,'available');
 assert.equal(result.source.sha,SHA);
 assert.equal(result.articles.length,2);
 assert.equal(result.changes.length,2);
 assert.deepEqual(result.topics,['engineering','terminal']);
 assert.ok(validatePublicKnowledge(result));
 assert.ok(validKnowledgeSnapshot(result));
 assert.match(result.articles.find(a=>a.path===X).body,/Knowledge ownership/);
 assert.equal(result.articles[0].path,Y); // same timestamp, stable topic order
});
test('offline branch absence is unavailable, not a fabricated empty verified ledger',()=>{
 const u=unavailableKnowledge();
 assert.equal(u.status,'unavailable');assert.equal(u.source,null);
 assert.ok(validatePublicKnowledge(u));assert.ok(validKnowledgeSnapshot(u));
 assert.equal(validKnowledgeSnapshot({...u,status:'available'}),false);
});
test('project rejects index drift, unsafe sources, synthetic IDs and secret-like bodies',()=>{
 let f=fixture();f.index.categories.terminal=[Y];
 assert.throws(()=>projectKnowledge(f),/category path index drift/);
 f=fixture();f.files[X]=f.files[X].replace('status: verified','status: candidate');
 assert.throws(()=>projectKnowledge(f),/stale article index/);
 f=fixture();f.files[X]=f.files[X].replace('title: "Terminal facts"','id: made-up\ntitle: "Terminal facts"');
 assert.throws(()=>projectKnowledge(f),/frontmatter/);
 f=fixture();f.files[X]=f.files[X].replace(source,'javascript:alert(1)');
 assert.throws(()=>projectKnowledge(f),/invalid article source/);
 f=fixture();f.files[X]+='\nAn internal path: /home/runner/.ssh/id_rsa\n';
 assert.throws(()=>projectKnowledge(f),/sensitive article body/);
 f=fixture();f.files[Y]='---\n'+f.files[Y];assert.throws(()=>projectKnowledge(f));
 f=fixture();f.changelog='# Knowledge Changelog\n\n';
 assert.throws(()=>projectKnowledge(f),/missing latest article changelog/);
});
test('client routes preserve true path identity, reject traversal and allow deep links',()=>{
 assert.equal(knowledgeHref(X),'#/knowledge?article='+encodeURIComponent(X));
 assert.equal(knowledgeHref('../secret.md'),'#/knowledge');
 assert.deepEqual(knowledgeRoute('#/knowledge?view=changes'),{view:'changes',article:null});
 assert.equal(knowledgeRoute('#/knowledge?article='+encodeURIComponent(Y)).article,Y);
 assert.equal(knowledgeRoute('#/knowledge?article=../bad.md').article,null);
});
test('topic, category and text filters work on published article data',()=>{
 const docs=projectKnowledge(fixture()).articles;
 assert.equal(filterKnowledge(docs,{query:'sourced'}).length,2);
 assert.equal(filterKnowledge(docs,{topic:'terminal'}).length,1);
 assert.equal(filterKnowledge(docs,{category:'knowledge'}).length,1);
 assert.equal(filterKnowledge(docs,{query:'not in docs'}).length,0);
});
test('Pages native navigation, trusted deployment and safe text-only rendering are wired',async()=>{
 const [html,app,reader,workflow,build]=await Promise.all([
  readFile(new URL('../index.html',import.meta.url),'utf8'),
  readFile(new URL('../app.js',import.meta.url),'utf8'),
  readFile(new URL('../knowledge.js',import.meta.url),'utf8'),
  readFile(new URL('../../.github/workflows/deploy-pages.yml',import.meta.url),'utf8'),
  readFile(new URL('../scripts/build.mjs',import.meta.url),'utf8')
 ]);
 assert.match(html,/href="#\/knowledge" data-route="\/knowledge"/);
 assert.match(app,/renderKnowledge\(root,knowledgeSnapshot,location\.hash\)/);
 assert.match(app,/validKnowledgeSnapshot/);
 assert.match(reader,/document\.createTextNode/);
 assert.doesNotMatch(reader,/\binnerHTML\b\s*=/);
 assert.match(workflow,/ref: knowledge/);
 assert.match(workflow,/persist-credentials: false/);
 assert.match(workflow,/knowledge-ledger-contract\.mjs check knowledge-store/);
 assert.match(workflow,/EXPECTED_KNOWLEDGE_SHA/);
 assert.match(workflow,/EXPECTED_KNOWLEDGE_JSON_SHA256/);
 assert.match(workflow,/sha256sum "\$knowledge_json"/);
 assert.match(workflow,/\$url\/data\/knowledge\.json\?revision=\$EXPECTED_KNOWLEDGE_SHA/);
 assert.match(build,/data\/knowledge\.json/);
});
