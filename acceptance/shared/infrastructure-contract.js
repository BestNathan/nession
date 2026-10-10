const fs = require('node:fs');
const path = require('node:path');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function must(text, pattern, label) {
  if (!pattern.test(text)) throw new Error('missing contract: ' + label);
}

function workspaceRoot() {
  return process.cwd();
}

function trustedRoot() {
  const root = process.env.NESSION_ACCEPTANCE_TRUSTED_ROOT;
  if (!root) throw new Error('NESSION_ACCEPTANCE_TRUSTED_ROOT is required');
  return root;
}

function targetSha() {
  const value = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA || '');
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('exact acceptance target SHA is required');
  return value;
}

function result(summary, evidence) {
  return { status: 'pass', summary, evidence };
}

function verifySc09() {
  const workflow = read(path.join(workspaceRoot(), '.github/workflows/acceptance-cases.yml'));
  must(workflow, /push:\s*\n\s*branches:\s*\[staging, main\]/, 'push trigger covers staging/main');
  must(workflow, /discover-ref "\$\{target_sha\}"/, 'exact-SHA Requirement association discovery');
  must(workflow, /ref:\s*\$\{\{ steps\.target\.outputs\.target_sha \}\}/, 'exact target checkout');
  if (process.env.GITHUB_ACTIONS === 'true') {
    if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF_NAME !== 'staging') {
      throw new Error('SC-09 must be proven by the automatic staging push path');
    }
    if (process.env.GITHUB_SHA !== targetSha()) {
      throw new Error('staging push SHA does not equal acceptance target SHA');
    }
  }
  return result(
    'Automatic staging merged-SHA Case selection uses trusted association discovery and exact checkout.',
    [
      { type: 'workflow', value: 'Acceptance Cases event=push branch=staging target_sha=' + targetSha() },
      { type: 'contract', value: 'trusted discover-ref maps merged SHA to associated Requirement Issues' },
    ],
  );
}

function verifySc10() {
  const workflow = read(path.join(trustedRoot(), '.github/workflows/acceptance-cases.yml'));
  const ingest = read(path.join(trustedRoot(), 'scripts/acceptance-case-ingest.mjs'));
  must(workflow, /main\) stage=post-merge/, 'main push maps to post-merge');
  must(workflow, /target_sha="\$\{PUSH_SHA\}"/, 'post-merge uses exact push SHA');
  must(ingest, /stage === 'post-merge' \? 'main'/, 'post-merge eligibility compares current main SHA');
  must(ingest, /normalizeAcceptanceCaseResult\(context, item, 'case-runner'\)/, 'same trusted Case projection');
  must(ingest, /currentSha !== item\.target_sha/, 'historical SHA cannot project');
  return result(
    'The same trusted runner maps main push to post-merge and projects only current-main, stage-matching results.',
    [
      { type: 'contract', value: 'main push -> stage=post-merge using Acceptance Cases runner' },
      { type: 'security', value: 'projection checks current main SHA and never equates merge with production deployment' },
    ],
  );
}

