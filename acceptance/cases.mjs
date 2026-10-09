import fs from 'node:fs';
import path from 'node:path';

export const CASE_SCHEMA_VERSION = 1;
export const CASE_STAGES = new Set(['pre-merge', 'staging', 'post-merge']);
export const CASE_RUNTIMES = new Set(['full-stack-local']);
export const VERIFIER_TYPES = new Set(['browser', 'protocol', 'runtime']);
export const RESULT_POLICIES = new Set(['all-pass']);

function scalar(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  if (/^\d+$/.test(text)) return Number(text);
  return text;
}

export function parseCaseYaml(text, source = 'case.yaml') {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = {};
  let inVerifiers = false;
  let current = null;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (raw.includes('\t')) throw new Error(source + ':' + (i + 1) + ': tabs are not allowed');

    const top = raw.match(/^([a-z_]+):\s*(.*)$/);
    if (top) {
      inVerifiers = top[1] === 'verifiers';
      current = null;
      if (inVerifiers) {
        if (top[2].trim()) throw new Error(source + ':' + (i + 1) + ': verifiers must be a block list');
        out.verifiers = [];
      } else {
        out[top[1]] = scalar(top[2]);
      }
      continue;
    }

    if (inVerifiers) {
      const item = raw.match(/^\s{2}-\s+([a-z_]+):\s*(.+)$/);
      if (item) {
        current = { [item[1]]: scalar(item[2]) };
        out.verifiers.push(current);
        continue;
      }
      const field = raw.match(/^\s{4}([a-z_]+):\s*(.+)$/);
      if (field && current) {
        current[field[1]] = scalar(field[2]);
        continue;
      }
    }

    throw new Error(source + ':' + (i + 1) + ': unsupported case.yaml syntax');
  }
  return out;
}

function canonicalIssue(value) {
  const issue = Number(value);
  if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error('case issue must be a positive integer');
  return issue;
}

function canonicalCriterion(value) {
  const criterion = String(value ?? '').trim().toUpperCase();
  if (!/^SC-\d{2,}$/.test(criterion)) throw new Error('invalid case criterion: ' + (criterion || '(empty)'));
  return criterion;
}

function relativeEntry(value) {
  const entry = String(value ?? '').trim();
  if (!entry) throw new Error('verifier entry is required');
  if (path.isAbsolute(entry) || entry.split(/[\\/]+/).includes('..')) {
    throw new Error('verifier entry must stay inside its Case directory: ' + entry);
  }
  if (entry === '.' || entry.startsWith('./')) throw new Error('verifier entry must use a canonical relative filename');
  return entry.replaceAll('\\', '/');
}

export function validateCaseManifest(raw, caseDir) {
  const allowed = new Set([
    'schema_version',
    'issue',
    'criterion',
    'stage',
    'runtime',
    'verifiers',
    'result_policy',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error('unsupported case manifest field: ' + key);
  }

  if (Number(raw.schema_version) !== CASE_SCHEMA_VERSION) {
    throw new Error('unsupported case schema_version: ' + raw.schema_version);
  }
  const issue = canonicalIssue(raw.issue);
  const criterion = canonicalCriterion(raw.criterion);
  const stage = String(raw.stage ?? '').trim().toLowerCase();
  if (!CASE_STAGES.has(stage)) throw new Error('unsupported case stage: ' + (stage || '(empty)'));
  const runtime = String(raw.runtime ?? '').trim();
  if (!CASE_RUNTIMES.has(runtime)) throw new Error('unsupported runtime profile: ' + (runtime || '(empty)'));
  const resultPolicy = String(raw.result_policy ?? '').trim();
  if (!RESULT_POLICIES.has(resultPolicy)) {
    throw new Error('unsupported result_policy: ' + (resultPolicy || '(empty)'));
  }
  if (!Array.isArray(raw.verifiers) || raw.verifiers.length === 0) {
    throw new Error('case requires at least one verifier');
  }

  const seenEntries = new Set();
  const verifiers = raw.verifiers.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('verifier[' + index + '] must be an object');
    for (const key of Object.keys(item)) {
      if (!['type', 'entry'].includes(key)) throw new Error('unsupported verifier field: ' + key);
    }
    const type = String(item.type ?? '').trim().toLowerCase();
    if (!VERIFIER_TYPES.has(type)) throw new Error('unsupported verifier type: ' + (type || '(empty)'));
    const entry = relativeEntry(item.entry);
    if (seenEntries.has(entry)) throw new Error('duplicate verifier entry: ' + entry);
    seenEntries.add(entry);
    if (caseDir) {
      const full = path.resolve(caseDir, entry);
      const root = path.resolve(caseDir) + path.sep;
      if (!full.startsWith(root) || !fs.existsSync(full) || (fs.lstatSync(full).isSymbolicLink() || !fs.lstatSync(full).isFile())) {
        throw new Error('missing verifier entry: ' + entry);
      }
    }
    return { type, entry };
  });

  if (caseDir) {
    const criterionDir = path.basename(caseDir);
    const issueDir = path.basename(path.dirname(caseDir));
    if (issueDir !== String(issue)) {
      throw new Error('case path issue ' + issueDir + ' does not match manifest issue ' + issue);
    }
    if (criterionDir !== criterion) {
      throw new Error('case path criterion ' + criterionDir + ' does not match manifest criterion ' + criterion);
    }
  }

  return {
    schema_version: CASE_SCHEMA_VERSION,
    issue,
    criterion,
    stage,
    runtime,
    verifiers,
    result_policy: resultPolicy,
  };
}

