#!/usr/bin/env node
// Trusted Issue lifecycle reconciliation; Acceptance evaluation/projection is
// owned by the existing Agent / SC Acceptance and Case Ingest paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  completedIssueAcceptanceDecision,
  extractSection,
  isAcceptanceIssue,
  parseAcceptanceReport,
  parseClosingIssueNumbers,
  parsePreMergeIssueNumbers,
  parseSuccessCriteria,
} from './requirement-acceptance.mjs';
import { planStage, validateAcceptancePlan, canonicalAcceptanceStage } from './acceptance-plan.mjs';
import {collectPrRequiredQualityAsync, validPrRequiredQualityReceipt}
  from './acceptance-pr-web-quality-receipt.mjs';
import { parseCommand } from './github-comment-command.mjs';
import {collectToolchain4241} from './acceptance-toolchain-4241-evidence.mjs';
import {invalidatedConvergenceWriter4059Row,collectConvergenceWriter4059,
  validConvergenceWriterReceipt} from './acceptance-convergence-writer-4137.mjs';

const SHA = /^[0-9a-f]{40}$/i;
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function resolveAcceptComment(event, repo, actor) {
  if (event?.action !== 'created' || event.repository?.full_name !== repo ||
      event.issue?.pull_request || event.issue?.state !== 'open' ||
      !Number.isSafeInteger(event.issue?.number) || event.issue.number <= 0 ||
      event.sender?.login !== actor) return null;
  const comment = event.comment;
  const kind = parseCommand(comment?.body);
  if (!comment || kind?.handler !== 'accept' ||
      comment.user?.type !== 'User' || comment.user.login !== actor ||
      !TRUSTED_ASSOCIATIONS.has(comment.author_association) ||
      !Number.isSafeInteger(comment.id) || comment.id <= 0) return null;
  return { issueNumber: event.issue.number, commentId: comment.id,
    targetMainSha: kind.target_sha ?? null, targetPrSha: kind.target_pr_sha ?? null,
    replacementOldPr: kind.replacement_old_pr ?? null,
    replacementNewPr: kind.replacement_new_pr ?? null };
}

export function decideIssueClosure(issue, associatedPrs, options = {}) {
  if (!issue || issue.pull_request || issue.state !== 'open' || !isAcceptanceIssue(issue)) {
    return { action: 'skip', reason: 'not an open Bug/Requirement' };
  }
  if (issue.state_reason === 'not_planned') return { action: 'skip', reason: 'not planned' };
  const labels = (issue.labels || []).map(x => typeof x === 'string' ? x : x.name);
  if (labels.includes('status:blocked') || labels.includes('status:on-hold')) {
    return { action: 'pending', reason: 'explicit blocking status' };
  }
  if (options.manualReopened) {
    return { action: 'pending', reason: 'human-reopened Issue needs explicit /accept' };
  }
  const accepted = completedIssueAcceptanceDecision(issue);
  if (accepted.kind !== 'accepted') {
    return { action: 'pending', reason: 'canonical closure validation: ' +
      (accepted.result?.errors || []).join('; ') };
  }
  // #4137: the historically disproven #4059 SC-02 Pass (green Waker + BLOCKED
  // converge, skipped writer) is immutable history, not acceptance. Refuse
  // closure until a real authenticated convergence-writer receipt replaces it;
  // the original row is never hand-edited. The independent operation-level
  // re-attestation lives in qualifyConvergenceWriter4059Closure below.
  if (issue.number === 4059) {
    const row = parseAcceptanceReport(extractSection(issue.body, 'Acceptance Report'))
      .rows.get('SC-02');
    if (row && String(row.result).toLowerCase() === 'pass' &&
        invalidatedConvergenceWriter4059Row(4059, 'SC-02', row.evidence)) {
      return { action: 'pending', reason:
        '#4059 SC-02 historical Pass is disproven; closure requires an authenticated ' +
        'convergence-writer operation receipt (#4137)' };
    }
  }
  if (!Array.isArray(associatedPrs) || associatedPrs.length === 0) {
    return { action: 'pending', reason: 'no verified implementation PR association' };
  }
  // Search finds superseded PRs referenced by Issue number, even when they
  // were intentionally closed without merging. Do not let an abandoned
  // alternative block an otherwise accepted implementation indefinitely.
  const merged = associatedPrs.filter(pr => Boolean(pr.merged_at));
  if (merged.length === 0) {
    return { action: 'pending', reason: 'no verified merged implementation PR' };
  }
  // GitOps is Nession's reviewed orphan deployment-source branch (#4110).
  // A merged GitOps PR is a valid implementation relation, never a deployed
  // runtime attestation. Arbitrary branch names remain rejected.
  if (associatedPrs.some(pr =>
    (pr.state === 'open' && !pr.merged_at) ||
    (pr.merged_at && !['staging', 'main', 'gitops'].includes(pr.base?.ref)))) {
    return { action: 'pending', reason: 'associated active PR or invalid merge target' };
  }
  return { action: 'close', reason: 'accepted SCs and merged implementation PRs' };
}

// /accept needs an implementation relation, not a text-only reference.
// Preserve historical "(#N)" PR titles and explicit closing/implementing
// declarations, but never infer implementation from "Refs #N" or a mention.
export function explicitlyImplementsIssue(pr, issueNumber, owner, name) {
  if (parseClosingIssueNumbers(pr.body, owner, name).includes(issueNumber) ||
      parseClosingIssueNumbers(pr.title, owner, name).includes(issueNumber)) return true;
  if ([...String(pr.title || '').matchAll(/\(([^)]*)\)/g)].some((match) =>
    new RegExp('^\\s*#' + issueNumber + '(?:\\s+SC-\\d{2,})?\\s*$', 'i').test(match[1])))
    return true;
  const declarations = String(pr.body || '').replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/).filter(line => /^\s*(?:[-*+]\s+)?(?:implements?|addresses?)\s+/i.test(line));
  return declarations.some(line =>
    parsePreMergeIssueNumbers(line, owner, name).includes(issueNumber));
}

// GitHub's own commit -> PR association proves the exact source identity.
// Neither the PR body nor a later Issue mention can attest that source SHA.
export async function verifiedManualSourcePulls(repository, issueNumber, prs, token,
  request = githubRequest) {
  const { owner, name, prefix } = repoParts(repository);
  const verified = [];
  for (const pr of prs) {
    if (!explicitlyImplementsIssue(pr, issueNumber, owner, name)) continue;
    if (!SHA.test(String(pr.head?.sha || '')) ||
        pr.head?.repo?.full_name !== repository ||
        pr.base?.repo?.full_name !== repository ||
        !['main', 'staging'].includes(pr.base?.ref) ||
        (pr.state === 'closed' && !pr.merged_at)) continue;
    const associated = await request(prefix + '/commits/' + pr.head.sha +
      '/pulls?per_page=100', { token });
    if (!Array.isArray(associated) || associated.length >= 100)
      throw Error('incomplete exact-head PR source provenance for #' + pr.number);
    if (associated.some(p => p.number === pr.number &&
        p.head?.sha === pr.head.sha &&
        p.head?.repo?.full_name === repository &&
        p.base?.repo?.full_name === repository &&
        p.base?.ref === pr.base.ref)) verified.push(pr);
  }
  return verified;
}

export function selectManualAgentRuns(issue, prs, {
  verifiedStagingSha = null, verifiedMainSha = null, verifiedPrSha = null,
  verifiedPrAnchors = [], diagnostics = [],
} = {}) {
  const success = parseSuccessCriteria(extractSection(issue.body, 'Success Criteria'));
  const report = parseAcceptanceReport(extractSection(issue.body, 'Acceptance Report'));
  const parsed = validateAcceptancePlan(issue.body, success.criteria.keys(), report.rows);
  if (success.errors.length || report.errors.length || parsed.errors.length) {
    return [];
  }
  if (!parsed.plan) return []; // Legacy implicit methods cannot authorize a new Agent.
  const planned = new Map();
  for (const [id, entry] of parsed.plan.entries()) {
    const row = report.rows.get(id);
    if (!row || entry.method !== 'agent') continue;
    // #4137: a checked Pass row normally locks its source, but the historically
    // disproven #4059 SC-02 must stay selectable so an explicit /accept can
    // dispatch a trusted replay at the original negative main SHA. The
    // invalidation is deterministic and source-bound, never prose-driven.
    if (['pass', 'n/a'].includes(row.result.toLowerCase()) && success.criteria.get(id)?.checked &&
        !invalidatedConvergenceWriter4059Row(issue.number, id, row.evidence)) continue;
    const stage = planStage(entry);
    if (!stage || planned.has(stage)) continue;
    const candidates = prs.filter(pr =>
      stage === 'pr' ||
      (stage === 'staging' && pr.base?.ref === 'staging' && pr.merged_at) ||
      (stage === 'post-merge' && pr.base?.ref === 'main' && pr.merged_at));
    candidates.sort((a, b) => String(b.merged_at || b.updated_at || '').localeCompare(
      String(a.merged_at || a.updated_at || '')));
    let pr = candidates[0];
    if (stage === 'pr') {
      // A previously accepted criterion anchors the shared PR-stage source;
      // no unanchored newest-head fallback may overwrite it. Distinct heads
      // without an anchor are ambiguous, even when both PRs really implement.
      const acceptedRefs = new Set([...parsed.plan].filter(([criterion, entry]) =>
        planStage(entry) === 'pr' &&
        ['pass', 'n/a'].includes(String(report.rows.get(criterion)?.result || '').toLowerCase()) &&
        success.criteria.get(criterion)?.checked)
        .map(([criterion]) => /\bref ([0-9a-f]{40});/i
          .exec(String(report.rows.get(criterion)?.evidence || ''))?.[1])
        .filter(Boolean));
      const heads = [...new Set(candidates.map(p => p.head?.sha)
        .filter(sha => SHA.test(String(sha || ''))))];
      // Previously accepted SCs are immutable. A human-selected current
      // merged PR head can prove that every old accepted SHA belongs to its
      // *same* implementing PR ancestry (trusted GitHub compare + commit→PR).
      // This authorizes evaluating only the Pending SCs at the newer head,
      // not silently replacing earlier accepted evidence (#4076).
      const anchorProof = new Set(verifiedPrAnchors);
      const selected = acceptedRefs.size
        ? (verifiedPrSha && heads.includes(verifiedPrSha)
          ? ([...acceptedRefs].every(ref =>
              ref === verifiedPrSha || anchorProof.has(ref)) ? verifiedPrSha : null)
          : (acceptedRefs.size === 1 && heads.includes([...acceptedRefs][0])
            ? [...acceptedRefs][0] : null))
        : verifiedPrSha
          ? (heads.includes(verifiedPrSha) ? verifiedPrSha : null)
          : (heads.length === 1 ? heads[0] : null);
      if (!selected) {
        diagnostics.push('PR stage: ' + (heads.length === 0
          ? 'no source-verified implementing PR'
          : 'ambiguous or conflicting implementing PR exact heads; preserve accepted SC source'));
        continue;
      }
      pr = candidates.find(p => p.head.sha === selected);
    }
    // The optional historic-main target is independently authenticated by
    // verifyManualPostMergeTarget; never reinterpret it as a PR or staging SHA.
    const sha = stage === 'post-merge' && SHA.test(String(verifiedMainSha || '')) &&
      prs.some(p => p.base?.ref === 'main' && p.merged_at &&
        SHA.test(String(p.merge_commit_sha || '')))
      ? verifiedMainSha
      : stage === 'pr' ? pr?.head?.sha : pr?.merge_commit_sha;
    if (!SHA.test(String(sha || ''))) {
      // A main-only implementation can reach staging through a subsequent
      // authenticated merge. The caller supplies this SHA only after proving
      // exact main-merge-commit ancestry on the staging branch.
      if (stage === 'staging' && SHA.test(String(verifiedStagingSha || '')) &&
          prs.some(p => p.base?.ref === 'main' && p.merged_at &&
            SHA.test(String(p.merge_commit_sha || '')))) {
        planned.set(stage, verifiedStagingSha);
      }
      continue;
    }
    planned.set(stage, sha);
  }
  return [...planned].map(([stage, sha]) => ({ stage, target_ref: sha }));
}

// #4253: Independent replacement has NO Git ancestry to a force-pushed
// historical accepted source. Explicit Owner intent and fresh, independently
// merged implementing PR evidence permit a NEW evaluation; the previous SC
// receipts are retained as historical data, never presented as signed by the
// replacement or inherited as a Pass.
export function independentReplacementContract(issue, previousPr, replacementPr,
  repository, sourceComment) {
  const oldId = previousPr?.number, newId = replacementPr?.number;
  const command = '/accept replace ' + oldId + ' ' + newId;
  if (!issue || issue.pull_request || String(issue.state).toLowerCase() !== 'open' ||
      !Number.isSafeInteger(issue.number) || !isAcceptanceIssue(issue) ||
      !Number.isSafeInteger(oldId) || !Number.isSafeInteger(newId) ||
      oldId <= 0 || newId <= 0 || oldId === newId ||
      !/^[\w.-]+\/[\w.-]+$/.test(String(repository ?? '')) ||
      !sourceComment || sourceComment.body !== command ||
      !Number.isSafeInteger(sourceComment.id) || sourceComment.id <= 0 ||
      sourceComment.user?.login !== 'BestNathan' ||
      sourceComment.user?.type !== 'User' ||
      sourceComment.author_association !== 'OWNER' ||
      !sourceComment.created_at ||
      sourceComment.updated_at !== sourceComment.created_at ||
      sourceComment.issue_url !== 'https://api.github.com/repos/' +
        repository + '/issues/' + issue.number)
    return null;
  const {owner,name} = repoParts(repository);
  const eligible = pr => Boolean(pr?.merged_at) &&
    ['main','staging'].includes(pr.base?.ref) &&
    pr.head?.repo?.full_name === repository &&
    pr.base?.repo?.full_name === repository &&
    SHA.test(String(pr.head?.sha || '')) &&
    SHA.test(String(pr.merge_commit_sha || '')) &&
    explicitlyImplementsIssue(pr,issue.number,owner,name);
  // The retired PR may carry only a historical Refs declaration (#3919).
  // It is never an authority for a new Pass; the independently checked new PR
  // still must explicitly IMPLEMENT the Issue under the canonical rule.
  const oldHistoricallyLinked = eligible(previousPr) ||
    (Boolean(previousPr?.merged_at) &&
      previousPr.head?.repo?.full_name === repository &&
      previousPr.base?.repo?.full_name === repository &&
      ['main','staging'].includes(previousPr.base?.ref) &&
      SHA.test(String(previousPr.head?.sha || '')) &&
      SHA.test(String(previousPr.merge_commit_sha || '')) &&
      new RegExp('(?:^|\\n)Refs\\s+#'+issue.number+'(?:\\.|\\s|$)','i')
        .test(String(previousPr.body || '')));
  if (!oldHistoricallyLinked || !eligible(replacementPr) ||
      String(previousPr.merged_at) >= String(replacementPr.merged_at))
    return null;
  const criteria = parseSuccessCriteria(extractSection(issue.body,'Success Criteria'));
  const report = parseAcceptanceReport(extractSection(issue.body,'Acceptance Report'));
  const plan = validateAcceptancePlan(issue.body,criteria.criteria.keys(),report.rows);
  if (criteria.errors.length || report.errors.length || plan.errors.length ||
      !plan.plan || criteria.criteria.size === 0 || criteria.criteria.size > 16)
    return null;
  const oldSources = new Set();
  const selected = [];
  for (const [id,sc] of criteria.criteria) {
    const row = report.rows.get(id);
    const match = /^run [1-9]\d*; ref ([a-f0-9]{40}); source agent(?:-[a-z0-9-]+)?;/i
      .exec(String(row?.evidence || ''));
    if (!sc.checked || !row || row.result !== 'Pass' ||
        planStage(plan.plan.get(id)) !== 'pr' ||
        plan.plan.get(id)?.method !== 'agent' || !match ||
        match[1].toLowerCase() === replacementPr.head.sha)
      return null;
    oldSources.add(match[1].toLowerCase());
    selected.push(id);
  }
  if (report.rows.size !== selected.length || oldSources.size > 16)
    return null;
  return {issue:issue.number, previous_pr:oldId, replacement_pr:newId,
    target_ref:replacementPr.head.sha, comment_id:sourceComment.id,
    old_sources:[...oldSources].sort(), criteria:selected.sort()};
}

// Shared pure verifier used by both /accept dispatch and the trusted
// Acceptance projector. Never treat the caller's claimed target as proof.
export function independentReplacementSourceEvidence(policy, replacement,
  associated, branch, merge, compare, repository) {
  return Boolean(policy && replacement && policy.target_ref === replacement.head?.sha &&
    replacement.head?.repo?.full_name === repository &&
    replacement.base?.repo?.full_name === repository &&
    ['main','staging'].includes(replacement.base?.ref) &&
    replacement.merged_at &&
    Array.isArray(associated) && associated.length < 100 &&
    associated.some(p => p.number === policy.replacement_pr &&
      p.merged_at && p.head?.sha === policy.target_ref &&
      p.head?.repo?.full_name === repository &&
      p.base?.repo?.full_name === repository &&
      p.base?.ref === replacement.base.ref) &&
    merge?.sha === replacement.merge_commit_sha &&
    Array.isArray(merge.parents) && merge.parents.length === 2 &&
    merge.parents.every(parent => SHA.test(String(parent?.sha || ''))) &&
    SHA.test(String(branch?.commit?.sha || '')) &&
    isMainMergeAncestorOfStaging(replacement.merge_commit_sha,
      branch.commit.sha,compare));
}

