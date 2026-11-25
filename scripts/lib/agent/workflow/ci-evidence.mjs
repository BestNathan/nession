// Issue #4528 — exact-head CI evidence collection.
//
// The collector receives an already-frozen obligation (policy declarations,
// never derived from observation) and authenticates each required check run
// against its GitHub Run / attempt / Job / steps. An app slug or check name
// alone is not proof: a terminal result is accepted only when the Run belongs
// to this repository, the exact obligation HEAD, the declared workflow path and
// a completed Job of that attempt. Anything unverifiable is `unknown`, and
// anything absent is `missing`; neither is a pass.
import { classifyCiResults } from './ci-barrier.mjs';
import { stableDigest } from './contract.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const CHECK_CONCLUSIONS = new Set([
  'success', 'failure', 'neutral', 'cancelled', 'timed_out', 'skipped',
]);
const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

function reject(message) {
  throw new Error('agent workflow ci-evidence: ' + message);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function parseDetailsUrl(detailsUrl, repository) {
  if (typeof detailsUrl !== 'string' || detailsUrl.length > 500) return null;
  const prefix = 'https://github.com/' + repository + '/actions/runs/';
  if (!detailsUrl.startsWith(prefix)) return null;
  const match = /^([1-9][0-9]*)(?:\/job\/([1-9][0-9]*))?$/.exec(
    detailsUrl.slice(prefix.length));
  if (!match) return null;
  return { run_id: Number(match[1]), job_id: match[2] == null ? null : Number(match[2]) };
}

async function readPaginated(fetchGitHub, endpoint, key, label, maxPages) {
  const items = [];
  let total = null;
  for (let page = 1; page <= maxPages; page++) {
    const response = await fetchGitHub(endpoint + '&page=' + page);
    if (response == null || !Array.isArray(response[key])) {
      reject('invalid ' + label + ' response');
    }
    if (key === 'check_runs') {
      if (!Number.isSafeInteger(response.total_count) || response.total_count < 0) {
        reject('invalid ' + label + ' total');
      }
      if (total == null) total = response.total_count;
      else if (total !== response.total_count) reject(label + ' total changed while paging');
    }
    items.push(...response[key]);
    if (response[key].length < 100) return items;
  }
  if (total != null && total > maxPages * 100) reject(label + ' observation bound exceeded');
  return items;
}

function stepsDigest(steps) {
  if (!Array.isArray(steps)) return null;
  return stableDigest(['agent-workflow-v2-ci-steps', steps.map((step) => [
    String(step?.name ?? '').slice(0, 300),
    typeof step?.conclusion === 'string' ? step.conclusion : null,
  ])]);
}

async function authenticateRun({
  fetchGitHub, repository, declaration, checkRun, head_sha, maxJobPages,
}) {
  const parsed = parseDetailsUrl(checkRun.details_url, repository);
  if (parsed == null) return { conclusion: 'unknown', evidence_ref: null };
  const run = await fetchGitHub('actions/runs/' + parsed.run_id);
  if (run == null || run.id !== parsed.run_id ||
      run.head_sha !== head_sha || run.status !== 'completed' ||
      !positive(run.run_attempt) || !PR_EVENTS.has(run.event)) {
    return { conclusion: 'unknown', evidence_ref: null };
  }
  if (declaration.run_path != null && run.path !== declaration.run_path) {
    return { conclusion: 'unknown', evidence_ref: null };
  }
  if (checkRun.status !== 'completed') return { conclusion: 'pending', evidence_ref: null };
  if (run.conclusion !== checkRun.conclusion) {
    return { conclusion: 'unknown', evidence_ref: null };
  }
  const jobs = await readPaginated(
    fetchGitHub,
    'actions/runs/' + parsed.run_id + '/attempts/' + run.run_attempt +
      '/jobs?per_page=100',
    'jobs', 'jobs', maxJobPages);
  const job = parsed.job_id != null ?
    jobs.find((entry) => entry?.id === parsed.job_id) :
    jobs.find((entry) => entry?.name === declaration.name);
  if (job == null || job.head_sha !== head_sha ||
      job.run_attempt !== run.run_attempt || job.status !== 'completed' ||
      job.conclusion !== checkRun.conclusion) {
    return { conclusion: 'unknown', evidence_ref: null };
  }
  const digest = stepsDigest(job.steps);
  if (digest == null) return { conclusion: 'unknown', evidence_ref: null };
  const evidenceRef = 'run:' + parsed.run_id + '/attempt:' + run.run_attempt +
    '/job:' + job.id + '/steps:' + digest.slice(0, 24);
  if (evidenceRef.length > 500) return { conclusion: 'unknown', evidence_ref: null };
  return { conclusion: checkRun.conclusion, evidence_ref: evidenceRef };
}

function conclusionOf(checkRun) {
  if (checkRun == null) return 'missing';
  if (checkRun.status !== 'completed') return 'pending';
  return CHECK_CONCLUSIONS.has(checkRun.conclusion) ? checkRun.conclusion : 'unknown';
}

// Freeze-then-observe. The obligation HEAD/base must equal the caller's exact
// PR binding; a mismatch is stale evidence, never a smaller observation.
export async function collectExactCheckEvidence({
  fetchGitHub, repository, obligation, head_sha, base_sha = null,
  observed_at, maxCheckRunPages = 3, maxJobPages = 3,
}) {
  if (typeof fetchGitHub !== 'function') reject('GitHub reader required');
  if (!REPO.test(repository ?? '')) reject('invalid repository');
  if (!obligation || !Array.isArray(obligation.checks) ||
      !/^[a-f0-9]{64}$/.test(obligation.obligation_sha256 ?? '')) {
    reject('frozen obligation required');
  }
  if (obligation.head_sha !== head_sha) reject('obligation HEAD mismatch');
  if (base_sha != null && obligation.base_sha != null && obligation.base_sha !== base_sha) {
    reject('stale obligation base');
  }
  if (!positive(observed_at)) reject('invalid observation time');
  if (!Number.isSafeInteger(maxCheckRunPages) || maxCheckRunPages < 1 ||
      maxCheckRunPages > 10 || !Number.isSafeInteger(maxJobPages) || maxJobPages < 1 ||
      maxJobPages > 10) reject('invalid observation bound');

  const runs = await readPaginated(
    fetchGitHub, 'commits/' + head_sha + '/check-runs?per_page=100',
    'check_runs', 'check runs', maxCheckRunPages);
  const authenticated = runs.filter((run) =>
    run != null && positive(run.id) && typeof run.name === 'string' &&
    run.name.length > 0 && run.name.length <= 200 &&
    run.head_sha === head_sha && run.app != null &&
    typeof run.app.slug === 'string' && /^[a-z0-9-]{1,40}$/.test(run.app.slug));
  const results = [];
  for (const declaration of obligation.checks) {
    const candidates = authenticated.filter((run) =>
      run.name === declaration.name &&
      (declaration.producer_app_slug == null ||
        run.app.slug === declaration.producer_app_slug));
    if (!candidates.length) {
      results.push({
        name: declaration.name, workflow: declaration.workflow,
        conclusion: 'missing', evidence_ref: null,
      });
      continue;
    }
    // A rerun creates newer check runs. The newest candidate is the current
    // generation; while it is queued/running the older success is stale.
    candidates.sort((a, b) => b.id - a.id);
    const current = candidates[0];
    const conclusion = conclusionOf(current);
    if (conclusion === 'missing' || conclusion === 'pending') {
      results.push({
        name: declaration.name, workflow: declaration.workflow,
        conclusion, evidence_ref: null,
      });
      continue;
    }
    const proof = await authenticateRun({
      fetchGitHub, repository, declaration, checkRun: current, head_sha, maxJobPages,
    });
    results.push({
      name: declaration.name, workflow: declaration.workflow,
      conclusion: proof.conclusion, evidence_ref: proof.evidence_ref,
    });
  }
  const ci = classifyCiResults({
    obligation, head_sha, results, observed_at,
  });
  return ci;
}