export function readCase(caseDir) {
  const manifestPath = path.join(caseDir, 'case.yaml');
  if (!fs.existsSync(manifestPath)) throw new Error('missing case.yaml: ' + manifestPath);
  if (fs.lstatSync(manifestPath).isSymbolicLink() || !fs.lstatSync(manifestPath).isFile()) throw new Error('Case manifest must be a real file');
  const raw = parseCaseYaml(fs.readFileSync(manifestPath, 'utf8'), manifestPath);
  return {
    dir: path.resolve(caseDir),
    manifestPath,
    manifest: validateCaseManifest(raw, caseDir),
  };
}

export function discoverCases(casesRoot) {
  const root = path.resolve(casesRoot);
  if (!fs.existsSync(root)) return [];
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Case root symlink forbidden');
  const cases = [];
  const owners = new Set();

  for (const issueName of fs.readdirSync(root).sort()) {
    const issueDir = path.join(root, issueName);
    if (fs.lstatSync(issueDir).isSymbolicLink() || !fs.lstatSync(issueDir).isDirectory()) throw new Error('case registry contains non-directory or symlink: ' + issueName);
    if (!/^\d+$/.test(issueName)) throw new Error('invalid Issue directory in case registry: ' + issueName);

    for (const criterionName of fs.readdirSync(issueDir).sort()) {
      const caseDir = path.join(issueDir, criterionName);
      if (fs.lstatSync(caseDir).isSymbolicLink() || !fs.lstatSync(caseDir).isDirectory()) {
        throw new Error('Issue case registry contains non-directory: ' + issueName + '/' + criterionName);
      }
      if (!/^SC-\d{2,}$/.test(criterionName)) {
        throw new Error('invalid SC directory in case registry: ' + issueName + '/' + criterionName);
      }
      const item = readCase(caseDir);
      const owner = item.manifest.issue + '/' + item.manifest.criterion;
      if (owners.has(owner)) throw new Error('duplicate Case ownership: ' + owner);
      owners.add(owner);
      cases.push(item);
    }
  }
  return cases;
}

export function validateCaseAgainstAcceptanceContext(caseManifest, context) {
  if (caseManifest.issue !== Number(context.issue?.number)) {
    throw new Error('Case issue does not match trusted Acceptance context');
  }
  if (caseManifest.stage !== String(context.stage)) {
    throw new Error(
      caseManifest.criterion + ' Case stage ' + caseManifest.stage +
      ' does not match trusted stage ' + context.stage,
    );
  }
  const criterion = (context.criteria ?? []).find((item) => item.criterion === caseManifest.criterion);
  if (!criterion) {
    throw new Error(
      caseManifest.criterion + ' is absent from trusted ' + context.stage + ' Acceptance contract',
    );
  }
  return criterion;
}

export function aggregateVerifierResults(verifiers, policy = 'all-pass') {
  if (policy !== 'all-pass') throw new Error('unsupported result policy: ' + policy);
  if (!Array.isArray(verifiers) || verifiers.length === 0) return 'Pending';
  if (verifiers.some((item) => item.result === 'Error')) return 'Error';
  if (verifiers.some((item) => item.result === 'Fail')) return 'Fail';
  if (verifiers.some((item) => item.result === 'Pending')) return 'Pending';
  return verifiers.every((item) => item.result === 'Pass') ? 'Pass' : 'Error';
}
