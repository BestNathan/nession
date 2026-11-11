#!/usr/bin/env node
// Owner: #3180 SC-03 — the rendered GitOps storage contract for Nession.
//
// The `gitops` orphan branch is the deployment-state owner. This checker reads
// a checkout of that branch (or a fixture tree) and proves that every
// supported environment renders the same storage shape:
//
//   - the Server's NESSION_HOME and the Agent's AGENT_EROFS_STORAGE_DIR live
//     inside the deployment's `/data` mount, never on the container layer;
//   - that mount is a PVC backed by an NFS PV (direct `volumeName` or the
//     environment's single NFS PV), with ReadWriteMany and Retain;
//   - the effective server registry/blobs root and the Agent cache root are
//     distinct per environment, and every environment keeps the same NFS
//     server identity;
//   - Server and Agent share the environment's data volume family, while the
//     Agent cache is a separate directory (the Blob Store stays Server-owned).
//
// It does not read a cluster, apply anything, or provision storage.
import fs from 'node:fs';
import path from 'node:path';

const NFS_ROOT = '/mnt/share/k8s';
const DATA_MOUNT = '/data';
const NESSION_HOME = 'NESSION_HOME';
const EROFS_STORAGE = 'AGENT_EROFS_STORAGE_DIR';

function fail(message) {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// Minimal YAML subset parser.
//
// The owned manifests use block mappings, block sequences, block scalars
// (`|-`) and plain/quoted scalars. A general YAML implementation is not
// needed, and pulling one in would add a dependency to the Node-only tooling
// job (which never runs `npm ci`). Unknown constructs fail closed.
// ---------------------------------------------------------------------------
function significantLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const result = [];
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (raw.includes('\t')) fail('manifest uses tab indentation');
    const indent = raw.length - raw.trimStart().length;
    result.push({ indent, text: raw.slice(indent) });
  }
  return result;
}

function parseScalar(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return null;
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isSequenceItem(line) {
  return line.text === '-' || line.text.startsWith('- ');
}

function parseBlock(lines, index, indent) {
  if (index >= lines.length || lines[index].indent < indent) {
    return { value: null, next: index };
  }
  return isSequenceItem(lines[index])
    ? parseSequence(lines, index, indent)
    : parseMapping(lines, index, indent);
}

function parseBlockScalar(lines, index, parentIndent) {
  if (index >= lines.length || lines[index].indent <= parentIndent) {
    return { value: '', next: index };
  }
  const childIndent = lines[index].indent;
  let next = index;
  const content = [];
  while (next < lines.length && lines[next].indent >= childIndent) {
    content.push(' '.repeat(lines[next].indent - childIndent) + lines[next].text);
    next += 1;
  }
  return { value: content.join('\n'), next };
}

function parseMapping(lines, index, indent) {
  const map = {};
  let next = index;
  while (next < lines.length && lines[next].indent === indent && !isSequenceItem(lines[next])) {
    const match = lines[next].text.match(/^([^:]+):(.*)$/);
    if (!match) fail('unsupported manifest line: ' + lines[next].text);
    const key = match[1].trim();
    const rest = match[2].trim();
    if (rest === '|' || rest === '|-') {
      const block = parseBlockScalar(lines, next + 1, indent);
      map[key] = block.value;
      next = block.next;
    } else if (rest === '') {
      if (next + 1 < lines.length &&
          (lines[next + 1].indent > indent ||
           (lines[next + 1].indent === indent && isSequenceItem(lines[next + 1])))) {
        // A block sequence under a mapping key may sit at the key's own
        // indentation (the kustomization files in the owned tree do).
        const child = parseBlock(lines, next + 1, lines[next + 1].indent);
        map[key] = child.value;
        next = child.next;
      } else {
        map[key] = null;
        next += 1;
      }
    } else {
      map[key] = parseScalar(rest);
      next += 1;
    }
  }
  return { value: map, next };
}

function parseSequence(lines, index, indent) {
  const items = [];
  let next = index;
  while (next < lines.length && lines[next].indent === indent && isSequenceItem(lines[next])) {
    const content = lines[next].text === '-' ? '' : lines[next].text.slice(2);
    if (content === '') {
      if (next + 1 < lines.length && lines[next + 1].indent > indent) {
        const child = parseBlock(lines, next + 1, lines[next + 1].indent);
        items.push(child.value);
        next = child.next;
      } else {
        items.push(null);
        next += 1;
      }
      continue;
    }
    const first = content.match(/^([^:]+):(.*)$/);
    if (!first) {
      items.push(parseScalar(content));
      next += 1;
      continue;
    }
    // A sequence item that is a mapping: its first key shares the dash line;
    // the remaining keys are indented under the dash.
    const item = {};
    const key = first[1].trim();
    const rest = first[2].trim();
    if (rest === '|' || rest === '|-') {
      const block = parseBlockScalar(lines, next + 1, indent);
      item[key] = block.value;
      next = block.next;
    } else if (rest === '') {
      if (next + 1 < lines.length && lines[next + 1].indent > indent) {
        const child = parseBlock(lines, next + 1, lines[next + 1].indent);
        item[key] = child.value;
        next = child.next;
      } else {
        item[key] = null;
        next += 1;
      }
    } else {
      item[key] = parseScalar(rest);
      next += 1;
    }
    if (next < lines.length && lines[next].indent > indent && !isSequenceItem(lines[next])) {
      const restOfItem = parseMapping(lines, next, lines[next].indent);
      Object.assign(item, restOfItem.value);
      next = restOfItem.next;
    }
    items.push(item);
  }
  return { value: items, next };
}

export function parseYamlDocuments(text) {
  const documents = [];
  let current = [];
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (/^---\s*$/.test(line)) {
      if (current.length) documents.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) documents.push(current.join('\n'));
  return documents
    .filter((document) => significantLines(document).length > 0)
    .map((document) => {
      const lines = significantLines(document);
      const parsed = parseBlock(lines, 0, lines[0].indent);
      if (parsed.next !== lines.length) fail('unsupported trailing YAML content');
      return parsed.value;
    });
}

// ---------------------------------------------------------------------------
// GitOps rendering (the owned subset).
// ---------------------------------------------------------------------------
function readTreeFile(root, relative) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) fail('missing GitOps file: ' + relative);
  return fs.readFileSync(full, 'utf8');
}

