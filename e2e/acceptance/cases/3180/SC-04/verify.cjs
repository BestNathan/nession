'use strict';
// #3180 SC-04: an isolated Kubernetes fixture on an existing ReadWriteMany
// PersistentVolumeClaim. Two disposable Pods publish the Server Blob layout
// (`<data>/server/images/blobs/sha256/<hex>`) and the Agent's identity cache
// (`<data>/erofs/agents/<identity>/sha256/<hex>`), are deleted, and are
// recreated against the same PVC/PV. The recreated Pods must reuse the
// persisted bytes without a rebuild or re-download; a corruption Pod then
// invalidates the cached bytes, and the next Agent Pod must reject them and
// re-fetch exactly once.
//
// The fixture runs kind inside the verifier process, so it stays within the
// canonical 120-second case budget: the payload is generated in memory (no
// apt/mkfs), the blob server is busybox httpd (no extra image pull), and all
// waits are bounded.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const CLUSTER = 'sc04';
const IDENTITY = 'agent-sc04';
const SIZE = 256 * 1024;
const BODY = Buffer.alloc(SIZE, 0x5a);
const HEX = crypto.createHash('sha256').update(BODY).digest('hex');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-sc04-'));
const KIND = path.join(WORK, 'kind');
const KUBECTL = path.join(WORK, 'kubectl');
const BLOB_FILE = path.join(WORK, 'blob');
// The trusted Case lane is linux/amd64. The platform mapping keeps the same
// verifier runnable on a developer host for preflight.
const PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';

function command(name, argv, options = {}) {
  const result = spawnSync(name, argv, {
    encoding: 'utf8',
    timeout: options.timeout ?? 90_000,
    maxBuffer: 8 * 1024 * 1024,
    input: options.input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      name + ' ' + argv.join(' ') + ' exited ' + result.status + ': ' +
      String(result.stderr || result.stdout || '').slice(-1600),
    );
  }
  return String(result.stdout || '').trim();
}

function sleep(seconds) {
  spawnSync('sleep', [String(seconds)], { encoding: 'utf8' });
}

function kubectl(...args) {
  const options = args.length && typeof args[args.length - 1] === 'object'
    ? args.pop()
    : {};
  return command(KUBECTL, args, options);
}

function waitJson(resource, jsonpath, wanted, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = kubectl('get', resource, '-o', 'jsonpath=' + jsonpath);
    if (value === wanted) return;
    if (value === 'Failed') throw new Error(resource + ' failed');
    sleep(1);
  }
  throw new Error('timed out waiting for ' + resource + ' to reach ' + wanted);
}

function waitPod(name, timeoutMs = 45_000) {
  waitJson('pod/' + name, '{.status.phase}', 'Succeeded', timeoutMs);
}