// Fetch exact GitHub issue/PR/comment/commit/branch data at EACH trust
// boundary. A comment is an intent and cannot attest merge, quality, or
// accepted content. A new model result still must be applied by the canonical
// Acceptance executor under current exact-HEAD required Quality.
export async function verifyIndependentReplacement(repository, issue,
  previousPrNumber, replacementPrNumber, commentId, token,
  request = githubRequest) {
  if (!token || !Number.isSafeInteger(previousPrNumber) ||
      !Number.isSafeInteger(replacementPrNumber) ||
      !Number.isSafeInteger(commentId) || !Number.isSafeInteger(issue?.number))
    throw Error('invalid independent replacement request');
  const {prefix} = repoParts(repository);
  const [previous, replacement, comment] = await Promise.all([
    request(prefix+'/pulls/'+previousPrNumber,{token}),
    request(prefix+'/pulls/'+replacementPrNumber,{token}),
    request(prefix+'/issues/comments/'+commentId,{token}),
  ]);
  const policy = independentReplacementContract(issue,previous,replacement,
    repository,comment);
  if (!policy) throw Error('replacement requires original Owner intent, historical accepted SCs and two independently merged implementing PRs');
  const [associated,branch,merge] = await Promise.all([
    request(prefix+'/commits/'+policy.target_ref+'/pulls?per_page=100',{token}),
    request(prefix+'/branches/'+replacement.base.ref,{token}),
    request(prefix+'/commits/'+replacement.merge_commit_sha,{token}),
  ]);
  if (!SHA.test(String(branch?.commit?.sha || '')))
    throw Error('replacement protected destination branch lacks commit');
  const compare = await request(prefix+'/compare/'+replacement.merge_commit_sha+
    '...'+branch.commit.sha,{token});
  if (!independentReplacementSourceEvidence(policy,replacement,
    associated,branch,merge,compare,repository))
    throw Error('replacement lacks authenticated exact-head PR, two-parent merge or protected-branch ancestry');
  return policy;
}

/** Trust-gated re-evaluation of a merged implementation's newer PR head.
 * Every already-Pass PR-stage source must be an actual ancestor of the
 * selected head in the same merged Issue-linked PR, never merely a prose ref.
 * No accepted criterion is mutated by this function (#4076).
 */
export async function verifyManualAcceptedPrAnchors(repository, issue, prs,
  selectedSha, token, request = githubRequest) {
  if (!SHA.test(String(selectedSha ?? '')) || !token || !Array.isArray(prs))
    throw Error('invalid manual PR anchor proof request');
  const selected = prs.filter(pr => pr.merged_at &&
    pr.head?.sha === selectedSha && ['main','staging'].includes(pr.base?.ref));
  if (selected.length !== 1)
    throw Error('ambiguous or missing merged implementing PR for selected SHA');
  const pr = selected[0];
  const report = parseAcceptanceReport(extractSection(issue.body, 'Acceptance Report'));
  const criteria = parseSuccessCriteria(extractSection(issue.body, 'Success Criteria'));
  const plan = validateAcceptancePlan(issue.body, criteria.criteria.keys(), report.rows);
  if (report.errors.length || criteria.errors.length || plan.errors.length || !plan.plan)
    throw Error('invalid authoritative Issue Acceptance contract');
  const anchors = new Set();
  for (const [id, row] of report.rows) {
    if (planStage(plan.plan.get(id)) !== 'pr' || !criteria.criteria.get(id)?.checked ||
        !['pass','n/a'].includes(String(row.result).toLowerCase())) continue;
    const ref = /\bref ([0-9a-f]{40});/i.exec(String(row.evidence ?? ''))?.[1];
    if (ref) anchors.add(ref);
  }
  if (anchors.size > 8) throw Error('too many PR Acceptance source anchors');
  const { prefix } = repoParts(repository);
  const verified = [];
  for (const oldSha of anchors) {
    if (oldSha === selectedSha) { verified.push(oldSha); continue; }
    const [comparison, related] = await Promise.all([
      request(prefix + '/compare/' + oldSha + '...' + selectedSha, { token }),
      request(prefix + '/commits/' + oldSha + '/pulls?per_page=100', { token }),
    ]);
    const ancestral = comparison?.base_commit?.sha === oldSha &&
      comparison?.merge_base_commit?.sha === oldSha &&
      comparison?.behind_by === 0 && comparison?.ahead_by > 0 &&
      comparison?.status === 'ahead';
    const samePr = Array.isArray(related) && related.length < 100 &&
      related.some(p => p.number === pr.number && p.merged_at &&
        p.head?.sha === selectedSha &&
        p.head?.repo?.full_name === repository &&
        p.base?.repo?.full_name === repository &&
        p.base?.ref === pr.base.ref);
    if (!ancestral || !samePr)
      throw Error('accepted PR source lacks authenticated same-PR ancestry: ' + oldSha);
    verified.push(oldSha);
  }
  return verified;
}

async function githubRequest(path, { token, method = 'GET', body } = {}) {
  if (!token) throw Error('GITHUB_TOKEN/GH_TOKEN is required');
  const response = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nession-issue-lifecycle',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error('GitHub ' + method + ' ' + path + ': ' + response.status +
    ' ' + (await response.text()).slice(0, 400));
  if (response.status === 204) return null;
  return response.json();
}

// Read-only source proof is independently collected from official GitHub
// source/Actions/OCI readback receipts. The Issue or model supplies no pins.
async function sourceProof4241(repository, targetSha, token,
  request = githubRequest, getLog = null) {
  if(repository!=='BestNathan/nession'||!SHA.test(String(targetSha||''))||!token)
    throw Error('untrusted toolchains orphan acceptance source');
  const readLog=getLog??(async path=>{
    const response=await fetch('https://api.github.com'+path,{
      headers:{Accept:'application/vnd.github+json',
        Authorization:'Bearer '+token,
        'X-GitHub-Api-Version':'2022-11-28',
        'User-Agent':'nession-issue-lifecycle'},
    });
    if(!response.ok)throw Error('toolchains read-only job log unavailable: '+response.status);
    return response.text();
  });
  return collectToolchain4241({repo:repository,targetSha,stage:'post-merge',
    issue:4241,get:path=>request(path,{token}),getLog:readLog});
}
function accepted4241Target(issue) {
  if(issue?.number!==4241)return null;
  const criteria=parseSuccessCriteria(extractSection(issue.body,'Success Criteria'));
  const report=parseAcceptanceReport(extractSection(issue.body,'Acceptance Report'));
  const plan=validateAcceptancePlan(issue.body,criteria.criteria.keys(),report.rows);
  if(criteria.errors.length||report.errors.length||plan.errors.length||!plan.plan)
    return null;
  const refs=[];
  for(const id of ['SC-02','SC-03','SC-04','SC-05']) {
    const row=report.rows.get(id),criterion=criteria.criteria.get(id),
      entry=plan.plan.get(id);
    if(!row||!criterion?.checked||row.result!=='Pass'||
       entry?.method!=='agent'||planStage(entry)!=='post-merge')return null;
    const match=/^run [1-9][0-9]*; ref ([a-f0-9]{40}); source agent(?:-[a-z0-9-]+)?;/i
      .exec(String(row.evidence??''));
    if(!match)return null;
    refs.push(match[1].toLowerCase());
  }
  return new Set(refs).size===1?refs[0]:null;
}
// #4137: closure of #4059 additionally requires the independent operation-level
// convergence-writer receipt re-read from GitHub at the SC-02 source SHA. A
// checked Pass row — even one that is not the known historical negative — cannot
// close the Issue without a real authenticated workflow-bearing promotion. This
// consumes the canonical attestor; it duplicates no writer policy.
export async function qualifyConvergenceWriter4059Closure(repository, issue, token,
  request = githubRequest, getLog = null) {
  if (issue?.number !== 4059) return { qualified: true };
  const row = parseAcceptanceReport(extractSection(issue.body, 'Acceptance Report'))
    .rows.get('SC-02');
  if (!row || String(row.result).toLowerCase() !== 'pass') return { qualified: true };
  if (invalidatedConvergenceWriter4059Row(4059, 'SC-02', row.evidence)) {
    return { qualified: false, reason: 'historical SC-02 Pass is disproven (#4137)' };
  }
  const match = /^run [1-9][0-9]*; ref ([a-f0-9]{40}); source agent/i
    .exec(String(row.evidence ?? ''));
  const targetSha = match?.[1]?.toLowerCase();
  if (!SHA.test(String(targetSha || ''))) {
    return { qualified: false, reason: 'SC-02 Pass lacks an exact source SHA receipt' };
  }
  const readLog = getLog ?? (async path => {
    const response = await fetch('https://api.github.com' + path, {
      headers: { Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nession-issue-lifecycle' },
    });
    if (!response.ok) throw Error('convergence read-only job log unavailable: ' + response.status);
    return response.text();
  });
  const get = path => request(path, { token });
  // Bounded exact-SHA run listing (the canonical collector owns all attestation
  // policy). acceptance-ci-evidence.mjs executes main() at import, so it cannot
  // be imported here; this mirrors its bounded workflowRunsForSha pagination.
  const runs = [];
  for (let page = 1; page <= 3; page += 1) {
    const payload = await get('/repos/' + repository + '/actions/runs?head_sha=' +
      targetSha + '&per_page=100&page=' + page);
    const pageRuns = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
    runs.push(...pageRuns);
    if (pageRuns.length < 100) break;
  }
  if (runs.length > 300) throw Error('excessive workflow run listing for exact SHA');
  const proof = await collectConvergenceWriter4059({ repo: repository, targetSha, runs,
    get, getLog: readLog });
  return validConvergenceWriterReceipt(proof, targetSha)
    ? { qualified: true, receipt: proof }
    : { qualified: false,
      reason: 'no authenticated convergence-writer operation receipt at SC-02 source (#4137)' };
}
function repoParts(repository) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository || '');
  if (!match) throw Error('invalid GITHUB_REPOSITORY');
  return { owner: match[1], name: match[2], prefix: '/repos/' + repository };
}

async function relatedPulls(repository, issueNumber, token, includePr = null, request = githubRequest) {
  const { owner, name, prefix } = repoParts(repository);
  const query = encodeURIComponent('repo:' + repository + ' is:pr ' + issueNumber);
  const found = await request('/search/issues?q=' + query + '&per_page=100', { token });
  if (found.incomplete_results || found.total_count > 100 || !Array.isArray(found.items)) {
    throw Error('incomplete implementation PR discovery; refusing Issue closure');
  }
  // Search can surface the Issue itself or another non-PR item; only an item
  // GitHub typed as a pull request whose number is not this Issue's may be
  // fetched as /pulls/<n> (#4214). A claimed PR that cannot be read still
  // fails closed below.
  const numbers = new Set(found.items
    .filter(item => item && Number.isSafeInteger(item.number) &&
      item.number !== issueNumber && item.pull_request)
    .map(item => item.number));
  if (includePr) numbers.add(includePr);
  const prs = [];
  for (const number of numbers) {
    if (!Number.isSafeInteger(number) || number <= 0) throw Error('invalid PR discovery result');
    const pr = await request(prefix + '/pulls/' + number, { token });
    // #4160: only explicit implementing/closing PRs may participate in Issue
    // completion. A `Refs #N` catalog/fixture PR is evidence, not an
    // implementation relation; it must not block closure by target branch.
    if (explicitlyImplementsIssue(pr, issueNumber, owner, name)) {
      prs.push(pr);
    }
  }
  return prs;
}

// Compare metadata comes from GitHub REST, not Issue prose, PR descriptions,
// or a user-supplied SHA. Diverged and incomplete lineage must fail closed.
export function isMainMergeAncestorOfStaging(mainMergeSha, stagingSha, comparison) {
  return SHA.test(String(mainMergeSha || '')) &&
    SHA.test(String(stagingSha || '')) &&
    comparison?.base_commit?.sha === mainMergeSha &&
    comparison?.merge_base_commit?.sha === mainMergeSha &&
    comparison?.behind_by === 0 &&
    Number.isSafeInteger(comparison?.ahead_by) &&
    ['ahead', 'identical'].includes(comparison?.status);
}

async function verifiedStagingTargetForMainPR(repository, prs, token, request) {
  // Only Issue-associated, actually merged Main PRs may authorize this
  // fallback. The separate Acceptance executor still independently verifies
  // the stage, exact target SHA, CI evidence, and SC contract.
  const mainMerges = prs.filter(pr => pr.base?.ref === 'main' && pr.merged_at &&
    SHA.test(String(pr.merge_commit_sha || '')));
  if (mainMerges.length === 0) return null;
  const { prefix } = repoParts(repository);
  const branch = await request(prefix + '/branches/staging', { token });
  const stagingSha = branch?.commit?.sha;
  if (!SHA.test(String(stagingSha || ''))) {
    throw Error('authenticated staging branch has no valid commit SHA');
  }
  for (const pr of mainMerges) {
    const source = pr.merge_commit_sha;
    const comparison = await request(prefix + '/compare/' + source + '...' + stagingSha,
      { token });
    if (isMainMergeAncestorOfStaging(source, stagingSha, comparison)) return stagingSha;
  }
  return null;
}

// An explicit /accept post-merge SHA is an intent, not proof. GitHub itself
// must independently establish a protected main two-parent PR merge, current
// main ancestry, and lineage from a merged implementation PR on this Issue.
// No caller-controlled Issue text may substitute for these witnesses.
export async function verifyManualPostMergeTarget(repository, targetSha, prs,
  token, request = githubRequest) {
  if (!SHA.test(String(targetSha || '')) || !Array.isArray(prs) || !token)
    throw Error('invalid historical main acceptance request');
  const { prefix } = repoParts(repository);
  const sourcePrs = prs.filter(p => p?.base?.ref === 'main' &&
    p.base?.repo?.full_name === repository &&
    p.head?.repo?.full_name === repository && Boolean(p.merged_at) &&
    SHA.test(String(p.merge_commit_sha || '')));
  if (sourcePrs.length === 0) throw Error('no verified Issue-linked main implementation PR');
  const [main, commit, pulls] = await Promise.all([
    request(prefix + '/branches/main', { token }),
    request(prefix + '/commits/' + targetSha, { token }),
    request(prefix + '/commits/' + targetSha + '/pulls?per_page=10', { token }),
  ]);
  const mainHead = main?.commit?.sha;
  if (!SHA.test(String(mainHead || '')) || commit?.sha !== targetSha ||
      !Array.isArray(commit.parents) || commit.parents.length !== 2 ||
      commit.parents.some(parent => !SHA.test(String(parent?.sha || ''))) ||
      !Array.isArray(pulls) || pulls.length > 10 ||
      !pulls.some(p => p?.merged_at && p.merge_commit_sha === targetSha &&
        p.base?.ref === 'main' && p.base?.repo?.full_name === repository &&
        p.head?.repo?.full_name === repository)) {
    throw Error('historical target is not a verified main two-parent PR merge');
  }
  const targetOnMain = await request(prefix + '/compare/' + targetSha + '...' +
    mainHead, { token });
  if (!isMainMergeAncestorOfStaging(targetSha, mainHead, targetOnMain))
    throw Error('historical target is not a current protected main ancestor');
  let associated = false;
  for (const pr of sourcePrs) {
    const proof = await request(prefix + '/compare/' + pr.merge_commit_sha + '...' +
      targetSha, { token });
    if (isMainMergeAncestorOfStaging(pr.merge_commit_sha, targetSha, proof)) {
      associated = true;
      break;
    }
  }
  if (!associated) throw Error('historical main target does not include Issue implementation');
  return targetSha; // Only the existing read-only Agent/Case projector may Pass.
}

export function hasUnrecoveredHumanReopen(events, comments) {
  const reopens = events.filter(e => e.event === 'reopened' && e.actor?.type === 'User')
    .map(e => e.created_at).filter(Boolean).sort();
  if (!reopens.length) return false;
  const lastReopen = reopens.at(-1);
  // /accept is an explicit owner/collaborator recovery intent. The later
  // trusted projector still has to prove every applicable SC independently.
  return !comments.some(c => parseCommand(c.body)?.handler === 'accept' &&
    c.user?.type === 'User' &&
    TRUSTED_ASSOCIATIONS.has(c.author_association) &&
    typeof c.created_at === 'string' && c.created_at > lastReopen);
}

async function humanReopened(repository, issueNumber, token, request = githubRequest) {
  const { prefix } = repoParts(repository);
  // Incomplete event/comment history cannot prove the absence of a later
  // human hold. Fail closed rather than treating an unseen /accept as authority.
  const events = await request(prefix + '/issues/' + issueNumber + '/events?per_page=100', { token });
  if (!Array.isArray(events) || events.length === 100) {
    throw Error('Issue event history incomplete; refusing automatic close');
  }
  if (!events.some(e => e.event === 'reopened' && e.actor?.type === 'User')) return false;
  const comments = await request(prefix + '/issues/' + issueNumber + '/comments?per_page=100', { token });
  if (!Array.isArray(comments) || comments.length === 100) {
    throw Error('Issue comment history incomplete; refusing automatic close');
  }
  return hasUnrecoveredHumanReopen(events, comments);
}

// #4146: canonical Issue closure consumes the SAME required-Quality source
// attestor as PR SC normalization. Historical text Pass and an unrelated
// merged PR cannot together grant completion of a different source HEAD.
// A PR may accumulate reviewed Main merge-base refresh commits *after* its
// original exact-head SC Acceptance. The historic SC source remains immutable;
// authorize a successor only with GitHub's same-PR association and strict Git
// ancestry, then require independent exact-head Quality for BOTH revisions.
export async function verifyHistoricalPrSourceSuccessor(repository, sourceSha, pr,
  token, request = githubRequest) {
  if (!SHA.test(String(sourceSha || '')) || !SHA.test(String(pr?.head?.sha || '')) ||
      sourceSha === pr.head.sha || !pr?.merged_at ||
      !['main','staging','gitops'].includes(pr?.base?.ref) ||
      pr.head?.repo?.full_name !== repository ||
      pr.base?.repo?.full_name !== repository ||
      !Number.isSafeInteger(pr?.number) || !token) return false;
  const {prefix}=repoParts(repository);
  const [compare,associated]=await Promise.all([
    request(prefix+'/compare/'+sourceSha+'...'+pr.head.sha, {token}),
    request(prefix+'/commits/'+sourceSha+'/pulls?per_page=100', {token}),
  ]);
  if (!Array.isArray(associated) || associated.length >= 100 ||
      compare?.base_commit?.sha !== sourceSha ||
      compare?.merge_base_commit?.sha !== sourceSha ||
      compare?.status !== 'ahead' || compare?.behind_by !== 0 ||
      !Number.isSafeInteger(compare?.ahead_by) || compare.ahead_by <= 0 ||
      !associated.some(p=>p.number === pr.number &&
        p.head?.repo?.full_name === repository &&
        p.base?.repo?.full_name === repository &&
        p.base?.ref === pr.base.ref && Boolean(p.merged_at))) return false;
  return true;
}

