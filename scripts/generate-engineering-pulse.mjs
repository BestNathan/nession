#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_EXTENSIONS = new Set([
  ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".html", ".sh", ".py", ".sql",
]);
const EXCLUDED_SEGMENTS = new Set([
  ".claude", "node_modules", "target", "dist", "coverage", "vendor",
  "generated", "__snapshots__", "screenshots", "test-results",
]);

function fail(message, fix) {
  throw new Error(`${message}\n  Fix: ${fix}`);
}

function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    fail(
      `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
      "run from a full-history checkout of main (actions/checkout fetch-depth: 0).",
    );
  }
}

function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isSourcePath(file) {
  const normalized = normalizePath(file);
  const segments = normalized.split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(extname(normalized).toLowerCase());
}

function countPhysicalLines(text) {
  if (text.length === 0) return 0;
  const newlineCount = (text.match(/\n/g) ?? []).length;
  return newlineCount + (text.endsWith("\n") ? 0 : 1);
}

function trackedSourceFiles() {
  const raw = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return raw.split("\0").filter(Boolean).filter(isSourcePath);
}

function sourceStats(cutoffIso) {
  const files = trackedSourceFiles();
  let loc = 0;

  for (const file of files) {
    loc += countPhysicalLines(readFileSync(file, "utf8"));
  }

  const baselineBeforeCutoff = git([
    "rev-list",
    "-1",
    `--before=${cutoffIso}`,
    "HEAD",
  ]);
  const roots = git(["rev-list", "--max-parents=0", "HEAD"])
    .split("\n")
    .filter(Boolean);
  const baseline = baselineBeforeCutoff || roots.at(-1);

  if (!baseline) {
    fail(
      "could not determine a churn baseline commit",
      "verify the checkout contains at least one commit.",
    );
  }

  const numstat = git([
    "diff",
    "--numstat",
    "--no-renames",
    `${baseline}..HEAD`,
  ]);

  let additions7d = 0;
  let deletions7d = 0;

  for (const line of numstat.split("\n")) {
    if (!line) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const file = pathParts.join("\t");

    if (!isSourcePath(file)) continue;
    if (!/^\d+$/.test(addedRaw) || !/^\d+$/.test(deletedRaw)) continue;

    additions7d += Number(addedRaw);
    deletions7d += Number(deletedRaw);
  }

  return {
    loc,
    files: files.length,
    additions_7d: additions7d,
    deletions_7d: deletions7d,
    baseline,
  };
}

function commitStats(cutoffIso) {
  return {
    total: Number(git(["rev-list", "--count", "HEAD"])),
    last_7d: Number(
      git(["rev-list", "--count", `--since=${cutoffIso}`, "HEAD"]),
    ),
  };
}

async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "nession-engineering-pulse",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    fail(
      `GitHub API ${path} returned ${response.status}: ${body.slice(0, 300)}`,
      "verify GITHUB_TOKEN has Actions, Issues, Pull Requests and Contents access, then re-run the workflow.",
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
    searchCount(repository, "is:issue", token),
    searchCount(repository, "is:issue is:open", token),
    searchCount(repository, `is:issue created:>=${cutoffIso}`, token),
    searchCount(repository, `is:issue closed:>=${cutoffIso}`, token),
    searchCount(repository, "is:pr", token),
    searchCount(repository, "is:pr is:open", token),
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
  let last7d = 0;

  while (true) {
    const payload = await githubJson(
      `/repos/${repository}/actions/runs?per_page=100&page=${page}`,
      token,
    );
    const runs = payload.workflow_runs ?? [];

    if (page === 1) {
      total = payload.total_count ?? runs.length;
    }

    let sawOlder = false;
    for (const run of runs) {
      const created = Date.parse(run.created_at);
      if (Number.isNaN(created)) continue;
      if (created >= cutoffMs) last7d += 1;
      else sawOlder = true;
    }

    if (sawOlder || runs.length < 100) break;

    page += 1;
    if (page > 100) {
      fail(
        "workflow-run pagination exceeded 10,000 recent runs",
        "narrow the collection strategy before re-running the workflow.",
      );
    }
  }

  return { total, last_7d: last7d };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderSvg(metrics, theme) {
  const dark = theme === "dark";
  const palette = dark
    ? {
        bg: "#0d1117",
        card: "#161b22",
        border: "#30363d",
        text: "#e6edf3",
        muted: "#8b949e",
        accent: "#58a6ff",
        green: "#3fb950",
        red: "#f85149",
      }
    : {
        bg: "#ffffff",
        card: "#f6f8fa",
        border: "#d0d7de",
        text: "#1f2328",
        muted: "#656d76",
        accent: "#0969da",
        green: "#1a7f37",
        red: "#cf222e",
      };

  const cards = [
    {
      label: "Source LOC",
      primary: formatNumber(metrics.source.loc),
      secondary: `${formatNumber(metrics.source.files)} tracked source files`,
      kind: "text",
    },
    {
      label: "7d Churn",
      primary: "",
      secondary: "source additions / deletions",
      kind: "churn",
    },
    {
      label: "Commits",
      primary: formatNumber(metrics.commits.total),
      secondary: `+${formatNumber(metrics.commits.last_7d)} in 7d`,
      kind: "accent",
    },
    {
      label: "Issues",
      primary: `${formatNumber(metrics.issues.total)} total`,
      secondary: `${formatNumber(metrics.issues.open)} open · +${formatNumber(metrics.issues.created_7d)} / ${formatNumber(metrics.issues.closed_7d)} closed 7d`,
      kind: "accent",
    },
    {
      label: "Pull Requests",
      primary: `${formatNumber(metrics.pull_requests.total)} total`,
      secondary: `${formatNumber(metrics.pull_requests.open)} open · +${formatNumber(metrics.pull_requests.created_7d)} / ${formatNumber(metrics.pull_requests.merged_7d)} merged 7d`,
      kind: "accent",
    },
    {
      label: "Workflow Runs",
      primary: formatNumber(metrics.workflow_runs.total),
      secondary: `+${formatNumber(metrics.workflow_runs.last_7d)} in 7d`,
      kind: "accent",
    },
  ];

  const width = 960;
  const height = 248;
  const margin = 16;
  const gap = 12;
  const cardWidth = (width - margin * 2 - gap * 2) / 3;
  const cardHeight = 78;
  const startY = 58;

  const cardSvg = cards
    .map((card, index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const x = margin + col * (cardWidth + gap);
      const y = startY + row * (cardHeight + gap);
      const primaryColor =
        card.kind === "accent" ? palette.accent : palette.text;
      const primaryText =
        card.kind === "churn"
          ? `<tspan fill="${palette.green}">+${xml(formatNumber(metrics.source.additions_7d))}</tspan><tspan fill="${palette.muted}"> / </tspan><tspan fill="${palette.red}">−${xml(formatNumber(metrics.source.deletions_7d))}</tspan>`
          : xml(card.primary);

      return `
      <g>
        <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="10" fill="${palette.card}" stroke="${palette.border}"/>
        <text x="${x + 14}" y="${y + 22}" class="label">${xml(card.label)}</text>
        <text x="${x + 14}" y="${y + 49}" class="primary" fill="${primaryColor}">${primaryText}</text>
        <text x="${x + 14}" y="${y + 68}" class="secondary">${xml(card.secondary)}</text>
      </g>`;
    })
    .join("");

  const updated = new Date(metrics.generated_at)
    .toISOString()
    .replace(".000Z", "Z");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Nession Engineering Pulse</title>
  <desc id="desc">Repository scale and rolling seven-day engineering activity for Nession.</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .heading { font-size: 18px; font-weight: 650; fill: ${palette.text}; }
    .meta { font-size: 11px; fill: ${palette.muted}; }
    .label { font-size: 11px; font-weight: 600; fill: ${palette.muted}; }
    .primary { font-size: 20px; font-weight: 700; }
    .secondary { font-size: 10px; fill: ${palette.muted}; }
  </style>
  <rect width="${width}" height="${height}" rx="14" fill="${palette.bg}" stroke="${palette.border}"/>
  <text x="${margin}" y="28" class="heading">Engineering Pulse</text>
  <text x="${width - margin}" y="28" text-anchor="end" class="meta">main · rolling 7d · updated ${xml(updated)}</text>
  ${cardSvg}
</svg>
`;
}