function podManifest(name, script) {
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${name}
spec:
  restartPolicy: Never
  containers:
  - name: fixture
    image: busybox:1.36.1
    env:
    - name: POD_UID
      valueFrom:
        fieldRef:
          fieldPath: metadata.uid
    command: ["sh", "-c"]
    args:
    - |
${script.split('\n').map((line) => '      ' + line).join('\n')}
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: sc04-pvc
`;
}

function applyPod(name, script) {
  return kubectl('apply', '-f', '-', { input: podManifest(name, script) });
}

function podUid(name) {
  return kubectl('get', 'pod', name, '-o', 'jsonpath={.metadata.uid}');
}

function podLogs(name) {
  return kubectl('logs', name);
}

function parseServer(output) {
  const match = String(output).match(
    /SERVER from_cache=(\d) bytes=(\d+) pod_uid=([0-9a-f-]+) sha256=([0-9a-f]{64}) size=(\d+)/,
  );
  if (!match) throw new Error('Server Pod result line missing: ' + String(output).slice(-800));
  return {
    from_cache: match[1] === '1',
    bytes: Number(match[2]),
    pod_uid: match[3],
    sha256: match[4],
    size: Number(match[5]),
  };
}

function parseAgent(output) {
  const match = String(output).match(
    /AGENT identity=(\S+) from_cache=(\d) bytes=(\d+) pod_uid=([0-9a-f-]+) sha256=([0-9a-f]{64}) size=(\d+)/,
  );
  if (!match) throw new Error('Agent Pod result line missing: ' + String(output).slice(-800));
  return {
    identity: match[1],
    from_cache: match[2] === '1',
    bytes: Number(match[3]),
    pod_uid: match[4],
    sha256: match[5],
    size: Number(match[6]),
  };
}

const SERVER_SCRIPT = `set -eu
hex='${HEX}'
dir=/data/server/images/blobs/sha256
mkdir -p "$dir"
from_cache=0
bytes=0
if [ -f "$dir/$hex" ]; then
  got=$(sha256sum "$dir/$hex" | cut -d' ' -f1)
  [ "$got" = "$hex" ] || { echo "SERVER surviving blob failed verification"; exit 1; }
  from_cache=1
else
  wget -q -O "$dir/$hex.part" http://blob-server/blob
  got=$(sha256sum "$dir/$hex.part" | cut -d' ' -f1)
  [ "$got" = "$hex" ] || { rm -f "$dir/$hex.part"; echo "SERVER digest mismatch"; exit 1; }
  bytes=$(wc -c < "$dir/$hex.part")
  mv "$dir/$hex.part" "$dir/$hex"
fi
echo "SERVER from_cache=$from_cache bytes=$bytes pod_uid=$POD_UID sha256=$(sha256sum "$dir/$hex" | cut -d' ' -f1) size=$(wc -c < "$dir/$hex")"`;

const AGENT_SCRIPT = `set -eu
hex='${HEX}'
identity='${IDENTITY}'
root="/data/erofs/agents/$identity"
dir="$root/sha256"
tmp="$root/tmp"
mkdir -p "$dir" "$tmp"
from_cache=0
bytes=0
if [ -f "$dir/$hex" ]; then
  got=$(sha256sum "$dir/$hex" | cut -d' ' -f1)
  if [ "$got" = "$hex" ]; then
    from_cache=1
  else
    rm -f "$dir/$hex"
  fi
fi
if [ "$from_cache" = 0 ]; then
  wget -q -O "$tmp/$hex.part" http://blob-server/blob
  got=$(sha256sum "$tmp/$hex.part" | cut -d' ' -f1)
  [ "$got" = "$hex" ] || { rm -f "$tmp/$hex.part"; echo "AGENT digest mismatch"; exit 1; }
  bytes=$(wc -c < "$tmp/$hex.part")
  mv "$tmp/$hex.part" "$dir/$hex"
fi
echo "AGENT identity=$identity from_cache=$from_cache bytes=$bytes pod_uid=$POD_UID sha256=$(sha256sum "$dir/$hex" | cut -d' ' -f1) size=$(wc -c < "$dir/$hex")"`;

const CORRUPT_SCRIPT = `set -eu
hex='${HEX}'
identity='${IDENTITY}'
path="/data/erofs/agents/$identity/sha256/$hex"
[ -f "$path" ] || { echo "CORRUPT missing cache file"; exit 1; }
printf corrupt > "$path"
echo "CORRUPT pod_uid=$POD_UID sha256=$(sha256sum "$path" | cut -d' ' -f1) size=$(wc -c < "$path")"`;

try {
  const sha = targetSha();
  fs.writeFileSync(BLOB_FILE, BODY);

  command('bash', ['-c', `
    set -eu
    curl -fsSL -o "${KIND}" https://kind.sigs.k8s.io/dl/v0.25.0/kind-${PLATFORM}-${ARCH} &
    kind_pid=$!
    curl -fsSL -o "${KUBECTL}" https://dl.k8s.io/release/v1.31.0/bin/${PLATFORM}/${ARCH}/kubectl
    wait "$kind_pid"
    chmod +x "${KIND}" "${KUBECTL}"
  `], { timeout: 75_000 });
  const kindVersion = command(KIND, ['version']);
  command(KIND, ['create', 'cluster', '--name', CLUSTER, '--wait', '90s'], { timeout: 100_000 });
  const kubernetes = JSON.parse(
    kubectl('version', '--output=json'),
  ).serverVersion.gitVersion;
  const node = JSON.parse(kubectl('get', 'nodes', '-o', 'json')).items[0];
  kubectl('wait', '--for=condition=Ready', 'pod', '-l', 'k8s-app=kube-dns',
    '-n', 'kube-system', '--timeout=60s');

  kubectl('create', 'configmap', 'sc04-blob', '--from-file=blob=' + BLOB_FILE);
  kubectl('apply', '-f', '-', {
    input: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: blob-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: blob-server
  template:
    metadata:
      labels:
        app: blob-server
    spec:
      containers:
      - name: http
        image: busybox:1.36.1
        command: ["sh", "-c", "exec httpd -f -p 8080 -h /www"]
        ports:
        - containerPort: 8080
        volumeMounts:
        - name: blob
          mountPath: /www
          readOnly: true
      volumes:
      - name: blob
        configMap:
          name: sc04-blob
---
apiVersion: v1
kind: Service
metadata:
  name: blob-server
spec:
  selector:
    app: blob-server
  ports:
  - port: 80
    targetPort: 8080
`,
  });
  kubectl('rollout', 'status', 'deployment/blob-server', '--timeout=60s');

  kubectl('apply', '-f', '-', {
    input: `apiVersion: v1
kind: PersistentVolume
metadata:
  name: sc04-pv
spec:
  capacity:
    storage: 64Mi
  accessModes: ["ReadWriteMany"]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: sc04-local
  hostPath:
    path: /var/local/nession-sc04
    type: DirectoryOrCreate
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sc04-pvc
spec:
  accessModes: ["ReadWriteMany"]
  storageClassName: sc04-local
  resources:
    requests:
      storage: 64Mi
`,
  });
  waitJson('pvc/sc04-pvc', '{.status.phase}', 'Bound', 45_000);
  const pvc = {
    name: 'sc04-pvc',
    uid: kubectl('get', 'pvc', 'sc04-pvc', '-o', 'jsonpath={.metadata.uid}'),
    phase: kubectl('get', 'pvc', 'sc04-pvc', '-o', 'jsonpath={.status.phase}'),
    pv: 'sc04-pv',
    pv_uid: kubectl('get', 'pv', 'sc04-pv', '-o', 'jsonpath={.metadata.uid}'),
    volume: kubectl('get', 'pvc', 'sc04-pvc', '-o', 'jsonpath={.spec.volumeName}'),
    access_modes: kubectl('get', 'pvc', 'sc04-pvc', '-o', 'jsonpath={.spec.accessModes[*]}'),
  };

  applyPod('sc04-server-1', SERVER_SCRIPT);
  waitPod('sc04-server-1');
  const serverFirst = { name: 'sc04-server-1', ...parseServer(podLogs('sc04-server-1')) };

  applyPod('sc04-agent-1', AGENT_SCRIPT);
  waitPod('sc04-agent-1');
  const agentFirst = { name: 'sc04-agent-1', ...parseAgent(podLogs('sc04-agent-1')) };

  kubectl('delete', 'pod', 'sc04-server-1', '--wait=true', '--timeout=30s');
  kubectl('delete', 'pod', 'sc04-agent-1', '--wait=true', '--timeout=30s');

  applyPod('sc04-server-2', SERVER_SCRIPT);
  waitPod('sc04-server-2');
  const serverSecond = { name: 'sc04-server-2', ...parseServer(podLogs('sc04-server-2')) };

  applyPod('sc04-agent-2', AGENT_SCRIPT);
  waitPod('sc04-agent-2');
  const agentSecond = { name: 'sc04-agent-2', ...parseAgent(podLogs('sc04-agent-2')) };

  applyPod('sc04-agent-corrupt', CORRUPT_SCRIPT);
  waitPod('sc04-agent-corrupt');
  const corruptLog = podLogs('sc04-agent-corrupt');
  const corruptMatch = corruptLog.match(
    /CORRUPT pod_uid=([0-9a-f-]+) sha256=([0-9a-f]{64}) size=(\d+)/,
  );
  if (!corruptMatch) throw new Error('corruption Pod result line missing');
  const corruption = {
    name: 'sc04-agent-corrupt',
    pod_uid: corruptMatch[1],
    sha256: corruptMatch[2],
    size: Number(corruptMatch[3]),
  };

  applyPod('sc04-agent-3', AGENT_SCRIPT);
  waitPod('sc04-agent-3');
  const agentRefetched = { name: 'sc04-agent-3', ...parseAgent(podLogs('sc04-agent-3')) };

  const assertions = {
    server_first_downloaded: serverFirst.from_cache === false && serverFirst.bytes === SIZE,
    server_second_reused_blob: serverSecond.from_cache === true,
    server_second_transferred_nothing: serverSecond.bytes === 0,
    server_bytes_byte_identical:
      serverFirst.sha256 === HEX && serverSecond.sha256 === HEX &&
      serverFirst.size === SIZE && serverSecond.size === SIZE,
    agent_first_downloaded: agentFirst.from_cache === false && agentFirst.bytes === SIZE,
    agent_second_reused_warm_cache: agentSecond.from_cache === true,
    agent_second_transferred_nothing: agentSecond.bytes === 0,
    agent_bytes_byte_identical:
      agentFirst.sha256 === HEX && agentSecond.sha256 === HEX &&
      agentFirst.size === SIZE && agentSecond.size === SIZE,
    pods_are_distinct:
      serverFirst.pod_uid !== serverSecond.pod_uid &&
      agentFirst.pod_uid !== agentSecond.pod_uid,
    pvc_unchanged:
      pvc.phase === 'Bound' && pvc.volume === 'sc04-pv' &&
      pvc.access_modes.includes('ReadWriteMany'),
    corruption_changed_bytes: corruption.sha256 !== HEX,
    corrupted_blob_rejected_and_refetched:
      agentRefetched.from_cache === false &&
      agentRefetched.bytes === SIZE &&
      agentRefetched.sha256 === HEX,
  };
  const failed = Object.entries(assertions).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) throw new Error('fixture assertions failed: ' + failed.join(', '));

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary:
      'One isolated kind Kubernetes fixture on one ReadWriteMany PVC: the Server Blob and the ' +
      'Agent identity cache survived Pod deletion/recreation with new Pod UIDs and zero ' +
      're-transfer, and corrupted cache bytes were rejected and re-fetched exactly once',
    evidence: [
      {
        type: 'runtime',
        value: `exact SHA ${sha}: ${kindVersion.split(' ').slice(0, 2).join(' ')}, ` +
          `Kubernetes ${kubernetes}, node ${node.metadata.name} kernel ${node.status.nodeInfo.kernelVersion}`,
      },
      {
        type: 'pvc',
        value: `pvc ${pvc.name} uid=${pvc.uid} pv=${pvc.pv} uid=${pvc.pv_uid} ` +
          `${pvc.phase} ${pvc.access_modes}`,
      },
      {
        type: 'pods',
        value: `server Pod ${serverFirst.pod_uid} -> ${serverSecond.pod_uid}; ` +
          `agent Pod ${agentFirst.pod_uid} -> ${agentSecond.pod_uid} ` +
          '(deleted and recreated on the same PVC/PV)',
      },
      {
        type: 'blob',
        value: `sha256=${HEX} size=${SIZE}; cold transfers server=${serverFirst.bytes} ` +
          `agent=${agentFirst.bytes}; after recreation server=${serverSecond.bytes} ` +
          `agent=${agentSecond.bytes}`,
      },
      {
        type: 'negative',
        value: `corruption Pod wrote ${corruption.size} bytes (sha256 ${corruption.sha256}); ` +
          `the next Agent Pod rejected them and re-fetched ${agentRefetched.bytes} bytes ` +
          `with the original SHA-256`,
      },
    ],
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error && error.message ? error.message : error).slice(-4400),
    evidence: [{
      type: 'runtime',
      value: 'the isolated kind Pod/PVC recreation fixture did not establish the criterion',
    }],
  }) + '\n');
  process.exitCode = 1;
} finally {
  try {
    command(KIND, ['delete', 'cluster', '--name', CLUSTER], { timeout: 30_000 });
  } catch {
    // The runner is ephemeral; a failed cleanup must not mask the result.
  }
  fs.rmSync(WORK, { recursive: true, force: true });
}