// #4669: a same-PR force-push/retarget replaces the accepted source's Git
// ancestry. GitHub's own HeadRefForcePushedEvent binds the exact accepted
// source to the merged PR head, but that event is not a content proof. Accept
// the relation only when every path the source changed has the identical final
// tree entry (type, mode, blob/submodule SHA) at the merged head, including
// deletions and the old path of renames. The caller still requires independent
// exact-head required Quality on BOTH revisions; this function is never a
// substitute for Quality and never mutates accepted rows.
export async function verifyForcePushedPrSourceRebind(repository, sourceSha, pr,
  token, request = githubRequest) {
  if (!SHA.test(String(sourceSha || '')) || !SHA.test(String(pr?.head?.sha || '')) ||
      sourceSha === pr.head.sha || !pr?.merged_at ||
      !['main','staging','gitops'].includes(pr?.base?.ref) ||
      pr.head?.repo?.full_name !== repository ||
      pr.base?.repo?.full_name !== repository ||
      !Number.isSafeInteger(pr?.number) || !token) return false;
  const {owner,name,prefix}=repoParts(repository);
  // A complete, unpaginated timeline is required. The REST timeline omits the
  // before/after pair, so GraphQL is the canonical proof for this relation.
  const timeline=await request('/graphql',{token,method:'POST',body:{
    query:'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,'+
      'name:$name){pullRequest(number:$number){number merged headRefOid '+
      'timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],first:100){'+
      'pageInfo{hasNextPage} nodes{__typename ... on HeadRefForcePushedEvent{'+
      'beforeCommit{oid} afterCommit{oid}}}}}}}',
    variables:{owner,name,number:pr.number},
  }});
  const pull=timeline?.data?.repository?.pullRequest;
  const nodes=pull?.timelineItems?.nodes;
  if (!pull || pull.number !== pr.number || pull.merged !== true ||
      pull.headRefOid !== pr.head.sha ||
      pull.timelineItems?.pageInfo?.hasNextPage !== false ||
      !Array.isArray(nodes) || nodes.length === 0 ||
      !nodes.some(node=>node?.__typename === 'HeadRefForcePushedEvent' &&
        node.beforeCommit?.oid === sourceSha &&
        node.afterCommit?.oid === pr.head.sha)) return false;
  const divergence=await request(prefix+'/compare/'+sourceSha+'...'+pr.head.sha,{token});
  const base=divergence?.merge_base_commit?.sha;
  if (divergence?.status !== 'diverged' ||
      divergence?.base_commit?.sha !== sourceSha ||
      !SHA.test(String(base || '')) || base === sourceSha || base === pr.head.sha ||
      !Number.isSafeInteger(divergence?.ahead_by) || divergence.ahead_by <= 0 ||
      !Number.isSafeInteger(divergence?.behind_by) || divergence.behind_by <= 0)
    return false;
  const changes=await request(prefix+'/compare/'+base+'...'+sourceSha,{token});
  if (changes?.status !== 'ahead' || changes?.base_commit?.sha !== base ||
      changes?.merge_base_commit?.sha !== base || changes?.behind_by !== 0 ||
      !Number.isSafeInteger(changes?.ahead_by) || changes.ahead_by <= 0 ||
      !Array.isArray(changes?.files) || changes.files.length === 0 ||
      changes.files.length >= 300)
    return false; // GitHub caps compare files at 300; a capped answer is not proof.
  const expected=new Map(), absent=new Set();
  for (const file of changes.files) {
    const path=file?.filename;
    if (typeof path !== 'string' || !path || expected.has(path) || absent.has(path))
      return false;
    const status=file.status;
    if (status === 'removed') { absent.add(path); continue; }
    if (!['added','modified','renamed','copied','changed'].includes(status) ||
        !SHA.test(String(file?.sha || ''))) return false;
    expected.set(path,file.sha);
    if (status === 'renamed') {
      const previous=file?.previous_filename;
      if (typeof previous !== 'string' || !previous || previous === path ||
          expected.has(previous) || absent.has(previous)) return false;
      absent.add(previous);
    }
  }
  if (expected.size + absent.size === 0) return false;
  const [sourceTree,mergedTree]=await Promise.all([
    request(prefix+'/git/trees/'+sourceSha+'?recursive=1',{token}),
    request(prefix+'/git/trees/'+pr.head.sha+'?recursive=1',{token}),
  ]);
  const treeEntries=tree=>{
    if (!tree || tree.truncated !== false || !Array.isArray(tree.tree)) return null;
    const entries=new Map();
    for (const entry of tree.tree) {
      if (entry?.type === 'tree') continue;
      if (typeof entry?.path !== 'string' || !entry.path ||
          !['blob','commit'].includes(entry.type) ||
          !/^(?:100644|100755|120000|160000)$/.test(String(entry.mode || '')) ||
          !SHA.test(String(entry.sha || '')) || entries.has(entry.path)) return null;
      entries.set(entry.path,{type:entry.type,mode:entry.mode,sha:entry.sha});
    }
    return entries;
  };
  const sourceEntries=treeEntries(sourceTree), mergedEntries=treeEntries(mergedTree);
  if (!sourceEntries || !mergedEntries) return false;
  for (const [path,sha] of expected) {
    const sourceEntry=sourceEntries.get(path), mergedEntry=mergedEntries.get(path);
    if (!sourceEntry || sourceEntry.sha !== sha || !mergedEntry ||
        mergedEntry.type !== sourceEntry.type ||
        mergedEntry.mode !== sourceEntry.mode ||
        mergedEntry.sha !== sourceEntry.sha) return false;
  }
  for (const path of absent) {
    if (sourceEntries.has(path) || mergedEntries.has(path)) return false;
  }
  return true;
}

// #4321: an accepted PR-stage SC proof source may ride a *later* merged
// fixture/test PR that builds on the implementing PR. #4160 keeps such a
// `Refs #N` fixture PR out of the implementation relation (it must not block
// closure by target branch), yet the accepted-PR-pin design keeps the SC
// receipt pinned to that fixture commit. Authenticate the descendant source
// only when GitHub associates it with a merged same-repo fixture PR whose head
// provably contains a verified implementing PR head. The caller then requires
// independent exact-head required Quality on that fixture head; the intermediate
// fixture commit is covered by its merged PR head's Quality, not a separate run.
// This never makes a fixture PR an implementation relation and never accepts an
// unrelated or unverified source.
export async function verifyDescendantFixtureSource(repository, sourceSha, implementingPrs,
  token, request = githubRequest) {
  if (!SHA.test(String(sourceSha || '')) || !token ||
      !Array.isArray(implementingPrs)) return null;
  const implHeads = implementingPrs.filter(pr =>
    Boolean(pr?.merged_at) && SHA.test(String(pr?.head?.sha || '')) &&
    ['main','staging','gitops'].includes(pr?.base?.ref) &&
    pr.head?.repo?.full_name === repository &&
    pr.base?.repo?.full_name === repository).map(pr => pr.head.sha);
  if (implHeads.length === 0) return null;
  const {prefix} = repoParts(repository);
  const associated = await request(prefix+'/commits/'+sourceSha+'/pulls?per_page=100', {token});
  if (!Array.isArray(associated) || associated.length >= 100) return null;
  const fixtures = associated.filter(pr => Boolean(pr?.merged_at) &&
    Number.isSafeInteger(pr?.number) && SHA.test(String(pr?.head?.sha || '')) &&
    ['main','staging','gitops'].includes(pr?.base?.ref) &&
    pr.head?.repo?.full_name === repository &&
    pr.base?.repo?.full_name === repository);
  for (const fixture of fixtures) {
    const fixtureHead = fixture.head.sha;
    // sourceSha must sit inside this exact merged fixture PR (strict ancestry).
    if (fixtureHead !== sourceSha) {
      const within = await request(prefix+'/compare/'+sourceSha+'...'+fixtureHead, {token});
      if (within?.base_commit?.sha !== sourceSha ||
          within?.merge_base_commit?.sha !== sourceSha ||
          within?.status !== 'ahead' || within?.behind_by !== 0 ||
          !Number.isSafeInteger(within?.ahead_by) || within.ahead_by <= 0) continue;
    }
    // The fixture PR head must contain a verified implementing PR head.
    for (const implHead of implHeads) {
      if (implHead === fixtureHead) return fixtureHead;
      const contains = await request(prefix+'/compare/'+implHead+'...'+fixtureHead, {token});
      if (contains?.base_commit?.sha === implHead &&
          contains?.merge_base_commit?.sha === implHead &&
          contains?.status === 'ahead' && contains?.behind_by === 0 &&
          Number.isSafeInteger(contains?.ahead_by) && contains.ahead_by > 0) {
        return fixtureHead;
      }
    }
  }
  return null;
}

export async function qualifyIssuePrSourceForClosure(issue, prs, readQuality,
  verifySuccessor = async () => false, verifyDescendant = async () => null,
  verifyRebind = async () => false) {
  const criteria = parseSuccessCriteria(extractSection(issue?.body, 'Success Criteria'));
  const report = parseAcceptanceReport(extractSection(issue?.body, 'Acceptance Report'));
  const plan = validateAcceptancePlan(issue?.body, criteria.criteria.keys(), report.rows);
  if (criteria.errors.length || report.errors.length || plan.errors.length) {
    return {qualified:false, reason:'invalid Issue SC/Acceptance contract'};
  }
  const heads = new Set();
  const successorHeads = new Set();
  for (const [id, sc] of criteria.criteria) {
    const row = report.rows.get(id);
    const stage = plan.plan ? planStage(plan.plan.get(id)) :
      canonicalAcceptanceStage(row?.stage);
    if (stage !== 'pr' || row?.result === 'N/A') continue;
    // decideIssueClosure has already checked all SC states; this method
    // requires the independent exact-HEAD proof for each PR-stage Pass.
    if (!sc.checked || row?.result !== 'Pass') {
      return {qualified:false, reason:id+' is not a qualified PR-stage Pass'};
    }
    const match = /^run [1-9]\d*; ref ([a-f0-9]{40}); source (?:agent(?:-[a-z0-9-]+)?|case-runner);/i
      .exec(String(row.evidence ?? ''));
    if (!match) {
      return {qualified:false, reason:id+' lacks a canonical exact-source PR receipt'};
    }
    const head = match[1].toLowerCase();
    const candidates=Array.isArray(prs) ? prs.filter(pr=>
      Boolean(pr.merged_at) && ['main','staging','gitops'].includes(pr.base?.ref)) : [];
    let authorizedPr=candidates.some(pr=>pr.head?.sha===head);
    let descendantOnly=false;
    if (!authorizedPr) {
      // The older SC source must belong to this exact merged PR. Merely
      // sharing a commit ancestor across unrelated PRs is not sufficient.
      for (const pr of candidates) {
        if (await verifySuccessor(head, pr)) {
          successorHeads.add(pr.head.sha);
          authorizedPr=true;
          break;
        }
      }
    }
    if (!authorizedPr) {
      // #4669: a same-PR force-push/retarget has no Git ancestry. Accept only
      // the authenticated same-PR force-push event plus a byte-identical
      // changed-path tree; the Quality loop below still checks BOTH heads.
      for (const pr of candidates) {
        if (await verifyRebind(head, pr)) {
          successorHeads.add(pr.head.sha);
          authorizedPr=true;
          break;
        }
      }
    }
    if (!authorizedPr) {
      // #4321: the pinned SC source may be a descendant fixture commit riding a
      // later merged fixture PR that contains the implementation. Authenticate
      // that lineage, then require Quality on the merged fixture head only (the
      // intermediate fixture commit has no separate required-Quality run).
      const fixtureHead=await verifyDescendant(head,candidates);
      if (fixtureHead && SHA.test(String(fixtureHead))) {
        successorHeads.add(fixtureHead);
        authorizedPr=true;
        descendantOnly=true;
      }
    }
    if (!authorizedPr) {
      return {qualified:false,
        reason:id+' accepted source HEAD lacks an authenticated merged-PR successor '+
          'or content-preserving force-push rebind'};
    }
    if (!descendantOnly) heads.add(head);
  }
  const allHeads=new Set([...heads,...successorHeads]);
  if (allHeads.size > 16) return {qualified:false, reason:'too many PR Quality sources'};
  for (const head of allHeads) {
    // readQuality is always a trusted GitHub Run/Job/Step reader in production.
    const evidence = await readQuality(head);
    if (evidence?.status !== 'pass' ||
        !validPrRequiredQualityReceipt(evidence.receipt, head)) {
      return {qualified:false,
        reason:'accepted PR source '+head+' lacks independently verified required Quality'};
    }
  }
  return {qualified:true, sources:[...heads], verified_successors:[...successorHeads]};
}

// Native GitHub PR closing keywords can close an Issue outside our trusted
// reconcileIssue path. The issues:closed guard must consume the SAME merged
// implementation+exact-HEAD Quality policy rather than checked rows alone.
export async function assessNativeCompletedIssueSource(repository, number, token, {
  request = githubRequest, qualityReader = null,
} = {}) {
  const {prefix} = repoParts(repository);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw Error('invalid native Issue number');
  const issue = await request(prefix + '/issues/' + number, {token});
  if (!issue || issue.number !== number) throw Error('native Issue identity mismatch');
  if (issue.state !== 'closed' || issue.state_reason === 'not_planned' ||
      !isAcceptanceIssue(issue) || issue.pull_request)
    return {qualified:true, reason:'not a completed native Acceptance Issue'};
  // A native premature close cannot evade the orphan source and SC-01 Quality
  // contract. Reject it and let the existing closed-Issue guard restore state.
  if(number===4241) {
    const target=accepted4241Target(issue);
    if(!target||completedIssueAcceptanceDecision({...issue,state:'open'}).kind!=='accepted')
      return {qualified:false,reason:'toolchains SCs not formally accepted'};
    const proof=await sourceProof4241(repository,target,token,request);
    const original=await request(prefix+'/pulls/'+proof.historical_sc01.pr,{token});
    const quality=await qualifyIssuePrSourceForClosure(issue,[original],
      qualityReader??(sha=>collectPrRequiredQualityAsync(sha,
        path=>request(path,{token}))));
    return quality.qualified
      ? {qualified:true,reason:'authenticated orphan GHCR source + historical PR Quality'}
      : {qualified:false,reason:'toolchains SC-01 Quality: '+quality.reason};
  }
  const prs = await relatedPulls(repository, number, token, null, request);
  const decision = decideIssueClosure({...issue,state:'open'},prs);
  if (decision.action !== 'close')
    return {qualified:false,reason:'canonical Issue lifecycle: '+decision.reason};
  const qualified = await qualifyIssuePrSourceForClosure(issue,prs,
    qualityReader ?? (sha => collectPrRequiredQualityAsync(sha,
      path => request(path, {token}))),
    (head,pr)=>verifyHistoricalPrSourceSuccessor(repository,head,pr,token,request),
    (head,implPrs)=>verifyDescendantFixtureSource(repository,head,implPrs,token,request),
    (head,pr)=>verifyForcePushedPrSourceRebind(repository,head,pr,token,request));
  if (!qualified.qualified) {
    return {qualified:false,reason:'PR source Quality: '+qualified.reason};
  }
  if (number === 4059) {
    const writer = await qualifyConvergenceWriter4059Closure(repository, issue, token, request);
    if (!writer.qualified) {
      return {qualified:false,reason:'convergence writer: '+writer.reason};
    }
  }
  return {qualified:true,reason:'merged source and Quality verified'};
}

async function reconcileIssue(repository, number, token, { includePr = null,
  request = githubRequest, qualityReader = null } = {}) {
  const { prefix } = repoParts(repository);
  const issue = await request(prefix + '/issues/' + number, { token });
  if (!issue || issue.number !== number) throw Error('Issue number mismatch');
  if (issue.state !== 'open' || !isAcceptanceIssue(issue) || issue.pull_request) {
    return { action: 'skip', reason: 'not an open native acceptance Issue' };
  }
  // #4297: an explicitly allowlisted orphan catalog has no fabricated Main
  // implementing PR. Complete the ordinary SC Gate first, re-authenticate
  // every source and the historical PR-stage Quality, then let this SAME
  // deterministic Issue writer perform the only closure mutation.
  if(number===4241) {
    const labels=(issue.labels||[]).map(x=>typeof x==='string'?x:x.name);
    if(labels.includes('status:blocked')||labels.includes('status:on-hold'))
      return {action:'pending',reason:'explicit blocking status'};
    const manualReopened=await humanReopened(repository,number,token,request);
    if(manualReopened)return {action:'pending',reason:'human reopened Issue'};
    const target=accepted4241Target(issue);
    if(!target||completedIssueAcceptanceDecision(issue).kind!=='accepted')
      return {action:'pending',reason:'toolchains formal Acceptance SC-02..05 pending'};
    const proof=await sourceProof4241(repository,target,token,request);
    const sc01=await request(prefix+'/pulls/'+proof.historical_sc01.pr,{token});
    const qualified=await qualifyIssuePrSourceForClosure(issue,[sc01],
      qualityReader??(sha=>collectPrRequiredQualityAsync(sha,
        path=>request(path,{token}))));
    if(!qualified.qualified)return {action:'pending',reason:'historical SC-01 Quality: '+qualified.reason};
    const fresh=await request(prefix+'/issues/'+number,{token});
    if(fresh?.state!=='open'||fresh?.updated_at!==issue.updated_at)
      return {action:'pending',reason:'Issue changed during source reconciliation'};
    await request(prefix+'/issues/'+number,{token,method:'PATCH',
      body:{state:'closed',state_reason:'completed'}});
    return {action:'closed',reason:'authenticated toolchains source, 14 GHCR receipts, SC Gate and historical PR Quality',
      prs:proof.orphan_prs.map(x=>x.number)};
  }
  const prs = await relatedPulls(repository, number, token, includePr, request);
  const manualReopened = await humanReopened(repository, number, token, request);
  const decision = decideIssueClosure(issue, prs, { manualReopened });
  if (decision.action !== 'close') return { ...decision, prs: prs.map(pr => pr.number) };
  const qualified = await qualifyIssuePrSourceForClosure(issue, prs,
    qualityReader ?? (head => collectPrRequiredQualityAsync(head,
      path => request(path, {token}))),
    (head,pr)=>verifyHistoricalPrSourceSuccessor(repository,head,pr,token,request),
    (head,implPrs)=>verifyDescendantFixtureSource(repository,head,implPrs,token,request),
    (head,pr)=>verifyForcePushedPrSourceRebind(repository,head,pr,token,request));
  if (!qualified.qualified) {
    return {action:'pending', reason:'PR source Quality: '+qualified.reason,
      prs:prs.map(pr => pr.number)};
  }
  if (number === 4059) {
    const writer = await qualifyConvergenceWriter4059Closure(repository, issue, token, request);
    if (!writer.qualified) {
      return {action:'pending', reason:'convergence writer: '+writer.reason,
        prs:prs.map(pr => pr.number)};
    }
  }
  // Re-read before mutation: a later Issue edit or reopen must not be raced by
  // a stale evaluation. GitHub's Issues API has no compare-and-set PATCH.
  const fresh = await request(prefix + '/issues/' + number, { token });
  if (fresh.state !== 'open' || fresh.updated_at !== issue.updated_at) {
    return { action: 'pending', reason: 'Issue changed during reconciliation; retry on fresh evidence' };
  }
  await request(prefix + '/issues/' + number, {
    token, method: 'PATCH', body: { state: 'closed', state_reason: 'completed' },
  });
  return { action: 'closed', reason: decision.reason, prs: prs.map(pr => pr.number) };
}