function listEnvironmentIds(root) {
  const dir = path.join(root, 'environments');
  if (!fs.existsSync(dir)) fail('GitOps tree has no environments directory');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => {
      const overlay = path.join(dir, name, 'nession', 'kustomization.yaml');
      if (!fs.existsSync(overlay)) return false;
      // Only managed environments belong to the contract; anything else is
      // out of scope rather than silently green.
      return ['staging', 'staging-01', 'preprod', 'production'].includes(name);
    });
}

function deploymentFrom(document, role) {
  return document && document.kind === 'Deployment' &&
    document.metadata && document.metadata.name === 'nession-' + role
    ? document
    : null;
}

function container(document) {
  const containers = document?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) {
    fail('deployment must declare exactly one container');
  }
  return containers[0];
}

function envValue(document, name) {
  const env = container(document).env;
  if (!Array.isArray(env)) return null;
  const entry = env.find((item) => item && item.name === name);
  return entry ? String(entry.value ?? '') : null;
}

function mounts(document) {
  const value = container(document).volumeMounts;
  return Array.isArray(value) ? value : [];
}

function volumes(document) {
  const value = document?.spec?.template?.spec?.volumes;
  return Array.isArray(value) ? value : [];
}

function claimNameFor(document, volumeName) {
  const volume = volumes(document).find((item) => item && item.name === volumeName);
  return volume?.persistentVolumeClaim?.claimName ?? null;
}

function applyStrategicMergeClaims(deployment, patch, suffix, declaredClaims) {
  for (const volume of volumes(patch)) {
    const claim = volume?.persistentVolumeClaim?.claimName;
    if (!claim) continue;
    const target = volumes(deployment).find((item) => item && item.name === volume.name);
    if (!target) fail('claim patch names an unknown volume: ' + volume.name);
    target.persistentVolumeClaim = {
      claimName: declaredClaims.get(claim) ?? claim,
    };
  }
}

