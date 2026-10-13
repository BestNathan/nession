import fs from 'node:fs';
import path from 'node:path';
import { hashDependencyTree, resolveIdentity, resolveProviderPlan, verifyExternalDependencies,
  verifyEffectiveHarness, digest } from './contract.mjs';

const ID = /^[a-z][a-z0-9-]*$/;
const HOST = Object.freeze({
  'github.issue.read': 'read_target_issue',
  'github.pr.read': 'read_target_pr',
});
const CLAUDE_TOOLS = Object.freeze({
  'repo.read': ['Read'],
  'repo.search': ['Grep','Glob'],
  'repo.edit': ['Edit','Write'],
  'shell.test': ['Bash'],
});
function fail(message) { throw new Error('native harness: ' + message); }
function requireDir(dir, label) {
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory() ||
      fs.lstatSync(dir).isSymbolicLink()) fail('unsafe ' + label);
}
function safeParents(root, relative) {
  requireDir(root,'workspace');
  let cur=path.resolve(root);
  for (const part of relative.split('/').filter(Boolean)) {
    if (!ID.test(part) && part !== '.claude' && part !== '.harness' && part !== 'skills' &&
        part !== 'plugins' && part !== 'mcp' && part !== 'packages') fail('unsafe asset name');
    cur=path.join(cur,part);
    if (fs.existsSync(cur)) {
      if (!fs.lstatSync(cur).isDirectory() || fs.lstatSync(cur).isSymbolicLink()) fail('unsafe destination path');
    } else fs.mkdirSync(cur);
  }
  return cur;
}
function copyTree(sourceRoot,relative,destination) {
  const expected=hashDependencyTree(sourceRoot,relative);
  if (fs.existsSync(destination)) fail('asset destination collision: '+destination);
  const source=path.join(sourceRoot,relative);
  fs.cpSync(source,destination,{recursive:true,errorOnExist:true,force:false,dereference:false});
  const actual=hashDependencyTree(path.dirname(destination),path.basename(destination));
  if (actual!==expected) fail('staged asset content changed');
  return actual;
}
function plain(v) { return v && typeof v==='object' && !Array.isArray(v); }
function ensureUnconfigured(workspace, provider) {
  // Project settings are a separate capability source. A copied project with
  // hooks/settings/MCP is not automatically approved by its Skill digest.
  const pathParts=provider==='cursor'?['.cursor/hooks.json','.cursor/mcp.json',
    '.cursor/settings.json','.cursor/rules','.cursor/plugins']:
    ['.claude/settings.json','.claude/settings.local.json','.mcp.json','.claude/plugins'];
  for(const relative of pathParts) {
    const full=path.join(workspace,relative);
    if(fs.existsSync(full)) fail('ambient project capability requires explicit verification: '+relative);
  }
}
function checkLocalSkills(root,role,externalIds) {
  const found=[];
  for(const name of role.capabilities.skills) {
    if(externalIds.has(name)) continue;
    if(!ID.test(name)) fail('invalid local Skill');
    const relative='.claude/skills/'+name;
    const full=path.join(root,relative);
    requireDir(full,'repository Skill '+name);
    const skill=path.join(full,'SKILL.md');
    if(!fs.existsSync(skill)||!fs.lstatSync(skill).isFile()||
        fs.lstatSync(skill).isSymbolicLink()) fail('missing/unsafe SKILL.md: '+name);
    found.push({id:name,origin:'repository',tree_sha256:hashDependencyTree(root,relative)});
  }
  return found;
}
export function prepareNativeHarness(registry,request) {
  const {agent_id,task,environment,checkout,workspace,source_sha}=request ?? {};
  if(!/^[a-f0-9]{40}$/.test(source_sha ?? '')) fail('exact source SHA required');
  const identity=resolveIdentity(registry,agent_id,task,environment);
  const sourceRoot=path.resolve(checkout),destRoot=path.resolve(workspace);
  requireDir(sourceRoot,'source checkout');
  requireDir(destRoot,'isolated workspace');
  if(sourceRoot===destRoot) fail('native preparation requires a separate isolated workspace');
  const role=registry.roles[identity.role];
  const verified=verifyExternalDependencies(registry,sourceRoot);
  const dependencyById=new Map(registry.external_dependencies.map(dep=>[dep.id,dep]));
  const expectedExternal=new Set(registry.external_dependencies.filter(d=>d.kind==='skill').map(d=>d.id));
  for(const skill of role.capabilities.skills) {
    if(dependencyById.has(skill) && dependencyById.get(skill).kind!=='skill') fail('Skill has wrong external kind');
  }
  for(const plugin of role.capabilities.plugins) {
    if(dependencyById.get(plugin)?.kind!=='plugin') fail('Plugin is not pinned in dependency registry: '+plugin);
  }
  for(const server of role.capabilities.mcp) {
    if(dependencyById.get(server)?.kind!=='mcp') fail('MCP is not pinned in dependency registry: '+server);
  }
  const local=checkLocalSkills(sourceRoot,role,expectedExternal);
  ensureUnconfigured(destRoot,identity.provider);
  const assets=[];
  for(const skill of local) {
    const rel='.claude/skills/'+skill.id;
    const dir=safeParents(destRoot,'.claude/skills');
    const copied=copyTree(sourceRoot,rel,path.join(dir,skill.id));
    if(copied!==skill.tree_sha256) fail('repository Skill changed during staging');
    assets.push({...skill,loaded_path:rel});
  }
  const destinations={skill:'.claude/skills',plugin:'.harness/plugins',
    mcp:'.harness/mcp',cli:'.harness/packages',sdk:'.harness/packages',
    registry:'.harness/packages'};
  for(const dep of registry.external_dependencies) {
    const parent=destinations[dep.kind];
    const out=safeParents(destRoot,parent);
    const destination=path.join(out,dep.id);
    const copied=copyTree(sourceRoot,dep.path,destination);
    if(copied!==dep.sha256) fail('external dependency digest drift: '+dep.id);
    assets.push({id:dep.id,origin:'external',kind:dep.kind,revision:dep.revision,
      tree_sha256:copied,loaded_path:parent+'/'+dep.id});
  }
  for(const skill of role.capabilities.skills) {
    if(!assets.some(a=>a.id===skill&&(a.origin==='repository'||a.kind==='skill'))) {
      fail('required Skill is absent: '+skill);
    }
    const file=path.join(destRoot,'.claude/skills',skill,'SKILL.md');
    if(!fs.existsSync(file)||!fs.lstatSync(file).isFile()) fail('staged SKILL.md missing: '+skill);
  }
  const plan=resolveProviderPlan(registry,identity,verified);
  return {
    schema_version:1,identity,source_sha,workspace:destRoot,
    plan,assets,required_skills:[...role.capabilities.skills],
    required_plugins:[...role.capabilities.plugins],
    required_mcp:[...role.capabilities.mcp],
    preparation_sha256:digest({identity,source_sha,assets,
      semantic_capabilities:role.capabilities}),
  };
}
function requiredHostTools(prepared,providers) {
  const required=Object.keys(HOST).filter(x=>prepared.plan.canonical_capabilities.tools.includes(x));
  const missing=required.filter(x=>typeof providers?.[x]?.execute!=='function');
  if(missing.length) fail('missing permission-enforcing host tool: '+missing.join(','));
  return required;
}
function validateStagedAssets(prepared) {
  for(const asset of prepared.assets) {
    const actual=hashDependencyTree(prepared.workspace,asset.loaded_path);
    if(actual!==asset.tree_sha256) fail('staged asset was modified after verification: '+asset.id);
  }
}

