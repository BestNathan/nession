// Shared Pages navigation; index.html and workflows.html use this single source.
export const NAV_ITEMS = Object.freeze([
  {route:'/',label:'Overview'},
  {route:'/agents',label:'AI Agents'},
  {route:'/work',label:'Collaboration'},
  {route:'/workflows',label:'Workflows',file:'workflows.html'},
  {route:'/knowledge',label:'Knowledge'},
  {route:'/prototypes',label:'Prototypes',ariaLabel:'Explore interactive product prototypes'},
  {route:'/repository',label:'Repository'},
  {route:'/evidence',label:'Evidence'},
]);

const isStandalone=pathname=>pathname.endsWith('/workflows.html');

export function currentNavRoute(pathname,hash){
  if(isStandalone(pathname))return '/workflows';
  const raw=hash.replace(/^#/,'')||'/';
  if(raw.startsWith('/agents/')||raw.startsWith('/agents?'))return '/agents';
  if(raw.startsWith('/work/'))return '/work';
  if(raw==='/knowledge'||raw.startsWith('/knowledge?'))return '/knowledge';
  return raw;
}

export function mountNavigation(doc,win){
  const nav=doc.querySelector('nav.navigation');
  if(!nav)return;
  const standalone=isStandalone(win.location.pathname);
  const links=NAV_ITEMS.map(item=>{
    const link=doc.createElement('a');
    link.textContent=item.label;
    link.href=item.file||((standalone?'index.html#':'#')+item.route);
    link.dataset.route=item.route;
    if(item.ariaLabel)link.setAttribute('aria-label',item.ariaLabel);
    return link;
  });
  nav.replaceChildren(...links);
  const syncCurrent=()=>{
    const active=currentNavRoute(win.location.pathname,win.location.hash);
    for(const link of links){
      if(link.dataset.route===active)link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    }
  };
  syncCurrent();
  win.addEventListener('hashchange',syncCurrent);
}

if(typeof document!=='undefined'&&typeof window!=='undefined'){
  mountNavigation(document,window);
}
