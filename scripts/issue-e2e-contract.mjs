// E2E Verification is an Issue-owned per-change test selection, not a code impact graph.
// Scope is limited to the stable file IDs of e2e/tests/**/*.spec.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Shared evidence grammar for Issue audit, planning, projection and Acceptance.
// Pending has no run identity: prose is not an authenticated receipt.
const RECEIPT = /^run ([1-9]\d*)\/([1-9]\d*), SHA ([a-f0-9]{40}), contract ([a-f0-9]{64}), plan ([a-f0-9]{64}), tests (\d+)\/(\d+) \(https:\/\/github\.com\/BestNathan\/nession\/actions\/runs\/([1-9]\d*)\)$/;
export function parseE2EEvidence(row, contractDigest) {
  if (row?.result === 'Pending') {
    if (row.evidence !== '-') throw Error('Pending E2E evidence must be exactly "-"');
    return null;
  }
  if (!['Pass','Fail','Error'].includes(row?.result) ||
      !/^[a-f0-9]{64}$/.test(contractDigest)) throw Error('invalid E2E evidence identity');
  const match = row.evidence?.match(RECEIPT);
  if (!match || match[1] !== match[8] || match[4] !== contractDigest)
    throw Error('Issue E2E Report contains unauthenticated or mismatched evidence');
  const result = {run:Number(match[1]),attempt:Number(match[2]),sha:match[3],
    contract:match[4],plan:match[5],passed:Number(match[6]),discovered:Number(match[7])};
  if (!Number.isSafeInteger(result.run)||!Number.isSafeInteger(result.attempt)||
      !Number.isSafeInteger(result.passed)||!Number.isSafeInteger(result.discovered)||
      result.discovered<1||result.passed>result.discovered||
      (row.result==='Pass'&&result.passed!==result.discovered))
    throw Error('invalid E2E evidence counters or source identity');
  return result;
}
function visibleLines(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  let fence = null;
  return lines.map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const token = marker[1];
      if (!fence) fence = { char: token[0], length: token.length };
      else if (token[0] === fence.char && token.length >= fence.length) fence = null;
      return '';
    }
    return fence ? '' : line;
  });
}
function block(body, heading) {
  const lines = visibleLines(body);
  const begin = lines.findIndex(line => line.trim() === '## ' + heading);
  if (begin < 0) return null;
  let end = lines.findIndex((line, i) => i > begin && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  return lines.slice(begin + 1, end).join('\n');
}
function list(section, heading, errors) {
  const lines = section.split('\n');
  const begin = lines.findIndex(line => line.trim() === '### ' + heading);
  if (begin < 0) { errors.push('E2E Verification missing ### ' + heading); return { ids: [], none: null }; }
  let end = lines.findIndex((line, i) => i > begin && /^###?\s/.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(begin + 1, end).map(line => line.trim()).filter(Boolean);
  const ids = [], known = new Set();
  let none = null;
  for (const row of body) {
    if (row.startsWith('- none:')) {
      const reason = row.slice('- none:'.length).trim();
      if (!reason || none !== null) errors.push(heading + ' none requires one nonempty justification');
      none = reason || '';
      continue;
    }
    const m = row.match(/^-\s+([a-zA-Z0-9_-]+)$/);
    if (!m || !ID.test(m[1])) { errors.push(heading + ' invalid E2E ID line: ' + row); continue; }
    if (known.has(m[1])) errors.push(heading + ' duplicate E2E ID: ' + m[1]);
    known.add(m[1]); ids.push(m[1]);
  }
  if (none !== null && ids.length) errors.push(heading + ' cannot combine none with IDs');
  if (none === null && !ids.length) errors.push(heading + ' must declare IDs or justified none');
  return { ids, none };
}
function reportRows(body, errors) {
  const section = block(body, 'E2E Report');
  if (section === null) { errors.push('missing ## E2E Report'); return new Map(); }
  const lines = section.split('\n').filter(line => line.trim().startsWith('|'));
  const cells = lines.map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  if (!cells.length || cells[0].join('|').toLowerCase() !== 'id|type|result|evidence') {
    errors.push('E2E Report requires ID / Type / Result / Evidence table');
    return new Map();
  }
  const rows = new Map();
  for (const row of cells.slice(1)) {
    if (row.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    if (row.length !== 4 || !ID.test(row[0])) { errors.push('invalid E2E Report row'); continue; }
    if (rows.has(row[0])) errors.push('duplicate E2E Report ID: ' + row[0]);
    if (!['New', 'Regression'].includes(row[1])) errors.push('invalid E2E Report Type for ' + row[0]);
    if (!['Pending', 'Pass', 'Fail', 'Error'].includes(row[2])) errors.push('invalid E2E Report Result for ' + row[0]);
    if (!row[3]) errors.push('missing E2E Report Evidence for ' + row[0]);
    rows.set(row[0], { type: row[1], result: row[2], evidence: row[3] });
  }
  return rows;
}

export function parseIssueE2E(body, { requireDeclaration = false } = {}) {
  const section = block(body, 'E2E Verification');
  if (section === null && block(body, 'E2E Report') === null && !requireDeclaration) return null;
  const errors = [];
  if (section === null) return { errors: ['missing ## E2E Verification'], newIds: [], regressionIds: [], selectedIds: [], digest: null };
  const news = list(section, 'New', errors), regressions = list(section, 'Regression', errors);
  const newSet = new Set(news.ids);
  for (const id of regressions.ids) if (newSet.has(id)) errors.push('E2E ID cannot be New and Regression: ' + id);
  const selectedIds = [...new Set([...news.ids, ...regressions.ids])].sort();
  const rows = reportRows(body, errors);
  const declared = new Map([...news.ids.map(id => [id, 'New']), ...regressions.ids.map(id => [id, 'Regression'])]);
  for (const [id, type] of declared) {
    if (!rows.has(id)) errors.push('missing E2E Report row: ' + id);
    else if (rows.get(id).type !== type) errors.push('E2E Report Type mismatch for ' + id);
  }
  for (const id of rows.keys()) if (!declared.has(id)) errors.push('unrequired E2E Report ID: ' + id);
  const normalized = { newIds: [...news.ids].sort(), regressionIds: [...regressions.ids].sort(), newNone: news.none, regressionNone: regressions.none };
  // Result/Evidence must not change required set identity.
  const digest = createHash('sha256').update(JSON.stringify({ version: 1, ...normalized })).digest('hex');
  // Detect noncanonical Pending and forged receipts at Issue Audit / PR selection,
  // not only after tests succeed and the privileged writer tries to project.
  for (const [id,row] of rows) {
    try { parseE2EEvidence(row,digest); }
    catch (error) { errors.push(id+': '+error.message); }
  }
  return { ...normalized, selectedIds, rows, digest, errors };
}

export function verifyIssueE2EAgainstCatalog(declaration, headIds, baseIds) {
  if (!declaration || declaration.errors.length) throw new Error('missing or invalid Issue E2E declaration');
  const head = new Set(headIds), base = new Set(baseIds);
  for (const id of declaration.newIds) {
    if (!head.has(id) || base.has(id)) throw new Error('New E2E ID is not newly created at target SHA: ' + id);
  }
  for (const id of declaration.regressionIds) {
    if (!head.has(id) || !base.has(id)) throw new Error('Regression E2E ID missing from base/head: ' + id);
  }
  return declaration.selectedIds;
}

function selfTest() {
  const body = [
    '## E2E Verification', '### New', '- terminal-reconnect', '### Regression', '- terminal-attach',
    '## E2E Report', '| ID | Type | Result | Evidence |', '|---|---|---|---|',
    '| terminal-reconnect | New | Pending | - |', '| terminal-attach | Regression | Pending | - |',
  ].join('\n');
  const good = parseIssueE2E(body);
  assert.deepEqual(good.errors, []);
  assert.deepEqual(verifyIssueE2EAgainstCatalog(good, ['terminal-reconnect','terminal-attach'], ['terminal-attach']), ['terminal-attach', 'terminal-reconnect']);
  const proof='run 1/1, SHA '+'a'.repeat(40)+', contract '+good.digest+', plan '+'b'.repeat(64)+', tests 1/1 (https://github.com/BestNathan/nession/actions/runs/1)';
  assert.equal(parseIssueE2E(body.replace('| Pending | - |', '| Pass | '+proof+' |')).digest, good.digest);
  assert.equal(parseIssueE2E('old issue'), null);
  assert.equal(parseIssueE2E('```markdown\n## E2E Verification\n### New\n- fake\n## E2E Report\n```'), null);
  assert.match(parseIssueE2E('old issue', { requireDeclaration: true }).errors.join(','), /missing/);
  for (const [bad, expected] of [
    [body.replace('- terminal-attach', '- terminal-reconnect'), /cannot be New and Regression/],
    [body.replace('- terminal-attach', '- ../escape'), /invalid E2E ID/],
    [body.replace('### Regression\n- terminal-attach', '### Regression\n'), /must declare IDs/],
    [body.replace('| terminal-attach | Regression | Pending | - |', ''), /missing E2E Report row/],
    [body.replace('| terminal-attach | Regression | Pending | - |', '| stale | Regression | Pass | forged |'), /unrequired/],
  ]) assert.match(parseIssueE2E(bad).errors.join(','), expected);
  assert.throws(() => verifyIssueE2EAgainstCatalog(good, ['terminal-attach'], ['terminal-attach']), /New E2E/);
  assert.throws(() => verifyIssueE2EAgainstCatalog(good, ['terminal-reconnect', 'terminal-attach'], []), /Regression E2E/);
  assert.match(parseIssueE2E(body.replace('| Pending | - |','| Pending | Waiting for test ingest |')).errors.join('; '),/Pending E2E evidence must/);
  assert.match(parseIssueE2E(body.replace('| Pending | - |','| Pass | forged |')).errors.join('; '),/unauthenticated/);
  assert.match(parseIssueE2E(body.replace('| Pending | - |','| Fail | - |')).errors.join('; '),/unauthenticated/);
  assert.equal(parseE2EEvidence({result:'Pass',evidence:proof},good.digest).run,1);
  assert.throws(()=>parseE2EEvidence({result:'Pass',evidence:proof.replace('tests 1/1','tests 0/1')},good.digest),/invalid E2E evidence counters/);
  const none = parseIssueE2E([
    '## E2E Verification', '### New', '- none: no new browser behavior', '### Regression',
    '- none: documentation only', '## E2E Report', '| ID | Type | Result | Evidence |',
    '|---|---|---|---|',
  ].join('\n'));
  assert.deepEqual(none.errors, []); assert.deepEqual(none.selectedIds, []);
  console.log('Issue E2E contract: valid, legacy, none, duplicates, stale/forged and catalog negative fixtures passed');
}

if (process.argv[2] === 'self-test') selfTest();
