// Issue #4525 — production fact observer for Agent Workflow V2.
//
// The observer turns authenticated Run/Attempt/Job/Artifact/Store-receipt
// facts into the canonical lifecycle observation. It never invents a terminal
// result: an unavailable, mismatched or un-ingested source is a typed
// diagnostic, not an outcome. Raw private material (native session bytes,
// prompts, transcripts, checkpoint envelopes) never leaves this module.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  activeAction, validateLifecycleState,
} from './contract.mjs';
import { validateAuthenticatedAgentReceipt } from '../orchestration/result-artifact.mjs';
import { validateQwenPublisherIntent } from '../publisher/store-intent.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const REPO = 'BestNathan/nession';
const EVENTS = new Set(['workflow_dispatch', 'pull_request', 'workflow_run']);
const ROLE_SOURCES = Object.freeze({
  developer: Object.freeze({
    path: '.github/workflows/agent-develop.yml', name: 'Agent / Development',
  }),
  reviewer: Object.freeze({
    path: '.github/workflows/agent-review.yml', name: 'Agent / Review',
  }),
  publisher: Object.freeze({
    path: '.github/workflows/store-qwen-publisher.yml', name: 'Store / Qwen Publisher',
  }),
  acceptor: Object.freeze({
    path: '.github/workflows/agent-sc-acceptance.yml', name: 'Agent / SC Acceptance',
  }),
});
const FACT_KINDS = Object.freeze([
  'pending_dispatch', 'running', 'terminal_result', 'terminal_failure',
  'completed_uningested', 'unavailable', 'denied', 'merged', 'not_merged',
]);
const MAX_NOTES = 16;
const MAX_RECEIPT_FILES = 256;

function reject(message) {
  throw new Error('agent workflow facts: ' + message);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function onlyKeys(value, allowed, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    reject('invalid ' + label);
  }
}
function runIdentity(run) {
  return {
    id: run?.id,
    attempt: run?.run_attempt,
    status: run?.status,
    conclusion: run?.conclusion,
  };
}
function sourceMatches(run, source) {
  if (source == null) return true;
  return run?.path === source.path && run?.name === source.name;
}
function note(facts, role, kind, reason) {
  if (!FACT_KINDS.includes(kind)) reject('invalid fact kind');
  if (facts.notes.length >= MAX_NOTES) return;
  facts.notes.push({
    role,
    kind,
    reason: typeof reason === 'string' ? reason.slice(0, 200) : null,
  });
}
function unavailable(facts, role, reason) {
  note(facts, role, 'unavailable', reason);
  return { kind: 'unavailable', role, reason };
}
function denied(facts, role, reason) {
  note(facts, role, 'denied', reason);
  return { kind: 'denied', role, reason };
}

function classifyRun(run) {
  if (run.status !== 'completed') return { kind: 'running', status: run.status };
  if (run.conclusion === 'success') return { kind: 'success' };
  if (run.conclusion === 'cancelled' || run.conclusion === 'timed_out') {
    return {
      kind: 'terminal_failure', category: 'infrastructure',
      code: run.conclusion,
    };
  }
  return {
    kind: 'terminal_failure', category: 'model',
    code: run.conclusion ?? 'failed',
  };
}

async function readRejected(ports, method, args, facts, role) {
  try {
    return { value: await ports[method](args) };
  } catch {
    return { error: unavailable(facts, role, method + '_unavailable') };
  }
}

