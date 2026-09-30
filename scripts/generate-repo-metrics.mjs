#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_EXTENSIONS = new Set([
  '.rs',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.html',
  '.sh',
  '.py',
  '.sql',
]);
const EXCLUDED_SEGMENTS = new Set([
  '.claude',
  'node_modules',
  'target',
  'dist',
  'coverage',
  'vendor',
  'generated',
  '__snapshots__',
  'screenshots',
  'test-results',
]);

function fail(message, fix) {
  throw new Error(`${message}\n  Fix: ${fix}`);
}

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    fail(
      `git ${args.join(' ')} failed${error?.stderr ? `: ${String(error.stderr).trim()}` : ''}`,
      'run from a full-history checkout of main.',
    );
  }
}

function normalizePath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isSourcePath(file) {
  const normalized = normalizePath(file);
  if (
    normalized
      .split('/')
      .some((segment) => EXCLUDED_SEGMENTS.has(segment))
  ) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(extname(normalized).toLowerCase());
}

function countPhysicalLines(text) {
  if (!text.length) return 0;
  const newlineCount = (text.match(/\n/g) ?? []).length;
  return newlineCount + (text.endsWith('\n') ? 0 : 1);
}

function trackedSourceFiles() {
  const raw = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return raw.split('\0').filter(Boolean).filter(isSourcePath);
}

function sourceStats(cutoffIso) {
  const files = trackedSourceFiles();
  let loc = 0;
  for (const file of files) {
    loc += countPhysicalLines(readFileSync(file, 'utf8'));
  }

  const baselineBeforeCutoff = git([
    'rev-list',
    '-1',
    `--before=${cutoffIso}`,
    'HEAD',
  ]);
  const roots = git(['rev-list', '--max-parents=0', 'HEAD'])
    .split('\n')
    .filter(Boolean);
  const baseline = baselineBeforeCutoff || roots.at(-1);

  if (!baseline) {
    fail(
      'could not determine a churn baseline commit',
      'verify the checkout contains at least one commit.',
    );
  }

  const numstat = git([
    'diff',
    '--numstat',
    '--no-renames',
    `${baseline}..HEAD`,
  ]);

  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    if (!line) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split('\t');
    const file = pathParts.join('\t');

    if (!isSourcePath(file)) continue;
    if (!/^\d+$/.test(addedRaw) || !/^\d+$/.test(deletedRaw)) continue;

    additions += Number(addedRaw);
    deletions += Number(deletedRaw);
  }

  return {
    repository: { loc, files: files.length },
    churn: { additions, deletions, baseline },
  };
}

function commitStats(cutoffIso) {
  return {
    total: Number(git(['rev-list', '--count', 'HEAD'])),
    last_7d: Number(
      git(['rev-list', '--count', `--since=${cutoffIso}`, 'HEAD']),
    ),
  };
}

async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'nession-repo-metrics',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    fail(
      `GitHub API ${path} returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
      'verify GITHUB_TOKEN repository read permissions.',
    );
  }

  return response.json();
}

async function searchCount(repository, qualifier, token) {
  const query = `repo:${repository} ${qualifier}`;
  const payload = await githubJson(
    `/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
    token,
  );
  return payload.total_count ?? 0;
}

async function issueAndPrStats(repository, cutoffIso, token) {
  const [
    issuesTotal,
    issuesOpen,
    issuesCreated7d,
    issuesClosed7d,
    prsTotal,
    prsOpen,
    prsCreated7d,
    prsMerged7d,
  ] = await Promise.all([
    searchCount(repository, 'is:issue', token),
    searchCount(repository, 'is:issue is:open', token),
    searchCount(repository, `is:issue created:>=${cutoffIso}`, token),
    searchCount(repository, `is:issue closed:>=${cutoffIso}`, token),
    searchCount(repository, 'is:pr', token),
    searchCount(repository, 'is:pr is:open', token),
    searchCount(repository, `is:pr created:>=${cutoffIso}`, token),
    searchCount(repository, `is:pr is:merged merged:>=${cutoffIso}`, token),
  ]);

  return {
    issues: {
      total: issuesTotal,
      open: issuesOpen,
      created_7d: issuesCreated7d,
      closed_7d: issuesClosed7d,
    },
    pull_requests: {
      total: prsTotal,
      open: prsOpen,
      created_7d: prsCreated7d,
      merged_7d: prsMerged7d,
    },
  };
}

