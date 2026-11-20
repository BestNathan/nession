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
    targetMainSha: kind.target_sha ?? null, targetPrSha: kind.target_pr_sha ?? null };
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
    if (['pass', 'n/a'].includes(row.result.toLowerCase()) && success.criteria.get(id)?.checked) continue;
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
  const numbers = new Set(found.items.map(pr => pr.number));
  if (includePr) numbers.add(includePr);
  const prs = [];
  for (const number of numbers) {
    if (!Number.isSafeInteger(number) || number <= 0) throw Error('invalid PR discovery result');
    const pr = await request(prefix + '/pulls/' + number, { token });
    if (parsePreMergeIssueNumbers(pr.body, owner, name, pr.title).includes(issueNumber)) {
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
export async function qualifyIssuePrSourceForClosure(issue, prs, readQuality) {
  const criteria = parseSuccessCriteria(extractSection(issue?.body, 'Success Criteria'));
  const report = parseAcceptanceReport(extractSection(issue?.body, 'Acceptance Report'));
  const plan = validateAcceptancePlan(issue?.body, criteria.criteria.keys(), report.rows);
  if (criteria.errors.length || report.errors.length || plan.errors.length) {
    return {qualified:false, reason:'invalid Issue SC/Acceptance contract'};
  }
  const heads = new Set();
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
    const authorizedPr = Array.isArray(prs) && prs.some(pr =>
      Boolean(pr.merged_at) && pr.head?.sha === head &&
      ['main','staging','gitops'].includes(pr.base?.ref));
    if (!authorizedPr) {
      return {qualified:false,
        reason:id+' accepted source HEAD is not the merged Issue implementation HEAD'};
    }
    heads.add(head);
  }
  if (heads.size > 16) return {qualified:false, reason:'too many PR Quality sources'};
  for (const head of heads) {
    // readQuality is always a trusted GitHub Run/Job/Step reader in production.
    const evidence = await readQuality(head);
    if (evidence?.status !== 'pass' ||
        !validPrRequiredQualityReceipt(evidence.receipt, head)) {
      return {qualified:false,
        reason:'accepted PR source '+head+' lacks independently verified required Quality'};
    }
  }
  return {qualified:true, sources:[...heads]};
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
  const prs = await relatedPulls(repository, number, token, null, request);
  const decision = decideIssueClosure({...issue,state:'open'},prs);
  if (decision.action !== 'close')
    return {qualified:false,reason:'canonical Issue lifecycle: '+decision.reason};
  const qualified = await qualifyIssuePrSourceForClosure(issue,prs,
    qualityReader ?? (sha => collectPrRequiredQualityAsync(sha,
      path => request(path, {token}))));
  return qualified.qualified
    ? {qualified:true,reason:'merged source and Quality verified'}
    : {qualified:false,reason:'PR source Quality: '+qualified.reason};
}

async function reconcileIssue(repository, number, token, { includePr = null,
  request = githubRequest, qualityReader = null } = {}) {
  const { prefix } = repoParts(repository);
  const issue = await request(prefix + '/issues/' + number, { token });
  if (!issue || issue.number !== number) throw Error('Issue number mismatch');
  if (issue.state !== 'open' || !isAcceptanceIssue(issue) || issue.pull_request) {
    return { action: 'skip', reason: 'not an open native acceptance Issue' };
  }
  const prs = await relatedPulls(repository, number, token, includePr, request);
  const manualReopened = await humanReopened(repository, number, token, request);
  const decision = decideIssueClosure(issue, prs, { manualReopened });
  if (decision.action !== 'close') return { ...decision, prs: prs.map(pr => pr.number) };
  const qualified = await qualifyIssuePrSourceForClosure(issue, prs,
    qualityReader ?? (head => collectPrRequiredQualityAsync(head,
      path => request(path, {token}))));
  if (!qualified.qualified) {
    return {action:'pending', reason:'PR source Quality: '+qualified.reason,
      prs:prs.map(pr => pr.number)};
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

async function handleManual(event, repository, actor, token, request = githubRequest) {
  const command = resolveAcceptComment(event, repository, actor);
  if (!command) return { action: 'skip', reason: 'untrusted or non-/accept comment' };
  if (process.env.GITHUB_RUN_ATTEMPT && process.env.GITHUB_RUN_ATTEMPT !== '1') {
    return { action: 'skip', reason: 'manual dispatch is first-attempt only' };
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
  for (const run of runs) {
    await request(prefix + '/actions/workflows/agent-sc-acceptance.yml/dispatches', {
      token, method: 'POST',
      body: { ref: 'main', inputs: {
        issue_number: String(command.issueNumber), stage: run.stage,
        target_ref: run.target_ref, provider: '', deployment: '',
      }},
    });
  }
  return { action: runs.length ? 'dispatched' : 'pending', reason: result.reason,
    agent_runs: runs, diagnostics, note: 'Case/deployed proof remains with its existing trusted runner' };
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
  assert.equal(resolveAcceptComment(e, 'X/y', 'owner').issueNumber, 19);
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
  const mock = async (path, options = {}) => {
    if (path.startsWith('/search/issues?')) return { incomplete_results: false, total_count: 1,
      items: [{ number: 21 }] };
    if (path.endsWith('/pulls/21')) return effectivePr;
    if (path.endsWith('/commits/'+sha+'/pulls?per_page=100'))
      return [{number:21,head:effectivePr.head,base:effectivePr.base}];
    if (path.endsWith('/branches/staging')) return { commit: { sha: stagingSha } };
    if (path.includes('/compare/')) return validCompare;
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
  const nativeRead=async(path,opts={}) =>
    path.endsWith('/issues/19') && opts.method!=='PATCH'
      ? {...live,state:'closed',state_reason:'completed'} : mock(path,opts);
  assert.equal((await assessNativeCompletedIssueSource('X/y',19,'fixture-token',{
    request:nativeRead,qualityReader:fixtureQuality})).qualified,true);
  assert.equal((await assessNativeCompletedIssueSource('X/y',19,'fixture-token',{
    request:nativeRead,qualityReader:async()=>({status:'fail'})})).qualified,false);
  assert.equal((await assessNativeCompletedIssueSource('X/y',19,'fixture-token',{
    request:async(path,opts)=>{
      if(path.endsWith('/pulls/21'))return {...effectivePr,merged_at:null};
      return nativeRead(path,opts);
    },qualityReader:fixtureQuality})).qualified,false);
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