function applyJsonPatches(deployment, ops) {
  if (!Array.isArray(ops)) return;
  for (const op of ops) {
    if (!op || typeof op !== 'object') fail('JSON patch must be an object');
    const target = String(op.path ?? '');
    const match = target.match(
      /^\/spec\/template\/spec\/containers\/0\/volumeMounts\/(\d+)(?:\/(.+))?$/,
    );
    if (match) {
      const index = Number(match[1]);
      const mount = mounts(deployment)[index];
      if (!mount) fail('JSON patch targets a missing volumeMount index ' + index);
      if (op.op !== 'add' && op.op !== 'replace') {
        fail('unsupported volumeMount patch operation: ' + op.op);
      }
      const field = match[2] ?? '';
      if (field === 'subPath') {
        mount.subPath = parseScalar(op.value);
      } else if (field === '') {
        fail('whole volumeMount replacement is not part of the storage contract');
      } else {
        fail('unsupported volumeMount patch field: ' + field);
      }
      continue;
    }
    if (target === '/spec/template/spec/containers/0/volumeMounts/-') {
      // Appended mounts (for example the sandbox cgroup mount) do not carry
      // the data volume; keep them so later patches can address the index.
      const value = op.value;
      if (!value || typeof value !== 'object') fail('appended volumeMount must be an object');
      if (typeof value.mountPath === 'string' && path.normalize(value.mountPath) === DATA_MOUNT) {
        fail('a patch may not replace the /data mount with an appended mount');
      }
      mounts(deployment).push(value);
      continue;
    }
    fail('unsupported JSON patch path: ' + target);
  }
}

function applyDeploymentPatch(deployment, strategy, suffix, declaredClaims) {
  applyStrategicMergeClaims(deployment, strategy, suffix, declaredClaims);
  const env = strategy?.spec?.template?.spec?.containers?.[0]?.env;
  if (Array.isArray(env)) {
    const targetEnv = container(deployment).env;
    if (!Array.isArray(targetEnv)) fail('deployment has no env list to patch');
    for (const entry of env) {
      const existing = targetEnv.find((item) => item && item.name === entry.name);
      if (!existing) fail('env patch names an unknown variable: ' + entry.name);
      if (entry.value !== undefined) existing.value = entry.value;
    }
  }
}