async function roleFact({ ports, state, action, facts, role, now }) {
  const source = ROLE_SOURCES[role] ?? null;
  if (action == null || action.role !== role) return null;
  if (action.run == null) {
    if (['dispatching', 'ambiguous'].includes(action.status)) {
      return unavailable(facts, role, 'run_not_verified');
    }
    return { kind: 'pending_dispatch', role };
  }
  if (!positive(action.run.id) || !positive(action.run.attempt)) {
    return denied(facts, role, 'invalid_run_binding');
  }
  const read = await readRejected(ports, 'readRun', {
    runId: action.run.id, attempt: action.run.attempt,
  }, facts, role);
  if (read.error) return read.error;
  const run = read.value;
  if (run?.id !== action.run.id || run?.run_attempt !== action.run.attempt) {
    return denied(facts, role, 'run_binding_mismatch');
  }
  if (run?.repository?.full_name !== REPO ||
      !EVENTS.has(run?.event) || run?.head_branch !== 'main' ||
      !sourceMatches(run, source)) {
    return denied(facts, role, 'run_source_mismatch');
  }
  const classification = classifyRun(run);
  if (classification.kind === 'running') {
    let claim = null;
    if (typeof ports.readClaim === 'function') {
      const claimRead = await readRejected(ports, 'readClaim', {
        runId: run.id, attempt: run.run_attempt, actionId: action.id,
      }, facts, role);
      if (!claimRead.error && claimRead.value != null) {
        claim = claimRead.value;
        if (claim.action_id !== action.id ||
            claim.run_id !== run.id ||
            claim.run_attempt !== run.run_attempt ||
            claim.fencing_generation !== state.thread.fencing_generation) {
          return denied(facts, role, 'claim_mismatch');
        }
      }
    }
    let jobCount = null;
    let executing = false;
    if (typeof ports.readRunJobs === 'function') {
      const jobsRead = await readRejected(ports, 'readRunJobs', {
        runId: run.id, attempt: run.run_attempt,
      }, facts, role);
      if (!jobsRead.error && Array.isArray(jobsRead.value?.jobs)) {
        jobCount = jobsRead.value.jobs.length;
        executing = jobsRead.value.jobs.some((job) =>
          job?.status === 'in_progress');
      }
    }
    return {
      kind: 'running', role, run: runIdentity(run),
      status: claim != null ? 'claimed' : classification.status,
      claimed: claim != null,
      executing,
      jobs: jobCount,
    };
  }
  if (classification.kind === 'terminal_failure') {
    // A failed Run without an accepted result is still a real terminal
    // failure: cancelled/timed_out are infrastructure, other failures model.
    return {
      kind: 'terminal_failure', role, run: runIdentity(run),
      category: classification.category, code: classification.code,
      outcome: classification.category === 'infrastructure' &&
        run.conclusion === 'cancelled' ? 'cancelled' :
        run.conclusion === 'timed_out' ? 'timeout' : 'failed',
      checkpoint: null,
    };
  }
  if (role === 'developer' || role === 'reviewer') {
    const receiptRead = await readRejected(ports, 'readResultReceipt', {
      issue: state.issue, actionId: action.id,
      runId: run.id, attempt: run.run_attempt,
    }, facts, role);
    if (receiptRead.error) {
      return { ...receiptRead.error, kind: 'completed_uningested' };
    }
    const receipt = receiptRead.value;
    if (receipt == null) {
      return {
        kind: 'completed_uningested', role, run: runIdentity(run),
        reason: 'result_not_ingested',
      };
    }
    let valid;
    try {
      valid = validateAuthenticatedAgentReceipt(receipt);
    } catch {
      return denied(facts, role, 'result_receipt_untrusted');
    }
    if (valid.issue !== state.issue || valid.action_id !== action.id ||
        valid.result.kind !== role || valid.result.run_id !== run.id ||
        valid.result.run_attempt !== run.run_attempt ||
        valid.source.run_id !== run.id ||
        valid.source.attempt !== run.run_attempt ||
        valid.source.repository !== REPO ||
        !SHA40.test(valid.result.target_sha ?? '')) {
      return denied(facts, role, 'result_receipt_mismatch');
    }
    if (role === 'reviewer' && valid.result.target_sha !== state.thread.head_sha) {
      return denied(facts, role, 'reviewer_head_mismatch');
    }
    let verdict = null;
    if (role === 'reviewer' && valid.result.outcome === 'changes_requested') {
      const verdictRead = await readRejected(ports, 'readReviewVerdict', {
        issue: state.issue, actionId: action.id,
        runId: run.id, attempt: run.run_attempt, receipt,
      }, facts, role);
      if (verdictRead.error) return verdictRead.error;
      verdict = verdictRead.value;
      if (verdict == null ||
          verdict.kind !== 'agent_review_verdict' ||
          verdict.outcome !== valid.result.outcome ||
          verdict.head_sha !== valid.result.target_sha ||
          !Array.isArray(verdict.findings)) {
        return denied(facts, role, 'review_verdict_mismatch');
      }
    }
    let checkpoint = null;
    if (role === 'developer' && valid.result.outcome === 'implementation_ready') {
      const checkpointRead = await readRejected(ports, 'readCheckpoint', {
        issue: state.issue, role, agentId: action.agent_id,
      }, facts, role);
      if (checkpointRead.error) return checkpointRead.error;
      checkpoint = checkpointRead.value;
      if (checkpoint == null) {
        return denied(facts, role, 'implementation_ready_without_checkpoint');
      }
    }
    return {
      kind: 'terminal_result', role, run: runIdentity(run),
      outcome: valid.result.outcome,
      target_sha: valid.result.target_sha,
      findings: verdict?.findings ?? [],
      checkpoint,
      receipt: {
        action_id: valid.action_id,
        run_id: valid.result.run_id,
        run_attempt: valid.result.run_attempt,
      },
      evidence_generation: role === 'reviewer' ? action.evidence_generation : null,
    };
  }
  if (role === 'publisher') {
    const publicationRead = await readRejected(ports, 'readPublication', {
      issue: state.issue, actionId: action.id,
      runId: run.id, attempt: run.run_attempt,
    }, facts, role);
    if (publicationRead.error) {
      return { ...publicationRead.error, kind: 'completed_uningested' };
    }
    const publication = publicationRead.value;
    if (publication == null) {
      return {
        kind: 'completed_uningested', role, run: runIdentity(run),
        reason: 'publication_not_ingested',
      };
    }
    if (publication.issue !== state.issue ||
        publication.action_id !== action.id ||
        publication.run_id !== run.id ||
        publication.run_attempt !== run.run_attempt ||
        !SHA40.test(publication.head_sha ?? '')) {
      return denied(facts, role, 'publication_receipt_mismatch');
    }
    return {
      kind: 'terminal_result', role, run: runIdentity(run),
      outcome: 'published', head_sha: publication.head_sha,
      pr: publication.pr ?? null,
      receipt: {
        action_id: publication.action_id,
        run_id: publication.run_id,
        run_attempt: publication.run_attempt,
      },
    };
  }
  // acceptor
  const acceptanceRead = await readRejected(ports, 'readAcceptance', {
    issue: state.issue, actionId: action.id,
    runId: run.id, attempt: run.run_attempt, gate: action.gate,
  }, facts, role);
  if (acceptanceRead.error) {
    return { ...acceptanceRead.error, kind: 'completed_uningested' };
  }
  const acceptance = acceptanceRead.value;
  if (acceptance == null) {
    return {
      kind: 'completed_uningested', role, run: runIdentity(run),
      reason: 'acceptance_not_ingested',
    };
  }
  if (acceptance.issue !== state.issue ||
      acceptance.action_id !== action.id ||
      acceptance.run_id !== run.id ||
      acceptance.run_attempt !== run.run_attempt ||
      !SHA40.test(acceptance.head_sha ?? '') ||
      !['passed', 'failed', 'pending'].includes(acceptance.outcome)) {
    return denied(facts, role, 'acceptance_receipt_mismatch');
  }
  return {
    kind: 'terminal_result', role, run: runIdentity(run),
    outcome: acceptance.outcome,
    head_sha: acceptance.head_sha,
    failed_criteria: Array.isArray(acceptance.failed_criteria) ?
      acceptance.failed_criteria : [],
    digest: acceptance.digest,
    receipt: {
      action_id: acceptance.action_id,
      run_id: acceptance.run_id,
      run_attempt: acceptance.run_attempt,
    },
  };
}