// Owner /accept may request a *new* PR Acceptance only when every locked,
// already-Pass PR-stage source at the previous SHA had actually failed exact
// Quality and current HEAD is a verified descendant in the SAME merged PR.
// verifyManualAcceptedPrAnchors authenticates same-PR ancestry separately;
// this selector never fabricates a Result or touches accepted Issue rows.
export async function qualifyManualFailedQualityRecovery(issue, targetSha,
  acceptedPrAnchors, readQuality) {
  if (!SHA.test(String(targetSha || '')) ||
      !Array.isArray(acceptedPrAnchors) ||
      typeof readQuality !== 'function') return false;
  const report = parseAcceptanceReport(extractSection(issue?.body, 'Acceptance Report'));
  const criteria = parseSuccessCriteria(extractSection(issue?.body, 'Success Criteria'));
  const plan = validateAcceptancePlan(issue?.body, criteria.criteria.keys(), report.rows);
  if (report.errors.length || criteria.errors.length || plan.errors.length ||
      !plan.plan) return false;
  const accepted = [];
  for (const [id, entry] of plan.plan) {
    if (planStage(entry) !== 'pr' || entry.method !== 'agent') continue;
    const row = report.rows.get(id);
    if (!criteria.criteria.get(id)?.checked || row?.result !== 'Pass') continue;
    const match = /^run [1-9]\d*; ref ([a-f0-9]{40}); source agent(?:-[a-z0-9-]+)?;/i
      .exec(String(row.evidence ?? ''));
    if (!match) return false;
    accepted.push(match[1].toLowerCase());
  }
  const previous = [...new Set(accepted)];
  if (previous.length !== 1 || previous[0] === targetSha ||
      !acceptedPrAnchors.includes(previous[0])) return false;
  const oldQuality = await readQuality(previous[0]);
  if (oldQuality?.status !== 'fail') return false;
  const currentQuality = await readQuality(targetSha);
  return currentQuality?.status === 'pass' &&
    validPrRequiredQualityReceipt(currentQuality.receipt, targetSha);
}

// Comment Router deliberately acknowledges after dispatch/run discovery.
// A /accept worker can start first; wait for the exact trusted acknowledgment
// BEFORE snapshotting updated_at, without weakening the final freshness guard.
export async function waitForAcceptRouterAck(repository, issueNumber, commentId, token, {
  request = githubRequest,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  attempts = 20,
} = {}) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 ||
      !Number.isSafeInteger(commentId) || commentId <= 0 ||
      !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20)
    throw Error('invalid /accept acknowledgment boundary');
  const { prefix } = repoParts(repository);
  const marker = '\n\n<!-- nession-command-comment:' + commentId + ' -->';
  for (let attempt = 0; attempt < attempts; attempt++) {
    const comments = await request(prefix + '/issues/' + issueNumber +
      '/comments?per_page=100&sort=created&direction=desc', { token });
    if (!Array.isArray(comments) || comments.length > 100)
      throw Error('unbounded /accept router acknowledgment inventory');
    if (comments.some(comment =>
      comment?.user?.type === 'Bot' &&
      comment.user.login === 'github-actions[bot]' &&
      typeof comment.body === 'string' &&
      comment.body.startsWith('Comment command `/accept') &&
      comment.body.includes(' accepted for Issue #' + issueNumber + '.') &&
      comment.body.includes(marker))) return true;
    if (attempt + 1 < attempts) await pause(1000);
  }
  return false;
}

async function handleManual(event, repository, actor, token, request = githubRequest) {
  const command = resolveAcceptComment(event, repository, actor);
  if (!command) return { action: 'skip', reason: 'untrusted or non-/accept comment' };
  if (process.env.GITHUB_RUN_ATTEMPT && process.env.GITHUB_RUN_ATTEMPT !== '1') {
    return { action: 'skip', reason: 'manual dispatch is first-attempt only' };
  }
  // Router acknowledgment comments change Issue.updated_at. Snapshot only
  // after this exact comment's receipt is visible, or fail closed.
  if (!await waitForAcceptRouterAck(repository, command.issueNumber,
    command.commentId, token, { request })) {
    return { action: 'pending', reason: 'source-bound Comment Router acknowledgment not visible' };
  }
  const { prefix } = repoParts(repository);
  // The fresh /accept must be newer than the latest human reopen; a delayed
  // workflow for an older comment cannot override a later user hold.
  const result = await reconcileIssue(repository, command.issueNumber, token,
    { request });
  if (result.action !== 'pending') return result;
  if (await humanReopened(repository, command.issueNumber, token, request)) {
    return { action: 'pending', reason: 'later human reopen supersedes this /accept' };
  }
  const issue = await request(prefix + '/issues/' + command.issueNumber, { token });
  const labels = (issue.labels || []).map(x => typeof x === 'string' ? x : x.name);
  if (labels.includes('status:blocked') || labels.includes('status:on-hold')) {
    return { action: 'pending', reason: 'explicit blocker prevents manual re-dispatch' };
  }
  if(command.issueNumber===4241) {
    // Owner input is intent only. No arbitrary source ref, Issue claim, or
    // historical failed Publisher Run can authorize a new acceptance Agent.
    if(!command.targetMainSha||command.targetPrSha||
        command.replacementOldPr!=null||command.replacementNewPr!=null)
      return {action:'pending',reason:'toolchains requires explicit post-merge main SHA'};
    const proof=await sourceProof4241(repository,command.targetMainSha,token,request);
    const criteria=parseSuccessCriteria(extractSection(issue.body,'Success Criteria'));
    const report=parseAcceptanceReport(extractSection(issue.body,'Acceptance Report'));
    const plan=validateAcceptancePlan(issue.body,criteria.criteria.keys(),report.rows);
    if(criteria.errors.length||report.errors.length||plan.errors.length||!plan.plan)
      throw Error('toolchains Acceptance Plan contract invalid');
    const pending=['SC-02','SC-03','SC-04','SC-05'].filter(id=>{
      const row=report.rows.get(id),criterion=criteria.criteria.get(id);
      return row&&!(['Pass','N/A'].includes(row.result)&&criterion?.checked);
    });
    if(!pending.length)
      return {action:'pending',reason:'toolchains has no pending post-merge SCs'};
    for(const id of pending){
      const entry=plan.plan.get(id);
      if(!entry||entry.method!=='agent'||planStage(entry)!=='post-merge')
        throw Error('unexpected toolchains Acceptance method/stage '+id);
    }
    await request(prefix+'/actions/workflows/agent-sc-acceptance.yml/dispatches',{
      token,method:'POST',body:{ref:'main',inputs:{
        issue_number:'4241',stage:'post-merge',target_ref:proof.target_sha,
        provider:'',deployment:''}}});
    return {action:'dispatched',reason:'authenticated orphan catalog and publisher evidence',
      agent_runs:[{stage:'post-merge',target_ref:proof.target_sha}],
      diagnostics:[],note:'only deterministic projector may update SCs'};
  }
  const prs = await relatedPulls(repository, command.issueNumber, token, null, request);
  const sourcePrs = await verifiedManualSourcePulls(repository, command.issueNumber,
    prs, token, request);
  const verifiedMainSha = command.targetMainSha
    ? await verifyManualPostMergeTarget(repository, command.targetMainSha, sourcePrs,
      token, request) : null;
  // Do not trust caller-supplied SHA by itself. verifiedManualSourcePulls
  // already checks GitHub's exact commit→PR association and repository
  // identity; require a completed implementation merge as well.
  const verifiedPrSha = command.targetPrSha && sourcePrs.some(pr =>
    pr.merged_at && pr.head?.sha === command.targetPrSha)
    ? command.targetPrSha : null;
  if (command.targetPrSha && !verifiedPrSha) {
    throw Error('unverified or unmerged Issue-linked exact PR head');
  }
  // Explicit independent replacement never infers old source ancestry.
  // Re-attest the exact historical and new merged PRs from GitHub; only a
  // separately trusted Agent may re-evaluate each checked old SC at new HEAD.
  const replacement = command.replacementOldPr != null &&
    command.replacementNewPr != null
    ? await verifyIndependentReplacement(repository, issue,
        command.replacementOldPr, command.replacementNewPr,
        command.commentId, token, request) : null;
  if (replacement) {
    const quality = await collectPrRequiredQualityAsync(replacement.target_ref,
      path => request(path, {token}));
    if (quality?.status !== 'pass' ||
        !validPrRequiredQualityReceipt(quality.receipt,replacement.target_ref))
      return {action:'pending',reason:'replacement exact-HEAD required Quality is not independently green'};
  }
  const verifiedPrAnchors = verifiedPrSha
    ? await verifyManualAcceptedPrAnchors(repository, issue, sourcePrs,
      verifiedPrSha, token, request) : [];
  const diagnostics = [];
  if (!sourcePrs.length && prs.length)
    diagnostics.push('reference-only or unverified PR: no source-aligned implementation');
  const directlySelected = selectManualAgentRuns(issue, sourcePrs,
    { verifiedMainSha, verifiedPrSha, verifiedPrAnchors, diagnostics });
  // A historical model Pass from a FAILED exact-HEAD Quality run must not
  // permanently lock the same merged implementing PR after a green repair.
  // The trusted evaluator independently selects and re-attests the stale
  // criteria; no old Reviewer/SC record is promoted by this dispatch.
  if (verifiedPrSha && !directlySelected.some(x => x.stage === 'pr') &&
      await qualifyManualFailedQualityRecovery(issue, verifiedPrSha,
        verifiedPrAnchors, sha => collectPrRequiredQualityAsync(sha,
          path => request(path, {token})))) {
    directlySelected.push({stage:'pr',target_ref:verifiedPrSha});
  }
  // Never invent a staging association. When the source PR was correctly
  // merged to main (e.g. scripts-only), authenticate its actual ancestry in
  // staging before scheduling the pending merged/staging Agent criterion.
  const verifiedStagingSha = directlySelected.some(run => run.stage === 'staging')
    ? null : await verifiedStagingTargetForMainPR(repository, sourcePrs, token, request);
  const runs = verifiedStagingSha
    ? selectManualAgentRuns(issue, sourcePrs,
      { verifiedStagingSha, verifiedMainSha, verifiedPrSha, verifiedPrAnchors, diagnostics })
    : directlySelected;
  const finalRuns = replacement
    ? [{stage:'pr',target_ref:replacement.target_ref}] : runs;
  for (const run of finalRuns) {
    await request(prefix + '/actions/workflows/agent-sc-acceptance.yml/dispatches', {
      token, method: 'POST',
      body: { ref: 'main', inputs: {
        issue_number: String(command.issueNumber), stage: run.stage,
        target_ref: run.target_ref, provider: '', deployment: '',
        ...(replacement ? {source_replacement_comment_id:String(replacement.comment_id)} : {}),
      }},
    });
  }
  return { action: finalRuns.length ? 'dispatched' : 'pending', reason: result.reason,
    agent_runs: finalRuns, diagnostics,
    note: 'Case/deployed proof remains with its existing trusted runner' };
}