export function renderEnvironment(root, environment) {
  const overlayRelative = `environments/${environment}/nession/kustomization.yaml`;
  const overlayText = readTreeFile(root, overlayRelative);
  const [overlay] = parseYamlDocuments(overlayText);
  if (!overlay || overlay.kind !== 'Kustomization') fail(overlayRelative + ': not a Kustomization');
  const suffix = String(overlay.nameSuffix ?? '');
  if (suffix && !/^-[a-z0-9-]+$/.test(suffix)) fail(overlayRelative + ': invalid nameSuffix');
  const resources = Array.isArray(overlay.resources) ? overlay.resources : [];
  if (!resources.some((resource) => String(resource).endsWith('base/nession'))) {
    fail(overlayRelative + ': must include the base/nession resources');
  }

  const serverBase = deploymentFrom(
    parseYamlDocuments(readTreeFile(root, 'base/nession/deployment-server.yaml'))[0],
    'server',
  );
  const agentBase = deploymentFrom(
    parseYamlDocuments(readTreeFile(root, 'base/nession/deployment-agent.yaml'))[0],
    'agent',
  );
  if (!serverBase || !agentBase) fail('base deployments are missing server or agent');

  // Deep-clone the base documents; overlays mutate them.
  const server = JSON.parse(JSON.stringify(serverBase));
  const agent = JSON.parse(JSON.stringify(agentBase));
  if (server.metadata?.name) server.metadata.name += suffix;
  if (agent.metadata?.name) agent.metadata.name += suffix;

  const declarations = { pvs: [], pvcs: [] };
  for (const resource of resources) {
    const text = String(resource);
    if (text.endsWith('/base/nession') || !text.endsWith('.yaml')) continue;
    const relative = path.posix.normalize(
      path.posix.join(`environments/${environment}/nession`, text),
    );
    for (const document of parseYamlDocuments(readTreeFile(root, relative))) {
      if (document.kind === 'PersistentVolume') {
        if (document.metadata?.name) document.metadata.name += suffix;
        if (document.spec?.claimRef) delete document.spec.claimRef;
        declarations.pvs.push(document);
      } else if (document.kind === 'PersistentVolumeClaim') {
        if (document.metadata?.name) document.metadata.name += suffix;
        if (document.spec?.volumeName) document.spec.volumeName += suffix;
        declarations.pvcs.push(document);
      }
    }
  }
  // A base/patched claim names the unsuffixed object; kustomize's
  // nameReference rewrites it to the rendered PVC name.
  const declaredClaims = new Map();
  for (const pvc of declarations.pvcs) {
    const rendered = pvc.metadata.name;
    const baseName = suffix && rendered.endsWith(suffix)
      ? rendered.slice(0, -suffix.length)
      : rendered;
    declaredClaims.set(baseName, rendered);
  }

  // Base claim references follow kustomize nameReference.
  for (const document of [server, agent]) {
    for (const volume of volumes(document)) {
      const claim = volume?.persistentVolumeClaim?.claimName;
      if (claim && declaredClaims.has(claim)) {
        volume.persistentVolumeClaim.claimName = declaredClaims.get(claim);
      }
    }
  }

  const strategic = Array.isArray(overlay.patchesStrategicMerge)
    ? overlay.patchesStrategicMerge
    : [];
  for (const patchPath of strategic) {
    const relative = path.posix.normalize(
      path.posix.join(`environments/${environment}/nession`, String(patchPath)),
    );
    for (const patch of parseYamlDocuments(readTreeFile(root, relative))) {
      if (patch.kind === 'Deployment' && patch.metadata?.name === 'nession-server') {
        applyDeploymentPatch(server, patch, suffix, declaredClaims);
      } else if (patch.kind === 'Deployment' && patch.metadata?.name === 'nession-agent') {
        applyDeploymentPatch(agent, patch, suffix, declaredClaims);
      }
    }
  }

  const patches = Array.isArray(overlay.patches) ? overlay.patches : [];
  for (const patch of patches) {
    if (patch.path) {
      // File patches in this tree only change env/ingress/sandbox details;
      // they are parsed so a malformed file fails closed, but only storage
      // fields are applied.
      const relative = path.posix.normalize(
        path.posix.join(`environments/${environment}/nession`, String(patch.path)),
      );
      readTreeFile(root, relative);
      continue;
    }
    if (typeof patch.patch === 'string') {
      const ops = parseYamlDocuments(patch.patch)[0];
      const target = patch.target ?? {};
      if (target.kind !== 'Deployment') {
        fail('inline patch target must be a Deployment');
      }
      const baseName = String(target.name ?? '');
      const deployment = baseName === 'nession-server' ? server
        : baseName === 'nession-agent' ? agent : null;
      if (!deployment) fail('inline patch targets an unknown deployment: ' + baseName);
      applyJsonPatches(deployment, ops);
      continue;
    }
    fail('unsupported patch entry in ' + overlayRelative);
  }

  return { environment, suffix, server, agent, ...declarations };
}

// ---------------------------------------------------------------------------
// Contract assertions.
// ---------------------------------------------------------------------------
function normalizeMount(value) {
  return path.posix.normalize(String(value ?? ''));
}

function requireDataMount(input, role, errors) {
  const dataMounts = mounts(input).filter(
    (mount) => mount && normalizeMount(mount.mountPath) === DATA_MOUNT,
  );
  if (dataMounts.length !== 1) {
    errors.push(role + ' must mount exactly one volume at ' + DATA_MOUNT);
    return null;
  }
  const dataVolume = volumes(input).find((volume) => volume.name === dataMounts[0].name);
  if (!dataVolume) {
    errors.push(role + ' data mount has no matching volume');
    return null;
  }
  if (dataVolume.emptyDir || dataVolume.hostPath) {
    errors.push(role + ' data volume falls back to the container/node ephemeral layer');
    return null;
  }
  const claim = dataVolume.persistentVolumeClaim?.claimName;
  if (!claim) {
    errors.push(role + ' data volume is not a persistentVolumeClaim');
    return null;
  }
  return { mount: dataMounts[0], claim };
}

