// Nession AI Workspace · read-only playback of archived TypeSafe/Jev Task observations.
// This renderer performs NO inference, has NO access to credentials, and never mutates Workspace.
(() => {
  'use strict';
  const archive = window.NESSION_JEV_REPLAY;
  const app = document.getElementById('app');
  const topbar = document.querySelector('.top-actions');
  if (!archive || !app || !topbar) return;
  const suites = archive.suites;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
  const total = suites.reduce((n,s) => n + s.cases.length, 0);
  let suiteId = 'initial', variant = 'all', selectedId = suites[0].cases[0].id, stage = 0, visible = false;
  let returnFocus = null;
  const stageNames = ['用户目标','View State','Action Space','Jev Choice','结果验证'];
  const suiteById = id => suites.find(x => x.id === id) || suites[0];
  const suite = () => suiteById(suiteId);
  const filtered = () => suite().cases.filter(x => variant === 'all' || x.variant === variant);
  const current = () => filtered().find(x => (x.variant ? x.variant + ':' : '') + x.id === selectedId) || filtered()[0];
  const caseKey = x => (x.variant ? x.variant + ':' : '') + x.id;
  const runUrl = s => 'https://github.com/BestNathan/nession/actions/runs/' + s.run;
  const sourceUrl = s => 'https://github.com/BestNathan/nession/blob/task-results/sources/' +
    s.sourceSha + '/' + s.taskId + '.json';
  const recordUrl = s => 'https://github.com/BestNathan/nession/blob/task-results/runs/' +
    s.taskId + '/' + s.run + '-1/record.json';
  const pct = (n,d) => d ? Math.round(n/d*100) + '%' : '—';
  const summary = s => ({count:s.cases.length,hits:s.cases.filter(x => x.result.hit).length});

  const trigger = document.createElement('button');
  trigger.id = 'jevReplayButton';
  trigger.type = 'button';
  trigger.className = 'jr-launch';
  trigger.setAttribute('aria-haspopup','dialog');
  trigger.setAttribute('aria-label','查看真实 Jev 测试回放');
  trigger.setAttribute('title','查看 2026-10-23 的真实 Jev 决策过程');
  trigger.setAttribute('aria-expanded','false');
  trigger.innerHTML = '<span class="jr-dot" aria-hidden="true"></span><span class="jr-long">真实测试回放</span><span class="jr-short">回放</span>';
  const inspect = document.getElementById('inspectButton');
  if (inspect) topbar.insertBefore(trigger, inspect);
  else topbar.appendChild(trigger);

  const overlay = document.createElement('div');
  overlay.id = 'jevReplayOverlay';
  overlay.className = 'jr-overlay';
  overlay.setAttribute('aria-hidden','true');
  overlay.innerHTML = '<div class="jr-dialog" role="dialog" aria-modal="true" aria-labelledby="jrTitle">' +
    '<div class="jr-header"><div><div class="jr-overline">Nession / System One / archived observations</div>' +
    '<h2 id="jrTitle" class="jr-title">真实 Jev 决策 · 测试回放</h2>' +
    '<div class="jr-subtitle">2026-10-23 · jev-1.13.0 · ' + total +
    ' 次独立真实请求 · 只读快照，不会重新调用 API</div></div>' +
    '<button id="jrClose" class="jr-close" type="button" aria-label="关闭测试回放">×</button></div>' +
    '<div id="jrMetrics" class="jr-metrics"></div>' +
    '<div id="jrTabs" class="jr-tabs" role="tablist" aria-label="真实模型测试批次"></div>' +
    '<div class="jr-main"><aside class="jr-left"><div id="jrLeftHead" class="jr-left-head"></div>' +
    '<div id="jrList" class="jr-list" aria-label="测试用例列表"></div></aside>' +
    '<div class="jr-right"><div id="jrRightHeader" class="jr-right-header"></div>' +
    '<div id="jrExtra"></div><div id="jrSteps" class="jr-steps" role="group" aria-label="决策步骤"></div>' +
    '<div id="jrDetail" class="jr-detail"></div>' +
    '<div id="jrFooter" class="jr-footer"></div></div></div></div>';
  app.appendChild(overlay);
  const el = id => document.getElementById(id);

  function renderMetrics() {
    el('jrMetrics').innerHTML = suites.map((s,i)=>{
      const list = s.id === 'comparison' ? s.cases.filter(x=>x.variant==='progressive') : s.cases;
      const hits = list.filter(x=>x.result.hit).length;
      const metric = i === 0 ? '首次真实测试' : i === 1 ? '渐进式提示词' : '相关性约束提示词';
      return '<div class="jr-metric"><span>' + metric + '</span><strong>' +
        hits + ' / ' + list.length + ' <small style="font-size:10px;font-weight:500;color:#8b97a3">' +
        pct(hits,list.length) + '</small></strong></div>';
    }).join('');
  }
  function renderTabs() {
    el('jrTabs').innerHTML = suites.map(s => {
      const n=summary(s);
      return '<button type="button" class="jr-tab" role="tab" aria-selected="' + (suiteId===s.id) +
        '" data-jr-suite="' + escape(s.id) + '">' + escape(s.label) +
        ' · ' + n.hits + '/' + n.count + '</button>';
    }).join('') +
    '<span style="font-size:10px;color:#929aa6;margin-left:auto">实测数据 ≠ 生产验收</span>';
  }
  function renderList() {
    const s=suite(),cases=filtered();
    const filters = s.variants.length > 1 ?
      '<span style="display:flex;gap:5px"><button type="button" class="jr-filter" data-jr-filter="all" aria-pressed="' +
      (variant==='all') + '">全部</button>' + s.variants.map(v =>
      '<button type="button" class="jr-filter" data-jr-filter="' + escape(v.id) + '" aria-pressed="' +
      (variant===v.id) + '">' + escape(v.label) + '</button>').join('') + '</span>' : '';
    el('jrLeftHead').innerHTML = '<span class="jr-left-title">用例 ' + cases.length + ' 条</span>' + filters;
    el('jrList').innerHTML = cases.map((c,i) =>
      '<button type="button" class="jr-case" data-jr-case="' + escape(caseKey(c)) +
      '" aria-current="' + (caseKey(current())===caseKey(c)) + '">' +
      '<span class="jr-case-heading"><span>' + escape(c.variant ? c.variant + ' · ' + c.id : c.id) +
      '</span><span class="' + (c.result.hit?'jr-pass':'jr-fail') + '">' +
      (c.result.hit?'✓ 命中':'× 偏差') + '</span></span>' +
      '<span class="jr-case-question">' + escape(c.utterance) +
      '</span><span class="jr-meta">' + escape(c.view) + ' · ' +
      escape(c.result.elapsedMs) + ' ms</span></button>').join('');
  }
  function compareTable() {
    const s=suite();
    if(s.id!=='comparison')return '';
    const cases=s.cases.filter(x=>x.variant==='baseline');
    const other=s.cases.filter(x=>x.variant==='progressive');
    return '<div class="jr-compare"><div class="jr-compare-top">相同用例 · 严格匹配 vs 渐进推进（点击具体结果查看完整过程）</div>' +
    cases.map(c => {
      const b=other.find(x=>x.id===c.id);
      const choice=(entry,label) =>
        '<button type="button" class="jr-compare-choice ' + (entry.result.hit?'jr-pass':'jr-fail') +
        '" data-jr-compare="' + escape(c.id) + '" data-jr-variant="' + escape(entry.variant) + '">' +
        escape(label) + ' ' + (entry.result.hit?'✓':'×') + '<small>' +
        escape(entry.result.selected) + '</small></button>';
      return '<div class="jr-compare-row"><span>' + escape(c.utterance) + '</span>' +
        choice(c,'严格') + choice(b,'渐进') + '</div>';
    }).join('') + '</div>';
  }
  function firstRunPath() {
    if(suiteId!=='initial')return '';
    const sequence=[
      ['root-goal','根层入口'],
      ['agent-target-Beijing','发现 Agent'],
      ['agent-selected-create','打开表单'],
      ['form-name-no-submit','填写字段'],
      ['explicit-submit','提交选择'],
      ['confirmed-open','结果打开']
    ];
    return '<div class="jr-caveat">下列是<strong>独立测试场景</strong>按设计状态路径排列，不是一次连续的真实 Nession 端到端运行；模拟模型选择 ≠ 后端执行。</div>' +
      '<div class="jr-timeline">' + sequence.map(([id,label])=>{
        const row=suite().cases.find(x=>x.id===id);
        return '<button type="button" class="jr-flow-node ' +
          (current().id===id?'is-active':'') + '" data-jr-case="' + escape(id) + '">' +
          escape(label) + ' <span class="' +(row.result.hit?'jr-pass':'jr-fail') +
          '">' + (row.result.hit?'✓':'×') + '</span></button>';
      }).join('')+'</div>';
  }
  function renderRightHeader() {
    const s=suite(),c=current();
    el('jrRightHeader').innerHTML =
      '<div class="jr-overline">TEST CASE / ' + escape(c.id) + '</div>' +
      '<div class="jr-case-title">' + escape(c.utterance) + '</div>' +
      '<div class="jr-meta">' + escape(s.detail) + (c.variant ? ' · ' + escape(c.variant) : '') + '</div>' +
      '<div class="jr-status-bar"><span class="jr-pill ' + (c.result.hit?'good':'bad') + '">' +
      (c.result.hit?'✓ 模型选择命中':'× 与期望不一致') + '</span>' +
      '<span class="jr-pill">' + escape(c.result.elapsedMs) + ' ms</span>' +
      '<span class="jr-pill">confidence ' + (c.result.confidence==null?'未记录':(c.result.confidence*100).toFixed(0)+'%') +
      '</span></div>';
    el('jrExtra').innerHTML = compareTable() + firstRunPath();
  }
  function renderSteps(){
    el('jrSteps').innerHTML = stageNames.map((name,i)=>
      '<button class="jr-step" type="button" data-jr-stage="' + i +
      '" aria-current="' + (i===stage?'step':'false') + '">' +
      String(i+1).padStart(2,'0') + ' · ' + escape(name) + '</button>').join('');
  }
  function actionCard(a,i,c,highlight){
    const active=c.result.selected===a.id;
    const expected=c.result.expected===a.id;
    return '<div class="jr-action ' + (highlight&&active?(c.result.hit?'actual':'wrong'):'') + '">' +
      '<span class="jr-action-marker">' + escape('c'+i) + '</span>' +
      '<div style="flex:1;min-width:0"><div class="jr-action-description">' + escape(a.label) + '</div>' +
      '<div class="jr-action-id">' + escape(a.id) + ' · ' + escape(a.actionId) + '</div></div>' +
      (highlight&&(active||expected)?'<span class="jr-action-note ' +
      (active?(c.result.hit?'jr-pass':'jr-fail'):'') + '">' +
      (active?'Jev 选择':'预期动作') + '</span>':'') + '</div>';
  }
  function renderDetail(){
    const c=current(),s=suite(),v=s.variants.find(x=>x.id===(c.variant||s.variants[0].id)) || s.variants[0];
    const state={utterance:c.utterance,currentView:c.view,...c.context};
    const candidateIds=c.actions.map(a=>a.id);
    const selected=c.result.selected,expected=c.result.expected;
    let html='';
    if(stage===0){
      html='<div class="jr-section"><div class="jr-section-title">01 / ORIGINAL USER QUESTION</div><div class="jr-utterance">' +
        escape(c.utterance) + '</div><p class="jr-step-label">这是归档 Task 中真实请求使用的用户问题。当前回放不会请求 Jev，也不会更新右侧真实 AI Workspace。</p>' +
        '<div class="jr-prompt"><strong>本次提示词策略：</strong><div style="margin-top:5px">' +
        escape(v.instruction) + '</div></div></div>';
    } else if(stage===1){
      html='<div class="jr-section"><div class="jr-section-title">02 / VIEW STATE · 归档输入 Fixture</div>' +
        '<pre class="jr-code">' + escape(JSON.stringify(state,null,2)) + '</pre>' +
        '<p class="jr-step-label">视图和目标上下文来自该次 Task 的固定输入样例，不是原型当前正在运行的 Scene。</p></div>';
    } else if(stage===2){
      html='<div class="jr-section"><div class="jr-section-title">03 / CURRENTLY EXPOSED ACTIONS</div>' +
        c.actions.map((a,i)=>actionCard(a,i,c,false)).join('') +
        '<div class="jr-action"><span class="jr-action-marker">—</span><div class="jr-action-description">' +
        'none · 当前无合适动作 / 必须澄清或等待</div></div>' +
        '<p class="jr-step-label">只有这些候选进入本次 Choice。未渲染的 SessionCreate 叶子动作不会偷偷加入根层候选集。</p></div>';
    } else if(stage===3){
      html='<div class="jr-section"><div class="jr-section-title">04 / ARCHIVED REAL JEV CHOICE</div>' +
        '<div class="jr-utterance" style="font-size:17px">' + escape(selected==='none'?'none · 无匹配动作':selected) + '</div>' +
        '<div class="jr-status-bar"><span class="jr-pill">confidence ' +
        (c.result.confidence==null?'未记录':(c.result.confidence*100).toFixed(0)+'%') +
        '</span><span class="jr-pill">' + escape(c.result.elapsedMs) + ' ms · 请求往返耗时</span>' +
        (c.result.choice?'<span class="jr-pill">原始 choice = '+escape(c.result.choice)+'</span>':'') +
        (c.result.expectedProbability!=null?'<span class="jr-pill">期望候选概率 '+(c.result.expectedProbability*100).toFixed(0)+'%</span>':'') +
        '</div><p class="jr-step-label">选择与 confidence、耗时来自真实 Jev Task 归档。' +
        (c.result.choice?'choice 字段为真实返回值。':'该 Task 仅归档了映射后的候选 ID，未保留原始 choice 键。') +
        '</p></div>';
    } else {
      html='<div class="jr-section"><div class="jr-section-title">05 / ACCEPTANCE EXPECTATION VS REAL MODEL</div>' +
      '<div class="jr-action"><span class="jr-action-marker">✓</span><div style="flex:1"><div class="jr-meta">EXPECTED</div>' +
        '<div class="jr-action-id" style="font-size:12px;color:#344253">'+ escape(expected)+'</div></div></div>' +
      '<div class="jr-action '+(c.result.hit?'actual':'wrong')+'"><span class="jr-action-marker">' +
        (c.result.hit?'✓':'×') + '</span><div style="flex:1"><div class="jr-meta">ACTUAL JEV SELECTION</div>' +
        '<div class="jr-action-id" style="font-size:12px;color:#344253">'+ escape(selected)+'</div></div></div>' +
      '<p class="jr-step-label">'+(c.result.hit?'模型选择与预期一致。':'该选择与预期不一致；这正是下一版提示词/相关性边界要修复的问题。') +
      ' 此处仅评估候选选择，不验证真实 API 业务操作。</p></div>';
    }
    const goalOpts=c.actions.map(a=>({candidateId:a.id,actionId:a.actionId,label:a.label}));
    html += '<div class="jr-section"><div class="jr-section-title">SOURCE & REQUEST DETAILS</div>' +
      '<div class="jr-meta">候选数量 '+c.actions.length+' · '+
      (c.result.tokens==null?
        (c.result.inputTokens==null?'本次未归档 Token 数':'输入 '+c.result.inputTokens+' / 输出 '+c.result.outputTokens+' tokens'):
        ('请求 Token 合计 '+c.result.tokens)) +
      (c.result.requestHash?' · SHA256 摘要 '+escape(c.result.requestHash):'') +
      '</div><details style="margin-top:11px"><summary style="font-size:11px;cursor:pointer;color:#58708b">查看当前样例 Action Space / 候选映射</summary>' +
      '<pre class="jr-code" style="margin-top:8px">'+escape(JSON.stringify({model:archive.model,source:'archived task fixture',state,actions:goalOpts,choiceOptions:[...candidateIds,'none']},null,2))+'</pre></details>' +
      '<details style="margin-top:9px"><summary style="font-size:11px;cursor:pointer;color:#58708b">查看本次模型判断提示词</summary>' +
      '<div class="jr-prompt">' + escape(v.instruction) + '</div></details></div>';
    el('jrDetail').innerHTML=html;
  }
  function renderFooter() {
    const s=suite(),cases=filtered(),index=cases.findIndex(x=>caseKey(x)===caseKey(current()));
    el('jrFooter').innerHTML =
      '<div class="jr-buttons"><button class="jr-btn" data-jr-prev type="button" '+(stage===0?'disabled':'')+'>'+
      '← 上一阶段</button><button class="jr-btn jr-btn-primary" data-jr-next type="button">'+
      (stage===stageNames.length-1?'下一用例 →':'下一阶段 →')+'</button>' +
      '<button class="jr-btn" data-jr-nextcase type="button" '+(index===cases.length-1?'disabled':'')+
      '>跳到下一例</button></div><div class="jr-links">' +
      '<a href="' + runUrl(s) + '" target="_blank" rel="noopener noreferrer">GitHub Run ↗</a>' +
      '<a href="' + recordUrl(s) + '" target="_blank" rel="noopener noreferrer">原始归档 ↗</a>' +
      '<a href="' + sourceUrl(s) + '" target="_blank" rel="noopener noreferrer">固定输入源码 ↗</a></div>';
  }
  function render(){
    if(!filtered().length)variant='all';
    if(!filtered().find(x=>caseKey(x)===selectedId))selectedId=caseKey(filtered()[0]);
    renderMetrics();renderTabs();renderList();renderRightHeader();renderSteps();renderDetail();renderFooter();
  }
  function openReplay(){
    if(visible)return;
    returnFocus = document.activeElement;
    visible = true;
    overlay.classList.add('jr-open');
    overlay.setAttribute('aria-hidden','false');
    trigger.setAttribute('aria-expanded','true');
    render();
    el('jrClose').focus();
  }
  function closeReplay(){
    if(!visible)return;
    visible=false;
    overlay.classList.remove('jr-open');
    overlay.setAttribute('aria-hidden','true');
    trigger.setAttribute('aria-expanded','false');
    if(location.hash.startsWith('#jev-replay')){
      history.replaceState(null,'',location.pathname + location.search);
    }
    (returnFocus && typeof returnFocus.focus==='function' ? returnFocus : trigger).focus();
  }
  function pickSuite(id){
    suiteId=id;variant='all';selectedId=caseKey(suite().cases[0]);stage=0;render();
  }
  function advanceStage(){
    if(stage < stageNames.length-1){stage++;render();return;}
    const c=filtered(),index=c.findIndex(x=>caseKey(x)===caseKey(current()));
    if(index<c.length-1){selectedId=caseKey(c[index+1]);stage=0;render();}
  }
  trigger.addEventListener('click',()=>{
    if(location.hash!=='#jev-replay')location.hash='jev-replay';
    openReplay();
  });
  overlay.addEventListener('click',event=>{
    if(event.target===overlay){closeReplay();return;}
    const btn=event.target.closest('button');
    if(!btn)return;
    const d=btn.dataset;
    if(btn.id==='jrClose')return closeReplay();
    if(d.jrSuite)return pickSuite(d.jrSuite);
    if(d.jrFilter){variant=d.jrFilter;stage=0;selectedId=caseKey(filtered()[0]);return render();}
    if(d.jrCase){selectedId=d.jrCase;stage=0;return render();}
    if(d.jrStage!=null){stage=Math.max(0,Math.min(4,Number(d.jrStage)));return render();}
    if(d.jrCompare){
      const v=d.jrVariant==='progressive'?'progressive':'baseline';
      variant='all';selectedId=v+':'+d.jrCompare;stage=4;return render();
    }
    if(btn.hasAttribute('data-jr-prev')){stage=Math.max(0,stage-1);return render();}
    if(btn.hasAttribute('data-jr-next'))return advanceStage();
    if(btn.hasAttribute('data-jr-nextcase')){
      const c=filtered(),index=c.findIndex(x=>caseKey(x)===caseKey(current()));
      if(index<c.length-1){selectedId=caseKey(c[index+1]);stage=0;render();}
    }
  });
  document.addEventListener('keydown',event=>{
    if(!visible)return;
    if(event.key==='Escape'){event.preventDefault();closeReplay();return;}
    if(event.key==='Tab'){
      const focusables=[...overlay.querySelectorAll('button:not([disabled]),a[href],summary')].filter(x=>x.offsetParent!==null);
      if(!focusables.length)return;
      const first=focusables[0],last=focusables[focusables.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
  window.addEventListener('hashchange',()=>{
    if(location.hash.startsWith('#jev-replay'))openReplay();
    else closeReplay();
  });
  if(location.hash.startsWith('#jev-replay'))openReplay();
})();