function runSelfTest() {
  const checks = [
    [isSourcePath("crates/nession-server/src/main.rs"), true, "Rust source is included"],
    [isSourcePath("web/src/App.tsx"), true, "TSX source is included"],
    [isSourcePath("web/src/generated/protocol.ts"), false, "generated source is excluded"],
    [isSourcePath("e2e/specs/__snapshots__/fixture.ts"), false, "snapshots are excluded"],
    [isSourcePath("Cargo.lock"), false, "lockfiles are excluded"],
    [countPhysicalLines("a\nb\n"), 2, "trailing-newline line count"],
    [countPhysicalLines("a\nb"), 2, "non-trailing-newline line count"],
    [countPhysicalLines(""), 0, "empty file line count"],
  ];

  for (const [actual, expected, name] of checks) {
    if (actual !== expected) {
      fail(
        `self-test failed: ${name} (got ${actual}, expected ${expected})`,
        "fix the generator before publishing metrics.",
      );
    }
  }

  const fixture = {
    generated_at: "2026-09-28T00:00:00.000Z",
    source: {
      loc: 12345,
      files: 100,
      additions_7d: 500,
      deletions_7d: 300,
    },
    commits: { total: 1000, last_7d: 50 },
    issues: { total: 200, open: 20, created_7d: 10, closed_7d: 8 },
    pull_requests: {
      total: 900,
      open: 2,
      created_7d: 30,
      merged_7d: 28,
    },
    workflow_runs: { total: 3000, last_7d: 400 },
  };

  const svg = renderSvg(fixture, "dark");
  if (
    !svg.includes("Engineering Pulse") ||
    !svg.includes("+500") ||
    !svg.includes("−300")
  ) {
    fail(
      "self-test failed: SVG fixture did not render expected metrics",
      "fix renderSvg before publishing metrics.",
    );
  }

  console.log("✓ Engineering Pulse generator self-test passed");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;

  if (!repository) {
    fail(
      "GITHUB_REPOSITORY is not set",
      "run inside GitHub Actions or export owner/repo before invoking the generator.",
    );
  }
  if (!token) {
    fail(
      "GITHUB_TOKEN is not set",
      "provide the workflow GITHUB_TOKEN with repository read permissions.",
    );
  }

  const now = process.env.METRICS_NOW
    ? new Date(process.env.METRICS_NOW)
    : new Date();
  if (Number.isNaN(now.getTime())) {
    fail(
      `METRICS_NOW is invalid: ${process.env.METRICS_NOW}`,
      "unset METRICS_NOW or provide a valid ISO-8601 timestamp.",
    );
  }

  const cutoff = new Date(now.getTime() - 7 * DAY_MS);
  const cutoffIso = cutoff.toISOString().replace(".000Z", "Z");
  const outputDir = resolve(
    process.env.METRICS_OUTPUT_DIR || "engineering-pulse-out",
  );

  const source = sourceStats(cutoffIso);
  const commits = commitStats(cutoffIso);
  const [{ issues, pull_requests }, workflow_runs] = await Promise.all([
    issueAndPrStats(repository, cutoffIso, token),
    workflowStats(repository, cutoff.getTime(), token),
  ]);

  const metrics = {
    schema_version: 1,
    repository,
    branch: "main",
    generated_at: now.toISOString(),
    window_start: cutoff.toISOString(),
    source,
    commits,
    issues,
    pull_requests,
    workflow_runs,
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    resolve(outputDir, "metrics.json"),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  writeFileSync(
    resolve(outputDir, "project-pulse-light.svg"),
    renderSvg(metrics, "light"),
  );
  writeFileSync(
    resolve(outputDir, "project-pulse-dark.svg"),
    renderSvg(metrics, "dark"),
  );

  console.log(`✓ Engineering Pulse generated in ${outputDir}`);
  console.log(
    `  Source LOC: ${formatNumber(source.loc)} (${formatNumber(source.files)} files)`,
  );
  console.log(
    `  7d churn: +${formatNumber(source.additions_7d)} / −${formatNumber(source.deletions_7d)}`,
  );
  console.log(
    `  Commits: ${formatNumber(commits.total)} total / +${formatNumber(commits.last_7d)} 7d`,
  );
  console.log(
    `  Issues: ${formatNumber(issues.total)} total / ${formatNumber(issues.open)} open`,
  );
  console.log(
    `  PRs: ${formatNumber(pull_requests.total)} total / ${formatNumber(pull_requests.open)} open`,
  );
  console.log(
    `  Workflow runs: ${formatNumber(workflow_runs.total)} total / +${formatNumber(workflow_runs.last_7d)} 7d`,
  );
}

main().catch((error) => {
  console.error(
    `✗ Engineering Pulse generation failed: ${error?.message ?? error}`,
  );
  process.exit(1);
});