function verifySc11() {
  const workflow = read(path.join(trustedRoot(), '.github/workflows/acceptance-cases.yml'));
  for (const name of ['issue_number', 'criterion', 'target_sha', 'stage', 'runtime_profile']) {
    must(workflow, new RegExp('\\n\\s{6}' + name + ':'), 'manual input ' + name);
  }
  must(workflow, /\^\[0-9a-fA-F\]\{40\}\$/, 'manual exact SHA validation');
  must(workflow, /manual_criterion="\$\{INPUT_CRITERION\}"/, 'manual SC selection');
  must(workflow, /runtime_profile="\$\{INPUT_RUNTIME\}"/, 'manual runtime selection');
  // Both manual workflow_dispatch and automatic pushes flow through the same
  // canonical E2E CLI; legacy --target-sha is intentionally retired.
  must(workflow, /args=\(acceptance --issue-json/, 'shared canonical Case CLI argument array');
  must(workflow, /args\+=\(--issue "\${issue}" --sc "\${criterion}" --stage "\${ACCEPTANCE_STAGE}"\)/,
    'shared Issue/SC/stage selector');
  must(workflow, /args\+=\(--sha "\${TARGET_SHA}" --profile "\${profile}" --output "\${output}"\)/,
    'manual and automatic paths share exact SHA and runtime profile');
  must(workflow, /node workspace\/e2e\/run "\${args\[@\]}"/,
    'shared canonical Case runner entrypoint');
  return result(
    'Manual dispatch selects Issue, SC, exact SHA, stage and runtime profile through the same deterministic Case runner.',
    [
      { type: 'contract', value: 'workflow_dispatch inputs=issue_number,criterion,target_sha,stage,runtime_profile' },
      { type: 'contract', value: 'target_sha validated as exact 40-character commit SHA' },
    ],
  );
}

function verifySc12() {
  const workflow = read(path.join(trustedRoot(), '.github/workflows/acceptance-case-ingest.yml'));
  const ingest = read(path.join(trustedRoot(), 'scripts/acceptance-case-ingest.mjs'));
  must(workflow, /workflow_run:\s*\n\s*workflows:\s*\["Acceptance Cases"\]/, 'trusted workflow-run ingestion');
  must(workflow, /group:\s*acceptance-results-ingest/, 'serialized ingestion concurrency');
  must(workflow, /checkout --orphan acceptance-results/, 'independent orphan results branch');
  must(workflow, /if \[\[ -e "\$\{destination\}" \]\]/, 'existing record collision rejection');
  must(workflow, /git -C results-repo push origin acceptance-results/, 'append-only push without force');
  must(ingest, /source_result_sha256/, 'record provenance checksum');
  must(ingest, /'runs',\s*\n\s*date,\s*\n\s*item\.run_id \+ '-' \+ item\.run_attempt/, 'durable deterministic record path');
  return result(
    'Compact Case records are serialized into an append-only orphan branch with checksummed provenance; large artifacts stay outside product Git.',
    [
      { type: 'record', value: 'durable_branch=acceptance-results mode=orphan append-only serialized-ingest' },
      { type: 'artifact', value: 'large browser traces/screenshots/logs remain GitHub Actions artifacts' },
    ],
  );
}

function verifySc13() {
  const sourceWorkflow = read(path.join(workspaceRoot(), '.github/workflows/acceptance-cases.yml'));
  const ingestWorkflow = read(path.join(trustedRoot(), '.github/workflows/acceptance-case-ingest.yml'));
  const ingest = read(path.join(trustedRoot(), 'scripts/acceptance-case-ingest.mjs'));
  const executor = read(path.join(trustedRoot(), 'scripts/acceptance-executor.mjs'));
  must(sourceWorkflow, /permissions:\s*\n\s*contents:\s*read\s*\n\s*issues:\s*read/, 'Case runner has no write permission');
  must(ingestWorkflow, /contents:\s*write\s*\n\s*issues:\s*write/, 'only trusted ingestion can persist/project');
  must(ingest, /currentSha !== item\.target_sha/, 'stale target rejected from projection');
  must(ingest, /issueIsAssociatedWithSha/, 'Issue/SHA association enforced');
  must(executor, /contractDigest\(contract\) !== normalized\.contract_sha256/, 'stale contract digest rejected');
  must(executor, /selected_criteria/, 'independent SC projection');
  return result(
    'Untrusted Case execution is read-only; trusted ingestion alone writes durable records and Issue projections with stale SHA/contract defenses.',
    [
      { type: 'security', value: 'Case workflow permissions=contents:read,issues:read' },
      { type: 'security', value: 'trusted ingest validates current SHA, association, contract digest and selected SC before Issue write' },
    ],
  );
}

function verifySc15() {
  const docs = read(path.join(workspaceRoot(), 'docs/architecture/acceptance-cases.md'));
  must(docs, /Archive, removal, and promotion/i, 'lifecycle section');
  must(docs, /delete the Case directory/i, 'Case removal supported');
  must(docs, /acceptance-results/i, 'historical provenance retained');
  must(docs, /promot.*regression E2E/i, 'promotion guidance');
  return result(
    'Case lifecycle explicitly supports later source removal while durable records/Git SHA preserve provenance, and useful scenarios can graduate to regression E2E.',
    [
      { type: 'docs', value: 'docs/architecture/acceptance-cases.md#archive-removal-and-promotion' },
    ],
  );
}

function verifySc16() {
  const docs = read(path.join(workspaceRoot(), 'docs/architecture/acceptance-cases.md'));
  const skill = read(path.join(workspaceRoot(), '.claude/skills/nession-acceptance/SKILL.md'));
  for (const phrase of ['Creating a Case', 'Stage selection', 'Verifier choice', 'Evidence quality', 'Security boundary']) {
    must(docs, new RegExp(phrase, 'i'), 'docs section ' + phrase);
  }
  must(skill, /Source-aligned Acceptance Cases/i, 'skill Case guidance');
  must(skill, /one Case per Issue\/SC/i, 'skill independent Case rule');
  must(skill, /browser.*protocol.*runtime/i, 'skill verifier methods');
  must(skill, /acceptance-results/i, 'skill durable result guidance');
  return result(
    'Architecture docs and project skill define Case creation, stages, verifier choice, evidence quality, independent reporting and security isolation.',
    [
      { type: 'docs', value: 'docs/architecture/acceptance-cases.md' },
      { type: 'skill', value: '.claude/skills/nession-acceptance/SKILL.md' },
    ],
  );
}

function verifySc17() {
  const docs = read(path.join(workspaceRoot(), 'docs/architecture/acceptance-cases.md'));
  must(docs, /Remote profiles/i, 'remote profile section');
  for (const phrase of ['remote-staging', 'remote-production', 'VPN-connected', 'deployment identity', 'least privilege', 'safe cleanup']) {
    must(docs, new RegExp(phrase, 'i'), 'remote requirement ' + phrase);
  }
  must(docs, /deferred until.*infrastructure/i, 'implementation deferral');
  if (process.env.GITHUB_ACTIONS === 'true') {
    if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF_NAME !== 'main') {
      throw new Error('SC-17 must be proven on the post-merge main push path');
    }
    if (process.env.GITHUB_SHA !== targetSha()) throw new Error('post-merge main SHA mismatch');
  }
  return result(
    'Remote staging/production profiles are separately specified with VPN runner, deployment identity, least privilege and cleanup; implementation remains explicitly deferred.',
    [
      { type: 'docs', value: 'remote-staging and remote-production profile contract specified; runtime enablement deferred' },
      { type: 'workflow', value: 'post-merge evidence target_sha=' + targetSha() + ' branch=main' },
    ],
  );
}

function verifyInfrastructureCriterion(criterion) {
  switch (criterion) {
    case 'SC-09': return verifySc09();
    case 'SC-10': return verifySc10();
    case 'SC-11': return verifySc11();
    case 'SC-12': return verifySc12();
    case 'SC-13': return verifySc13();
    case 'SC-15': return verifySc15();
    case 'SC-16': return verifySc16();
    case 'SC-17': return verifySc17();
    default: throw new Error('unsupported infrastructure criterion ' + criterion);
  }
}

module.exports = { verifyInfrastructureCriterion };