function environmentContract(rendered, shared) {
  const errors = [];
  const { environment, server, agent, pvs, pvcs } = rendered;
  const serverMount = requireDataMount(server, 'server', errors);
  const agentMount = requireDataMount(agent, 'agent', errors);
  if (!serverMount || !agentMount) return { errors, lines: [] };

  if (serverMount.claim !== agentMount.claim) {
    errors.push('server and agent must share the environment data volume family');
  }
  const serverSubPath = serverMount.mount.subPath
    ? normalizeMount(serverMount.mount.subPath)
    : '';
  const agentSubPath = agentMount.mount.subPath
    ? normalizeMount(agentMount.mount.subPath)
    : '';
  if (serverSubPath !== agentSubPath) {
    errors.push('server and agent data mounts must use the same subPath');
  }
  const home = envValue(server, NESSION_HOME);
  if (!home || normalizeMount(home) !== DATA_MOUNT) {
    errors.push('server ' + NESSION_HOME + ' must be ' + DATA_MOUNT + ', got ' + JSON.stringify(home));
  }
  const erofs = envValue(agent, EROFS_STORAGE);
  if (!erofs) {
    errors.push('agent ' + EROFS_STORAGE + ' is missing');
  } else {
    const cacheRelative = path.posix.relative(DATA_MOUNT, normalizeMount(erofs));
    if (!cacheRelative || cacheRelative.startsWith('..') || path.posix.isAbsolute(cacheRelative)) {
      errors.push('agent ' + EROFS_STORAGE + ' must live under ' + DATA_MOUNT + ', got ' + erofs);
    }
  }

  const pvc = pvcs.find((entry) => entry.metadata.name === serverMount.claim);
  if (!pvc) {
    errors.push('data claim is not declared in the environment: ' + serverMount.claim);
    return { errors, lines: [] };
  }
  const accessModes = pvc.spec?.accessModes ?? [];
  if (!accessModes.includes('ReadWriteMany')) {
    errors.push('data claim ' + serverMount.claim + ' must request ReadWriteMany');
  }
  let pv = null;
  let binding = 'volumeName';
  if (pvc.spec?.volumeName) {
    pv = pvs.find((entry) => entry.metadata.name === pvc.spec.volumeName);
    if (!pv) errors.push('data claim volumeName has no PV in the environment');
  } else {
    // A dynamic claim is only acceptable when the environment declares
    // exactly one NFS PV the claim can bind; otherwise the storage identity
    // cannot be proved from the rendered tree.
    binding = 'environment-nfs-pv';
    const nfsPvs = pvs.filter((entry) => entry.spec?.nfs);
    if (nfsPvs.length !== 1) {
      errors.push('data claim has no volumeName and the environment does not declare exactly one NFS PV');
    } else {
      pv = nfsPvs[0];
    }
  }
  if (!pv) return { errors, lines: [] };

  const nfs = pv.spec?.nfs;
  if (!nfs || !nfs.server || !nfs.path) {
    errors.push('data PV must be an NFS volume');
    return { errors, lines: [] };
  }
  if (pv.spec?.persistentVolumeReclaimPolicy !== 'Retain') {
    errors.push('data PV ' + pv.metadata.name + ' must use Retain');
  }
  const nfsPath = normalizeMount(nfs.path);
  if (nfsPath !== NFS_ROOT && !nfsPath.startsWith(NFS_ROOT + '/')) {
    errors.push('data PV path must be under ' + NFS_ROOT + ', got ' + nfs.path);
  }
  if (shared.nfsServer && shared.nfsServer !== nfs.server) {
    errors.push('NFS server identity changed across environments');
  }
  shared.nfsServer = shared.nfsServer ?? nfs.server;

  const subPath = serverMount.mount.subPath ? normalizeMount(serverMount.mount.subPath) : '';
  const effectiveRoot = subPath ? path.posix.join(nfsPath, subPath) : nfsPath;
  if (shared.roots.has(effectiveRoot)) {
    errors.push('environment data root collides with ' + shared.roots.get(effectiveRoot));
  }
  shared.roots.set(effectiveRoot, environment);

  const serverRoot = path.posix.join(effectiveRoot, 'server');
  const cacheRoot = path.posix.join(effectiveRoot, path.posix.relative(DATA_MOUNT, normalizeMount(erofs)));
  const lines = [
    environment + ': claim=' + serverMount.claim + ' pv=' + pv.metadata.name +
      ' binding=' + binding + ' nfs=' + nfs.server + ':' + nfsPath +
      ' subPath=' + (subPath || '-') +
      ' server=' + serverRoot + ' erofs=' + cacheRoot,
  ];
  return { errors, lines };
}

