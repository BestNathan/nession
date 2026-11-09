#!/usr/bin/env node
// #2358. Read-only live GitHub policy admission before minting the dedicated
// Knowledge Publisher installation token. The API readback is authoritative:
// a main-owned workflow or runbook alone never proves server-side protection.
import assert from 'node:assert/strict';

const REPO = 'BestNathan/nession';
const REF = 'refs/heads/knowledge';
const SHA = /^[0-9a-f]{40}$/;
const SPECS = Object.freeze([
  { name: 'Knowledge / Writer identity', types: ['creation', 'update'], bypass: 'app' },
  { name: 'Knowledge / Append-only',
    types: ['deletion', 'non_fast_forward', 'required_linear_history'], bypass: 'none' },
]);
function fail(s) { throw Error('knowledge-publisher-policy: ' + s); }
function requireRuleset(r, spec, appId) {
  if (!r || r.name !== spec.name || r.target !== 'branch' || r.enforcement !== 'active')
    fail(spec.name + ': not an active branch Ruleset');
  if (r.source_type && r.source_type !== 'Repository')
    fail(spec.name + ': an unexpected organization source owns the rules');
  const names = r.conditions?.ref_name;
  if (!names || JSON.stringify(names.include) !== JSON.stringify([REF]) ||
      !Array.isArray(names.exclude) || names.exclude.length !== 0)
    fail(spec.name + ': must match only the exact knowledge ref');
  const types = (r.rules ?? []).map(x => x.type).sort();
  if (JSON.stringify(types) !== JSON.stringify([...spec.types].sort()))
    fail(spec.name + ': Ruleset rule types differ from approved policy');
  const actors = r.bypass_actors;
  // GitHub deliberately redacts bypass_actors for callers without ruleset
  // administration authority. Do not give the publisher Admin:write merely
  // to observe this field. Admin-side signed receipts + canary are separate SCs.
  if (!Array.isArray(actors)) return false;
  if (spec.bypass === 'none' && actors.length) fail(spec.name + ': append-only must have zero bypass actors');
  if (spec.bypass === 'app' &&
      (actors.length !== 1 || Number(actors[0].actor_id) !== appId ||
       actors[0].actor_type !== 'Integration' || actors[0].bypass_mode !== 'always'))
    fail(spec.name + ': bypass identity is not the dedicated Knowledge App');
  return true;
}
export function verifyPolicy(branch, list, details, appId) {
  if (!Number.isSafeInteger(appId) || appId <= 0) fail('real dedicated App ID required');
  if (!branch || branch.name !== 'knowledge' || branch.protected !== true ||
      !SHA.test(branch.commit?.sha || ''))
    fail('live knowledge ref must have protected=true and exact SHA readback');
  if (!Array.isArray(list) || !Array.isArray(details) || list.length >= 100)
    fail('missing or incomplete GitHub Ruleset enumeration');
  const bypassReadbacks = [];
  for (const spec of SPECS) {
    const found = list.filter(x => x.name === spec.name && x.target === 'branch' && x.source_type === 'Repository');
    if (found.length !== 1) fail(spec.name + ': expected one repository-owned Ruleset');
    const rule = details.find(x => x.id === found[0].id);
    if (!rule) fail(spec.name + ': missing authenticated Ruleset detail');
    bypassReadbacks.push(requireRuleset(rule, spec, appId));
  }
  return { knowledge_head: branch.commit.sha,
    writer_ruleset_id: details.find(x => x.name === SPECS[0].name).id,
    append_only_ruleset_id: details.find(x => x.name === SPECS[1].name).id,
    app_id: appId, bypass_metadata_visible: bypassReadbacks.every(Boolean),
    result: 'active_ruleset_structure_verified_readonly' };
}
function test() {
  const appId = 876543;
  const branch = { name: 'knowledge', protected: true, commit: { sha: 'a'.repeat(40) } };
  const writer = { id: 11, source_type:'Repository', name:SPECS[0].name,
    target:'branch', enforcement:'active',
    conditions:{ref_name:{include:[REF],exclude:[]}},
    rules:[{type:'creation'},{type:'update'}],
    bypass_actors:[{actor_id:appId,actor_type:'Integration',bypass_mode:'always'}] };
  const append = { id: 12, source_type:'Repository', name:SPECS[1].name,
    target:'branch', enforcement:'active',
    conditions:{ref_name:{include:[REF],exclude:[]}},
    rules:[{type:'deletion'},{type:'non_fast_forward'},{type:'required_linear_history'}],
    bypass_actors:[] };
  const list=[{id:11,name:writer.name,target:'branch',source_type:'Repository'},
    {id:12,name:append.name,target:'branch',source_type:'Repository'}];
  assert.equal(verifyPolicy(branch,list,[writer,append],appId).bypass_metadata_visible,true);
  const masked = verifyPolicy(branch,list,[{...writer,bypass_actors:undefined},
    {...append,bypass_actors:undefined}],appId);
  assert.equal(masked.result,'active_ruleset_structure_verified_readonly');
  assert.equal(masked.bypass_metadata_visible,false);
  for (const changed of [
    {branch:{...branch,protected:false}},
    {list:list.slice(0,1)},
    {details:[{...writer,enforcement:'evaluate'},append]},
    {details:[{...writer,bypass_actors:[{actor_id:1,actor_type:'Integration',bypass_mode:'always'}]},append]},
    {details:[writer,{...append,bypass_actors:[{actor_id:appId}]}]},
    {details:[writer,{...append,rules:[{type:'deletion'}]}]},
    {details:[{...writer,conditions:{ref_name:{include:['~ALL'],exclude:[]}}},append]},
  ]) assert.throws(() => verifyPolicy(changed.branch??branch,changed.list??list,
    changed.details??[writer,append],appId));
  console.log('knowledge-publisher-policy: live Ruleset identity/append-only negative fixtures passed');
}
async function request(url, token) {
  const response = await fetch('https://api.github.com' + url, {
    headers: {Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28', Authorization:'Bearer '+token },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) fail('GitHub readback HTTP ' + response.status + ' for ' + url);
  return response.json();
}
async function check() {
  const token = process.env.GH_TOKEN;
  const appId = Number(process.env.KNOWLEDGE_PUBLISHER_APP_ID);
  if (!token || !Number.isSafeInteger(appId) || appId<=0 ||
      process.env.GITHUB_EVENT_NAME !== 'repository_dispatch' ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_REPOSITORY !== REPO)
    fail('trusted main and read-only API token plus dedicated App ID required');
  const prefix = '/repos/' + REPO;
  const [branch,list] = await Promise.all([
    request(prefix + '/branches/knowledge',token),
    request(prefix + '/rulesets?per_page=100',token),
  ]);
  if (!Array.isArray(list)) fail('unexpected rulesets response');
  const selected = list.filter(x => SPECS.some(s => s.name === x.name));
  const details=[];
  for(const item of selected) details.push(await request(prefix+'/rulesets/'+item.id,token));
  const verified = verifyPolicy(branch,list,details,appId);
  console.log(JSON.stringify(verified));
}
try {
  if (process.argv[2] === 'self-test') test();
  else if (process.argv[2] === 'check') await check();
  else fail('usage: self-test | check');
} catch(error) { console.error(error.message); process.exitCode=1; }