// The observer's action IDs come from the active state action; the event
// mapper is given the action explicitly so no ID is ever inferred from prose.
function mapFactToObservation(role, action, fact) {
  if (fact == null || action == null) return null;
  if (fact.kind === 'running') {
    return {
      action_id: action.id, run_id: fact.run.id, attempt: fact.run.attempt,
      status: fact.status, outcome: null, target_sha: null,
      failure: null, checkpoint: null, verified: true,
    };
  }
  if (fact.kind === 'terminal_failure') {
    return {
      action_id: action.id, run_id: fact.run.id, attempt: fact.run.attempt,
      status: 'completed', outcome: fact.outcome, target_sha: action.sha,
      failure: { category: fact.category, code: fact.code },
      checkpoint: fact.checkpoint ?? null, verified: true,
    };
  }
  if (fact.kind !== 'terminal_result') return null;
  if (role === 'developer') {
    return {
      action_id: action.id, run_id: fact.run.id, attempt: fact.run.attempt,
      status: 'completed', outcome: fact.outcome,
      target_sha: fact.target_sha, failure: null,
      checkpoint: fact.checkpoint, verified: true,
    };
  }
  if (role === 'publisher') {
    return {
      action_id: action.id, run_id: fact.run.id, attempt: fact.run.attempt,
      status: 'completed', outcome: 'published',
      pr: fact.pr, failure: null, readback: null, verified: true,
    };
  }
  if (role === 'reviewer') {
    return {
      action_id: action.id, run_id: fact.run.id, attempt: fact.run.attempt,
      status: 'completed', outcome: fact.outcome,
      head_sha: fact.target_sha,
      evidence_generation: fact.evidence_generation,
      digest: createHash('sha256').update(JSON.stringify(fact.findings)).digest('hex'),
      findings: fact.findings, verified: true,
    };
  }
  // acceptor
  return {
    action_id: action.id, run_id: fact.run.id, attempt: fact.run.attempt,
    stage: action.gate, head_sha: fact.head_sha, outcome: fact.outcome,
    digest: fact.digest, failed_criteria: fact.failed_criteria,
    verified: true,
  };
}