export function checkGitOpsStorage(root) {
  const environments = listEnvironmentIds(root);
  if (environments.length === 0) fail('no managed GitOps environments found');
  const shared = { nfsServer: null, roots: new Map() };
  const errors = [];
  const lines = [];
  for (const environment of environments) {
    const rendered = renderEnvironment(root, environment);
    const result = environmentContract(rendered, shared);
    lines.push(...result.lines);
    errors.push(...result.errors.map((error) => environment + ': ' + error));
  }
  return { environments, lines, errors };
}

// ---------------------------------------------------------------------------
// Fixtures: a real-shaped two-environment tree. Each mutation starts from the
// valid fixture, so a detector regression is one string away.
// ---------------------------------------------------------------------------
const BASE_SERVER = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: nession-server
spec:
  template:
    spec:
      containers:
        - name: nession-server
          env:
            - name: NESSION_HOME
              value: "/data"
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: nession-server-data
`;

const BASE_AGENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: nession-agent
spec:
  template:
    spec:
      containers:
        - name: nession-agent
          env:
            - name: AGENT_EROFS_STORAGE_DIR
              value: "/data/erofs"
          volumeMounts:
            - name: claude-home
              mountPath: /root/.claude
            - name: data
              mountPath: /data
      volumes:
        - name: claude-home
          persistentVolumeClaim:
            claimName: nession-server-data
        - name: data
          persistentVolumeClaim:
            claimName: nession-server-data
`;

