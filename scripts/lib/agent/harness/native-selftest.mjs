import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { hashDependencyTree, validateRegistry } from './contract.mjs';
import { prepareNativeHarness,cursorNativeOptions,claudeNativeOptions,auditNativeLoad } from './native.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-native-harness-'));
function put(rel,data='name: test\n') {
  const file=path.join(root,'checkout',rel);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,data);
}
function fresh(name) {
  const dir=path.join(root,name);
  fs.mkdirSync(dir);
  return dir;
}
try {
  const checkout=fresh('checkout');
  for(const name of ['nession-development','nession-gates','nession-code-review']) {
    put('.claude/skills/'+name+'/SKILL.md','---\nname: '+name+'\n---\n');
  }
  put('thirdparty/superpowers/SKILL.md','---\nname: superpowers\n---\n');
  put('thirdparty/superpowers/references/usage.md','revision 19\n');
  put('thirdparty/shadcn/registry.json','{"components":["button"]}\n');
  put('thirdparty/sample-plugin/.claude-plugin/plugin.json','{"name":"sample-plugin"}\n');
  put('thirdparty/github-readonly/server.json',JSON.stringify({type:'stdio',command:'server.sh',args:[],provides:['github.issue.read','github.pr.read']})+'\n');
  put('thirdparty/github-readonly/server.sh','#!/usr/bin/env bash\nexit 0\n');
  const git=(...args)=>execFileSync('git',['-C',checkout,...args],{encoding:'utf8'}).trim();
  git('init','-q');
  git('config','user.email','agent-fixture@example.invalid');
  git('config','user.name','Agent Harness Fixture');
  git('add','-A');
  git('commit','-qm','fixture');
  const sourceSha=git('rev-parse','HEAD');

  const ext=[
    {id:'superpowers',kind:'skill',revision:'c7d152b4a','path':'thirdparty/superpowers'},
    {id:'shadcn',kind:'registry',revision:'v3.0.1','path':'thirdparty/shadcn'},
    {id:'sample-plugin',kind:'plugin',revision:'v1.0.0','path':'thirdparty/sample-plugin'},
  ].map(d=>({...d,sha256:hashDependencyTree(checkout,d.path)}));
  const reg=structuredClone(registry);
  reg.roles.developer.capabilities.skills.push('superpowers');
  reg.external_dependencies=ext;
  validateRegistry(reg);
  const request={agent_id:'dev-cursor-01',task:'implement',environment:'agent-dev-cursor-01',
    checkout,workspace:fresh('cursor'),source_sha:sourceSha};
  const prep=prepareNativeHarness(reg,request);
  assert.throws(()=>prepareNativeHarness(reg,{...request,workspace:fresh('wrong-sha'),
    source_sha:'f'.repeat(40)}),/HEAD does not match/);
  assert.equal(prep.assets.length,5);
  assert.ok(prep.assets.some(x=>x.id==='superpowers'&&x.origin==='external'));
  assert.ok(prep.assets.some(x=>x.id==='shadcn'&&x.kind==='registry'));
  assert.ok(fs.existsSync(path.join(request.workspace,'.claude/skills/superpowers/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(request.workspace,'.claude/skills/shadcn')));
  assert.ok(!fs.existsSync(path.join(request.workspace,'.harness/plugins/shadcn')));
  const hostTools={
    'github.issue.read':{description:'Read issue',execute:async()=>({})},
    'github.pr.read':{description:'Read PR',execute:async()=>({})},
  };
  assert.throws(()=>cursorNativeOptions(prep),/missing permission-enforcing/);
  const cursor=cursorNativeOptions(prep,{hostTools});
  assert.equal(cursor.agent_options.local.sandboxOptions.enabled,true);
  assert.deepEqual(cursor.agent_options.local.settingSources,['project']);
  assert.ok(cursor.agent_options.tools.includes('shell'));
  assert.ok(cursor.agent_options.tools.includes('mcp'));
  assert.ok(!cursor.agent_options.tools.includes('bash'));
  assert.ok(!cursor.agent_options.local.settingSources.includes('user'));
  assert.equal(cursor.agent_options.local.customTools.read_target_issue,hostTools['github.issue.read']);
  assert.equal(Object.hasOwn(cursor.agent_options,'mcpServers'),false);
  const observed={tools:[...new Set(prep.plan.native_tools.map(x=>x.native_name))],
    skills:prep.required_skills,mcp:[],plugins:[]};
  const effective=auditNativeLoad(prep,observed,'sdk-1.2');
  assert.match(effective.sha256,/^[a-f0-9]{64}$/);
  assert.equal(auditNativeLoad(prep,observed,'sdk-1.2',effective.sha256).sha256,effective.sha256);
  assert.throws(()=>auditNativeLoad(prep,observed,'sdk-1.2','0'.repeat(64)),/incompatible/);
  assert.throws(()=>auditNativeLoad(prep,{...observed,skills:[]},'sdk-1.2'),/not loaded/);
  assert.throws(()=>auditNativeLoad(prep,{...observed,tools:[...observed.tools,'unapproved-tool']},'sdk-1.2'),/undeclared/);
  assert.throws(()=>auditNativeLoad(prep,{...observed,skills:[...observed.skills,'unverified-plugin-skill']},'sdk-1.2'),/undeclared/);
  assert.throws(()=>auditNativeLoad(prep,{...observed,tools:[...observed.tools,observed.tools[0]]},'sdk-1.2'),/duplicate/);
  assert.throws(()=>auditNativeLoad(prep,null,'sdk-1.2'),/unobserved/);

  const claudeReg=structuredClone(reg);
  claudeReg.instances['dev-claude-01']={role:'developer',provider:'claude-code',
    environment:'agent-dev-claude-01'};
  validateRegistry(claudeReg);
  const claudePrep=prepareNativeHarness(claudeReg,{...request,agent_id:'dev-claude-01',
    environment:'agent-dev-claude-01',workspace:fresh('claude')});
  assert.throws(()=>claudeNativeOptions(claudePrep),/require pinned MCP/);
  const isolated=structuredClone(claudeReg);
  isolated.roles.developer.capabilities.tools=['repo.read','repo.search','repo.edit','shell.test'];
  isolated.roles.developer.capabilities.plugins=['sample-plugin'];
  const stage=prepareNativeHarness(isolated,{...request,agent_id:'dev-claude-01',
    environment:'agent-dev-claude-01',workspace:fresh('claude-plugin')});
  const cli=claudeNativeOptions(stage);
  assert.ok(cli.args.includes('--strict-mcp-config'));
  assert.ok(cli.args.includes('--setting-sources'));
  assert.ok(cli.args.includes('--plugin-dir'));
  assert.ok(cli.args.includes('Read,Grep,Glob,Edit,Write,Bash')===false);
  assert.ok(cli.args.includes('Bash,Edit,Glob,Grep,Read,Write'));
  const pluginDir=cli.args[cli.args.indexOf('--plugin-dir')+1];
  assert.ok(fs.existsSync(path.join(pluginDir,'.claude-plugin/plugin.json')));
  assert.throws(()=>cursorNativeOptions({...stage,identity:{...stage.identity,provider:'cursor'}}),/plugin injection/);
  const cursorWithoutPlugin=prepareNativeHarness(reg,{...request,workspace:fresh('cursor-clean')});
  assert.equal(cursorNativeOptions(cursorWithoutPlugin,{hostTools}).provider,'cursor');

  const pinnedMcp={id:'github-readonly',kind:'mcp',revision:'b1d2e3f4a5',
    path:'thirdparty/github-readonly',
    sha256:hashDependencyTree(checkout,'thirdparty/github-readonly')};
  const withMcp=structuredClone(claudeReg);
  withMcp.external_dependencies.push(pinnedMcp);
  withMcp.roles.developer.capabilities.mcp=['github-readonly'];
  const mcpClaude=prepareNativeHarness(withMcp,{...request,agent_id:'dev-claude-01',
    environment:'agent-dev-claude-01',workspace:fresh('mcp-claude')});
  const mcpArgs=claudeNativeOptions(mcpClaude);
  assert.ok(mcpArgs.args.includes('--mcp-config'));
  const configPath=mcpArgs.args[mcpArgs.args.indexOf('--mcp-config')+1];
  const servers=JSON.parse(fs.readFileSync(configPath,'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers),['github-readonly']);
  assert.ok(servers['github-readonly'].command.endsWith('github-readonly/server.sh'));
  const mcpCursor=prepareNativeHarness(withMcp,{...request,workspace:fresh('mcp-cursor')});
  const mcpCursorOptions=cursorNativeOptions(mcpCursor,{hostTools});
  assert.deepEqual(Object.keys(mcpCursorOptions.agent_options.mcpServers),['github-readonly']);
  assert.ok(mcpCursorOptions.agent_options.tools.includes('mcp'));
  const rogue=path.join(mcpClaude.workspace,'.harness/mcp/github-readonly/server.json');
  fs.writeFileSync(rogue,'{"type":"stdio","command":"/bin/sh"}');
  assert.throws(()=>claudeNativeOptions(mcpClaude),/staged asset was modified/);

  put('thirdparty/superpowers/references/usage.md','modified!\n');
  assert.throws(()=>prepareNativeHarness(reg,{...request,workspace:fresh('tampered')}),/sha256 mismatch/);
  put('thirdparty/superpowers/references/usage.md','revision 19\n');
  const badRev=structuredClone(reg);
  badRev.external_dependencies[0].revision='latest';
  assert.throws(()=>prepareNativeHarness(badRev,{...request,workspace:fresh('mutable')}),/unversioned/);
  const wrongKind=structuredClone(reg);
  wrongKind.roles.developer.capabilities.skills.push('shadcn');
  assert.throws(()=>prepareNativeHarness(wrongKind,{...request,workspace:fresh('wrong-kind')}),/wrong external kind/);
  const ambient=fresh('ambient');
  fs.mkdirSync(path.join(ambient,'.cursor'));
  fs.writeFileSync(path.join(ambient,'.cursor/hooks.json'),'{}');
  assert.throws(()=>prepareNativeHarness(reg,{...request,workspace:ambient}),/ambient project/);
  const link=fresh('symlink');
  fs.symlinkSync(path.join(root,'checkout'),path.join(link,'.claude'));
  assert.throws(()=>prepareNativeHarness(reg,{...request,workspace:link}),/unsafe destination/);
  const unsafe=structuredClone(reg);
  unsafe.external_dependencies[0].path='../outside';
  assert.throws(()=>prepareNativeHarness(unsafe,{...request,workspace:fresh('traversal')}),/unsafe dependency path/);
  console.log('native Harness: provider-specific options, verified asset staging, digest and negative fixtures passed');
} finally {fs.rmSync(root,{recursive:true,force:true});}