async function selfTest() {
  // Fixture runs are not a manual workflow dispatch. A rerun's ambient
  // GITHUB_RUN_ATTEMPT=2 must not change deterministic mock expectations,
  // while handleManual still rejects real manual retries.
  const originalAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ATTEMPT = '1';
  const sha = 'a'.repeat(40);
  const body = '## Success Criteria\n- [x] SC-01 acceptance is proven\n\n## Acceptance Plan\n\n' +
  '\x60\x60\x60yaml\nacceptance:\n  SC-01:\n    when: pr\n    method: agent\n\x60\x60\x60\n\n' +
  '## Acceptance Report\n\n| Criterion | Result | Evidence |\n|---|---|---|\n' +
  '| SC-01 | Pass | run 100; ref ' + sha + '; source agent-qwen; test: exact SHA fixture |\n';
  const issue = { number: 19, state: 'open', labels: [{ name: 'bug' }], body };
  const pr = { number: 21, title: 'fix (#19)', body: 'Fixes #19', head: { sha },
    base: { ref: 'staging' }, merged_at: '2026-11-11T01:00:00Z', merge_commit_sha: sha };
  // #4146: signed SC Pass alone cannot close an Issue when the exact
  // implementing PR head failed Quality or no longer matches the merged PR.
  const qualityReceipt = {
    kind:'pr_required_quality_v1', repository:'BestNathan/nession',
    workflow:'.github/workflows/ci-quality.yml', head_sha:sha,
    result:'success', run_id:101, run_attempt:1, scope_job_id:102,
    web_check_job_id:103,
    scope_step:'Classify the exact PR or main-push change',
    web_check_step:'Enforce applicable Quality results at the stable check name',
    job_outcomes:{'instruction-check':'skipped','workflow-check':'skipped',
      'rust-check':'skipped','tooling-check':'success','web-tests':'skipped'},
  };
  const fixtureQuality = async head => ({status:'pass',
    receipt:{...qualityReceipt,head_sha:head}});
  assert.equal((await qualifyIssuePrSourceForClosure(issue,[pr],fixtureQuality)).qualified,
    true,'source-aligned qualified PR is eligible for eventual closure');
  for (const blocked of [
    {prs:[{...pr,head:{sha:'b'.repeat(40)}}],reader:fixtureQuality},
    {prs:[pr],reader:async()=>({status:'fail',reason:'#4143 web-check failure'})},
    {prs:[pr],reader:async()=>({status:'pending',reason:'CI in progress'})},
    {prs:[pr],reader:async()=>({status:'pass',receipt:{
      ...qualityReceipt,head_sha:'b'.repeat(40)}})},
    {prs:[pr],reader:async()=>({status:'pass',receipt:{
      ...qualityReceipt,run_attempt:0}})},
    {prs:[{...pr,merged_at:null}],reader:fixtureQuality},
  ]) assert.equal((await qualifyIssuePrSourceForClosure(issue,blocked.prs,
    blocked.reader)).qualified,false,
    'failed/pending/stale Quality or amended/nonmerged head cannot close');

  // Historical accepted PR head is immutable; a later reviewed two-parent
  // merge-base refresh changes the final PR head. Independently attest both
  // the old accepted Quality and the *final* required Quality before closure.
  const successorSha='b'.repeat(40);
  const advancedPr={...pr,head:{sha:successorSha}};
  const verifiedFixtureSuccessor=async (oldHead,newPr)=>
    oldHead===sha && newPr.number===pr.number &&
    newPr.head.sha===successorSha && Boolean(newPr.merged_at);
  const futureQualified=await qualifyIssuePrSourceForClosure(issue,[advancedPr],
    fixtureQuality,verifiedFixtureSuccessor);
  assert.equal(futureQualified.qualified,true,
    'same-PR verified ancestral source and independent exact-head Quality qualify');
  assert.deepEqual(futureQualified.verified_successors,[successorSha]);
  assert.equal((await qualifyIssuePrSourceForClosure(issue,[advancedPr],
    fixtureQuality,async()=>false)).qualified,false,
    'unverified ancestry never inherits an SC Pass');
  assert.equal((await qualifyIssuePrSourceForClosure(issue,[advancedPr],
    async head=>head===sha?await fixtureQuality(head):{status:'fail'},
    verifiedFixtureSuccessor)).qualified,false,
    'a failed final PR Quality cannot borrow earlier accepted green evidence');
  const changedPr={...advancedPr,number:pr.number+1};
  assert.equal((await qualifyIssuePrSourceForClosure(issue,[changedPr],
    fixtureQuality,verifiedFixtureSuccessor)).qualified,false,
    'source from a different PR number is not a signed successor');
  assert.equal((await qualifyIssuePrSourceForClosure(issue,
    [{...advancedPr,merged_at:null}],fixtureQuality,
    verifiedFixtureSuccessor)).qualified,false,
    'an unmerged later PR head remains unqualified');
  const sameRepo={full_name:'BestNathan/nession'};
  const assocPr={...advancedPr,head:{sha:successorSha,repo:sameRepo},
    base:{ref:'main',repo:sameRepo}};
  const readHistoric=async path=>{
    if(path.includes('/compare/'))return {base_commit:{sha},
      merge_base_commit:{sha},status:'ahead',behind_by:0,ahead_by:2};
    if(path.includes('/commits/'))return [{number:assocPr.number,merged_at:pr.merged_at,
      head:{repo:sameRepo},base:{ref:'main',repo:sameRepo}}];
    throw Error('unexpected history evidence path');
  };
  assert.equal(await verifyHistoricalPrSourceSuccessor('BestNathan/nession',
    sha,assocPr,'fixture-token',readHistoric),true);
  assert.equal(await verifyHistoricalPrSourceSuccessor('Unrelated/repository',
    sha,assocPr,'fixture-token',async()=>{throw Error('should not query foreign repo');}),
    false,'foreign repository cannot confer accepted source authority');
  assert.equal(await verifyHistoricalPrSourceSuccessor('BestNathan/nession',
    sha,assocPr,'fixture-token',async path=>
      path.includes('/compare/') ? {base_commit:{sha},merge_base_commit:{sha},
        status:'diverged',behind_by:1,ahead_by:2} :
      [{number:assocPr.number,merged_at:pr.merged_at,head:{repo:sameRepo},
        base:{ref:'main',repo:sameRepo}}]),false,
    'diverged unrelated history cannot confer a signed SC');
  assert.equal(await verifyHistoricalPrSourceSuccessor('BestNathan/nession',
    sha,assocPr,'fixture-token',async path=>
      path.includes('/compare/') ? {base_commit:{sha},merge_base_commit:{sha},
        status:'ahead',behind_by:0,ahead_by:2} :
      [{number:assocPr.number+1,merged_at:pr.merged_at,head:{repo:sameRepo},
        base:{ref:'main',repo:sameRepo}}]),false,
    'ancestor source associated with a different PR is not accepted');

  // #4669: a same-PR force-push/retarget has no Git ancestry to the accepted
  // source. The positive fixture requires the exact GitHub force-push pair and
  // identical final tree entries for every changed path. Negative fixtures
  // reject every partial proof; both heads still need exact-head Quality.
  const rebindBase='e'.repeat(40);
  const modifiedBlob='1'.repeat(40), addedBlob='2'.repeat(40), renamedBlob='3'.repeat(40);
  const rebindTimeline={data:{repository:{pullRequest:{number:assocPr.number,
    merged:true,headRefOid:successorSha,timelineItems:{pageInfo:{hasNextPage:false},
      nodes:[{__typename:'HeadRefForcePushedEvent',beforeCommit:{oid:sha},
        afterCommit:{oid:successorSha}}]}}}}};
  const rebindDivergence={status:'diverged',base_commit:{sha},
    merge_base_commit:{sha:rebindBase},ahead_by:2,behind_by:3};
  const rebindChanges={status:'ahead',base_commit:{sha:rebindBase},
    merge_base_commit:{sha:rebindBase},behind_by:0,ahead_by:2,files:[
      {filename:'scripts/modified.mjs',status:'modified',sha:modifiedBlob},
      {filename:'scripts/added.mjs',status:'added',sha:addedBlob},
      {filename:'scripts/renamed.mjs',status:'renamed',sha:renamedBlob,
        previous_filename:'scripts/old-name.mjs'},
      {filename:'scripts/removed.mjs',status:'removed'},
    ]};
  const treeEntry=(path,mode,blob)=>({path,type:'blob',mode,sha:blob});
  const rebindSourceTree={truncated:false,tree:[
    {path:'scripts',type:'tree',mode:'040000',sha:'a'.repeat(40)},
    treeEntry('scripts/modified.mjs','100644',modifiedBlob),
    treeEntry('scripts/added.mjs','100644',addedBlob),
    treeEntry('scripts/renamed.mjs','100755',renamedBlob),
  ]};
  const rebindMergedTree={truncated:false,tree:[
    ...rebindSourceTree.tree,
    treeEntry('scripts/staging-only.mjs','100644','4'.repeat(40)),
  ]};
  const treeWithout=(tree,path)=>({...tree,
    tree:tree.tree.filter(entry=>entry.path!==path)});
  const treeWith=(tree,...entries)=>({...tree,tree:[
    ...tree.tree.filter(entry=>!entries.some(replacement=>replacement.path===entry.path)),
    ...entries]});

  const repoPrefix='/repos/BestNathan/nession';
  const rebindRead=(overrides={})=>async path=>{
    if(path==='/graphql')return overrides.timeline??rebindTimeline;
    if(path===repoPrefix+'/compare/'+sha+'...'+successorSha)
      return overrides.divergence??rebindDivergence;
    if(path===repoPrefix+'/compare/'+rebindBase+'...'+sha)
      return overrides.changes??rebindChanges;
    if(path===repoPrefix+'/git/trees/'+sha+'?recursive=1')
      return overrides.sourceTree??rebindSourceTree;
    if(path===repoPrefix+'/git/trees/'+successorSha+'?recursive=1')
      return overrides.mergedTree??rebindMergedTree;
    throw Error('unexpected force-push rebind evidence path '+path);
  };
  const rebind=(overrides={})=>verifyForcePushedPrSourceRebind('BestNathan/nession',
    sha,assocPr,'fixture-token',rebindRead(overrides));
  assert.equal(await rebind(),true,
    'same-PR force-push pair and identical changed-path tree qualify');
  const rebindQualifier=(overrides={},reader=fixtureQuality)=>
    qualifyIssuePrSourceForClosure(issue,[assocPr],reader,async()=>false,async()=>null,
      (head,pr)=>verifyForcePushedPrSourceRebind('BestNathan/nession',head,pr,
        'fixture-token',rebindRead(overrides)));
  const rebound=await rebindQualifier();
  assert.equal(rebound.qualified,true,
    'closure accepts a content-preserving same-PR force-push rebind');
  assert.deepEqual(rebound.sources,[sha]);
  assert.deepEqual(rebound.verified_successors,[successorSha]);
  assert.equal((await rebindQualifier({}, async head=>head===successorSha
    ? {status:'fail'} : await fixtureQuality(head))).qualified,false,
    'the merged force-push head still needs independent exact-head Quality');
  assert.equal((await rebindQualifier({}, async head=>head===sha
    ? {status:'fail'} : await fixtureQuality(head))).qualified,false,
    'the accepted force-pushed source still needs its own exact-head Quality');
  assert.equal(await verifyForcePushedPrSourceRebind('BestNathan/nession',
    sha,{...assocPr,merged_at:null},'fixture-token',async()=>{
      throw Error('unmerged PR must not query force-push history');
    }),false,'an unmerged PR cannot authorize a force-push rebind');
  assert.equal(await verifyForcePushedPrSourceRebind('BestNathan/nession',
    successorSha,assocPr,'fixture-token',async()=>{
      throw Error('same-head relation must not query force-push history');
    }),false,'an identical source and head is not a force-push rebind');
  assert.equal(await verifyForcePushedPrSourceRebind('Unrelated/repository',
    sha,assocPr,'fixture-token',async()=>{
      throw Error('foreign repository must not be queried');
    }),false,'a foreign repository cannot confer force-push authority');
  assert.equal(await verifyForcePushedPrSourceRebind('BestNathan/nession',sha,
    {...assocPr,head:{...assocPr.head,repo:{full_name:'attacker/fork'}}},
    'fixture-token',async()=>{throw Error('foreign head must not be queried');}),false);
  assert.equal(await verifyForcePushedPrSourceRebind('BestNathan/nession',sha,
    {...assocPr,base:{ref:'feature',repo:sameRepo}},'fixture-token',
    async()=>{throw Error('invalid base must not be queried');}),false);
  for (const [name,overrides] of [
    ['missing force-push pair',{timeline:{data:{repository:{pullRequest:{
      number:assocPr.number,merged:true,headRefOid:successorSha,
      timelineItems:{pageInfo:{hasNextPage:false},nodes:[]}}}}}}],
    ['reversed force-push pair',{timeline:{data:{repository:{pullRequest:{
      number:assocPr.number,merged:true,headRefOid:successorSha,
      timelineItems:{pageInfo:{hasNextPage:false},nodes:[{__typename:
        'HeadRefForcePushedEvent',beforeCommit:{oid:successorSha},
        afterCommit:{oid:sha}}]}}}}}}],
    ['paginated force-push history',{timeline:{data:{repository:{pullRequest:{
      number:assocPr.number,merged:true,headRefOid:successorSha,
      timelineItems:{pageInfo:{hasNextPage:true},nodes:[{__typename:
        'HeadRefForcePushedEvent',beforeCommit:{oid:sha},
        afterCommit:{oid:successorSha}}]}}}}}}],
    ['different merged head',{timeline:{data:{repository:{pullRequest:{
      number:assocPr.number,merged:true,headRefOid:sha,
      timelineItems:{pageInfo:{hasNextPage:false},nodes:[{__typename:
        'HeadRefForcePushedEvent',beforeCommit:{oid:sha},
        afterCommit:{oid:successorSha}}]}}}}}}],
    ['different pull request',{timeline:{data:{repository:{pullRequest:{
      number:assocPr.number+1,merged:true,headRefOid:successorSha,
      timelineItems:{pageInfo:{hasNextPage:false},nodes:[{__typename:
        'HeadRefForcePushedEvent',beforeCommit:{oid:sha},
        afterCommit:{oid:successorSha}}]}}}}}}],
    ['ancestral not diverged',{divergence:{...rebindDivergence,status:'ahead'}}],
    ['wrong origin revision',{divergence:{...rebindDivergence,
      base_commit:{sha:successorSha}}}],
    ['missing merge base',{divergence:{...rebindDivergence,
      merge_base_commit:{sha:'not-a-sha'}}}],
    ['no unique merged commits',{divergence:{...rebindDivergence,behind_by:0}}],
    ['changed-path comparison behind',{changes:{...rebindChanges,behind_by:1}}],
    ['empty changed-path comparison',{changes:{...rebindChanges,files:[]}}],
    ['capped changed-path comparison',{changes:{...rebindChanges,files:
      Array.from({length:300},(_,i)=>({filename:'scripts/f'+i+'.mjs',
        status:'added',sha:'5'.repeat(40)}))}}],
    ['unknown changed-path status',{changes:{...rebindChanges,files:[
      {filename:'scripts/modified.mjs',status:'unchanged',sha:modifiedBlob}]}}],
    ['deleted path retained at merged head',{mergedTree:{truncated:false,tree:[
      ...rebindMergedTree.tree,treeEntry('scripts/removed.mjs','100644',
        '6'.repeat(40))]}}],
    ['renamed-away path retained at merged head',{mergedTree:{truncated:false,
      tree:[...rebindMergedTree.tree,treeEntry('scripts/old-name.mjs','100644',
        '7'.repeat(40))]}}],
    ['changed blob differs at merged head',{mergedTree:treeWith(rebindMergedTree,
      treeEntry('scripts/modified.mjs','100644','8'.repeat(40)))}],
    ['changed mode differs at merged head',{mergedTree:treeWith(rebindMergedTree,
      treeEntry('scripts/renamed.mjs','100644',renamedBlob))}],
    ['source tree missing a changed path',{sourceTree:
      treeWithout(rebindSourceTree,'scripts/modified.mjs')}],
    ['source tree blob disagrees with compare',{sourceTree:treeWith(rebindSourceTree,
      treeEntry('scripts/modified.mjs','100644','9'.repeat(40)))}],
    ['merged tree truncated',{mergedTree:{...rebindMergedTree,truncated:true}}],
    ['source tree truncated',{sourceTree:{...rebindSourceTree,truncated:true}}],
  ]) assert.equal(await rebind(overrides),false,
    'force-push rebind fails closed on '+name);

  // #4321: a pinned SC source riding a later merged fixture PR that contains the
  // implementing head qualifies via the descendant path. Required Quality is
  // verified on the merged fixture head; the intermediate fixture commit has no
  // separate required-Quality run and is covered by its merged PR head.
  const descendantFixtureHead='c'.repeat(40);
  const verifiedFixtureDescendant=async (oldHead,implPrs)=>
    oldHead===sha && Array.isArray(implPrs) && implPrs.some(p=>p.head?.sha===successorSha)
      ? descendantFixtureHead : null;
  const descendantQualified=await qualifyIssuePrSourceForClosure(issue,[advancedPr],
    fixtureQuality,async()=>false,verifiedFixtureDescendant);
  assert.equal(descendantQualified.qualified,true,
    'descendant fixture source containing the implementing head qualifies');
  assert.deepEqual(descendantQualified.verified_successors,[descendantFixtureHead]);
  assert.deepEqual(descendantQualified.sources,[],
    'the intermediate fixture commit is covered by its merged head Quality, not a separate run');
  assert.equal((await qualifyIssuePrSourceForClosure(issue,[advancedPr],
    fixtureQuality,async()=>false,async()=>null)).qualified,false,
    'an unverified descendant fixture source never inherits an SC Pass');
  assert.equal((await qualifyIssuePrSourceForClosure(issue,[advancedPr],
    async head=>head===descendantFixtureHead?{status:'fail'}:await fixtureQuality(head),
    async()=>false,verifiedFixtureDescendant)).qualified,false,
    'failed merged fixture head Quality cannot close via the descendant path');
  assert.equal((await qualifyIssuePrSourceForClosure(issue,[advancedPr],
    fixtureQuality,async()=>false)).qualified,false,
    'the default no-op descendant verifier preserves prior fail-closed behavior');

  const implPr={...advancedPr,head:{sha:successorSha,repo:sameRepo},
    base:{ref:'main',repo:sameRepo}};
  const fixturePr={number:99,merged_at:pr.merged_at,
    head:{sha:descendantFixtureHead,repo:sameRepo},base:{ref:'staging',repo:sameRepo}};
  const aheadOf=baseSha=>({base_commit:{sha:baseSha},merge_base_commit:{sha:baseSha},
    status:'ahead',behind_by:0,ahead_by:2});
  const descendantRead=async path=>{
    if(path.includes('/commits/'+sha+'/pulls'))return [fixturePr];
    if(path.includes('/compare/'+sha+'...'+descendantFixtureHead))return aheadOf(sha);
    if(path.includes('/compare/'+successorSha+'...'+descendantFixtureHead))return aheadOf(successorSha);
    throw Error('unexpected descendant evidence path '+path);
  };
  assert.equal(await verifyDescendantFixtureSource('BestNathan/nession',sha,[implPr],
    'fixture-token',descendantRead),descendantFixtureHead,
    'merged fixture PR containing the implementing head authenticates the descendant source');
  assert.equal(await verifyDescendantFixtureSource('BestNathan/nession',descendantFixtureHead,
    [implPr],'fixture-token',async path=>{
      if(path.includes('/commits/'))return [fixturePr];
      if(path.includes('/compare/'+successorSha+'...'+descendantFixtureHead))return aheadOf(successorSha);
      throw Error('within-compare must be skipped when source equals the fixture head');
    }),descendantFixtureHead,
    'source equal to the merged fixture head is accepted without a within-compare');
  assert.equal(await verifyDescendantFixtureSource('BestNathan/nession',sha,
    [{...implPr,head:{sha:successorSha,repo:{full_name:'Unrelated/repository'}}}],
    'fixture-token',async()=>{throw Error('should not query without a same-repo implementing head');}),
    null,'foreign implementing repository cannot authenticate a descendant source');
  assert.equal(await verifyDescendantFixtureSource('BestNathan/nession',sha,[implPr],
    'fixture-token',async path=>path.includes('/commits/')?[{...fixturePr,merged_at:null}]:aheadOf(sha)),
    null,'an unmerged fixture PR cannot authenticate a descendant source');
  assert.equal(await verifyDescendantFixtureSource('BestNathan/nession',sha,[implPr],
    'fixture-token',async path=>path.includes('/commits/')?
      [{...fixturePr,head:{sha:descendantFixtureHead,repo:{full_name:'Unrelated/repository'}}}]:aheadOf(sha)),
    null,'a foreign fixture head repository is rejected');
  assert.equal(await verifyDescendantFixtureSource('BestNathan/nession',sha,[implPr],
    'fixture-token',async path=>path.includes('/commits/')?
      [{...fixturePr,base:{ref:'feature',repo:sameRepo}}]:aheadOf(sha)),
    null,'an invalid fixture base ref is rejected');
  assert.equal(await verifyDescendantFixtureSource('BestNathan/nession',sha,[implPr],
    'fixture-token',async path=>{
      if(path.includes('/commits/'))return [fixturePr];
      if(path.includes('/compare/'+sha+'...'))return {base_commit:{sha},
        merge_base_commit:{sha},status:'diverged',behind_by:1,ahead_by:2};
      return aheadOf(successorSha);
    }),null,'a source outside the fixture PR ancestry is rejected');
  assert.equal(await verifyDescendantFixtureSource('BestNathan/nession',sha,[implPr],
    'fixture-token',async path=>{
      if(path.includes('/commits/'))return [fixturePr];
      if(path.includes('/compare/'+sha+'...'))return aheadOf(sha);
      return {base_commit:{sha:successorSha},merge_base_commit:{sha:successorSha},
        status:'diverged',behind_by:1,ahead_by:2};
    }),null,'a fixture PR that does not contain the implementing head is rejected');
  assert.equal(await verifyDescendantFixtureSource('BestNathan/nession',sha,[implPr],
    'fixture-token',async path=>path.includes('/commits/')?
      Array.from({length:100},()=>fixturePr):aheadOf(sha)),
    null,'an incomplete associated-PR inventory fails closed');

  const liveNegativeHead='fa04599e1e9bb3f344d9dc43597f477c4063afc2';
  const originalIssue={...issue,body:body.replaceAll(sha,liveNegativeHead)};
  const failedPr={...pr,head:{sha:liveNegativeHead}};
  assert.equal((await qualifyIssuePrSourceForClosure(originalIssue,[failedPr],
    async()=>({status:'fail',reason:'Quality run 44694739296'}))).qualified,false,
    'real #4143 source was not Quality qualified despite approved Reviewer');
  assert.equal((await qualifyIssuePrSourceForClosure(originalIssue,
    [{...pr,head:{sha:'b'.repeat(40)}}],fixtureQuality)).qualified,false,
    'Owner #4145 merged patch cannot retroactively qualify source #4143');
  assert.equal((await qualifyIssuePrSourceForClosure(originalIssue,
    [{...failedPr,head:{sha:'c'.repeat(40)}}],fixtureQuality)).qualified,false,
    'amended PR head invalidates previously accepted source');
  assert.equal(decideIssueClosure(issue, [pr]).action, 'close');
  const gitopsPr = { ...pr, number: 22, state: 'closed',
    base: { ref: 'gitops' }, merged_at: '2026-11-18T09:49:12Z' };
  assert.equal(decideIssueClosure(issue, [pr, gitopsPr]).action, 'close',
    'merged GitOps and main/staging implementations are valid closure targets');
  assert.equal(decideIssueClosure(issue, [gitopsPr]).action, 'close',
    'a GitOps-only implementation may close only when all SCs are accepted');
  assert.equal(decideIssueClosure(issue,
    [pr, { ...gitopsPr, state: 'open', merged_at: null }]).action, 'pending',
    'an active unmerged GitOps implementation still blocks closure');
  assert.equal(decideIssueClosure(issue,
    [pr, { ...gitopsPr, base: { ref: 'prototype' } }]).action, 'pending',
    'unapproved merged orphan branches still block closure');
  assert.equal(decideIssueClosure({
    ...issue, body: body.replace('| SC-01 | Pass |', '| SC-01 | Pending |'),
  }, [pr, gitopsPr]).action, 'pending',
    'GitOps merge never substitutes for required SC Acceptance');
  // Regression #3491: a main merge with unchecked/unevaluated main-stage SC
  // must remain open for the merged-SHA Acceptance selector to discover it.
  const mainPendingBody = body.replace('- [x] SC-01', '- [ ] SC-01')
    .replace('when: pr\n', 'when: merged\n    branch: main\n')
    .replace('| SC-01 | Pass |', '| SC-01 | Pending |');
  assert.equal(decideIssueClosure(
    { ...issue, body: mainPendingBody }, [{ ...pr, base: { ref: 'main' } }]
  ).action, 'pending');
  // Mirror #3491's two main-only SCs and the merged implementation PR.
  // Both must remain pending for the post-merge runner; merge is not proof.
  const twoPendingMainScs = [
    '## Success Criteria',
    '- [ ] SC-01 verify source-bound Worker Store Ingest',
    '- [ ] SC-02 verify Publisher PR and immutable checkpoint',
    '', '## Acceptance Plan', '```yaml', 'acceptance:',
    '  SC-01:', '    when: merged', '    branch: main', '    method: agent',
    '  SC-02:', '    when: merged', '    branch: main', '    method: agent',
    '```', '', '## Acceptance Report', '| Criterion | Result | Evidence |',
    '|---|---|---|',
    '| SC-01 | Pending | waiting for signed Worker run readback |',
    '| SC-02 | Pending | waiting for Publisher source PR |',
  ].join('\n');
  const pendingVerdict = decideIssueClosure(
    { ...issue, number: 3491, body: twoPendingMainScs },
    [{ ...pr, base: { ref: 'main' }, number: 3513 }],
  );
  assert.equal(pendingVerdict.action, 'pending');
  assert.match(pendingVerdict.reason, /SC-01 is not checked/);
  assert.match(pendingVerdict.reason, /SC-02 is not checked/);

  assert.equal(decideIssueClosure(
    { ...issue, body: mainPendingBody
      .replace('- [ ] SC-01', '- [x] SC-01')
      .replace('| SC-01 | Pending |', '| SC-01 | Pass |') },
    [{ ...pr, base: { ref: 'main' } }]
  ).action, 'close');
  assert.equal(decideIssueClosure({ ...issue, labels: [{ name: 'requirement' }] }, [pr]).action, 'close');
  assert.equal(decideIssueClosure(issue, [pr], { manualReopened: true }).action, 'pending');
  assert.equal(decideIssueClosure(issue, [pr], {
    manualReopened: true, explicitAccept: true,
  }).action, 'pending', 'stale /accept cannot bypass human-reopen hold');
  assert.equal(decideIssueClosure(issue, []).action, 'pending');
  assert.equal(decideIssueClosure(issue, [{ ...pr, merged_at: null }]).action, 'pending');
  const abandoned = { ...pr, number: 3098, state: 'closed', merged_at: null };
  assert.equal(decideIssueClosure(issue, [pr, abandoned]).action, 'close',
    'superseded closed-unmerged PR cannot block a completed implementation');
  assert.equal(decideIssueClosure(issue, [abandoned]).action, 'pending',
    'abandoned PR alone is not implementation proof');
  assert.equal(decideIssueClosure(issue,
    [pr, { ...abandoned, state: 'open' }]).action, 'pending',
    'an active unmerged implementation must still block closure');
  assert.equal(decideIssueClosure(issue,
    [{ ...pr, base: { ref: 'prototype' } }, abandoned]).action, 'pending',
    'no unapproved merge target may confer implementation completion');
  assert.equal(decideIssueClosure({ ...issue, body: body.replace('| Pass |', '| Pending |') },
    [pr]).action, 'pending');
  assert.equal(decideIssueClosure({ ...issue, labels: [{ name: 'bug' }, { name: 'requirement' }] },
    [pr]).action, 'skip');
  assert.equal(decideIssueClosure({ ...issue, labels: [{ name: 'bug' }, { name: 'status:blocked' }] },
    [pr]).action, 'pending');
  assert.deepEqual(selectManualAgentRuns(
    { ...issue, body: body.replace('| Pass |', '| Pending |') }, [pr]),
    [{ stage: 'pr', target_ref: sha }]);
  assert.deepEqual(selectManualAgentRuns(issue, [pr]), []);
  // #4146: owner recovery is not a text override. It requires the existing
  // independently authenticated same-PR anchor and exact current Quality.
  const qualityFixture={status:'pass',receipt:{
    kind:'pr_required_quality_v1',repository:'BestNathan/nession',
    workflow:'.github/workflows/ci-quality.yml',
    head_sha:'b'.repeat(40),result:'success',run_id:100,run_attempt:1,
    scope_job_id:101,web_check_job_id:102,
    scope_step:'Classify the exact PR or main-push change',
    web_check_step:'Enforce applicable Quality results at the stable check name',
    job_outcomes:{'instruction-check':'skipped','workflow-check':'skipped',
      'rust-check':'skipped','tooling-check':'success','web-tests':'skipped'},
  }};
  const qualityReader=async ref=>ref===sha
    ? {status:'fail',reason:'real failed Quality source'}
    : qualityFixture;
  assert.equal(await qualifyManualFailedQualityRecovery(issue,
    'b'.repeat(40),[sha],qualityReader),true);
  assert.equal(await qualifyManualFailedQualityRecovery(issue,
    'b'.repeat(40),[],qualityReader),false);
  assert.equal(await qualifyManualFailedQualityRecovery(issue,
    'b'.repeat(40),[sha],async()=>qualityFixture),false,
    'a formerly green old accepted source remains immutable');
  assert.equal(await qualifyManualFailedQualityRecovery(issue,
    'b'.repeat(40),[sha],async()=>({status:'pending'})),false);
  assert.equal(await qualifyManualFailedQualityRecovery(issue,
    'c'.repeat(40),[sha],qualityReader),false,
    'wrong target SHA cannot borrow another PR Quality run');
  // #3545: PR #3529 implements the Issue, while later #3540 only mentions it.
  const actual = {...pr,number:3529,title:'fix Hosting test (#3528)',
    body:'Refs #3528',head:{...pr.head,sha:'7c7d36f9456d901d252abcfbbe5d2a991f202ba7'}};
  const refOnly = {...actual,number:3540,title:'fix tooling (#3479)',
    body:'Refs #3528',head:{...pr.head,sha:'06857762ece34cf9cbcd50c21454470ed39456f1'}};
  assert.equal(explicitlyImplementsIssue(actual,3528,'BestNathan','nession'),true);
  assert.equal(explicitlyImplementsIssue(refOnly,3528,'BestNathan','nession'),false);
  // A reviewed orphan catalog fixture may reference the Requirement without
  // implementing its main/staging acceptance contract. Search-result
  // discovery must discard this PR before decideIssueClosure is evaluated.
  const orphanReference={...refOnly,number:4190,base:{ref:'toolchains'},
    state:'closed',merged_at:'2026-11-21T04:05:23Z'};
  const searched=await relatedPulls('BestNathan/nession',3528,
    'fixture-token',null,async path=>{
      if(path.startsWith('/search/issues?q='))return {
        incomplete_results:false,total_count:3,items:[
          {number:3528},
          {number:actual.number,pull_request:{}},
          {number:orphanReference.number,pull_request:{}},
        ],
      };
      if(path.endsWith('/pulls/'+actual.number))return actual;
      if(path.endsWith('/pulls/'+orphanReference.number))return orphanReference;
      throw Error('unexpected PR discovery endpoint '+path);
    });
  assert.deepEqual(searched.map(p=>p.number),[actual.number],
    'reference-only orphan source is not an Issue implementation');
  assert.equal(decideIssueClosure(issue,searched).action,'close',
    'a completed implementation remains closable despite a reference-only orphan PR');
  assert.equal(decideIssueClosure(issue,[actual,orphanReference]).action,'pending',
    'raw unfiltered source would incorrectly block, guarding regression');

  const pendingPr = {...issue,number:3528,body:body.replace('| SC-01 | Pass |','| SC-01 | Pending |')};
  assert.deepEqual(selectManualAgentRuns(pendingPr,[actual]),
    [{stage:'pr',target_ref:actual.head.sha}]);
  // The native GitHub commit->PR witness rejects a forged SHA even when the
  // title claims implementation; a reference-only PR is never fetched.
  const nativeActual = {...actual,
    head:{...actual.head,repo:{full_name:'BestNathan/nession'}},
    base:{...actual.base,repo:{full_name:'BestNathan/nession'}}};
  const nativeReference = {...refOnly,
    head:{...refOnly.head,repo:{full_name:'BestNathan/nession'}},
    base:{...refOnly.base,repo:{full_name:'BestNathan/nession'}}};
  let nativeCalls = 0;
  const nativeRead = async path => {
    nativeCalls += 1;
    assert.equal(path,'/repos/BestNathan/nession/commits/'+nativeActual.head.sha+
      '/pulls?per_page=100');
    return [{number:nativeActual.number,head:nativeActual.head,base:nativeActual.base}];
  };
  assert.deepEqual((await verifiedManualSourcePulls('BestNathan/nession',3528,
    [nativeReference,nativeActual],'fixture-token',nativeRead)).map(p=>p.number),[3529]);
  assert.equal(nativeCalls,1,'reference-only PR must not be dispatched or queried');
  assert.deepEqual(await verifiedManualSourcePulls('BestNathan/nession',3528,
    [nativeActual],'fixture-token',async () => [{
      number:3529,head:{...nativeActual.head,sha:'f'.repeat(40)},base:nativeActual.base,
    }]),[],'GitHub source SHA mismatch must fail closed');
  const ambiguous = {...actual,number:3530,head:{...actual.head,sha:'e'.repeat(40)}};
  const reasons = [];
  assert.deepEqual(selectManualAgentRuns(pendingPr,[actual,ambiguous],{diagnostics:reasons}),[]);
  assert.match(reasons.join(' '),/ambiguous/);
  assert.deepEqual(selectManualAgentRuns(pendingPr,[actual,ambiguous],
    {verifiedPrSha:actual.head.sha}),
    [{stage:'pr',target_ref:actual.head.sha}],
    'explicit authenticated PR source resolves genuine multiple-PR ambiguity');
  assert.deepEqual(selectManualAgentRuns(pendingPr,[actual,ambiguous],
    {verifiedPrSha:'f'.repeat(40)}),[],
    'unknown PR head cannot select source');
  // Multiple copies of one exact head are still just one dispatch.
  assert.deepEqual(selectManualAgentRuns(pendingPr,[actual,actual]),
    [{stage:'pr',target_ref:actual.head.sha}]);
  // #3528: SC-01 already accepted on the source PR; SC-02 remains pending.
  // Another strongly associated (but different) PR must not steal SC-02.
  const twoScBody = body
    .replace('- [x] SC-01 acceptance is proven',
      '- [x] SC-01 acceptance is proven\n- [ ] SC-02 exact-head Quality receipt')
    .replace('  SC-01:\n    when: pr\n    method: agent\n',
      '  SC-01:\n    when: pr\n    method: agent\n'+
      '  SC-02:\n    when: pr\n    method: agent\n')
    .replace('ref '+sha+';', 'ref '+actual.head.sha+';')
    .replace('| SC-01 | Pass | run 100; ref '+actual.head.sha+
      '; source agent-qwen; test: exact SHA fixture |',
      '| SC-01 | Pass | run 100; ref '+actual.head.sha+
      '; source agent-qwen; test: exact SHA fixture |\n'+
      '| SC-02 | Pending | awaiting independently authenticated Web Quality |');
  const anchored = {...issue,number:3528,body:twoScBody};
  assert.deepEqual(selectManualAgentRuns(anchored,[ambiguous,actual]),
    [{stage:'pr',target_ref:actual.head.sha}]);
  assert.deepEqual(selectManualAgentRuns(anchored,[ambiguous,actual],
    {verifiedPrSha:ambiguous.head.sha}),[],
    'explicit PR head must not override an already accepted SC anchor');
  const unknownSource={...anchored,body:twoScBody.replace(
    'ref '+actual.head.sha+';', 'ref '+'c'.repeat(40)+';')};
  const ambiguousReasons=[];
  assert.deepEqual(selectManualAgentRuns(unknownSource,[actual,ambiguous],
    {diagnostics:ambiguousReasons}),[]);
  assert.match(ambiguousReasons.join(' '),/conflicting/);
  // #4076: prior Pass source is an authenticated ancestor of this very
  // merged implementing PR; select the newest head for Pending criteria only.
  const updatedHead = 'd'.repeat(40);
  const mergedSamePr = {...nativeActual, merged_at:'2026-11-19T10:00:00Z',
    state:'closed', head:{...nativeActual.head,sha:updatedHead}};
  const sourceAnchor = nativeActual.head.sha;
  const verifiedCompare = {base_commit:{sha:sourceAnchor},
    merge_base_commit:{sha:sourceAnchor},behind_by:0,ahead_by:5,status:'ahead'};
  const samePrWitness = [{number:mergedSamePr.number, merged_at:mergedSamePr.merged_at,
    head:mergedSamePr.head,base:mergedSamePr.base}];
  const ancestryRead = async path => {
    if (path.includes('/compare/')) return verifiedCompare;
    if (path.endsWith('/pulls?per_page=100')) return samePrWitness;
    throw Error('unexpected PR ancestry fetch: '+path);
  };
  assert.deepEqual(await verifyManualAcceptedPrAnchors('BestNathan/nession',
    anchored,[mergedSamePr],updatedHead,'fixture-token',ancestryRead),
    [sourceAnchor]);
  assert.deepEqual(selectManualAgentRuns(anchored,[mergedSamePr],
    {verifiedPrSha:updatedHead,verifiedPrAnchors:[sourceAnchor]}),
    [{stage:'pr',target_ref:updatedHead}]);
  assert.deepEqual(selectManualAgentRuns(anchored,[mergedSamePr],
    {verifiedPrSha:updatedHead}),[],
    'a newer head without authenticated original ancestry must fail closed');
  await assert.rejects(verifyManualAcceptedPrAnchors('BestNathan/nession',
    anchored,[mergedSamePr],updatedHead,'fixture-token',
    async path => path.includes('/compare/')
      ? {...verifiedCompare,behind_by:1,status:'diverged'} : samePrWitness),
  /lacks authenticated same-PR ancestry/);
  await assert.rejects(verifyManualAcceptedPrAnchors('BestNathan/nession',
    anchored,[mergedSamePr],updatedHead,'fixture-token',
    async path => path.includes('/compare/') ? verifiedCompare
      : [{...samePrWitness[0],number:9999}]),
  /lacks authenticated same-PR ancestry/);
  await assert.rejects(verifyManualAcceptedPrAnchors('BestNathan/nession',
    anchored,[mergedSamePr],updatedHead,'fixture-token',
    async path => path.includes('/compare/') ? verifiedCompare
      : [{...samePrWitness[0],head:{...samePrWitness[0].head,
          repo:{full_name:'attacker/fork'}}}]),
  /lacks authenticated same-PR ancestry/,
  'forked or spoofed PR association may not attest an accepted old head');
  await assert.rejects(verifyManualAcceptedPrAnchors('BestNathan/nession',
    anchored,[{...mergedSamePr,merged_at:null}],updatedHead,
    'fixture-token',ancestryRead),
  /ambiguous or missing merged implementing PR/,
  'an unmerged implementing PR never authorizes historic source recovery');
  const secondAnchor = 'c'.repeat(40);
  const multiAnchorBody = twoScBody
    .replace('- [ ] SC-02 exact-head Quality receipt',
      '- [x] SC-02 earlier accepted + third Pending\n- [ ] SC-03 exact-head Quality receipt')
    .replace('  SC-02:\n    when: pr\n    method: agent\n',
      '  SC-02:\n    when: pr\n    method: agent\n'+
      '  SC-03:\n    when: pr\n    method: agent\n')
    .replace('| SC-02 | Pending | awaiting independently authenticated Web Quality |',
      '| SC-02 | Pass | run 101; ref '+secondAnchor+
      '; source agent-qwen; test: second source |\n'+
      '| SC-03 | Pending | awaiting independently authenticated Web Quality |');
  const multiAnchorIssue = {...anchored,body:multiAnchorBody};
  const multiAnchorRead = async path => path.includes('/compare/')
    ? {base_commit:{sha:path.split('/compare/')[1].split('...')[0]},
      merge_base_commit:{sha:path.split('/compare/')[1].split('...')[0]},
      behind_by:0,ahead_by:5,status:'ahead'}
    : samePrWitness;
  assert.deepEqual(await verifyManualAcceptedPrAnchors('BestNathan/nession',
    multiAnchorIssue,[mergedSamePr],updatedHead,'fixture-token',multiAnchorRead),
    [sourceAnchor,secondAnchor]);
  assert.deepEqual(selectManualAgentRuns(multiAnchorIssue,[mergedSamePr],
    {verifiedPrSha:updatedHead,verifiedPrAnchors:[sourceAnchor,secondAnchor]}),
    [{stage:'pr',target_ref:updatedHead}]);
  assert.deepEqual(selectManualAgentRuns(multiAnchorIssue,[mergedSamePr],
    {verifiedPrSha:updatedHead,verifiedPrAnchors:[sourceAnchor]}),[],
    'partial ancestor proof must not authorize a mixed-source acceptance');
  const stagedBody = body.replace('when: pr\n',
    'when: merged\n    branch: staging\n').replace('| Pass |', '| Pending |');
  const mainPr = { ...pr, base: { ref: 'main' } };
  const stagingSha = 'b'.repeat(40);
  assert.deepEqual(selectManualAgentRuns({ ...issue, body: stagedBody }, [mainPr]), [],
    'main-only PR cannot authorize staging without GitHub ancestry');
  assert.deepEqual(selectManualAgentRuns({ ...issue, body: stagedBody }, [],
    { verifiedStagingSha: stagingSha }), [],
  'a staging SHA without an associated implementation must not authorize dispatch');
  assert.deepEqual(selectManualAgentRuns({ ...issue, body: stagedBody },
    [{ ...mainPr, merged_at: null }], { verifiedStagingSha: stagingSha }), [],
  'unmerged main PR must not authorize staging replay');
  assert.deepEqual(selectManualAgentRuns({ ...issue, body: stagedBody }, [mainPr],
    { verifiedStagingSha: stagingSha }), [{ stage: 'staging', target_ref: stagingSha }]);
  const validCompare = { status: 'ahead', ahead_by: 2, behind_by: 0,
    base_commit: { sha }, merge_base_commit: { sha } };
  assert.equal(isMainMergeAncestorOfStaging(sha, stagingSha, validCompare), true);
  for (const invalid of [
    { ...validCompare, status: 'diverged' },
    { ...validCompare, behind_by: 1 },
    { ...validCompare, merge_base_commit: { sha: stagingSha } },
    { ...validCompare, base_commit: { sha: stagingSha } },
    { ...validCompare, ahead_by: null },
    {},
  ]) assert.equal(isMainMergeAncestorOfStaging(sha, stagingSha, invalid), false,
    'unverified or divergent source cannot authorize staging replay');
  assert.equal(isMainMergeAncestorOfStaging('bad', stagingSha, validCompare), false);
  assert.equal(isMainMergeAncestorOfStaging(sha, 'bad', validCompare), false);
  // #3425: manual historical main target overrides only the pending post-
  // merge Agent stage after independent GitHub merge and ancestry proofs.
  const mergedMainBody = mainPendingBody;
  const sourceMainPr = {...mainPr, head: {...mainPr.head,
    repo: {full_name:'BestNathan/nession'}}, base: {...mainPr.base,
    repo: {full_name:'BestNathan/nession'}}};
  const targetMain = 'c'.repeat(40), currentMain = 'd'.repeat(40);
  assert.deepEqual(selectManualAgentRuns(
    {...issue, body:mergedMainBody},[sourceMainPr],{verifiedMainSha:targetMain}),
    [{stage:'post-merge',target_ref:targetMain}]);
  assert.deepEqual(selectManualAgentRuns(
    {...issue,body:stagedBody},[sourceMainPr],{verifiedMainSha:targetMain}), [],
    'a main override never converts a staging criterion into a main proof');
  assert.deepEqual(selectManualAgentRuns(
    {...issue,body:mergedMainBody},[{...sourceMainPr,merged_at:null}],
    {verifiedMainSha:targetMain}), [],
    'unmerged implementation cannot authorize a main target');
  const mainCompare = (base,head) => ({
    status:base===head?'identical':'ahead',ahead_by:base===head?0:1,
    behind_by:0,base_commit:{sha:base},merge_base_commit:{sha:base},
  });
  const mainMerge = {sha:targetMain,parents:[{sha},{sha:stagingSha}]};
  const sourceMerge = {...sourceMainPr,merged_at:'2026-11-11T01:00:00Z'};
  const candidate = {number:60,merged_at:'2026-11-14T10:50:17Z',
    merge_commit_sha:targetMain,base:{ref:'main',repo:{full_name:'BestNathan/nession'}},
    head:{sha:stagingSha,repo:{full_name:'BestNathan/nession'}}};
  const historicalRead = async (path) => {
    if(path.endsWith('/branches/main')) return {commit:{sha:currentMain}};
    if(path.endsWith('/commits/'+targetMain)) return mainMerge;
    if(path.endsWith('/commits/'+targetMain+'/pulls?per_page=10'))return [candidate];
    if(path.endsWith('/compare/'+targetMain+'...'+currentMain))
      return mainCompare(targetMain,currentMain);
    if(path.endsWith('/compare/'+sha+'...'+targetMain))
      return mainCompare(sha,targetMain);
    throw Error('unexpected historical main fixture '+path);
  };
  const historicalRepo='BestNathan/nession';
  assert.equal(await verifyManualPostMergeTarget(historicalRepo,targetMain,
    [sourceMerge],'fixture-token',historicalRead),targetMain);
  for (const wrong of [
    async path => path.endsWith('/commits/'+targetMain+'/pulls?per_page=10')
      ? [{...candidate,merge_commit_sha:stagingSha}] : historicalRead(path),
    async path => path.endsWith('/commits/'+targetMain)
      ? {...mainMerge,parents:[{sha}]} : historicalRead(path),
    async path => path.endsWith('/branches/main')
      ? {commit:{sha:'f'.repeat(40)}} :
      path.endsWith('/compare/'+targetMain+'...'+'f'.repeat(40))
        ? {status:'diverged'} : historicalRead(path),
    async path => path.endsWith('/compare/'+sha+'...'+targetMain)
      ? {status:'diverged'} : historicalRead(path),
  ]) await assert.rejects(verifyManualPostMergeTarget(historicalRepo,targetMain,
    [sourceMerge],'fixture-token',wrong),/historical (?:main )?target/);
  await assert.rejects(verifyManualPostMergeTarget(historicalRepo,targetMain,
    [{...sourceMerge,merged_at:null}],'fixture-token',historicalRead),
    /no verified Issue-linked/);
  await assert.rejects(verifyManualPostMergeTarget(historicalRepo,'bad',
    [sourceMerge],'fixture-token',historicalRead),/invalid historical main/);

  const reopened = [{ event: 'reopened', actor: { type: 'User' }, created_at: '2026-11-11T02:00:00Z' }];
  const recovery = [{ body: '/accept', user: { type: 'User' },
    author_association: 'OWNER', created_at: '2026-11-11T02:01:00Z' }];
  assert.equal(hasUnrecoveredHumanReopen(reopened, []), true);
  assert.equal(hasUnrecoveredHumanReopen(reopened, recovery), false);
  assert.equal(hasUnrecoveredHumanReopen(reopened, [{ ...recovery[0],
    user: { type: 'Bot' } }]), true);
  assert.equal(hasUnrecoveredHumanReopen(reopened, [{ ...recovery[0],
    created_at: '2026-11-11T01:59:00Z' }]), true);
  assert.equal(hasUnrecoveredHumanReopen([...reopened, { ...reopened[0],
    created_at: '2026-11-11T02:05:00Z' }], recovery), true);
  const e = { action: 'created', repository: { full_name: 'X/y' },
    issue: { number: 19, state: 'open' }, sender: { login: 'owner' },
    comment: { body: '/accept', id: 7, user: { login: 'owner', type: 'User' },
      author_association: 'OWNER' } };
  // #4253: the original PR's forced-away SC SHA is NEVER asserted to be
  // an ancestor of an independent replacement. Fresh merged source and
  // two-parent branch proof authorize new evaluation; all negatives reject.
  const replacementComment={id:501,body:'/accept replace 31 32',
    user:{login:'BestNathan',type:'User'},author_association:'OWNER',
    issue_url:'https://api.github.com/repos/BestNathan/nession/issues/19',
    created_at:'2026-11-19T08:00:00Z',
    updated_at:'2026-11-19T08:00:00Z'};
  const repRepo={full_name:'BestNathan/nession'};
  const previousPr={number:31,body:'Refs #19.',title:'historical proposal',
    merged_at:'2026-11-17T00:00:00Z',
    head:{sha:'c'.repeat(40),repo:repRepo},
    base:{ref:'main',repo:repRepo},merge_commit_sha:'d'.repeat(40)};
  const replacementPr={number:32,body:'Refs #19.',title:'fix: replacement (#19)',
    merged_at:'2026-11-18T00:00:00Z',
    head:{sha:'e'.repeat(40),repo:repRepo},
    base:{ref:'staging',repo:repRepo},merge_commit_sha:'f'.repeat(40)};
  const replacementIssue={...issue,body:body.replaceAll(sha,'b'.repeat(40))};
  const expectedReplacement=independentReplacementContract(replacementIssue,
    previousPr,replacementPr,'BestNathan/nession',replacementComment);
  assert.deepEqual(expectedReplacement?.criteria,['SC-01']);
  assert.deepEqual(expectedReplacement?.old_sources,['b'.repeat(40)]);
  for (const invalid of [
    {comment:{...replacementComment,updated_at:'2026-11-19T08:01:00Z'}},
    {comment:{...replacementComment,author_association:'COLLABORATOR'}},
    {comment:{...replacementComment,body:'/accept replace 31 33'}},
    {comment:{...replacementComment,issue_url:'https://api.github.com/repos/X/y/issues/19'}},
    {old:{...previousPr,merged_at:null}},
    {old:{...previousPr,head:{...previousPr.head,repo:{full_name:'foreign/r'}}}},
    {new:{...replacementPr,body:'Refs #19.',title:'unrelated'}},
    {new:{...replacementPr,merged_at:null}},
    {new:{...replacementPr,head:{...replacementPr.head,repo:{full_name:'foreign/r'}}}},
  ]) assert.equal(independentReplacementContract(replacementIssue,
    invalid.old??previousPr,invalid.new??replacementPr,'BestNathan/nession',
    invalid.comment??replacementComment),null,'foreign or edited source not accepted');
  const replacementAssoc=[{number:32,merged_at:replacementPr.merged_at,
    head:replacementPr.head,base:replacementPr.base}];
  const replacementBranch={commit:{sha:'a'.repeat(40)}};
  const replacementMerge={sha:replacementPr.merge_commit_sha,
    parents:[{sha:'1'.repeat(40)},{sha:'2'.repeat(40)}]};
  const replacementCompare={status:'ahead',behind_by:0,ahead_by:4,
    base_commit:{sha:replacementPr.merge_commit_sha},
    merge_base_commit:{sha:replacementPr.merge_commit_sha}};
  const sourceValid=(assoc=replacementAssoc,branch=replacementBranch,
    merge=replacementMerge,compare=replacementCompare)=>
    independentReplacementSourceEvidence(expectedReplacement,replacementPr,
      assoc,branch,merge,compare,'BestNathan/nession');
  assert.equal(sourceValid(),true,'merged replacement has independently verified source');
  assert.equal(sourceValid([{...replacementAssoc[0],number:33}]),false);
  assert.equal(sourceValid(replacementAssoc,replacementBranch,replacementMerge,
    {...replacementCompare,status:'diverged',behind_by:1}),false);
  assert.equal(sourceValid(replacementAssoc,replacementBranch,
    {...replacementMerge,parents:[{sha:'1'.repeat(40)}]}),false);
  const replacementRead=async path=>{
    if(path.endsWith('/pulls/31'))return previousPr;
    if(path.endsWith('/pulls/32'))return replacementPr;
    if(path.endsWith('/issues/comments/501'))return replacementComment;
    if(path.endsWith('/commits/'+replacementPr.head.sha+'/pulls?per_page=100'))
      return replacementAssoc;
    if(path.endsWith('/branches/staging'))return replacementBranch;
    if(path.endsWith('/commits/'+replacementPr.merge_commit_sha))return replacementMerge;
    if(path.includes('/compare/'))return replacementCompare;
    throw Error('unknown replacement test endpoint '+path);
  };
  assert.deepEqual(await verifyIndependentReplacement('BestNathan/nession',
    replacementIssue,31,32,501,'fixture-token',replacementRead),
    expectedReplacement);
  await assert.rejects(verifyIndependentReplacement('BestNathan/nession',
    replacementIssue,31,32,501,'fixture-token',
    async path=>path.includes('/compare/')?
      {...replacementCompare,status:'diverged'}:replacementRead(path)),
    /replacement lacks authenticated/);

  assert.equal(resolveAcceptComment(e, 'X/y', 'owner').issueNumber, 19);
  const replaceEvent={...e,comment:{...e.comment,
    body:'/accept replace 3919 4121'}};
  assert.deepEqual(resolveAcceptComment(replaceEvent,'X/y','owner'),{
    issueNumber:19,commentId:7,targetMainSha:null,targetPrSha:null,
    replacementOldPr:3919,replacementNewPr:4121},
    'explicit replacement selector passes only exact Owner comment intent');
  assert.equal(resolveAcceptComment({...replaceEvent,comment:{...replaceEvent.comment,
    author_association:'CONTRIBUTOR'}},'X/y','owner'),null,
    'untrusted replacement comment never schedules an Agent');
  const historicalEvent = {...e,comment:{...e.comment,
    body:'/accept post-merge '+targetMain}};
  assert.equal(resolveAcceptComment(historicalEvent,'X/y','owner')
    ?.targetMainSha,targetMain);
  const prEvent = {...e,comment:{...e.comment,body:'/accept pr '+sha}};
  assert.equal(resolveAcceptComment(prEvent,'X/y','owner')?.targetPrSha,sha);
  assert.equal(resolveAcceptComment({...prEvent,comment:{...prEvent.comment,
    body:'/accept pr bad'}},'X/y','owner'),null);
  assert.equal(resolveAcceptComment({...historicalEvent,comment:{
    ...historicalEvent.comment,body:'/accept post-merge bad'}},'X/y','owner'),null);

  for (const mutated of [
    { comment: { ...e.comment, body: '/accept now' } },
    { comment: { ...e.comment, author_association: 'CONTRIBUTOR' } },
    { comment: { ...e.comment, user: { ...e.comment.user, type: 'Bot' } } },
    { issue: { ...e.issue, pull_request: {} } },
    { issue: { ...e.issue, state: 'closed' } },
    { sender: { login: 'forged' } },
  ]) assert.equal(resolveAcceptComment({ ...e, ...mutated }, 'X/y', 'owner'), null);
  // Exercise the real mocked REST orchestration, not merely the policy function.
  let live = { ...issue, updated_at: '2026-11-11T01:00:00Z' };
  let writes = 0, dispatches = 0;
  let effectivePr = {...pr, head:{...pr.head,repo:{full_name:'X/y'}},
    base:{...pr.base,repo:{full_name:'X/y'}}};
  const ackComment = {user: {login: 'github-actions[bot]', type: 'Bot'},
    body: 'Comment command `/accept` accepted for Issue #19. [Actions run](https://example.test/22). ' +
      'This request is not an Acceptance Pass or proof that a Developer has started.\n\n' +
      '<!-- nession-command-comment:7 -->'};
  let ackReads = 0;
  assert.equal(await waitForAcceptRouterAck('X/y', 19, 7, 'fixture-token', {
    request: async () => ++ackReads === 2 ? [ackComment] : [],
    pause: async () => {},
    attempts: 3,
  }), true, 'delayed trusted receipt must settle before the Issue snapshot');
  assert.equal(ackReads, 2);
  for (const invalid of [
    {...ackComment, user: {login: 'attacker', type: 'User'}},
    {...ackComment, body: ackComment.body.replace('comment:7', 'comment:8')},
    {...ackComment, body: ackComment.body.replace('Issue #19', 'Issue #20')},
  ]) {
    assert.equal(await waitForAcceptRouterAck('X/y', 19, 7, 'fixture-token', {
      request: async () => [invalid], pause: async () => {}, attempts: 1,
    }), false, 'spoofed or unrelated acknowledgment must not authorize closure');
  }
  assert.equal(await waitForAcceptRouterAck('X/y', 19, 7, 'fixture-token', {
    request: async () => [], pause: async () => {}, attempts: 2,
  }), false, 'missing acknowledgment must fail closed');
  const mock = async (path, options = {}) => {
    if (path.startsWith('/search/issues?')) return { incomplete_results: false, total_count: 1,
      items: [{ number: 21, pull_request: {} }] };
    if (path.endsWith('/pulls/21')) return effectivePr;
    if (path.endsWith('/commits/'+sha+'/pulls?per_page=100'))
      return [{number:21,head:effectivePr.head,base:effectivePr.base}];
    if (path.endsWith('/branches/staging')) return { commit: { sha: stagingSha } };
    if (path.includes('/compare/')) return validCompare;
    if (path.endsWith('/issues/19/comments?per_page=100&sort=created&direction=desc'))
      return [ackComment];
    if (path.endsWith('/issues/19/events?per_page=100')) return [];
    if (path.endsWith('/actions/workflows/agent-sc-acceptance.yml/dispatches')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.body.inputs.target_ref,
        options.body.inputs.stage === 'staging' ? stagingSha : sha);
      dispatches += 1; return null;
    }
    if (path.endsWith('/issues/19')) {
      if (options.method === 'PATCH') {
        assert.equal(options.body.state, 'closed');
        writes += 1; live = { ...live, state: 'closed' };
      }
      return live;
    }
    throw Error('unexpected fixture API path ' + path);
  };
  // GitHub-native completion must not bypass exact-source qualification.
  const nativeCloseFixtureRead=async(path,opts={}) =>
    path.endsWith('/issues/19') && opts.method!=='PATCH'
      ? {...live,state:'closed',state_reason:'completed'} : mock(path,opts);
  assert.equal((await assessNativeCompletedIssueSource('X/y',19,'fixture-token',{
    request:nativeCloseFixtureRead,qualityReader:fixtureQuality})).qualified,true);
  assert.equal((await assessNativeCompletedIssueSource('X/y',19,'fixture-token',{
    request:nativeCloseFixtureRead,qualityReader:async()=>({status:'fail'})})).qualified,false);
  assert.equal((await assessNativeCompletedIssueSource('X/y',19,'fixture-token',{
    request:async(path,opts)=>{
      if(path.endsWith('/pulls/21'))return {...effectivePr,merged_at:null};
      return nativeCloseFixtureRead(path,opts);
    },qualityReader:fixtureQuality})).qualified,false);
  // A search result may include the Issue itself (a non-PR item). It must
  // never be fetched as /pulls/<issue-number>; the real merged PR still
  // qualifies (#4214).
  const searchWithIssue = async (path, opts = {}) =>
    path.startsWith('/search/issues?')
      ? { incomplete_results: false, total_count: 2,
          items: [{ number: 19 }, { number: 21, pull_request: {} }] }
      : nativeCloseFixtureRead(path, opts);
  assert.equal((await assessNativeCompletedIssueSource('X/y', 19, 'fixture-token', {
    request: searchWithIssue, qualityReader: fixtureQuality })).qualified, true);
  // A search item that claims to be a PR but cannot be read still fails
  // closed; the filter must not silently drop a real PR.
  const unreadableClaimedPr = async (path, opts = {}) => {
    if (path.startsWith('/search/issues?'))
      return { incomplete_results: false, total_count: 2,
        items: [{ number: 21, pull_request: {} }, { number: 22, pull_request: {} }] };
    if (path.endsWith('/pulls/22')) throw Error('GitHub GET /repos/X/y/pulls/22: 404');
    return nativeCloseFixtureRead(path, opts);
  };
  await assert.rejects(() => assessNativeCompletedIssueSource('X/y', 19, 'fixture-token', {
    request: unreadableClaimedPr, qualityReader: fixtureQuality }), /404/);
  const once = await reconcileIssue('X/y', 19, 'fixture-token', { request: mock, qualityReader: fixtureQuality });
  assert.equal(once.action, 'closed');
  assert.equal(writes, 1);
  assert.equal((await reconcileIssue('X/y', 19, 'fixture-token',
    { request: mock, qualityReader: fixtureQuality })).action, 'skip');
  assert.equal(writes, 1, 'repeat delivery must never write another closure');
  // Acceptance-first: a trusted Pass arriving before merge cannot close;
  // the subsequent merge event converges using the already projected proof.
  live = { ...issue, updated_at: '2026-11-11T01:00:01Z' };
  effectivePr = { ...effectivePr, merged_at: null };
  assert.equal((await reconcileIssue('X/y', 19, 'fixture-token',
    { request: mock, qualityReader: fixtureQuality })).action, 'pending');
  assert.equal(writes, 1);
  effectivePr = {...pr, head:{...pr.head,repo:{full_name:'X/y'}},
    base:{...pr.base,repo:{full_name:'X/y'}}};
  assert.equal((await reconcileIssue('X/y', 19, 'fixture-token',
    { request: mock, qualityReader: fixtureQuality })).action, 'closed');
  assert.equal(writes, 2);
  // Merge-first: missing SC proof keeps Issue Open until the later
  // authorized Acceptance projection causes another reconciliation.
  live = { ...issue, updated_at: '2026-11-11T01:00:02Z',
    body: body.replace('| Pass |', '| Pending |') };
  assert.equal((await reconcileIssue('X/y', 19, 'fixture-token',
    { request: mock, qualityReader: fixtureQuality })).action, 'pending');
  assert.equal(writes, 2);
  live = { ...issue, updated_at: '2026-11-11T01:00:03Z' };
  assert.equal((await reconcileIssue('X/y', 19, 'fixture-token',
    { request: mock, qualityReader: fixtureQuality })).action, 'closed');
  assert.equal(writes, 3);
  assert.equal((await reconcileIssue('X/y', 19, 'fixture-token',
    { request: mock, qualityReader: fixtureQuality })).action, 'skip');
  assert.equal(writes, 3, 'both event orders must converge exactly once');
  // Restore an open pending Issue to exercise explicitly requested recovery.
  live = { ...issue, updated_at: '2026-11-11T01:01:00Z',
    body: body.replace('| Pass |', '| Pending |') };
  const manual = await handleManual(e, 'X/y', 'owner', 'fixture-token', mock);
  assert.equal(manual.action, 'dispatched');
  assert.equal(dispatches, 1);
  assert.equal(writes, 3, 'manual command cannot turn Pending into Pass');
  assert.equal((await handleManual({ ...e, comment: { ...e.comment, body: '/accept all' } },
    'X/y', 'owner', 'fixture-token', mock)).action, 'skip');
  assert.equal(dispatches, 1, 'untrusted comments cannot dispatch');
  const targeted = await handleManual(prEvent, 'X/y', 'owner', 'fixture-token', mock);
  assert.equal(targeted.action, 'dispatched', 'verified PR selection dispatches');
  assert.deepEqual(targeted.agent_runs,[{stage:'pr',target_ref:sha}]);
  assert.equal(dispatches, 2);
  await assert.rejects(handleManual({...prEvent,comment:{...prEvent.comment,
    body:'/accept pr '+'f'.repeat(40)}},'X/y','owner','fixture-token',mock),
    /unverified or unmerged Issue-linked exact PR head/);
  assert.equal(dispatches, 2, 'unverified target never dispatches');
  // End-to-end /accept mock: a main-only implementation reaches the exact
  // staging SHA by authenticated ancestry, not by editing the SC plan.
  live = { ...issue, body: stagedBody, updated_at: '2026-11-11T01:01:01Z' };
  effectivePr = {...mainPr,head:{...mainPr.head,repo:{full_name:'X/y'}},
    base:{...mainPr.base,repo:{full_name:'X/y'}}};
  const stagingRecovery = await handleManual(e, 'X/y', 'owner', 'fixture-token', mock);
  assert.equal(stagingRecovery.action, 'dispatched');
  assert.deepEqual(stagingRecovery.agent_runs,
    [{ stage: 'staging', target_ref: stagingSha }]);
  assert.equal(dispatches, 3);
  const tamperedCompare = async (path, options = {}) =>
    path.includes('/compare/')
      ? { ...validCompare, merge_base_commit: { sha: stagingSha } }
      : mock(path, options);
  const refused = await handleManual(e, 'X/y', 'owner', 'fixture-token', tamperedCompare);
  assert.equal(refused.action, 'pending');
  assert.equal(refused.agent_runs.length, 0);
  assert.equal(dispatches, 3, 'tampered ancestry must never dispatch');
  effectivePr = {...pr,head:{...pr.head,repo:{full_name:'X/y'}},
    base:{...pr.base,repo:{full_name:'X/y'}}};
  live = { ...issue, body, updated_at: '2026-11-11T01:02:00Z' };
  // Distinct timestamps across successive reads force no mutation.
  let reads = 0;
  const race = async (path, options = {}) => {
    if (path.endsWith('/issues/19') && options.method !== 'PATCH') {
      reads += 1; return { ...live, updated_at: '2026-11-11T01:02:0' + reads + 'Z' };
    }
    return mock(path, options);
  };
  assert.equal((await reconcileIssue('X/y', 19, 'fixture-token',
    { request: race, qualityReader: fixtureQuality })).action, 'pending');
  assert.equal(writes, 3, 'racing edits must not close the Issue');
  await assert.rejects(reconcileIssue('X/y', 19, 'fixture-token', {
    request: async (path, options) => path.endsWith('/events?per_page=100')
      ? Array(100).fill({event:'labeled'}) : mock(path, options),
  }), /event history incomplete/);
  // #4137: the live false-closure counterexample — #4059 with every SC checked
  // Pass, including the historically disproven SC-02 (green Waker 44678335169 +
  // BLOCKED converge 44678377431). Closure must fail closed and an explicit
  // /accept must still select the negative main source for a trusted replay.
  const repo4059 = 'BestNathan/nession';
  const mainSha4059 = 'a'.repeat(40);
  const prHead4059 = 'f'.repeat(40);
  const invalidSc02 = 'run 44678335169; ref ' + mainSha4059 + '; source agent-qwen; ' +
    'workflow: Post-Run Waker; workflow: Convergence run 44678377431 conclusion=success';
  const body4059 = '## Success Criteria\n' +
    '- [x] SC-01 deterministic policy fixture\n' +
    '- [x] SC-02 real source-bound Convergence run\n' +
    '- [x] SC-03 no weakened auto-merge\n\n' +
    '## Acceptance Plan\n\n```yaml\nacceptance:\n  SC-01:\n    when: pr\n    method: agent\n' +
    '  SC-02:\n    when: merged\n    branch: main\n    method: agent\n' +
    '  SC-03:\n    when: pr\n    method: agent\n```\n\n' +
    '## Acceptance Report\n\n| Criterion | Result | Evidence |\n|---|---|---|\n' +
    '| SC-01 | Pass | run 100; ref ' + prHead4059 + '; source agent-qwen; test: fixture |\n' +
    '| SC-02 | Pass | ' + invalidSc02 + ' |\n' +
    '| SC-03 | Pass | run 100; ref ' + prHead4059 + '; source agent-qwen; test: fixture |\n';
  const issue4059 = { number: 4059, state: 'open', labels: [{ name: 'bug' }], body: body4059 };
  const mainPr4059 = { number: 4128, title: 'fix (#4059)', body: 'Fixes #4059',
    head: { sha: prHead4059 }, base: { ref: 'main' },
    merged_at: '2026-11-20T05:01:26Z', merge_commit_sha: mainSha4059 };
  assert.equal(decideIssueClosure(issue4059, [mainPr4059]).action, 'pending',
    'all-checked SCs with the disproven #4059 SC-02 must not close');
  assert.match(decideIssueClosure(issue4059, [mainPr4059]).reason, /disproven/);
  assert.equal(decideIssueClosure({ ...issue4059, number: 4140 }, [mainPr4059]).action,
    'close', 'the invalidation is scoped to #4059 SC-02 only');
  const genuineSc02 = 'run 45332410930; ref ' + mainSha4059 + '; source agent-qwen; ' +
    'authenticated-convergence-writer: Run 111/1, App writer minted, MERGED';
  const genuineBody4059 = body4059.replace(invalidSc02, genuineSc02);
  assert.equal(decideIssueClosure({ ...issue4059, body: genuineBody4059 }, [mainPr4059]).action,
    'close', 'a non-historical Pass row is not deterministically invalidated');
  assert.deepEqual(selectManualAgentRuns(issue4059, [mainPr4059],
    { verifiedMainSha: mainSha4059 }),
    [{ stage: 'post-merge', target_ref: mainSha4059 }],
    'explicit /accept selects the historical negative source despite the checked Pass');
  assert.deepEqual(selectManualAgentRuns({ ...issue4059, number: 4140 }, [mainPr4059],
    { verifiedMainSha: mainSha4059 }), [],
    'other Issues keep the checked-Pass lock');
  // Independent operation-level closure attestation re-read from GitHub.
  const lane4059 = 'b'.repeat(40), head4059 = 'c'.repeat(40),
    merge4059 = 'd'.repeat(40), staging4059 = 'e'.repeat(40);
  const wf4059 = '.github/workflows/release-staging-convergence.yml';
  const required4059 = ['CI / Quality Gate', 'E2E / Tests', 'Acceptance / Case Smoke'];
  const run4059 = { id: 111, run_attempt: 1, path: wf4059,
    name: 'Release / Staging Convergence', head_branch: 'main', head_sha: mainSha4059,
    event: 'push', status: 'completed', conclusion: 'success' };
  const mintStep = { name: 'Mint workflow-file integration token from Publisher App',
    status: 'completed', conclusion: 'success' };
  const armStep = { name: 'Idempotently prepare and arm protected GitHub Auto-merge',
    status: 'completed', conclusion: 'success' };
  const job4059 = { id: 222, name: 'converge', status: 'completed', conclusion: 'success',
    steps: [mintStep, armStep] };
  const plan4059 = { schema_version: 1, main_sha: mainSha4059, branches: [{ branch: 'staging',
    sha: lane4059, workflow_write_required: true, actions: ['sync-main-to-lane'] }] };
  const decisions4059 = [{ branch: 'staging', direction: 'sync-main-to-lane',
    action: 'created', number: 333, integration_head: head4059, outcome: 'AUTO_MERGE_QUALIFIED' }];
  const transcript4059 = [JSON.stringify(plan4059, null, 2), JSON.stringify(decisions4059, null, 2)]
    .join('\n').split('\n').map(x => '2026-11-23T07:00:00.001Z ' + x).join('\n');
  const pr4059 = { number: 333, state: 'closed', created_at: '2026-11-23T07:00:00Z',
    merged_at: '2026-11-23T07:30:00Z',
    merge_commit_sha: merge4059, user: { login: 'nession-publisher[bot]' },
    base: { ref: 'staging', repo: { full_name: repo4059 } },
    head: { ref: 'chore/staging-sync-fixture', sha: head4059, repo: { full_name: repo4059 } },
    body: 'Staging Convergence automated proposal (fixture)\n\n' +
      '<!-- nession-convergence-pr:v1 branch=staging main=' + mainSha4059 +
      ' lane=' + lane4059 + ' head=' + head4059 + ' digest=' + 'e'.repeat(64) + ' -->' };
  const commit4059 = { sha: head4059, parents: [{ sha: lane4059 }, { sha: mainSha4059 }] };
  const workflowPaths4059 = {
    'CI / Quality Gate': '.github/workflows/ci-quality.yml',
    'E2E / Tests': '.github/workflows/e2e-tests.yml',
    'Acceptance / Case Smoke': '.github/workflows/acceptance-case-smoke.yml',
  };
  const ci4059 = required4059.map((name, i) => ({ id: 400 + i, run_attempt: 1, name,
    path: workflowPaths4059[name], head_branch: pr4059.head.ref,
    created_at: '2026-11-23T07:10:00Z',
    head_sha: head4059, event: 'pull_request', status: 'completed', conclusion: 'success',
    repository: { full_name: repo4059 }, head_repository: { full_name: repo4059 },
    pull_requests: [{ number: 333 }] }));
  const compare4059 = { status: 'ahead', merge_base_commit: { sha: merge4059 } };
  const writerMock = ({ job = job4059, log = transcript4059 } = {}) => async (path) => {
    if (path.includes('/actions/runs?head_sha=' + mainSha4059)) return { workflow_runs: [run4059] };
    if (path.includes('/actions/workflows/release-staging-convergence.yml/runs?head_sha=' +
      mainSha4059)) return { workflow_runs: [run4059] };
    if (path.includes('/actions/runs?head_sha=' + head4059)) return { workflow_runs: ci4059 };
    if (path.includes('/actions/workflows/ci-quality.yml/runs?head_sha=' + head4059))
      return { workflow_runs: [ci4059[0]] };
    if (path.includes('/actions/workflows/e2e-tests.yml/runs?head_sha=' + head4059))
      return { workflow_runs: [ci4059[1]] };
    if (path.includes('/actions/workflows/acceptance-case-smoke.yml/runs?head_sha=' + head4059))
      return { workflow_runs: [ci4059[2]] };
    if (path.includes('/actions/runs/111/attempts/1/jobs')) return { jobs: [job] };
    if (path.endsWith('/pulls/333')) return pr4059;
    if (path.includes('/git/commits/' + head4059)) return commit4059;
    if (path.endsWith('/branches/staging')) return { commit: { sha: staging4059 } };
    if (path.includes('/compare/' + merge4059 + '...' + staging4059)) return compare4059;
    throw Error('unexpected convergence endpoint ' + path);
  };
  const writerLog = async () => transcript4059;
  const genuineIssue4059 = { ...issue4059, body: genuineBody4059 };
  assert.equal((await qualifyConvergenceWriter4059Closure(repo4059, issue4059,
    'fixture-token', writerMock(), writerLog)).qualified, false,
    'the historical disproven row fails closed without GitHub authority');
  assert.equal((await qualifyConvergenceWriter4059Closure(repo4059, genuineIssue4059,
    'fixture-token', writerMock(), writerLog)).qualified, true,
    'a genuine source-bound operation receipt qualifies closure');
  const blockedJob = { ...job4059, steps: [{ ...mintStep, conclusion: 'skipped' }, armStep] };
  const blockedLog = transcript4059.replace('AUTO_MERGE_QUALIFIED', 'BLOCKED');
  assert.equal((await qualifyConvergenceWriter4059Closure(repo4059, genuineIssue4059,
    'fixture-token', writerMock({ job: blockedJob, log: blockedLog }), async () => blockedLog))
    .qualified, false, 'green job with BLOCKED controller / skipped writer cannot close');
  assert.equal((await qualifyConvergenceWriter4059Closure(repo4059,
    { ...issue4059, number: 4140 }, 'fixture-token', writerMock(), writerLog)).qualified, true,
    'non-#4059 Issues are unaffected');
  if (originalAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
  else process.env.GITHUB_RUN_ATTEMPT = originalAttempt;
  console.log('issue-lifecycle-reconcile: closure and exact /accept negative fixtures passed');
}

