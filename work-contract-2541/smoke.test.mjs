import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function mount() {
  const events = new Map();
  const fixtures = new Map();
  const classes = new Set();
  const product = {
    innerHTML: '', scrollTop: 0,
    classList: { toggle(name, enabled) { if(enabled) classes.add(name); else classes.delete(name); } },
    addEventListener(name, handler) { events.set('product:' + name, handler); },
    contains() { return true; }
  };
  const fixtureButtons = ['normal','changed','denied','unavailable','feishu','unbound'].map((id)=>({
    id,
    getAttribute(name) { return name === 'data-fixture' ? id : null; },
    setAttribute(name,value) { if(name==='aria-pressed')this.pressed=value; },
    addEventListener(_name, handler) { fixtures.set(id,handler); }
  }));
  const page = {
    querySelector(selector) {
      return selector === '[data-np-device]' ? { style:{ getPropertyValue() {return '1180px';} } } : null;
    },
    querySelectorAll(selector) {return selector === '[data-fixture]'?fixtureButtons:[];},
    addEventListener(name,handler) {events.set('page:' + name,handler);}
  };
  const document = {
    getElementById(id) {return id==='contract-product'?product:null;},
    querySelector(selector) {return selector==='[data-np-root]'?page:null;}
  };
  runInNewContext(script,{document});
  return {
    html() {return product.innerHTML;},
    capsule() {return product.innerHTML.match(/<nav class="wc-capability-capsule"[\s\S]*?<\/nav>/)?.[0] ?? '';},
    hasClass(name) {return classes.has(name);},
    act(name, value=null) {
      events.get('product:click')({target:{closest() {
        return {getAttribute(prop) {
          return prop==='data-action'?name:prop==='data-value'?value:null;
        }};
      }}});
    },
    fixture(name) {
      const button=fixtureButtons.find((entry)=>entry.id===name);
      assert.ok(button,'known fixture');
      fixtures.get(name).call(button);
    },
    type(value) {events.get('product:input')({target:{id:'work-reply-body',value}});},
    submit() {events.get('product:submit')({target:{id:'work-reply'},preventDefault(){}});},
    resize(width) {events.get('page:np:resize')({detail:{width}});}
  };
}

test('Work is in Workspace Capability Capsule, not an independent global page',()=>{
  const ui=mount();
  assert.match(ui.html(),/WORKSPACE \/ WORK CAPABILITY/);
  assert.match(ui.html(),/<h1>Work<\/h1>/);
  assert.match(ui.capsule(),/data-value="work"/);
  assert.match(ui.capsule(),/data-value="files"/);
  assert.match(ui.capsule(),/data-value="git"/);
  assert.match(ui.capsule(),/aria-current="page"/);
  assert.doesNotMatch(ui.html(),/\/ Current work \/ Contract/);
  ui.act('open');
  assert.match(ui.html(),/Definition v1/);
  assert.match(ui.capsule(),/data-value="work"/);
});

test('Contract is Work-local depth; capability switch preserves selected Contract tab/revision',()=>{
  const ui=mount();
  ui.act('open');
  ui.act('tab','criteria');
  assert.match(ui.html(),/Success criteria/);
  ui.act('capability','git');
  assert.match(ui.html(),/WORKSPACE \/ GIT CAPABILITY/);
  ui.act('capability','files');
  assert.match(ui.html(),/WORKSPACE \/ FILES CAPABILITY/);
  ui.act('capability','work');
  assert.match(ui.html(),/Success criteria/);
  assert.match(ui.html(),/Definition v1/);
});