function pinnedMcpServers(prepared) {
  const servers={};
  const requestedHost=prepared.plan.canonical_capabilities.tools.filter(t=>Object.hasOwn(HOST,t));
  const provided=new Set();
  for(const name of prepared.required_mcp) {
    const root=path.join(prepared.workspace,'.harness/mcp',name);
    requireDir(root,'pinned MCP '+name);
    const manifestFile=path.join(root,'server.json');
    if(!fs.existsSync(manifestFile)||!fs.lstatSync(manifestFile).isFile()||
        fs.lstatSync(manifestFile).isSymbolicLink()) fail('missing pinned MCP manifest: '+name);
    const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    if(!plain(manifest)||Object.keys(manifest).some(k=>!['type','command','args','provides'].includes(k))||
        manifest.type!=='stdio'||typeof manifest.command!=='string'||
        !Array.isArray(manifest.args)||manifest.args.some(x=>typeof x!=='string'||x.length>256)||
        !Array.isArray(manifest.provides)||manifest.provides.some(x=>typeof x!=='string')) {
      fail('unsupported or unsafe MCP manifest: '+name);
    }
    const entry=path.resolve(root,manifest.command);
    if(!entry.startsWith(root+path.sep)||!fs.existsSync(entry)||
        !fs.lstatSync(entry).isFile()||fs.lstatSync(entry).isSymbolicLink()) {
      fail('unpinned MCP executable: '+name);
    }
    for(const cap of manifest.provides) {
      if(!Object.hasOwn(HOST,cap)||provided.has(cap)) fail('unexpected/duplicate MCP capability: '+cap);
      provided.add(cap);
    }
    servers[name]={type:'stdio',command:entry,args:manifest.args};
  }
  if(prepared.identity.provider==='claude-code') {
    for(const cap of requestedHost) if(!provided.has(cap)) fail('MCP does not declare required GitHub capability: '+cap);
  }
  return servers;
}