async function main() {
  const [command, value] = process.argv.slice(2);
  if (command === 'self-test') { await selfTest(); return; }
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let result;
  if (command === 'issue') {
    if (!/^[1-9][0-9]*$/.test(value || '')) throw Error('positive Issue number required');
    result = await reconcileIssue(repository, Number(value), token);
  } else if (command === 'pr') {
    if (!/^[1-9][0-9]*$/.test(value || '')) throw Error('positive PR number required');
    const { owner, name, prefix } = repoParts(repository);
    const pr = await githubRequest(prefix + '/pulls/' + value, { token });
    if (!pr.merged_at || !['staging', 'main'].includes(pr.base?.ref)) {
      result = { action: 'skip', reason: 'PR not merged to staging/main' };
    } else {
      const numbers = parsePreMergeIssueNumbers(pr.body, owner, name, pr.title);
      result = [];
      for (const number of numbers) {
        result.push({ issue: number, ...await reconcileIssue(repository, number, token,
          { includePr: pr.number }) });
      }
    }
  } else if (command === 'manual') {
    const event = JSON.parse(fs.readFileSync(value, 'utf8'));
    result = await handleManual(event, repository, process.env.GITHUB_ACTOR, token);
  } else {
    throw Error('usage: issue-lifecycle-reconcile.mjs <self-test|issue N|pr N|manual EVENT_JSON>');
  }
  console.log(JSON.stringify(result));
}
if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