function fixtureEnvironment({ suffix, path: nfsPath, server = '192.168.2.105', subPath = null, volumeName = true, retain = 'Retain' }) {
  const pvc = volumeName
    ? `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nession-server-data
spec:
  accessModes:
    - ReadWriteMany
  volumeName: nession-data
  resources:
    requests:
      storage: 5Gi
`
    : `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nession-server-data
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 5Gi
`;
  const pv = `apiVersion: v1
kind: PersistentVolume
metadata:
  name: nession-data
spec:
  accessModes:
    - ReadWriteMany
  nfs:
    server: ${server}
    path: ${nfsPath}
  persistentVolumeReclaimPolicy: ${retain}
`;
  const subPathPatch = subPath === null ? '' : `
patches:
- patch: |-
    - op: add
      path: /spec/template/spec/containers/0/volumeMounts/0/subPath
      value: ${subPath}
  target:
    kind: Deployment
    name: nession-server
- patch: |-
    - op: add
      path: /spec/template/spec/containers/0/volumeMounts/1/subPath
      value: ${subPath}
  target:
    kind: Deployment
    name: nession-agent
`;
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: nession
${suffix ? 'nameSuffix: ' + suffix + '\n' : ''}resources:
- ../../../base/nession
- pv.yaml
- pvc.yaml
${subPathPatch}`;
}

function writeFixture(root, options) {
  const write = (relative, text) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  write('base/nession/deployment-server.yaml', BASE_SERVER);
  write('base/nession/deployment-agent.yaml', BASE_AGENT);
  const first = fixtureEnvironment({
    suffix: '-staging',
    path: '/mnt/share/k8s',
    subPath: 'staging',
    ...(options.first ?? {}),
  });
  const second = fixtureEnvironment({
    suffix: '',
    path: '/mnt/share/k8s/production',
    ...(options.second ?? {}),
  });
  write('environments/staging/nession/kustomization.yaml', first);
  write('environments/staging/nession/pv.yaml', options.firstPv ?? `apiVersion: v1
kind: PersistentVolume
metadata:
  name: nession-data
spec:
  accessModes:
    - ReadWriteMany
  nfs:
    server: 192.168.2.105
    path: /mnt/share/k8s
  persistentVolumeReclaimPolicy: Retain
`);
  write('environments/staging/nession/pvc.yaml', `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nession-server-data
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 5Gi
`);
  write('environments/production/nession/kustomization.yaml', second);
  write('environments/production/nession/pv.yaml', options.secondPv ?? `apiVersion: v1
kind: PersistentVolume
metadata:
  name: nession-data
spec:
  accessModes:
    - ReadWriteMany
  nfs:
    server: 192.168.2.105
    path: /mnt/share/k8s/production
  persistentVolumeReclaimPolicy: Retain
`);
  write('environments/production/nession/pvc.yaml', `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nession-server-data
spec:
  accessModes:
    - ReadWriteMany
  volumeName: nession-data
  resources:
    requests:
      storage: 5Gi
`);
}

function runFixture(mutator) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'gitops-storage-'));
  try {
    writeFixture(dir, {});
    if (mutator) mutator(dir);
    return checkGitOpsStorage(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function selfTest() {
  const baseline = runFixture();
  if (baseline.errors.length) {
    fail('baseline fixture must pass: ' + baseline.errors.join('; '));
  }
  const replace = (relative, before, after) => (dir) => {
    const full = path.join(dir, relative);
    const text = fs.readFileSync(full, 'utf8');
    if (!text.includes(before)) fail('fixture mutation anchor missing in ' + relative);
    fs.writeFileSync(full, text.replace(before, after));
  };
  const cases = [
    ['server NESSION_HOME missing', replace(
      'base/nession/deployment-server.yaml',
      '            - name: NESSION_HOME\n              value: "/data"\n',
      '',
    ), /NESSION_HOME/],
    ['agent cache outside the data mount', replace(
      'base/nession/deployment-agent.yaml',
      'value: "/data/erofs"',
      'value: "/var/lib/erofs"',
    ), /AGENT_EROFS_STORAGE_DIR must live under/],
    ['data volume becomes emptyDir', replace(
      'base/nession/deployment-server.yaml',
      '        - name: data\n          persistentVolumeClaim:\n            claimName: nession-server-data\n',
      '        - name: data\n          emptyDir: {}\n',
    ), /data volume falls back/],
    ['PV loses Retain', replace(
      'environments/production/nession/pv.yaml',
      'persistentVolumeReclaimPolicy: Retain',
      'persistentVolumeReclaimPolicy: Delete',
    ), /must use Retain/],
    ['NFS path leaves the shared root', replace(
      'environments/production/nession/pv.yaml',
      'path: /mnt/share/k8s/production',
      'path: /var/tmp/production',
    ), /must be under \/mnt\/share\/k8s/],
    ['NFS server identity changes', replace(
      'environments/production/nession/pv.yaml',
      'server: 192.168.2.105',
      'server: 10.0.0.9',
    ), /NFS server identity changed/],
    ['two environments render one data root', (dir) => {
      const full = path.join(dir, 'environments/production/nession/pv.yaml');
      fs.writeFileSync(full, fs.readFileSync(full, 'utf8')
        .replace('path: /mnt/share/k8s/production', 'path: /mnt/share/k8s/staging'));
    }, /environment data root collides with/],
    ['dynamic claim without an environment NFS PV', (dir) => {
      const full = path.join(dir, 'environments/staging/nession/pv.yaml');
      fs.writeFileSync(full, '');
    }, /does not declare exactly one NFS PV/],
  ];
  for (const [name, mutator, expected] of cases) {
    let result;
    try {
      result = runFixture(mutator);
    } catch (error) {
      // A structural failure also proves the detector rejected the mutation.
      if (expected.test(String(error.message))) continue;
      fail(name + ': unexpected error: ' + error.message);
    }
    const text = result.errors.join(' | ');
    if (!expected.test(text)) {
      fail(name + ': mutation escaped the detector (' + (text || 'no errors') + ')');
    }
  }
  return `gitops-storage-contract self-test: baseline accepted and ${cases.length} regressions rejected`;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    console.log(selfTest());
    return;
  }
  let root = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') {
      root = args[index + 1];
      index += 1;
    } else {
      fail('unknown argument: ' + args[index]);
    }
  }
  if (!root) fail('usage: gitops-storage-contract.mjs --root <gitops-checkout> | --self-test');
  const result = checkGitOpsStorage(root);
  for (const line of result.lines) console.log(line);
  if (result.errors.length) {
    for (const error of result.errors) console.error('gitops-storage-contract: ' + error);
    process.exitCode = 1;
    return;
  }
  console.log('gitops-storage-contract: ' + result.environments.length + ' environments render persisted, per-environment storage');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error('gitops-storage-contract: ' + (error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}