async function workflowStats(repository, cutoffMs, token) {
  let page = 1;
  let total = 0;
  let last_7d = 0;

  while (true) {
    const payload = await githubJson(
      `/repos/${repository}/actions/runs?per_page=100&page=${page}`,
      token,
    );
    const runs = payload.workflow_runs ?? [];

    if (page === 1) total = payload.total_count ?? runs.length;

    let sawOlder = false;
    for (const run of runs) {
      const created = Date.parse(run.created_at);
      if (Number.isNaN(created)) continue;
      if (created >= cutoffMs) last_7d += 1;
      else sawOlder = true;
    }

    if (sawOlder || runs.length < 100) break;

    page += 1;
    if (page > 100) {
      fail(
        'workflow-run pagination exceeded 10,000 recent runs',
        'narrow the collection strategy.',
      );
    }
  }

  return { total, last_7d };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(
      `${label} is missing or invalid: ${path}`,
      'inspect the corresponding repo-metrics collector job and re-run the workflow.',
    );
  }
}

function assertCollector(payload, expected, sha) {
  if (payload?.collector !== expected) {
    fail(
      `${expected} collector artifact has wrong identity`,
      'regenerate the collector artifact.',
    );
  }
  if (payload?.commit_sha !== sha) {
    fail(
      `${expected} metrics were measured at ${payload?.commit_sha ?? 'unknown'}, expected ${sha}`,
      'collect and publish metrics from the same main commit.',
    );
  }
}

function loadHealth(dir, sha) {
  const rust = readJson(resolve(dir, 'rust-health.json'), 'Rust health artifact');
  const web = readJson(resolve(dir, 'web-health.json'), 'Web health artifact');
  const e2e = readJson(resolve(dir, 'e2e-health.json'), 'E2E health artifact');

  assertCollector(rust, 'rust', sha);
  assertCollector(web, 'web', sha);
  assertCollector(e2e, 'e2e', sha);

  return { rust, web, e2e };
}