export function cursorNativeOptions(prepared,{hostTools}={}) {
  if(prepared.identity.provider!=='cursor') fail('provider mismatch');
  validateStagedAssets(prepared);
  if(prepared.required_plugins.length) fail('Cursor plugin injection from untrusted ambient settings is unsupported');
  const required=requiredHostTools(prepared,hostTools);
  const mcpServers=pinnedMcpServers(prepared);
  const builtins=new Set(prepared.plan.native_tools.map(x=>x.native_name).filter(x=>x!=='mcp'));
  const selected=[...builtins];
  if(required.length||prepared.required_mcp.length) selected.push('mcp');
  const customTools=Object.fromEntries(required.map(id=>[HOST[id],hostTools[id]]));
  return {
    provider:'cursor', source_sha:prepared.source_sha,preparation_sha256:prepared.preparation_sha256,
    agent_options:{
      tools:selected.sort(),
      ...(prepared.required_mcp.length?{mcpServers}:{}),
      local:{cwd:prepared.workspace,settingSources:['project'],sandboxOptions:{enabled:true},
        ...(required.length?{customTools}:{})},
    },
    required_inventory:{skills:prepared.required_skills,mcp:prepared.required_mcp,
      plugins:[],host_tools:required},
  };
}
export function claudeNativeOptions(prepared) {
  if(prepared.identity.provider!=='claude-code') fail('provider mismatch');
  validateStagedAssets(prepared);
  const tools=prepared.plan.canonical_capabilities.tools;
  // Host GitHub reads must have an explicitly bound, trusted MCP server; a
  // CLI flag is not evidence the required operations were implemented.
  if(tools.some(x=>Object.hasOwn(HOST,x)) && !prepared.required_mcp.length) {
    fail('Claude host GitHub capabilities require pinned MCP implementations');
  }
  const builtin=[...new Set(tools.flatMap(t=>CLAUDE_TOOLS[t]??[]))];
  const missing=tools.filter(t=>!CLAUDE_TOOLS[t]&&!Object.hasOwn(HOST,t));
  if(missing.length) fail('unavailable Claude native tool: '+missing.join(','));
  const servers=pinnedMcpServers(prepared);
  const args=['--setting-sources','project','--strict-mcp-config',
    '--allowedTools',builtin.sort().join(',')];
  if(prepared.required_mcp.length) {
    const configDir=safeParents(prepared.workspace,'.harness');
    const configFile=path.join(configDir,'mcp-config.json');
    if(fs.existsSync(configFile)) fail('Claude MCP config destination collision');
    const config={mcpServers:Object.fromEntries(Object.entries(servers).map(([id,s])=>
      [id,{command:s.command,args:s.args}]))};
    fs.writeFileSync(configFile,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
    args.push('--mcp-config',configFile);
  }
  for(const plugin of prepared.required_plugins) {
    const full=path.join(prepared.workspace,'.harness/plugins',plugin);
    const manifest=path.join(full,'.claude-plugin/plugin.json');
    if(!fs.existsSync(manifest)||!fs.lstatSync(manifest).isFile()||
        fs.lstatSync(manifest).isSymbolicLink()) fail('missing pinned Claude Plugin manifest');
    const details=JSON.parse(fs.readFileSync(manifest,'utf8'));
    if(details.name!==plugin) fail('Plugin identity does not match pinned role capability');
    args.push('--plugin-dir',full);
  }
  return {
    provider:'claude-code',source_sha:prepared.source_sha,
    preparation_sha256:prepared.preparation_sha256,
    cwd:prepared.workspace,args,
    required_inventory:{skills:prepared.required_skills,mcp:prepared.required_mcp,
      plugins:prepared.required_plugins,host_tools:tools.filter(x=>Object.hasOwn(HOST,x))},
  };
}
export function auditNativeLoad(prepared,observed,providerVersion,checkpointDigest=null) {
  validateStagedAssets(prepared);
  const plan=prepared.plan;
  if(!observed||!Array.isArray(observed.tools)||!Array.isArray(observed.skills)||
      !Array.isArray(observed.mcp)||!Array.isArray(observed.plugins)) fail('native inventory is unobserved');
  // Effective capabilities are computed from actual Provider-reported values,
  // not from our expected launch descriptor.
  const effective=verifyEffectiveHarness(plan,observed,prepared.source_sha,providerVersion);
  if(checkpointDigest!=null && checkpointDigest!==effective.sha256) fail('checkpoint Harness is incompatible');
  return effective;
}
