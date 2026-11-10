// Public technical Documents reader. All Markdown is rendered using DOM text
// nodes and a bounded allowlist of elements; raw HTML is never interpreted.
const REPO='https://github.com/BestNathan/nession';
const DOC=/^docs\/architecture\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const SHA=/^[a-f0-9]{40}$/;
const state={query:'',category:'All'};
const el=(tag,cls='',text)=>{
  const n=document.createElement(tag);
  if(cls)n.className=cls;
  if(text!==undefined)n.textContent=String(text);
  return n;
};
const add=(parent,...nodes)=>{for(const n of nodes)if(n)parent.append(n);return parent;};
const link=(text,href,cls='',external=false)=>{
  const n=el('a',cls,text);n.href=href;
  if(external){n.target='_blank';n.rel='noopener noreferrer';}
  return n;
};

export function documentsHref(path){
  return DOC.test(path)?'#/documents?doc='+encodeURIComponent(path):'#/documents';
}
export function documentsRoute(hash){
  const raw=String(hash||'').replace(/^#/,'');
  if(!/^\/documents(?:\?|$)/.test(raw))return null;
  const requested=new URLSearchParams(raw.split('?')[1]||'').get('doc');
  return {doc:requested&&DOC.test(requested)?requested:null,invalid:!!requested&&!DOC.test(requested)};
}
export function validDocumentsSnapshot(data){
  if(data?.schema_version!==1||!['available','unavailable'].includes(data.status)||
    !Array.isArray(data.documents)||data.documents.length>40)return false;
  if(data.status==='unavailable')return data.source===null&&data.documents.length===0;
  if(data.source?.branch!=='main'||data.source?.repository!=='BestNathan/nession'||
    !SHA.test(data.source.sha||'')||data.documents.length===0)return false;
  const paths=new Set();
  return data.documents.every(d=>{
    if(!DOC.test(d?.path||'')||paths.has(d.path)||typeof d.title!=='string'||
      d.title.length>160||typeof d.category!=='string'||d.category.length>40||
      typeof d.description!=='string'||d.description.length>300||
      typeof d.body!=='string'||!d.body.length||d.body.length>160000||
      d.source!==REPO+'/blob/'+data.source.sha+'/'+d.path)return false;
    paths.add(d.path);return true;
  });
}
export function filterDocuments(docs,{query='',category='All'}={}){
  const term=query.trim().toLocaleLowerCase();
  return docs.filter(d=>(category==='All'||d.category===category)&&
    (!term||[d.title,d.description,d.category,d.body].some(v=>v.toLocaleLowerCase().includes(term))));
}
function sourceLink(href,doc,source,knownPaths){
  if(typeof href!=='string'||!href||href.startsWith('//'))return null;
  try{
    const resolved=new URL(href,doc.source);
    if(resolved.protocol!=='https:'||resolved.username||resolved.password)return null;
    const prefix='/BestNathan/nession/blob/'+source.sha+'/';
    if(resolved.hostname==='github.com'&&resolved.pathname.startsWith(prefix)){
      const path=decodeURIComponent(resolved.pathname.slice(prefix.length));
      if(knownPaths.has(path)&&!resolved.hash)return {href:documentsHref(path),external:false};
      return {href:resolved.href,external:true};
    }
    // Public HTTPS references may be opened externally, but never interpreted.
    return {href:resolved.href,external:true};
  }catch{return null;}
}
function inline(text,parent,doc,source,knownPaths){
  const re=/(\[([^\]]{1,240})\]\(([^)\s]{1,800})\)|\*\*([^*\n]{1,300})\*\*|\x60([^\x60\n]{1,300})\x60)/g;
  let pos=0,m;
  while((m=re.exec(text))!==null){
    if(m.index>pos)parent.append(document.createTextNode(text.slice(pos,m.index)));
    if(m[2]!==undefined){
      const destination=sourceLink(m[3],doc,source,knownPaths);
      if(destination)parent.append(link(m[2],destination.href,'',destination.external));
      else parent.append(document.createTextNode(m[2]));
    }else if(m[4]!==undefined)parent.append(el('strong','',m[4]));
    else parent.append(el('code','',m[5]));
    pos=re.lastIndex;
  }
  if(pos<text.length)parent.append(document.createTextNode(text.slice(pos)));
}
function markdown(body,parent,doc,source,paths){
  const lines=body.split(/\r?\n/);
  let paragraph=[],list=null,listType=null,code=null,table=null;
  const flush=()=>{
    if(paragraph.length){
      const p=el('p');inline(paragraph.join(' '),p,doc,source,paths);
      parent.append(p);paragraph=[];
    }
    list=null;listType=null;table=null;
  };
  for(let i=0;i<lines.length;i++){
    const lineText=lines[i];
    if(code){
      if(/^\s*\x60{3,}\s*$/.test(lineText)){
        add(parent,add(el('pre'),el('code','',code.join('\n'))));code=null;
      }else code.push(lineText);
      continue;
    }
    if(/^\s*\x60{3,}[\w-]*\s*$/.test(lineText)){flush();code=[];continue;}
    if(/^\s*---+\s*$/.test(lineText)){flush();parent.append(el('hr'));continue;}
    const heading=/^(#{1,5})\s+(.+)$/.exec(lineText);
    if(heading){
      flush();
      const h=el('h'+Math.min(heading[1].length+1,6));
      inline(heading[2],h,doc,source,paths);parent.append(h);continue;
    }
    if(lineText.includes('|')&&i+1<lines.length&&
       /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])){
      flush();
      table=el('table');const head=el('thead'),tr=el('tr');
      for(const cell of lineText.replace(/^\s*\||\|\s*$/g,'').split('|')){
        const th=el('th');inline(cell.trim(),th,doc,source,paths);tr.append(th);
      }
      head.append(tr);table.append(head,el('tbody'));parent.append(table);i++;continue;
    }
    if(table&&lineText.includes('|')&&lineText.trim()){
      const tr=el('tr');
      for(const cell of lineText.replace(/^\s*\||\|\s*$/g,'').split('|')){
        const td=el('td');inline(cell.trim(),td,doc,source,paths);tr.append(td);
      }
      table.lastChild.append(tr);continue;
    }
    const li=/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/.exec(lineText);
    if(li){
      if(paragraph.length)flush();
      const kind=li[2]?'ol':'ul';
      if(!list||listType!==kind){list=el(kind);listType=kind;parent.append(list);}
      const item=el('li');inline(li[3],item,doc,source,paths);list.append(item);continue;
    }
    const quote=/^>\s?(.*)$/.exec(lineText);
    if(quote){flush();const block=el('blockquote');inline(quote[1],block,doc,source,paths);parent.append(block);continue;}
    if(!lineText.trim()){flush();continue;}
    if(list||table)flush();
    paragraph.push(lineText.trim());
  }
  if(code)add(parent,add(el('pre'),el('code','',code.join('\n'))));
  flush();
}
function reader(doc,data,paths){
  const article=el('article','documents-reader knowledge-reader');
  const back=link('← All documents','#/documents','documents-back');
  add(article,back,el('div','eyebrow',doc.category+' / TECHNICAL REFERENCE'),
    el('h2','',doc.title),el('p','knowledge-description',doc.description));
  const meta=el('div','documents-meta mono');
  add(meta,el('span','',doc.path),el('span','',data.source.sha.slice(0,12)));
  article.append(meta);
  const message=el('div','documents-note',
    'Source-backed design reference. Canonical code, tests and Gates determine implemented behavior.');
  const prose=el('div','knowledge-prose documents-prose');
  markdown(doc.body,prose,doc,data.source,paths);
  add(article,message,prose,
    link('View pinned GitHub source ↗',doc.source,'documents-source',true));
  return article;
}
export function renderDocuments(root,data,hash){
  add(root,el('div','eyebrow documents-kicker','NESSION / OPEN ENGINEERING / DOCUMENTS'),
    el('h1','documents-heading','Technical documents'),
    el('p','documents-lede',
      'The current architecture, interfaces and protocols behind Nession. Read from a pinned public source revision.'));
  if(!validDocumentsSnapshot(data)||data.status!=='available'){
    add(root,add(el('div','panel documents-unavailable'),
      el('h3','','Documents unavailable'),
      el('p','','The versioned source could not be loaded or verified; this does not mean there are no technical documents.'),
      link('Browse canonical architecture on GitHub ↗',REPO+'/tree/main/docs/architecture','documents-source',true)));
    return;
  }
  const route=documentsRoute(hash)||{doc:null,invalid:false};
  const selected=data.documents.find(d=>d.path===route.doc)||data.documents[0];
  const exact=!!route.doc&&data.documents.some(d=>d.path===route.doc);
  const paths=new Set(data.documents.map(d=>d.path));
  const snapshot=el('div','documents-snapshot mono');
  add(snapshot,el('span','','SOURCE / MAIN'),el('strong','',data.source.sha.slice(0,12)),
    el('span','',data.documents.length+' curated references'),
    link('GitHub ↗',REPO+'/tree/'+data.source.sha+'/docs/architecture','',true));
  root.append(snapshot);
  const layout=el('div','documents-layout'+(exact?' reading':''));
  const side=el('aside','documents-side');
  const listing=el('section','documents-listbox');
  const search=el('input','documents-search');search.type='search';
  search.placeholder='Search references';search.value=state.query;
  search.setAttribute('aria-label','Search technical documents');
  const categories=['All',...new Set(data.documents.map(d=>d.category))];
  const filters=el('div','documents-filters');
  const results=el('div','documents-results');
  const count=el('p','documents-count mono');
  listing.append(search,count,results);
  function rebuild(){
    filters.replaceChildren();
    for(const category of categories){
      const button=el('button','documents-filter'+(state.category===category?' active':''),category);
      button.type='button';button.setAttribute('aria-pressed',String(state.category===category));
      button.addEventListener('click',()=>{state.category=category;rebuild();});
      filters.append(button);
    }
    results.replaceChildren();
    const found=filterDocuments(data.documents,state);
    count.textContent=found.length+' / '+data.documents.length+' DOCUMENTS';
    for(const d of found){
      const a=link('',documentsHref(d.path),'documents-entry'+(d.path===selected.path?' selected':''));
      add(a,el('div','eyebrow',d.category),el('strong','',d.title),el('p','',d.description));
      if(d.path===selected.path)a.setAttribute('aria-current','page');
      results.append(a);
    }
    if(!found.length)results.append(el('p','documents-empty','No matching technical documents.'));
  }
  search.addEventListener('input',()=>{state.query=search.value;rebuild();});
  add(side,el('div','eyebrow','REFERENCE LIBRARY'),filters);
  rebuild();
  const detail=el('div','documents-reader-slot');
  if(route.invalid||route.doc&&!exact){
    add(detail,add(el('article','panel'),el('h3','','Unknown document'),
      el('p','','This reference is not in the published technical document catalog.')));
  }else detail.append(reader(selected,data,paths));
  layout.append(side,listing,detail);
  root.append(layout);
}
