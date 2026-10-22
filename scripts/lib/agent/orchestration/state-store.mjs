import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateDevelopmentState } from './outbox.mjs';

function reject(m) { throw new Error('agent workflow state store: ' + m); }
function bytes(record) { return Buffer.from(JSON.stringify(record, null, 2) + '\n'); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
const LIMIT = 512 * 1024;

export function issueStatePrefix(issue) {
  if (!Number.isSafeInteger(issue) || issue < 1) reject('invalid Issue ID');
  return 'workflows/issues/' + issue;
}
export function issueStatePath(issue, version) {
  if (!Number.isSafeInteger(version) || version < 1) reject('invalid version');
  return issueStatePrefix(issue) + '/states/' + String(version).padStart(8,'0') + '.json';
}
function checkedDirectory(root, relative = '') {
  let dir = path.resolve(root);
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) {
    reject('invalid root');
  }
  for (const part of relative.split('/').filter(Boolean)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(part)) reject('invalid path');
    dir = path.join(dir,part);
    if (fs.existsSync(dir)) {
      if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) reject('unsafe directory');
    } else fs.mkdirSync(dir);
  }
  return dir;
}
function get(root, name) {
  const dir = checkedDirectory(root,path.posix.dirname(name));
  const file = path.join(dir,path.posix.basename(name));
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) reject('invalid store object');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { reject('corrupt stored JSON'); }
}
function putOnce(root, rel, record) {
  const dir = checkedDirectory(root,path.posix.dirname(rel));
  const file = path.join(dir,path.posix.basename(rel));
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() ||
        !fs.readFileSync(file).equals(bytes(record))) reject('immutable state overwrite');
    return;
  }
  fs.writeFileSync(file, bytes(record), { flag:'wx',mode:0o600 });
}
export function readIssueWorkflowState(root, issue) {
  const prefix = issueStatePrefix(issue);
  const head = get(root,prefix+'/head.json');
  if (!head) return { state: null, version: 0, digest: null };
  if (!Number.isSafeInteger(head.version) || head.version < 1 ||
      head.path !== issueStatePath(issue,head.version) ||
      !/^[a-f0-9]{64}$/.test(head.sha256 ?? '')) reject('invalid head');
  const state = get(root,head.path);
  if (!state || state.issue !== issue || state.version !== head.version) reject('head target missing/mismatched');
  validateDevelopmentState(state);
  if (sha256(bytes(state)) !== head.sha256) reject('head digest mismatch');
  return { state,version:head.version,digest:head.sha256 };
}
export function writeIssueWorkflowState(root, state, expectedVersion) {
  validateDevelopmentState(state);
  const current = readIssueWorkflowState(root,state.issue);
  const nextBytes = bytes(state);
  if (nextBytes.byteLength > LIMIT) reject('state exceeds bounded metadata size');
  // Exactly replayed writes are idempotent; a new run cannot overwrite history.
  if (state.version === current.version) {
    if (current.state && nextBytes.equals(bytes(current.state))) {
      return { changed:false,version:current.version,digest:current.digest };
    }
    reject('state version collision');
  }
  if (expectedVersion !== current.version) reject('stale workflow state CAS');
  if (state.version !== current.version+1) reject('noncontiguous workflow state');
  const prefix=issueStatePrefix(state.issue);
  const rel=issueStatePath(state.issue,state.version);
  putOnce(root,rel,state);
  const head={version:state.version,path:rel,sha256:sha256(nextBytes)};
  const dir=checkedDirectory(root,prefix);
  const temp=path.join(dir,'.head-'+state.version+'.json');
  if (fs.existsSync(temp)) {
    if (!fs.lstatSync(temp).isFile() || fs.lstatSync(temp).isSymbolicLink() ||
        !fs.readFileSync(temp).equals(bytes(head))) reject('conflicting pending head');
  } else fs.writeFileSync(temp,bytes(head),{flag:'wx',mode:0o600});
  fs.renameSync(temp,path.join(dir,'head.json'));
  // This local file-store CAS is not a cross-worker lease: the privileged Git
  // writer must serialize and use a non-force fast-forward to the orphan ref.
  return {changed:true,version:state.version,digest:head.sha256};
}
