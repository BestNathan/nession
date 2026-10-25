'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');
const REMOTE='https://github.com/BestNathan/nession.git';
const ROOT='c91b60925b94792827198a31de739eeb50700cc3';
const ISSUE='https://github.com/BestNathan/nession/issues/2325';
function cap(cmd,args,opts={}){return spawnSync(cmd,args,{cwd:opts.cwd,encoding:'utf8',maxBuffer:16*1024*1024,timeout:opts.timeout||120000,env:{...process.env,...(opts.env||{})}});}
function run(cmd,args,opts={}){const r=cap(cmd,args,opts);if(r.error||r.status!==0)throw Error(cmd+' '+args.join(' ')+' failed: '+String(r.error?.message||r.stderr||r.stdout).trim());return String(r.stdout||'').trimEnd();}
function git(repo,...args){return run('git',['-C',repo,...args]);}
function ctx(){const target=String(process.env.NESSION_ACCEPTANCE_TARGET_SHA||'').trim();assert.match(target,/^[0-9a-f]{40}$/);const repo=process.cwd();assert.equal(git(repo,'rev-parse','HEAD'),target);const trusted=String(process.env.NESSION_ACCEPTANCE_TRUSTED_ROOT||'').trim();assert.ok(trusted);const checker=path.join(trusted,'scripts/knowledge-ledger-contract.mjs'),publisher=path.join(trusted,'scripts/knowledge-ledger-publish.mjs');assert.ok(fs.existsSync(checker));assert.ok(fs.existsSync(publisher));return {target,repo,trusted,checker,publisher};}
function check(c,ledger){const r=cap(process.execPath,[c.checker,'check',ledger,ROOT],{cwd:c.trusted});assert.equal(r.status,0,'ledger check failed: '+(r.stderr||r.stdout));const m=String(r.stdout).match(/knowledge-ledger-contract: PASS (\{[^\n]+\})/);assert.ok(m);return JSON.parse(m[1]);}
function clone(c,fn){const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-kb-case-')),ledger=path.join(tmp,'ledger');try{run('git',['clone','--quiet','--single-branch','--branch','knowledge','--no-tags',REMOTE,ledger],{cwd:tmp,timeout:120000});return fn(ledger,tmp);}finally{fs.rmSync(tmp,{recursive:true,force:true});}}
function index(ledger){return JSON.parse(fs.readFileSync(path.join(ledger,'index.json'),'utf8'));}
function articles(idx){return Object.values(idx.topics).flat().sort((a,b)=>a.path.localeCompare(b.path));}
function slug(s){return String(s).normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/gu,'-').replace(/[^\p{L}\p{N}-]+/gu,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');}
function fm(text,file){assert.ok(text.startsWith('---\n'),file+' frontmatter start');const end=text.indexOf('\n---\n',4);assert.ok(end>=0,file+' frontmatter end');const o={};for(const line of text.slice(4,end).split('\n')){const m=/^([a-z_]+):\s*(.*)$/.exec(line);assert.ok(m,file+' invalid field');const k=m[1],v=m[2];assert.ok(!Object.hasOwn(o,k),'duplicate field '+k);o[k]=(k==='categories'||k==='sources')?JSON.parse(v):v.startsWith('"')?JSON.parse(v):v;}return o;}
function ev(type,value){return {type,value:String(value).replace(/[\r\n]+/g,' ').trim()};}
function queryCheck(c,ledger){const idx=index(ledger),all=articles(idx),log=fs.readFileSync(path.join(ledger,'CHANGELOG.md'),'utf8');assert.ok(all.length);assert.ok(idx.topics.engineering?.length);assert.ok(idx.categories.knowledge?.length);let source=false;for(const a of all){const data=fm(fs.readFileSync(path.join(ledger,a.path),'utf8'),a.path);assert.equal(a.title,data.title);assert.equal(data.topic,a.path.split('/')[1]);assert.equal(path.basename(a.path,'.md'),slug(data.title));assert.ok(!Object.hasOwn(data,'id'));assert.ok(idx.categories[data.categories[0]]?.includes(a.path));assert.ok(log.includes(' | '+data.title+'\n'));assert.ok(data.sources.length);if(data.sources.some(s=>/^https:\/\/github\.com\/BestNathan\/nession\/blob\/[a-f0-9]{40}\//.test(s)))source=true;}assert.ok(source);return {idx,all,audit:check(c,ledger)};}
function reject(c,ledger,label,mutate){mutate();const r=cap(process.execPath,[c.checker,'check',ledger,ROOT],{cwd:c.trusted});git(ledger,'reset','--hard','HEAD');git(ledger,'clean','-fd');assert.notEqual(r.status,0,label+' unexpectedly passed');return ev('negative-fixture',label+' rejected');}
function negatives(c,ledger){
  const target=articles(index(ledger)).find(a=>a.status==='verified');
  assert.ok(target);
  const file=path.join(ledger,target.path),original=fs.readFileSync(file,'utf8'),proof=[];
  proof.push(reject(c,ledger,'synthetic ID/malformed frontmatter',()=>fs.writeFileSync(file,original.replace(/^title:/m,'id: synthetic\ntitle:'))));
  proof.push(reject(c,ledger,'shortened/unrelated title-derived filename',()=>fs.renameSync(file,path.join(path.dirname(file),'short-name.md'))));
  proof.push(reject(c,ledger,'topic/category index drift',()=>fs.writeFileSync(path.join(ledger,'index.json'),'{}\n')));
  proof.push(reject(c,ledger,'missing article changelog event',()=>{const p=path.join(ledger,'CHANGELOG.md'),t=fs.readFileSync(p,'utf8'),i=t.lastIndexOf('\n## ');assert.ok(i>0);fs.writeFileSync(p,t.slice(0,i).trimEnd()+'\n');}));
  proof.push(reject(c,ledger,'verified article missing exact-SHA source',()=>fs.writeFileSync(file,original.replace(/^sources:.*$/m,'sources: []'))));

  // Exercise the actual secret scanner, not an earlier index/hash mismatch:
  // create a valid atomic ledger commit whose only policy violation is secret-like content.
  const secretBase=git(ledger,'rev-parse','HEAD');
  git(ledger,'config','user.name','Nession Acceptance Fixture');
  git(ledger,'config','user.email','nession-acceptance@example.invalid');
  const secretAt=new Date().toISOString();
  assert.ok(Date.parse(secretAt)>=Date.parse('2026-10-24T12:24:00Z'));
  fs.writeFileSync(file,original.replace(/^updated_at:.*$/m,'updated_at: '+secretAt)+
    '\nSynthetic test marker: '+'gh'+'p_'+'A'.repeat(36)+'\n');
  const logPath=path.join(ledger,'CHANGELOG.md'),oldLog=fs.readFileSync(logPath,'utf8');
  const event=[
    '## '+secretAt+' | update | '+target.title,
    '- Path: '+target.path,
    '- Topic: '+target.path.split('/')[1],
    '- Categories: '+target.categories.join(', '),
    '- Reason: disposable negative fixture for the public-ledger secret scanner',
    '- Source: '+ISSUE,
  ].join('\n');
  fs.writeFileSync(logPath,oldLog.trimEnd()+'\n\n'+event+'\n');
  run(process.execPath,[c.checker,'index',ledger],{cwd:c.trusted});
  git(ledger,'add','CHANGELOG.md','index.json',target.path);
  git(ledger,'commit','-m','fixture: test secret scanner with valid ledger transaction');
  const secretResult=cap(process.execPath,[c.checker,'check',ledger,ROOT],{cwd:c.trusted});
  const secretOutput=String(secretResult.stderr||secretResult.stdout);
  git(ledger,'reset','--hard',secretBase);
  git(ledger,'clean','-fd');
  assert.notEqual(secretResult.status,0,'secret-like public knowledge unexpectedly passed');
  assert.match(secretOutput,/public knowledge contains secret-like text/,
    'secret scanner did not reject the otherwise-valid transaction: '+secretOutput);
  proof.push(ev('negative-fixture','structurally valid atomic commit with secret-like content rejected by explicit secret scanner'));

  const base=git(ledger,'rev-parse','HEAD');
  git(ledger,'config','user.name','Nession Acceptance Fixture');
  git(ledger,'config','user.email','nession-acceptance@example.invalid');
  const lp=path.join(ledger,'CHANGELOG.md'),before=fs.readFileSync(lp,'utf8'),marker='v1 commits remain in Git history';
  assert.ok(before.includes(marker));
  fs.writeFileSync(lp,before.replace(marker,'v1 history was rewritten'));
  git(ledger,'add','CHANGELOG.md');
  git(ledger,'commit','-m','fixture: rewrite historical changelog');
  const tamper=cap(process.execPath,[c.checker,'check',ledger,ROOT],{cwd:c.trusted});
  git(ledger,'reset','--hard',base);
  git(ledger,'clean','-fd');
  assert.notEqual(tamper.status,0,'historical log rewrite unexpectedly passed');
  proof.push(ev('negative-fixture','committed historical CHANGELOG rewrite rejected'));
  return proof;
}
function tooling(c){const a=cap(process.execPath,[c.checker,'self-test'],{cwd:c.trusted}),b=cap(process.execPath,[c.publisher,'self-test'],{cwd:c.trusted});assert.equal(a.status,0,'validator tests failed '+(a.stderr||a.stdout));assert.equal(b.status,0,'publisher tests failed '+(b.stderr||b.stdout));return {a:String(a.stdout).trim(),b:String(b.stdout).trim()};}
function audit(){const c=ctx();return clone(c,ledger=>{const r=check(c,ledger),head=git(ledger,'rev-parse','HEAD'),parents=git(ledger,'rev-list','--parents','-n','1',head).split(/\s+/);assert.equal(parents.length,2);assert.equal(git(ledger,'rev-list','--max-parents=0','HEAD'),ROOT);return {status:'pass',summary:'Live knowledge ledger passed the trusted read-only contract audit with intact orphan ancestry.',evidence:[ev('runtime','target_sha='+c.target),ev('knowledge-ledger','live_head='+head+'; parent='+parents[1]),ev('knowledge-ledger','pinned_root='+ROOT+'; topics='+r.topics+'; current_articles='+r.knowledge+'; changelog_events='+r.events)]};});}
function model(){const c=ctx();return clone(c,ledger=>{const r=queryCheck(c,ledger);return {status:'pass',summary:'Live v2 ledger passed contract and topic/category/full-title/path/exact-source query checks.',evidence:[ev('runtime','target_sha='+c.target),ev('knowledge-ledger','live_head='+r.audit.head),ev('knowledge-ledger','topics='+r.audit.topics+'; current_articles='+r.all.length),ev('knowledge-ledger','topic=engineering, category=knowledge, full title/path and exact-SHA source lookups passed')]};});}
function atomic(){
  const c=ctx();
  return clone(c,ledger=>{
    const initial=check(c,ledger);
    const base=git(ledger,'rev-parse','HEAD');
    const idx=index(ledger);
    const existing=articles(idx).find(a=>a.title==='Nession instruction architecture and knowledge ownership');
    assert.ok(existing,'current engineering article is required');
    const existingFile=path.join(ledger,existing.path);
    const originalBaseArticle=fs.readFileSync(existingFile,'utf8');
    const proof=[];
    git(ledger,'config','user.name','Nession Acceptance Fixture');
    git(ledger,'config','user.email','nession-acceptance@example.invalid');

    function nextAt(){
      const log=fs.readFileSync(path.join(ledger,'CHANGELOG.md'),'utf8');
      const dates=[...log.matchAll(/^## (\S+) \|/gm)].map(m=>Date.parse(m[1])).filter(Number.isFinite);
      return new Date(Math.max(Date.now(),(dates.at(-1)||0)+1000)).toISOString();
    }
    function event(at,action,title,filePath,topic,categories,reason,previous){
      const lines=[
        '## '+at+' | '+action+' | '+title,
        '- Path: '+filePath,
      ];
      if(previous)lines.push('- Previous path: '+previous);
      lines.push(
        '- Topic: '+topic,
        '- Categories: '+(categories.length?categories.join(', '):'none'),
        '- Reason: '+reason,
        '- Source: '+ISSUE
      );
      return lines.join('\n');
    }
    function appendEvents(newEvents){
      const file=path.join(ledger,'CHANGELOG.md');
      const old=fs.readFileSync(file,'utf8');
      fs.writeFileSync(file,old.trimEnd()+'\n\n'+newEvents.join('\n\n')+'\n');
    }
    function commitTransaction(message,changedPaths){
      run(process.execPath,[c.checker,'index',ledger],{cwd:c.trusted});
      git(ledger,'add','-A');
      const expected=['CHANGELOG.md','index.json',...changedPaths].sort();
      const staged=git(ledger,'diff','--cached','--no-renames','--name-only').split('\n').sort();
      assert.deepEqual(staged,expected,'atomic transaction staged unexpected/missing files: '+message);
      git(ledger,'commit','-m',message);
      const sha=git(ledger,'rev-parse','HEAD');
      const actual=git(ledger,'diff-tree','--no-renames','--no-commit-id','--name-only','-r','HEAD').split('\n').sort();
      assert.deepEqual(actual,expected,'one commit must contain the entire transaction: '+message);
      const audit=check(c,ledger);
      proof.push(ev('knowledge-ledger',message+' commit='+sha+'; changed='+expected.join(',')));
      proof.push(ev('knowledge-ledger','post-commit validator PASS; current_articles='+audit.knowledge+'; changelog_events='+audit.events));
      return sha;
    }

    const createdTitle='Acceptance Fixture: Knowledge Ledger Atomic Publish';
    const createdPath='topics/engineering/'+slug(createdTitle)+'.md';
    assert.ok(!fs.existsSync(path.join(ledger,createdPath)),'temporary article path must be unused');
    const createAt=nextAt();
    const originalUpdated=originalBaseArticle.replace(/^updated_at:.*$/m,'updated_at: '+createAt)+
      '\n\n## Temporary Acceptance transaction\n\n[Disposable atomic publication fixture](./'+path.basename(createdPath)+').\n';
    fs.writeFileSync(existingFile,originalUpdated);
    fs.writeFileSync(path.join(ledger,createdPath),[
      '---',
      'title: "'+createdTitle+'"',
      'description: Disposable article for the isolated atomic-publication Case',
      'topic: engineering',
      'categories: ["acceptance-fixture","knowledge"]',
      'status: candidate',
      'created_at: '+createAt,
      'updated_at: '+createAt,
      'sources: ["'+ISSUE+'"]',
      '---',
      '',
      '# '+createdTitle,
      '',
      'This candidate exists only in a temporary clone used by the Acceptance Case.',
      'It must never be published to the shared knowledge ref.',
      '',
    ].join('\n'));
    appendEvents([
      event(createAt,'update',existing.title,existing.path,'engineering',existing.categories,
        'Disposable Acceptance: update current article and link its temporary fixture'),
      event(createAt,'create',createdTitle,createdPath,'engineering',['acceptance-fixture','knowledge'],
        'Disposable Acceptance: create candidate article'),
    ]);
    const createCommit=commitTransaction('fixture: atomically create and update current knowledge articles',
      [existing.path,createdPath]);
    proof.push(ev('knowledge-ledger','create/update verified in one article+index+CHANGELOG commit='+createCommit));

    const renamedTitle='Acceptance Fixture: Renamed Knowledge Ledger Atomic Publish';
    const renamedPath='topics/engineering/'+slug(renamedTitle)+'.md';
    const renameAt=nextAt();
    const createFixture=fs.readFileSync(path.join(ledger,createdPath),'utf8');
    const renamedFixture=createFixture
      .replace('title: "'+createdTitle+'"','title: "'+renamedTitle+'"')
      .replace(/^updated_at:.*$/m,'updated_at: '+renameAt)
      .replace('# '+createdTitle,'# '+renamedTitle);
    fs.renameSync(path.join(ledger,createdPath),path.join(ledger,renamedPath));
    fs.writeFileSync(path.join(ledger,renamedPath),renamedFixture);
    let article=fs.readFileSync(existingFile,'utf8');
    article=article.replace('./'+path.basename(createdPath),'./'+path.basename(renamedPath))
      .replace(/^updated_at:.*$/m,'updated_at: '+renameAt);
    fs.writeFileSync(existingFile,article);
    appendEvents([
      event(renameAt,'update',existing.title,existing.path,'engineering',existing.categories,
        'Disposable Acceptance: update link after fixture title rename'),
      event(renameAt,'rename',renamedTitle,renamedPath,'engineering',['acceptance-fixture','knowledge'],
        'Disposable Acceptance: rename complete title and filename',createdPath),
    ]);
    const renameCommit=commitTransaction('fixture: atomically rename the complete article title and filename',
      [existing.path,createdPath,renamedPath]);
    proof.push(ev('knowledge-ledger','rename verified with Previous path and full-title-derived filename; commit='+renameCommit));

    const movedPath='topics/skills/'+slug(renamedTitle)+'.md';
    const moveAt=nextAt();
    const renamedContent=fs.readFileSync(path.join(ledger,renamedPath),'utf8');
    const movedContent=renamedContent
      .replace(/^topic: engineering$/m,'topic: skills')
      .replace(/^updated_at:.*$/m,'updated_at: '+moveAt);
    fs.mkdirSync(path.dirname(path.join(ledger,movedPath)),{recursive:true});
    fs.renameSync(path.join(ledger,renamedPath),path.join(ledger,movedPath));
    fs.writeFileSync(path.join(ledger,movedPath),movedContent);
    article=fs.readFileSync(existingFile,'utf8')
      .replace('./'+path.basename(renamedPath),'../skills/'+path.basename(movedPath))
      .replace(/^updated_at:.*$/m,'updated_at: '+moveAt);
    fs.writeFileSync(existingFile,article);
    appendEvents([
      event(moveAt,'update',existing.title,existing.path,'engineering',existing.categories,
        'Disposable Acceptance: update cross-topic link after fixture move'),
      event(moveAt,'move',renamedTitle,movedPath,'skills',['acceptance-fixture','knowledge'],
        'Disposable Acceptance: move current article between primary topics',renamedPath),
    ]);
    const moveCommit=commitTransaction('fixture: atomically move the current article to another primary topic',
      [existing.path,renamedPath,movedPath]);
    proof.push(ev('knowledge-ledger','move verified with Previous path, topic/index change and backlink update; commit='+moveCommit));

    const deleteAt=nextAt();
    fs.rmSync(path.join(ledger,movedPath));
    article=fs.readFileSync(existingFile,'utf8')
      .replace(/\n\n## Temporary Acceptance transaction\n[\s\S]*$/,'')
      .replace(/^updated_at:.*$/m,'updated_at: '+deleteAt);
    fs.writeFileSync(existingFile,article);
    appendEvents([
      event(deleteAt,'update',existing.title,existing.path,'engineering',existing.categories,
        'Disposable Acceptance: remove link to deleted fixture'),
      event(deleteAt,'delete',renamedTitle,movedPath,'skills',['acceptance-fixture','knowledge'],
        'Disposable Acceptance: delete temporary article'),
    ]);
    const deleteCommit=commitTransaction('fixture: atomically delete the temporary article and remove its index entry',
      [existing.path,movedPath]);
    proof.push(ev('knowledge-ledger','delete verified and removed from derived index; commit='+deleteCommit));

    assert.equal(execFileSync('git',['-C',ledger,'show',base+':'+existing.path],{encoding:'utf8'}),originalBaseArticle,
      'historical article snapshot must remain byte-for-byte unchanged');
    const finalIndex=index(ledger);
    const allFinal=articles(finalIndex);
    assert.ok(!allFinal.some(a=>a.path===createdPath||a.path===renamedPath||a.path===movedPath),
      'deleted fixture must not remain in the current-state index');
    assert.ok(!finalIndex.categories['acceptance-fixture'],'deleted fixture category must be absent from current index');
    const history=fs.readFileSync(path.join(ledger,'CHANGELOG.md'),'utf8');
    for(const action of [' | create | '+createdTitle,' | rename | '+renamedTitle,' | move | '+renamedTitle,' | delete | '+renamedTitle]){
      assert.ok(history.includes(action+'\n'),'global CHANGELOG must retain action '+action);
    }
    const publisher=cap(process.execPath,[c.publisher,'self-test'],{cwd:c.trusted});
    assert.equal(publisher.status,0,'stale writer must be rejected: '+(publisher.stderr||publisher.stdout));
    assert.equal(git(ledger,'remote','get-url','origin'),REMOTE,'test must only retain public origin and never push');

    return {
      status:'pass',
      summary:'Isolated lifecycle tests verified create, update, rename, move and delete as atomic article+index+global-CHANGELOG commits; each transaction passed the trusted contract, prior history remained immutable, and stale CAS was rejected.',
      evidence:[
        ev('runtime','target_sha='+c.target),
        ev('knowledge-ledger','live_head_before_fixture='+base+'; initial_topics='+initial.topics),
        ...proof,
        ev('knowledge-ledger','prior current-article snapshot remained byte-for-byte unchanged'),
        ev('knowledge-ledger','deleted fixture absent from current topic/category index; historical create/rename/move/delete events retained'),
        ev('negative-fixture',String(publisher.stdout).trim()),
      ]
    };
  });
}
function negative(){const c=ctx();return clone(c,ledger=>{const live=check(c,ledger),t=tooling(c),proof=negatives(c,ledger);return {status:'pass',summary:'Live ledger and negative fixtures reject malformed metadata, title/path and index drift, missing changelog/source, secret-like content, stale CAS and committed history rewrite.',evidence:[ev('runtime','target_sha='+c.target),ev('knowledge-ledger','live_head='+live.head),ev('knowledge-ledger','validator fixtures: '+t.a),ev('knowledge-ledger','publisher fixtures: '+t.b),...proof]};});}
async function main(mode){if(mode==='audit')return audit();if(mode==='model')return model();if(mode==='atomic')return atomic();if(mode==='negative')return negative();throw Error('unknown mode '+mode);}
module.exports={main};