test('Web has separate Terminal surface return; App Back honors Work depth',()=>{
  const ui=mount();
  assert.match(ui.html(),/Open Terminal/);
  ui.act('terminal');
  assert.match(ui.html(),/dev-session/);
  assert.doesNotMatch(ui.html(),/Workspace capabilities/);
  ui.act('open-workspace');
  assert.match(ui.capsule(),/data-value="work"/);
  ui.resize(390);
  assert.ok(ui.hasClass('is-mobile'));
  assert.doesNotMatch(ui.html(),/wc-terminal-link/);
  ui.act('open');
  assert.match(ui.html(),/Back to Work capability/);
  ui.act('back');
  assert.match(ui.html(),/<h1>Work<\/h1>/);
  ui.act('back');
  assert.match(ui.html(),/dev-session/);
  ui.act('open-workspace');
  assert.match(ui.html(),/<h1>Work<\/h1>/);
  ui.resize(1180);
  assert.ok(!ui.hasClass('is-mobile'));
});

test('unbound Work has no dead Capsule entry and preserves other Workspace capabilities',()=>{
  const ui=mount();
  ui.fixture('unbound');
  assert.match(ui.html(),/Work is not available in this Workspace/);
  assert.doesNotMatch(ui.capsule(),/data-value="work"/);
  assert.match(ui.capsule(),/data-value="files"/);
  ui.act('capability','work'); // cannot select a hidden capability
  assert.match(ui.html(),/Work is not available/);
  ui.act('capability','files');
  assert.match(ui.html(),/WORKSPACE \/ FILES CAPABILITY/);
  assert.doesNotMatch(ui.capsule(),/data-value="work"/);
  ui.fixture('normal');
  assert.match(ui.capsule(),/data-value="work"/);
});

test('published criteria definition and source checklist differ from trusted verification',()=>{
  const ui=mount();
  ui.act('open');ui.act('criteria');ui.act('criterion','SC-01');
  assert.match(ui.html(),/Checked \[x\]/);
  assert.match(ui.html(),/Trusted verification:/);
  assert.match(ui.html(),/Pending/);
  assert.doesNotMatch(ui.html(),/Trusted verification:\s*Pass/);
});

test('WorkThread is associated activity: appending does not amend published Contract',()=>{
  const ui=mount();ui.act('open');ui.act('tab','thread');
  ui.type('Confirm TUI input after reconnect');
  ui.submit();
  assert.match(ui.html(),/Confirm TUI input after reconnect/);
  assert.match(ui.html(),/Contract v1 unchanged/);
  assert.match(ui.html(),/Local draft/);
});

test('untrusted WorkThread markup is escaped',()=>{
  const ui=mount();ui.act('open');ui.act('tab','thread');
  ui.type('<img src=x onerror=alert(1)>');ui.submit();
  assert.match(ui.html(),/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(ui.html(),/<img src=x/);
});

test('source edit proposes revision, comparison toggles and v2 requires explicit adoption',()=>{
  const ui=mount();ui.fixture('changed');ui.act('open');
  assert.match(ui.html(),/Source changed/);
  ui.act('source');assert.match(ui.html(),/Not published/);
  ui.act('compare');assert.match(ui.html(),/Version comparison/);
  ui.act('compare');assert.doesNotMatch(ui.html(),/Version comparison/);
  ui.act('confirm');assert.match(ui.html(),/Confirm adoption/);
  ui.act('adopt');assert.match(ui.html(),/Revision v2/);
  assert.match(ui.html(),/Revision v1/);
  ui.act('revision','1');
  assert.match(ui.html(),/Definition v1/);
  assert.match(ui.html(),/Published v2/);
  assert.match(ui.html(),/Execution.*Pinned to v1/s);
});

test('source denied/offline/Feishu fixtures stay inside Work capability view',()=>{
  const ui=mount();
  ui.fixture('denied');ui.act('open');
  assert.match(ui.html(),/Source access denied/);
  ui.act('source');assert.match(ui.html(),/Access denied/);
  assert.match(ui.capsule(),/data-value="work"/);
  ui.fixture('unavailable');ui.act('open');
  assert.match(ui.html(),/Source temporarily unavailable/);
  ui.fixture('feishu');ui.act('open');ui.act('source');
  assert.match(ui.html(),/feishu:example-tenant:doc:demo-42/);
  assert.match(ui.capsule(),/data-value="work"/);
});
