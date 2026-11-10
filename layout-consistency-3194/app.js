(() => {
  'use strict';
  const page = document.querySelector('[data-np-root]');
  const device = page.querySelector('[data-np-device]');
  const product = document.getElementById('nession-product');
  const state = {experience:'web',mode:'contract',surface:'detail',content:'normal',session:'edge-prod',appLayer:'workspace',selectedFile:'README.md',notice:''};
  const path = '/srv/projects/edge-platform/services/infra/region-ap-southeast-1/production/environments/session-configurations/agent-manifest.yaml';
  function action(name,label,cls=''){return '<button type="button" class="'+cls+'" data-action="'+name+'">'+label+'</button>';}
  function rows(){return state.content==='long'?Array.from({length:12},(_,i)=>'<div>Revision '+String(i+1).padStart(2,'0')+' · Infrastructure configuration checked against workspace locations</div>').join(''):'';}
  function head(title,category,button){
    return '<div class="page-head"><div><small>'+category+'</small><h2>'+title+'</h2></div>'+(button||'')+'</div>';
  }
  function detail(){
    return head('edge-platform','PROJECT / WORKSPACE',action('open-form','New Session'))+
    '<div class="details-grid"><section class="detail-card"><header>Project overview <span class="pill">Active</span></header>'+
    '<dl class="definition-row"><dt>Default Agent</dt><dd>edge-node-01</dd></dl>'+
    '<dl class="definition-row"><dt>Working directory</dt><dd>/workspaces/edge-platform</dd></dl>'+
    '<dl class="definition-row"><dt>Source</dt><dd>'+ (state.content==='long'?path:'github.com/example/edge-platform')+'</dd></dl>'+
    '<dl class="definition-row"><dt>Session template</dt><dd>Default Shell / Existing Location</dd></dl>'+
    '</section><section class="detail-card"><header>Recent work</header><div class="ghost-list">'+
    '<div class="ghost-item"><b>edge-prod</b><small>Attached · shell</small></div>'+
    '<div class="ghost-item"><b>deploy-review</b><small>Inactive · shell</small></div>'+
    '<div class="ghost-item"><b>infra-audit</b><small>Last opened earlier</small></div></div></section></div>'+
    '<div class="long-list">'+rows()+'</div>';
  }
  function field(label,value,type='input',wide=false){
    const control=type==='select'?
      '<select aria-label="'+label+'"><option>'+value+'</option><option>edge-node-02</option></select>':
      '<input aria-label="'+label+'" value="'+value.replace(/"/g,'&quot;')+'" />';
    return '<div class="form-field'+(wide?' wide':'')+'"><label>'+label+'</label>'+control+'</div>';
  }
  function form(){
    return head('New Session','PROJECT / OPERATION',action('cancel','Back to project'))+
    '<div class="form-wrap"><div class="form-main"><h3 class="subheading">Create a Session</h3>'+
    '<div class="form-grid">'+
    field('Name','review-shell')+field('Agent','edge-node-01')+
    field('Location','Existing Location','select')+
    field('Start command','/bin/bash')+
    field('Working directory',state.content==='long'?path:'/workspaces/edge-platform','input',true)+
    '<div class="form-field wide"><label>Environment</label><div class="form-help">Project default · env.production · read-only until creation</div></div>'+
    '</div></div><div class="action-row">'+action('cancel','Cancel')+action('submit','Create Session','primary')+'</div></div>'+
    '<div class="long-list">'+rows()+'</div>';
  }
  function files(){
    if(state.experience==='app'&&state.mode==='contract'&&state.selectedFile!=='list'){
      return head(state.selectedFile,'FILES / PREVIEW',action('file-list','Files'))+
      '<div class="split"><section class="file-preview"><h3>'+state.selectedFile+'</h3><pre>'+code()+'</pre></section></div>';
    }
    return head('Files','WORKSPACE / FILES','')+'<div class="split"><section class="file-tree"><strong>/edge-platform</strong>'+
      ['README.md','nession.toml','deploy.yaml','src/main.rs'].map(n=>'<button type="button" class="file-row'+(state.selectedFile===n?' selected':'')+'" data-file="'+n+'">▤　'+n+'</button>').join('')+
      '</section><section class="file-preview"><h3>'+state.selectedFile+'</h3><pre>'+code()+'</pre></section></div>'+
      '<div class="long-list">'+rows()+'</div>';
  }
  function code(){return '# edge-platform\n\n[workspace]\nname = "edge-platform"\nlocation = "/workspaces/edge-platform"\n\n[session]\nagent = "edge-node-01"\n'+(state.content==='long'?Array.from({length:10},(_,i)=>'source_'+i+' = "'+path+'"').join('\n'):'');}
  function dock(){
    return '<nav class="dock" aria-label="Workspace capabilities">'+
      ['detail','form','files'].map((s,i)=>action('go-'+s,['Project','Session','Files'][i],state.surface===s?'active':'')).join('')+
      action('terminal','Terminal')+'</nav>';
  }
  function mainContent(){
    return '<div class="work-region"><div class="view-scroll" id="owned-scroll"><div class="view-inner">'+
    (state.surface==='detail'?detail():state.surface==='form'?form():files())+
    '</div></div>'+dock()+'</div>';
  }
  function sidebar(){
    return '<aside class="sidebar"><div class="side-heading">NESSION</div>'+
      '<div class="side-label">Sessions</div>'+
      action('session-edge','●　edge-prod','side-item '+(state.session==='edge-prod'?'active':''))+
      action('session-review','◌　deploy-review','side-item '+(state.session==='deploy-review'?'active':''))+
      '<div class="side-label">Workspace</div>'+
      action('go-detail','◇　Project · edge-platform','side-item')+
      action('go-files','▤　Files','side-item')+
      '<div class="side-foot"><span class="dot"></span>Server connected<br>Agent edge-node-01</div></aside>';
  }
  function render(){
    product.dataset.experience=state.experience;
    product.className='nession-product '+state.mode;
    if(state.experience==='web'){
      product.innerHTML='<div class="shell">'+sidebar()+'<main class="work-surface">'+mainContent()+'</main></div>';
    } else if(state.appLayer==='sessions'){
      product.innerHTML='<div class="work-surface"><header class="app-header"><strong>Sessions</strong><span class="trail">edge-node-01</span></header>'+
        '<div class="view-scroll"><div class="session-list"><h3>Recent Sessions</h3>'+
        action('open-workspace','edge-prod　·　Open Workspace','side-item')+'</div></div></div>';
    } else {
      const title=state.surface==='files'&&state.selectedFile!=='list'&&state.mode==='contract'?'Files / '+state.selectedFile:'Workspace';
      product.innerHTML='<div class="work-surface"><header class="app-header">'+action('back','‹')+
        '<strong>'+title+'</strong><span class="trail">edge-prod</span></header>'+mainContent()+'</div>';
    }
    if(state.notice){product.insertAdjacentHTML('beforeend','<div class="notice" role="status">'+state.notice+'</div>');}
    page.querySelectorAll('[data-mode],[data-surface],[data-content]').forEach(b=>{
      const key=b.hasAttribute('data-mode')?'mode':b.hasAttribute('data-surface')?'surface':'content';
      b.setAttribute('aria-pressed',String(state[key]===b.dataset[key]));
    });
    refreshMetrics();
  }
  function refreshMetrics(){
    const scroll=product.querySelector('.view-scroll');
    const inner=product.querySelector('.view-inner');
    const extra=scroll?Math.max(0,Math.round(scroll.scrollWidth-scroll.clientWidth)):0;
    const height=scroll?Math.round(scroll.scrollHeight):0;
    const owner=scroll?getComputedStyle(scroll).overflowY:'none';
    document.getElementById('read-width').textContent=inner?Math.round(inner.getBoundingClientRect().width)+'px':'—';
    document.getElementById('read-overflow').textContent=extra?extra+'px':'0px';
    document.getElementById('read-scroll').textContent=owner==='auto'?'Workspace scroll ('+height+'px content)':owner==='hidden'?'Clipped at workspace':'No scroll owner';
    document.getElementById('read-owner').textContent=state.mode==='contract'?'Experience + Layout pattern':'Local utility classes';
  }
  page.addEventListener('np:resize',e=>{
    if(e.target!==device)return;
    const active=page.querySelector('[data-np-size][aria-pressed=true]');
    state.experience=active?.dataset.npExperience==='app'?'app':'web';
    if(state.experience==='web'){state.appLayer='workspace';state.selectedFile=state.surface==='files'?'README.md':state.selectedFile;}
    if(state.experience==='app'&&state.surface==='files'&&state.mode==='contract')state.selectedFile='list';
    device.style.setProperty('--np-device-height',state.experience==='web'?'760px':'844px');
    state.notice='';render();
  });
  page.addEventListener('click',e=>{
    const review=e.target.closest('[data-mode],[data-surface],[data-content]');
    if(review){const key=review.hasAttribute('data-mode')?'mode':review.hasAttribute('data-surface')?'surface':'content';
      state[key]=review.dataset[key];state.appLayer='workspace';state.notice='';
      if(key==='surface'&&state.surface==='files')state.selectedFile=state.experience==='app'&&state.mode==='contract'?'list':'README.md';
      if(key==='mode'&&state.surface==='files')state.selectedFile=state.experience==='app'&&state.mode==='contract'?'list':'README.md';
      render();return;
    }
    const file=e.target.closest('[data-file]');
    if(file){state.selectedFile=file.dataset.file;render();return;}
    const btn=e.target.closest('[data-action]');
    if(!btn)return;
    const a=btn.dataset.action;
    if(a.startsWith('go-')){state.surface=a.slice(3);state.appLayer='workspace';state.notice='';
      state.selectedFile=state.surface==='files'&&state.experience==='app'&&state.mode==='contract'?'list':'README.md';
    }else if(a==='open-form'){state.surface='form';}
    else if(a==='file-list'){state.selectedFile='list';}
    else if(a==='submit'){state.notice='Session draft created in this preview';}
    else if(a==='cancel'){state.surface='detail';state.notice='';}
    else if(a==='back'){if(state.surface==='files'&&state.selectedFile!=='list'&&state.mode==='contract'){state.selectedFile='list';}
      else{state.appLayer='sessions';}}
    else if(a==='open-workspace'){state.appLayer='workspace';state.surface='detail';}
    else if(a==='session-edge'||a==='session-review'){state.session=a==='session-edge'?'edge-prod':'deploy-review';state.notice='Session selected';}
    else if(a==='terminal'){state.notice='Terminal remains the current Session work surface';}
    render();
  });
  document.addEventListener('DOMContentLoaded',()=>{render();});
})();