function protocolStats() {
  let text;
  try {
    text = execFileSync('node', ['scripts/protocol-gate.mjs', '--json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    fail(
      `protocol catalog collection failed${error?.stderr ? `: ${String(error.stderr).trim()}` : ''}`,
      'run `node scripts/protocol-gate.mjs --json` and fix the protocol gate.',
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    fail(
      'protocol gate --json returned invalid JSON',
      'keep --json output machine-readable with no log prefix.',
    );
  }
}

function aggregateExecution(...parts) {
  const passed = parts.reduce(
    (sum, part) => sum + Number(part?.passed ?? 0),
    0,
  );
  const failed = parts.reduce(
    (sum, part) => sum + Number(part?.failed ?? 0),
    0,
  );
  const skipped = parts.reduce(
    (sum, part) => sum + Number(part?.skipped ?? 0),
    0,
  );
  const denominator = passed + failed;

  return {
    passed,
    failed,
    skipped,
    pass_rate: denominator === 0 ? null : passed / denominator,
  };
}

function assembleRepository(source, health, protocols) {
  const unit = aggregateExecution(
    health.rust.tests.unit,
    health.web.tests.unit,
  );
  const integration = aggregateExecution(
    health.rust.tests.integration,
    health.web.tests.integration,
  );
  const e2e = aggregateExecution(health.e2e.tests);

  const tests = {
    unit: {
      total:
        Number(health.rust.tests.unit.total) +
        Number(health.web.tests.unit.total),
      rust: health.rust.tests.unit.total,
      web: health.web.tests.unit.total,
    },
    integration: {
      total:
        Number(health.rust.tests.integration.total) +
        Number(health.web.tests.integration.total),
      rust: health.rust.tests.integration.total,
      web: health.web.tests.integration.total,
    },
    e2e: {
      total: health.e2e.tests.total,
      playwright: health.e2e.tests.total,
    },
  };

  tests.total = tests.unit.total + tests.integration.total + tests.e2e.total;

  return {
    source,
    tests,
    execution: { unit, integration, e2e },
    coverage: {
      rust: health.rust.coverage,
      web: health.web.coverage,
    },
    protocols,
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value) {
  return value == null || !Number.isFinite(Number(value))
    ? 'N/A'
    : `${Math.round(Number(value) * 100)}%`;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderCard(card, index, y, palette, metrics) {
  const width = 1180;
  const margin = 16;
  const gap = 10;
  const cardWidth = (width - margin * 2 - gap * 4) / 5;
  const cardHeight = 72;
  const x = margin + index * (cardWidth + gap);

  let primary = xml(card.primary);
  const primaryColor =
    card.kind === 'accent' ? palette.accent : palette.text;

  if (card.kind === 'churn') {
    primary =
      `<tspan fill="${palette.green}">+${xml(formatNumber(metrics.efficiency.source_churn.additions))}</tspan>` +
      `<tspan fill="${palette.muted}"> / </tspan>` +
      `<tspan fill="${palette.red}">−${xml(formatNumber(metrics.efficiency.source_churn.deletions))}</tspan>`;
  }

  return (
    `<g><rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="10" fill="${palette.card}" stroke="${palette.border}"/>` +
    `<text x="${x + 13}" y="${y + 20}" class="label">${xml(card.label)}</text>` +
    `<text x="${x + 13}" y="${y + 45}" class="primary" fill="${primaryColor}">${primary}</text>` +
    `<text x="${x + 13}" y="${y + 63}" class="secondary">${xml(card.secondary)}</text></g>`
  );
}

function renderSvg(metrics, theme) {
  const dark = theme === 'dark';
  const palette = dark
    ? {
        bg: '#0d1117',
        card: '#161b22',
        border: '#30363d',
        text: '#e6edf3',
        muted: '#8b949e',
        accent: '#58a6ff',
        green: '#3fb950',
        red: '#f85149',
      }
    : {
        bg: '#ffffff',
        card: '#f6f8fa',
        border: '#d0d7de',
        text: '#1f2328',
        muted: '#656d76',
        accent: '#0969da',
        green: '#1a7f37',
        red: '#cf222e',
      };

  const repository = metrics.repository;
  const efficiency = metrics.efficiency;

  const repositoryCards = [
    {
      label: 'Source',
      primary: `${formatNumber(repository.source.loc)} LOC`,
      secondary: `${formatNumber(repository.source.files)} tracked files`,
    },
    {
      label: 'Tests',
      primary: `${formatNumber(repository.tests.total)} total`,
      secondary:
        `U ${formatNumber(repository.tests.unit.total)} · ` +
        `I ${formatNumber(repository.tests.integration.total)} · ` +
        `E2E ${formatNumber(repository.tests.e2e.total)}`,
      kind: 'accent',
    },
    {
      label: 'Coverage',
      primary: `Rust ${formatPercent(repository.coverage.rust.lines.rate)}`,
      secondary: `Web ${formatPercent(repository.coverage.web.lines.rate)}`,
      kind: 'accent',
    },
    {
      label: 'Test Health',
      primary:
        `U ${formatPercent(repository.execution.unit.pass_rate)} · ` +
        `I ${formatPercent(repository.execution.integration.pass_rate)}`,
      secondary: `E2E ${formatPercent(repository.execution.e2e.pass_rate)}`,
      kind: 'accent',
    },
    {
      label: 'Protocols',
      primary: `${formatNumber(repository.protocols.units.total)} units`,
      secondary:
        `server ${formatNumber(repository.protocols.units.server)} · ` +
        `agent ${formatNumber(repository.protocols.units.agent)} · ` +
        `other ${formatNumber(repository.protocols.units.other)}`,
      kind: 'accent',
    },
  ];

  const efficiencyCards = [
    {
      label: 'Code Churn · 7d',
      primary: '',
      secondary: 'source additions / deletions',
      kind: 'churn',
    },
    {
      label: 'Commits',
      primary: formatNumber(efficiency.commits.total),
      secondary: `+${formatNumber(efficiency.commits.last_7d)} in 7d`,
      kind: 'accent',
    },
    {
      label: 'Issues',
      primary: `${formatNumber(efficiency.issues.open)} open`,
      secondary:
        `+${formatNumber(efficiency.issues.created_7d)} / ` +
        `−${formatNumber(efficiency.issues.closed_7d)} in 7d`,
      kind: 'accent',
    },
    {
      label: 'Pull Requests',
      primary: `${formatNumber(efficiency.pull_requests.open)} open`,
      secondary:
        `+${formatNumber(efficiency.pull_requests.created_7d)} / ` +
        `${formatNumber(efficiency.pull_requests.merged_7d)} merged 7d`,
      kind: 'accent',
    },
    {
      label: 'Workflow Activity',
      primary: formatNumber(efficiency.workflow_runs.total),
      secondary: `+${formatNumber(efficiency.workflow_runs.last_7d)} in 7d`,
      kind: 'accent',
    },
  ];

  const repositorySvg = repositoryCards
    .map((card, index) =>
      renderCard(card, index, 82, palette, metrics),
    )
    .join('');
  const efficiencySvg = efficiencyCards
    .map((card, index) =>
      renderCard(card, index, 226, palette, metrics),
    )
    .join('');

  const updated = new Date(metrics.generated_at)
    .toISOString()
    .replace('.000Z', 'Z');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1180" height="316" viewBox="0 0 1180 316" role="img" aria-labelledby="title desc">
  <title id="title">Nession Repository Telemetry</title>
  <desc id="desc">Current repository health and rolling seven-day engineering efficiency for Nession.</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .heading { font-size: 18px; font-weight: 650; fill: ${palette.text}; }
    .group { font-size: 11px; font-weight: 700; letter-spacing: .8px; fill: ${palette.text}; }
    .meta, .subtitle, .label, .secondary { fill: ${palette.muted}; }
    .meta, .subtitle, .label { font-size: 11px; }
    .label { font-weight: 600; }
    .primary { font-size: 18px; font-weight: 700; }
    .secondary { font-size: 10px; }
  </style>
  <rect width="1180" height="316" rx="14" fill="${palette.bg}" stroke="${palette.border}"/>
  <text x="16" y="28" class="heading">Repository Telemetry</text>
  <text x="1164" y="28" text-anchor="end" class="meta">main · updated ${xml(updated)}</text>

  <text x="16" y="55" class="group">REPOSITORY METRICS</text>
  <text x="1164" y="55" text-anchor="end" class="subtitle">current structure &amp; health</text>
  ${repositorySvg}

  <line x1="16" y1="177" x2="1164" y2="177" stroke="${palette.border}"/>

  <text x="16" y="200" class="group">ENGINEERING EFFICIENCY</text>
  <text x="1164" y="200" text-anchor="end" class="subtitle">rolling 7d · throughput &amp; repository flow</text>
  ${efficiencySvg}
</svg>
`;
}

function runSelfTest() {
  const checks = [
    [isSourcePath('crates/nession-server/src/main.rs'), true],
    [isSourcePath('web/src/generated/protocol.ts'), false],
    [countPhysicalLines('a\nb\n'), 2],
    [countPhysicalLines(''), 0],
  ];

  for (const [actual, expected] of checks) {
    if (actual !== expected) {
      fail(
        'self-test failed: source accounting',
        'fix repository source filters.',
      );
    }
  }

  const fixture = {
    generated_at: '2026-09-29T00:00:00.000Z',
    repository: {
      source: { loc: 12345, files: 100 },
      tests: {
        total: 312,
        unit: { total: 220 },
        integration: { total: 64 },
        e2e: { total: 28 },
      },
      execution: {
        unit: { pass_rate: 1 },
        integration: { pass_rate: 0.99 },
        e2e: { pass_rate: 0.97 },
      },
      coverage: {
        rust: { lines: { rate: 0.84 } },
        web: { lines: { rate: 0.88 } },
      },
      protocols: {
        units: { total: 58, server: 21, agent: 29, other: 8 },
      },
    },
    efficiency: {
      source_churn: { additions: 500, deletions: 300 },
      commits: { total: 1000, last_7d: 50 },
      issues: { open: 20, created_7d: 10, closed_7d: 8 },
      pull_requests: { open: 2, created_7d: 30, merged_7d: 28 },
      workflow_runs: { total: 3000, last_7d: 400 },
    },
  };

  const svg = renderSvg(fixture, 'dark');
  for (const required of [
    'REPOSITORY METRICS',
    'ENGINEERING EFFICIENCY',
    'Rust 84%',
    'server 21',
    '+500',
  ]) {
    if (!svg.includes(required)) {
      fail(
        `self-test failed: SVG missing ${required}`,
        'fix layered SVG rendering.',
      );
    }
  }

  console.log('✓ Repository Metrics generator self-test passed');
}

async function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;

  if (!repository) {
    fail(
      'GITHUB_REPOSITORY is not set',
      'run inside GitHub Actions or export owner/repo.',
    );
  }
  if (!token) {
    fail(
      'GITHUB_TOKEN is not set',
      'provide the workflow GITHUB_TOKEN.',
    );
  }

  const now = process.env.METRICS_NOW
    ? new Date(process.env.METRICS_NOW)
    : new Date();

  if (Number.isNaN(now.getTime())) {
    fail(
      `METRICS_NOW is invalid: ${process.env.METRICS_NOW}`,
      'provide a valid ISO-8601 timestamp.',
    );
  }

  const cutoff = new Date(now.getTime() - 7 * DAY_MS);
  const cutoffIso = cutoff.toISOString().replace('.000Z', 'Z');
  const outputDir = resolve(
    process.env.METRICS_OUTPUT_DIR || 'repo-metrics-out',
  );
  const healthDir = resolve(
    process.env.REPO_METRICS_HEALTH_DIR || 'repo-health',
  );
  const commitSha = git(['rev-parse', 'HEAD']);

  const source = sourceStats(cutoffIso);
  const health = loadHealth(healthDir, commitSha);
  const protocols = protocolStats();
  const commits = commitStats(cutoffIso);
  const [{ issues, pull_requests }, workflow_runs] = await Promise.all([
    issueAndPrStats(repository, cutoffIso, token),
    workflowStats(repository, cutoff.getTime(), token),
  ]);

  const metrics = {
    schema_version: 2,
    repository_name: repository,
    branch: 'main',
    commit_sha: commitSha,
    generated_at: now.toISOString(),
    repository: assembleRepository(
      source.repository,
      health,
      protocols,
    ),
    efficiency: {
      window: '7d',
      window_start: cutoff.toISOString(),
      source_churn: source.churn,
      commits,
      issues,
      pull_requests,
      workflow_runs,
    },
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    resolve(outputDir, 'metrics.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  writeFileSync(
    resolve(outputDir, 'repo-metrics-light.svg'),
    renderSvg(metrics, 'light'),
  );
  writeFileSync(
    resolve(outputDir, 'repo-metrics-dark.svg'),
    renderSvg(metrics, 'dark'),
  );

  console.log(`✓ Repository Metrics generated in ${outputDir}`);
  console.log(
    `  Repository: ${formatNumber(metrics.repository.source.loc)} LOC · ` +
      `${formatNumber(metrics.repository.tests.total)} tests · ` +
      `${formatNumber(metrics.repository.protocols.units.total)} protocol units`,
  );
  console.log(
    `  Efficiency: +${formatNumber(metrics.efficiency.source_churn.additions)} / ` +
      `−${formatNumber(metrics.efficiency.source_churn.deletions)} source lines in 7d`,
  );
}

main().catch((error) => {
  console.error(
    `✗ Repository Metrics generation failed: ${error?.message ?? error}`,
  );
  process.exit(1);
});