function boundedPr(pr) {
  if (pr == null) return null;
  if (!positive(pr.number) || !SHA40.test(pr.head_sha ?? '') ||
      !SHA40.test(pr.base_sha ?? '') ||
      !['open', 'closed', 'merged'].includes(pr.state) ||
      (pr.merged_sha != null && !SHA40.test(pr.merged_sha))) {
    return null;
  }
  return {
    number: pr.number, head_sha: pr.head_sha, base_sha: pr.base_sha,
    state: pr.state, merged_sha: pr.merged_sha ?? null,
  };
}

export function createFactObserver({ ports, now = Date.now() }) {
  if (ports == null || typeof ports !== 'object' || Array.isArray(ports)) {
    reject('invalid observer ports');
  }
  return {
    async inspect({ issue, state }) {
      validateLifecycleState(state);
      if (issue !== state.issue) reject('Issue/state mismatch');
      const facts = {
        issue,
        state_version: state.version,
        fencing_generation: state.thread.fencing_generation,
        pr: null,
        developer: null,
        publisher: null,
        reviewer: null,
        acceptance: null,
        merge: null,
        notes: [],
      };
      if (state.pr != null) {
        const prRead = await readRejected(ports, 'readPull', {
          number: state.pr.number,
        }, facts, 'pr');
        if (prRead.error) {
          facts.pr = boundedPr({
            number: state.pr.number, head_sha: state.pr.head_sha,
            base_sha: state.pr.base_sha, state: state.pr.state,
            merged_sha: state.pr.merged_sha,
          });
          note(facts, 'pr', 'unavailable', 'pr_readback_unavailable');
        } else {
          const observed = boundedPr(prRead.value);
          if (observed == null || observed.number !== state.pr.number) {
            note(facts, 'pr', 'denied', 'pr_readback_mismatch');
          } else {
            facts.pr = observed;
          }
        }
      }
      const action = activeAction(state);
      if (action != null) {
        const role = action.role;
        if (role != null && ROLE_SOURCES[role] != null) {
          const fact = await roleFact({
            ports, state, action, facts, role, now,
          });
          if (role === 'developer') facts.developer = fact;
          else if (role === 'publisher') facts.publisher = fact;
          else if (role === 'reviewer') facts.reviewer = fact;
          else if (role === 'acceptor') facts.acceptance = fact;
        }
      }
      if (state.pr != null &&
          ['waiting_merge', 'post_merge_acceptance'].includes(state.phase)) {
        const merged = facts.pr?.state === 'merged' && facts.pr.merged_sha != null;
        facts.merge = merged ?
          { kind: 'merged', pr_number: facts.pr.number, merged_sha: facts.pr.merged_sha } :
          { kind: 'not_merged', pr_number: facts.pr.number };
      }
      return facts;
    },

    async observe({ issue, state, wake }) {
      const facts = await this.inspect({ issue, state });
      const action = activeAction(state);
      const observation = {
        issue,
        state_version: state.version,
        observed_at: now(),
        wake: {
          source: wake.source,
          reason: wake.reason,
          correlation_id: wake.correlation_id ?? null,
        },
        fencing_generation: facts.fencing_generation,
        pr: facts.pr,
        developer: mapFactToObservation('developer', action?.role === 'developer' ? action : null, facts.developer),
        publisher: mapFactToObservation('publisher', action?.role === 'publisher' ? action : null, facts.publisher),
        reviewer: mapFactToObservation('reviewer', action?.role === 'reviewer' ? action : null, facts.reviewer),
        acceptance: mapFactToObservation('acceptor', action?.role === 'acceptor' ? action : null, facts.acceptance),
        merge: facts.merge?.kind === 'merged' ? {
          pr_number: facts.merge.pr_number,
          merged_sha: facts.merge.merged_sha,
          verified: true,
        } : null,
        ci: null,
      };
      // A merge fact is only an observation when the PR readback is authenticated.
      if (facts.pr == null) {
        observation.pr = null;
        observation.merge = null;
      }
      return observation;
    },

    async legacyPr({ issue, state }) {
      const read = await readRejected(ports, 'readLegacyPr', { issue, state }, { notes: [] }, 'legacy');
      if (read.error || read.value == null) return null;
      const pr = read.value;
      if (pr.issue !== issue || !SHA40.test(pr.head_sha ?? '') ||
          !SHA40.test(pr.base_sha ?? '') || !positive(pr.number)) {
        return null;
      }
      return boundedPr(pr);
    },
  };
}

