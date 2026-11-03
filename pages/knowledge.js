// Native public Knowledge reader. No product-Web imports and no Markdown HTML injection.
const GH='https://github.com/BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const ARTICLE=/^topics\/[a-z0-9]+(?:-[a-z0-9]+)*\/[^/]+\.md$/u;
const state={query:'',topic:'all',category:'all'};
const el=(tag,cls,value)=>{
  const n=document.createElement(tag);
  if(cls)n.className=cls;
  if(value!==undefined)n.textContent=String(value);
  return n;
};
const add=(parent,...items)=>{for(const item of items)if(item)parent.append(item);return parent;};
function local(label,hash,cls=''){const a=el('a',cls,label);a.href=hash;return a;}
function allowedExternal(url){
  try {const x=new URL(url);return x.protocol==='https:'&&
    (x.hostname==='github.com'||x.hostname==='gist.github.com')&&!x.username&&!x.password;}
  catch{return false;}
}
function external(label,url,cls=''){
  const a=el('a',cls,label);
  if(allowedExternal(url)){a.href=url;a.target='_blank';a.rel='noopener noreferrer';}
  return a;
}
function stamp(iso){
  return new Date(iso).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'});
}
export function knowledgeHref(path){
  if(!ARTICLE.test(path)||path.includes('..')||path.includes('\\'))return '#/knowledge';
  return '#/knowledge?article='+encodeURIComponent(path);
}
export function knowledgeRoute(hash){
  const raw=String(hash||'').replace(/^#/,'');
  if(!/^\/knowledge(?:\?|$)/.test(raw))return null;
  const q=new URLSearchParams(raw.split('?')[1]||'');
  const path=q.get('article');
  return {view:q.get('view')==='changes'?'changes':'browse',
    article:path&&ARTICLE.test(path)&&!path.includes('..')?path:null};
}
export function validKnowledgeSnapshot(data){
  return data?.schema_version===1&&['available','unavailable'].includes(data.status)&&
    Array.isArray(data.articles)&&Array.isArray(data.changes)&&
    Array.isArray(data.topics)&&Array.isArray(data.categories)&&
    data.articles.length<=200&&data.changes.length<=2000&&
    (data.status==='unavailable'?data.source===null&&data.articles.length===0:
      data.source?.branch==='knowledge'&&SHA.test(data.source.sha||'')&&
      data.articles.every(a=>ARTICLE.test(a?.path||'')&&typeof a.title==='string'&&
        typeof a.description==='string'&&typeof a.body==='string'&&
        ['verified','candidate'].includes(a.status)&&Array.isArray(a.categories)&&
        Array.isArray(a.sources)));
}
export function filterKnowledge(articles,{query='',topic='all',category='all'}={}){
  const q=query.toLocaleLowerCase().trim();
  return articles.filter(a=>(topic==='all'||a.topic===topic)&&
    (category==='all'||a.categories.includes(category))&&
    (!q||[a.title,a.description,a.topic,a.categories.join(' '),a.body]
      .join(' ').toLocaleLowerCase().includes(q)));
}
function resolveLink(link,article,paths){
  if(typeof link!=='string'||!link||link.startsWith('#'))return null;
  if(link.startsWith('https://'))return allowedExternal(link)?{href:link,external:true}:null;
  if(/^[a-z][a-z0-9+.-]*:/i.test(link)||link.startsWith('//'))return null;
  try {
    const parsed=new URL(link,'https://knowledge.local/'+article.path);
    if(parsed.hostname!=='knowledge.local')return null;
    const path=decodeURIComponent(parsed.pathname.slice(1));
    if(paths.has(path))return {href:knowledgeHref(path),external:false};
  } catch { /* malformed link */ }
  return null;
}
function inline(content,parent,article,paths){
  // Text nodes, never innerHTML. Unrecognized Markdown remains plain text.
  const re=/(\[([^\]]{1,240})\]\(([^)\s]{1,800})\)|\*\*([^*\n]{1,300})\*\*|\x60([^\x60\n]{1,300})\x60)/g;
  let pos=0,match;
  while((match=re.exec(content))!==null){
    if(match.index>pos)parent.append(document.createTextNode(content.slice(pos,match.index)));
    if(match[2]!==undefined){
      const link=resolveLink(match[3],article,paths);
      if(link){
        const a=el('a','',match[2]);a.href=link.href;
        if(link.external){a.target='_blank';a.rel='noopener noreferrer';}
        parent.append(a);
      }else parent.append(document.createTextNode(match[2]));
    }else if(match[4]!==undefined)parent.append(el('strong','',match[4]));
    else parent.append(el('code','',match[5]));
    pos=re.lastIndex;
  }
  if(pos<content.length)parent.append(document.createTextNode(content.slice(pos)));
}
function renderMarkdown(body,parent,article,paths){
  const lines=body.split(/\r?\n/);
  let list=null,kind=null,code=null,paragraph=[];
  function flush(){
    if(paragraph.length){
      const p=el('p');inline(paragraph.join(' '),p,article,paths);parent.append(p);paragraph=[];
    }
    list=null;kind=null;
  }
  for(const line of lines){
    if(code!==null){
      if(/^ *\x60{3,}\s*$/.test(line)){parent.append(add(el('pre'),el('code','',code.join('\n'))));code=null;}
      else code.push(line);
      continue;
    }
    if(/^ *\x60{3,}[\w-]*\s*$/.test(line)){flush();code=[];continue;}
    const h=/^(#{1,5})\s+(.+)$/.exec(line);
    if(h){flush();const n=el('h'+Math.min(h[1].length+1,6));inline(h[2],n,article,paths);parent.append(n);continue;}
    const li=/^\s*(?:([-*])|([0-9]+)\.)\s+(.+)$/.exec(line);
    if(li){
      if(paragraph.length)flush();
      const next=li[2]?'ol':'ul';
      if(!list||kind!==next){list=el(next);parent.append(list);kind=next;}
      const n=el('li');inline(li[3],n,article,paths);list.append(n);continue;
    }
    const quote=/^>\s?(.*)$/.exec(line);
    if(quote){flush();const n=el('blockquote');inline(quote[1],n,article,paths);parent.append(n);continue;}
    if(!line.trim()){flush();continue;}
    if(list)flush();
    paragraph.push(line.trim());
  }
  if(code!==null)parent.append(add(el('pre'),el('code','',code.join('\n'))));
  flush();
}
const pill=(label,cls='')=>el('span','knowledge-tag '+cls,label);
function articleReader(article,source,paths){
  const reader=el('article','knowledge-reader');
  reader.append(local('← All articles','#/knowledge','knowledge-back'));
  add(reader,el('div','eyebrow',article.topic+' / CURRENT KNOWLEDGE'),
    el('h2','',article.title),el('p','knowledge-description',article.description));
  const meta=el('div','knowledge-meta');
  add(meta,el('span','','Updated '+stamp(article.updated_at)),
    pill(article.status,article.status==='candidate'?'candidate':'verified'));
  for(const t of article.categories)meta.append(pill(t));
  reader.append(meta);
  reader.append(el('div','knowledge-authority',article.status==='verified'
    ?'Verified means sourced project knowledge, not live runtime truth. Code, Gates and owner decisions remain authoritative.'
    :'Candidate: this article is not verified against authoritative evidence.'));
  const prose=el('div','knowledge-prose');
  renderMarkdown(article.body,prose,article,paths);reader.append(prose);
  const sources=el('section','knowledge-sources');
  sources.append(el('h3','','Evidence sources'));
  for(const [i,url] of article.sources.entries())
    sources.append(external('Source '+(i+1)+' · '+url.replace(GH+'/','')+' ↗',url));
  reader.append(sources);
  const actions=el('div','knowledge-actions');
  add(actions,external('Original at pinned SHA ↗',GH+'/blob/'+source.sha+'/'+article.path,'action'),
    external('Git history ↗',GH+'/commits/knowledge/'+article.path,'action outline'));
  reader.append(actions);return reader;
}
function changeList(data){
  const wrap=el('div','knowledge-changes');
  const intro=el('div','knowledge-change-intro');
  add(intro,el('div','eyebrow','KNOWLEDGE / CHANGELOG'),
    el('h2','','Changes over time.'),
    el('p','','The single append-only project log. Historical article bodies live in Git commits.'));
  wrap.append(intro);
  const list=el('div','knowledge-change-list');
  const paths=new Set(data.articles.map(a=>a.path));
  for(const entry of data.changes){
    const row=el('article','knowledge-event');
    const time=el('time','',stamp(entry.at));time.dateTime=entry.at;
    row.append(time);
    const main=el('div');const head=el('div','knowledge-event-heading');
    add(head,pill(entry.action),el('strong','',entry.title));
    add(main,head,el('p','',entry.reason));
    const links=el('div','knowledge-event-links');
    if(paths.has(entry.path))links.append(local('Read current article ↗',knowledgeHref(entry.path)));
    links.append(external('Source issue / PR ↗',entry.source));
    main.append(links);row.append(main);list.append(row);
  }
  if(!data.changes.length)list.append(el('p','','No recorded changes.'));
  wrap.append(list);return wrap;
}
function filters(side,data,update){
  side.replaceChildren();
  side.append(el('div','eyebrow','TOPICS'));
  const rail=el('div','knowledge-topic-group');
  for(const t of ['all',...data.topics]){
    const count=t==='all'?data.articles.length:data.articles.filter(a=>a.topic===t).length;
    const b=el('button','knowledge-filter'+(state.topic===t?' active':''),(t==='all'?'All topics':t)+'  '+count);
    b.type='button';b.setAttribute('aria-pressed',state.topic===t?'true':'false');
    b.onclick=()=>{state.topic=t;update();};rail.append(b);
  }
  side.append(rail);side.append(el('div','eyebrow knowledge-category-title','CATEGORIES'));
  const chips=el('div','knowledge-categories');
  for(const c of ['all',...data.categories]){
    const b=el('button','knowledge-category'+(state.category===c?' active':''),c==='all'?'All tags':c);
    b.type='button';b.setAttribute('aria-pressed',state.category===c?'true':'false');
    b.onclick=()=>{state.category=c;update();};chips.append(b);
  }
  side.append(chips);
}
export function renderKnowledge(root,data,hash){
  const route=knowledgeRoute(hash)||{view:'browse',article:null};
  add(root,el('div','eyebrow knowledge-kicker','NESSION / OPEN ENGINEERING / KNOWLEDGE'),
    el('h1','knowledge-heading','What we’ve learned, kept.'),
    el('p','knowledge-lede','Source-grounded engineering decisions and insights, preserved as the project evolves.'));
  if(!data||data.status==='unavailable'){
    root.append(add(el('div','panel knowledge-unavailable'),
      el('h3','','Knowledge snapshot unavailable'),
      el('p','','The pinned source could not be validated or loaded. This is not an empty knowledge base.'),
      external('View Knowledge source ↗',GH+'/tree/knowledge')));return;
  }
  const source=el('div','knowledge-snapshot');
  add(source,el('span','eyebrow','SOURCE SNAPSHOT'),
    el('strong','','knowledge @ '+data.source.sha.slice(0,12)),
    el('span','',data.articles.length+' articles · '+data.topics.length+' topics'),
    el('small','','Built '+stamp(data.source.generated_at)+' · read-only'));
  root.append(source);
  const tabs=el('nav','knowledge-tabs');
  add(tabs,local('Browse knowledge','#/knowledge',route.view==='browse'?'active':''),
    local('Changes','#/knowledge?view=changes',route.view==='changes'?'active':''));
  root.append(tabs);
  if(route.view==='changes'){root.append(changeList(data));return;}
  const layout=el('div','knowledge-layout'),side=el('aside','knowledge-side');
  const listBox=el('section','knowledge-listbox'),search=el('input','knowledge-search');
  search.type='search';search.value=state.query;search.placeholder='Search decisions and concepts';
  search.setAttribute('aria-label','Search Knowledge articles');listBox.append(search);
  const count=el('div','knowledge-result-count'),entries=el('div','knowledge-entries');
  add(listBox,count,entries);
  const paths=new Set(data.articles.map(a=>a.path));
  const selected=route.article?data.articles.find(a=>a.path===route.article):data.articles[0]||null;
  function update(){
    filters(side,data,update);
    const found=filterKnowledge(data.articles,state).sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
    count.textContent=found.length+' '+(found.length===1?'ARTICLE':'ARTICLES');
    entries.replaceChildren();
    for(const a of found){
      const link=local('',knowledgeHref(a.path),'knowledge-entry'+(selected?.path===a.path?' selected':''));
      add(link,el('div','eyebrow',a.topic),el('strong','',a.title),el('p','',a.description));
      const meta=el('div','knowledge-entry-meta');
      add(meta,pill(a.status,a.status==='candidate'?'candidate':'verified'),el('span','',stamp(a.updated_at)));
      link.append(meta);entries.append(link);
    }
    if(!found.length)entries.append(el('p','knowledge-no-results',
      'No matching articles. Try another topic, category or search term.'));
  }
  search.oninput=()=>{state.query=search.value;update();};
  update();add(layout,side,listBox);
  const detail=el('div','knowledge-reader-slot');
  if(route.article&&!selected)detail.append(el('div','panel','Article not found in this source snapshot.'));
  else if(selected)detail.append(articleReader(selected,data.source,paths));
  else detail.append(el('div','panel','No published knowledge articles.'));
  if(route.article&&selected)layout.classList.add('reading');
  layout.append(detail);root.append(layout);
}