// ── Production composition: real scoped adapter bindings ──────────────────
// Every reader receives a trusted token/Store root from the caller; the
// observer itself has no privilege. Missing effects remain typed unavailable
// rather than guessed, until the apply composition slice wires them.
function safeJoin(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep)) reject('unsafe Store path');
  return target;
}
function listReceipts(root, issue) {
  const receipts = [];
  for (const namespace of ['results', 'producer-results-v2']) {
    const directory = safeJoin(root, 'workflows/issues/' + issue + '/' + namespace);
    if (!fs.existsSync(directory)) continue;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const names = fs.readdirSync(directory).sort();
    if (names.length > MAX_RECEIPT_FILES) reject('receipt directory exceeds bound');
    for (const name of names) {
      if (!/^[0-9]+-[0-9]+-[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      const fileStat = fs.lstatSync(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() ||
          fileStat.size > 128 * 1024) continue;
      let record;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      receipts.push(record);
    }
  }
  return receipts;
}

export function createProductionObserverPorts({
  token, storeRoot, repository = REPO,
}) {
  if (typeof token !== 'string' || token.length < 8) reject('read-only token required');
  if (typeof storeRoot !== 'string' || !fs.statSync(storeRoot).isDirectory()) {
    reject('trusted Store root required');
  }
  const fetchGitHub = async (endpoint) => {
    const response = await fetch(
      'https://api.github.com/repos/' + repository + '/' + endpoint, {
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(20000),
      });
    if (!response.ok) throw new Error('GitHub read failed: ' + response.status);
    return response.json();
  };
  return {
    async readPull({ number }) {
      const pull = await fetchGitHub('pulls/' + number);
      return {
        number: pull.number,
        state: pull.merged === true ? 'merged' : pull.state,
        head_sha: pull.head?.sha,
        base_sha: pull.base?.sha,
        merged_sha: pull.merged === true ? pull.merge_commit_sha : null,
      };
    },
    async readRun({ runId, attempt }) {
      return fetchGitHub('actions/runs/' + runId + '/attempts/' + attempt);
    },
    async readRunJobs({ runId, attempt }) {
      return fetchGitHub('actions/runs/' + runId + '/attempts/' + attempt +
        '/jobs?per_page=100');
    },
    async readClaim() {
      // Claim Artifact authentication is composed by the recovery slice.
      throw new Error('claim reader not composed');
    },
    async readResultReceipt({ issue, actionId, runId, attempt }) {
      const receipts = listReceipts(storeRoot, issue);
      for (const receipt of receipts) {
        if (receipt?.action_id !== actionId ||
            receipt?.result?.run_id !== runId ||
            receipt?.result?.run_attempt !== attempt) continue;
        return receipt;
      }
      return null;
    },
    async readReviewVerdict() {
      // The verdict Artifact reader is owned by the existing Reviewer Result
      // Ingest boundary; the composition slice wires it without re-implementing
      // Artifact authentication here.
      throw new Error('review verdict reader not composed');
    },
    async readPublication() {
      // Publication readback is wired by the trusted apply composition slice.
      throw new Error('publication reader not composed');
    },
    async readAcceptance() {
      throw new Error('acceptance reader not composed');
    },
    async readCheckpoint({ issue, role, agentId }) {
      const relativeHead = 'roles/' + role + '/' + agentId +
        '/issues/' + issue + '/head.json';
      const head = safeJoin(storeRoot, relativeHead);
      if (!fs.existsSync(head)) return null;
      const stat = fs.lstatSync(head);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
        reject('unsafe checkpoint head');
      }
      const headRecord = JSON.parse(fs.readFileSync(head, 'utf8'));
      if (!positive(headRecord?.version) ||
          typeof headRecord?.checkpoint_path !== 'string' ||
          !HEX64.test(headRecord?.ciphertext_sha256 ?? '')) {
        return null;
      }
      const checkpointFile = safeJoin(storeRoot, headRecord.checkpoint_path);
      const checkpointStat = fs.lstatSync(checkpointFile);
      if (!checkpointStat.isFile() || checkpointStat.isSymbolicLink() ||
          checkpointStat.size > 256 * 1024) return null;
      const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
      if (checkpoint?.version !== headRecord.version ||
          checkpoint?.ciphertext_sha256 !== headRecord.ciphertext_sha256 ||
          checkpoint?.identity?.role !== role ||
          checkpoint?.identity?.agent_id !== agentId ||
          checkpoint?.identity?.issue !== issue) {
        return null;
      }
      let commit;
      try {
        commit = execFileSync('git', ['-C', storeRoot, 'log', '-1',
          '--format=%H', 'HEAD', '--', relativeHead], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0',
            GIT_NO_REPLACE_OBJECTS: '1' },
        }).trim();
      } catch {
        return null;
      }
      if (!SHA40.test(commit)) return null;
      return {
        version: headRecord.version,
        commit_sha: commit,
        ciphertext_sha256: headRecord.ciphertext_sha256,
        native_session_id: null,
      };
    },
    async readLegacyPr({ issue }) {
      // A v1 state does not record its PR. Read the trusted Publisher intent
      // branch from the Store and locate exactly one repository PR; ambiguity
      // or absence is a typed null, never a guessed PR.
      const receipts = listReceipts(storeRoot, issue);
      const branches = new Set();
      for (const receipt of receipts) {
        if (receipt?.kind !== 'trusted_qwen_publisher_write_ahead_intent') continue;
        let intent;
        try {
          intent = validateQwenPublisherIntent(receipt);
        } catch {
          continue;
        }
        if (intent.issue !== issue) continue;
        branches.add(intent.branch);
      }
      if (branches.size !== 1) return null;
      const branch = [...branches][0];
      const pulls = await fetchGitHub(
        'pulls?state=all&per_page=10&head=' +
        encodeURIComponent('BestNathan:' + branch));
      if (!Array.isArray(pulls) || pulls.length !== 1) return null;
      const pull = pulls[0];
      if (pull?.head?.ref !== branch || pull?.head?.sha == null ||
          pull?.base?.repo?.full_name !== REPO ||
          pull?.head?.repo?.full_name !== REPO) return null;
      return {
        number: pull.number,
        head_sha: pull.head.sha,
        base_sha: pull.base.sha,
        state: pull.merged === true ? 'merged' : pull.state,
        merged_sha: pull.merged === true ? pull.merge_commit_sha : null,
      };
    },
  };
}

export { ROLE_SOURCES, listReceipts };
