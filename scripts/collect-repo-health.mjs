#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function fail(message, fix) {
  throw new Error(`${message}\n  Fix: ${fix}`);
}

function gitSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) {
    fail(
      `${command} could not start: ${result.error.message}`,
      options.fix ?? `verify ${command} is installed.`,
    );
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function execution(passed, failed, skipped) {
  const denominator = passed + failed;
  return {
    total: passed + failed + skipped,
    passed,
    failed,
    skipped,
    pass_rate: denominator === 0 ? null : passed / denominator,
  };
}

function unavailableCoverage(reason, includeCrates = false) {
  return {
    status: 'unavailable',
    reason,
    lines: { covered: null, total: null, rate: null },
    ...(includeCrates ? { crates: {} } : {}),
  };
}

function parseCargoSummaries(text) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let matches = 0;
  for (const match of text.matchAll(
    /test result:\s+\w+\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;/g,
  )) {
    passed += Number(match[1]);
    failed += Number(match[2]);
    skipped += Number(match[3]);
    matches += 1;
  }
  if (matches === 0) return null;
  return execution(passed, failed, skipped);
}

function rustThresholds() {
  const text = readFileSync('scripts/check-coverage.sh', 'utf8');
  const thresholds = {};
  for (const match of text.matchAll(/\["([^"]+)"\]=(\d+)/g)) {
    thresholds[match[1]] = Number(match[2]);
  }
  if (Object.keys(thresholds).length === 0) {
    fail(
      'could not read Rust coverage crate thresholds',
      'keep THRESHOLDS in scripts/check-coverage.sh machine-readable.',
    );
  }
  return thresholds;
}

function parseRustCoverage(payload, thresholds) {
  const files = payload?.data?.[0]?.files;
  if (!Array.isArray(files)) {
    fail(
      'cargo llvm-cov JSON has no data[0].files',
      'verify cargo-llvm-cov still emits LLVM coverage JSON.',
    );
  }

  const crates = {};
  let coveredTotal = 0;
  let lineTotal = 0;

  for (const [crate, threshold] of Object.entries(thresholds)) {
    let covered = 0;
    let total = 0;
    for (const file of files) {
      const filename = String(file.filename ?? '').replaceAll('\\', '/');
      if (
        !filename.includes(`/crates/${crate}/`) ||
        filename.endsWith('/main.rs')
      ) {
        continue;
      }
      covered += Number(file?.summary?.lines?.covered ?? 0);
      total += Number(file?.summary?.lines?.count ?? 0);
    }

    crates[crate] = {
      lines: {
        covered,
        total,
        rate: total === 0 ? null : covered / total,
      },
      threshold: threshold / 100,
    };
    coveredTotal += covered;
    lineTotal += total;
  }

  return {
    lines: {
      covered: coveredTotal,
      total: lineTotal,
      rate: lineTotal === 0 ? null : coveredTotal / lineTotal,
    },
    crates,
  };
}

function parseVitestJson(path) {
  if (!existsSync(path)) return null;
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  const total = Number(payload.numTotalTests ?? 0);
  const passed = Number(payload.numPassedTests ?? 0);
  const failed = Number(payload.numFailedTests ?? 0);
  const skipped = Number(
    payload.numPendingTests ??
      payload.numTodoTests ??
      Math.max(0, total - passed - failed),
  );
  return execution(passed, failed, skipped);
}

function playwrightTests(suites, out = []) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) out.push(test);
    }
    playwrightTests(suite.suites, out);
  }
  return out;
}

function parsePlaywrightJson(path) {
  if (!existsSync(path)) return null;
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const test of playwrightTests(payload.suites)) {
    const result = Array.isArray(test.results) ? test.results.at(-1) : null;
    const status = result?.status ?? test.status ?? test.expectedStatus;
    if (status === 'passed' || status === 'expected') passed += 1;
    else if (status === 'skipped') skipped += 1;
    else failed += 1;
  }

  return execution(passed, failed, skipped);
}

function write(path, value) {
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

function collectRust(output) {
  const unitRun = run('cargo', [
    'test',
    '--workspace',
    '--lib',
    '--no-fail-fast',
    '--color',
    'never',
  ]);
  const integrationRun = run('cargo', [
    'test',
    '--workspace',
    '--test',
    'integration',
    '--no-fail-fast',
    '--color',
    'never',
  ]);

  const unit = parseCargoSummaries(
    `${unitRun.stdout}\n${unitRun.stderr}`,
  );
  const integration = parseCargoSummaries(
    `${integrationRun.stdout}\n${integrationRun.stderr}`,
  );

  if (!unit) {
    fail(
      'Rust unit tests produced no libtest summaries',
      'run `cargo test --workspace --lib` and restore standard libtest summary output.',
    );
  }
  if (!integration) {
    fail(
      'Rust integration tests produced no libtest summaries',
      'run `cargo test --workspace --test integration` and restore standard libtest summary output.',
    );
  }

  const thresholds = rustThresholds();
  const packages = Object.keys(thresholds).flatMap((crate) => ['-p', crate]);
  const coverageRun = run('cargo', [
    'llvm-cov',
    ...packages,
    '--json',
    '--',
    '--skip',
    'terminal_io',
  ]);

  let coverage;
  try {
    coverage = parseRustCoverage(JSON.parse(coverageRun.stdout), thresholds);
  } catch (error) {
    if (unit.failed > 0 || integration.failed > 0) {
      coverage = unavailableCoverage(
        'coverage unavailable because the measured Rust test revision has failing tests',
        true,
      );
    } else {
      fail(
        `cargo llvm-cov did not produce usable JSON: ${error?.message ?? error}`,
        'install cargo-llvm-cov + llvm-tools-preview and inspect its stderr output.',
      );
    }
  }

  write(output, {
    schema_version: 1,
    collector: 'rust',
    commit_sha: gitSha(),
    measured_at: new Date().toISOString(),
    tests: { unit, integration },
    coverage,
    commands: {
      unit_exit_code: unitRun.code,
      integration_exit_code: integrationRun.code,
      coverage_exit_code: coverageRun.code,
    },
  });
}

function collectWeb(output) {
  const temp = mkdtempSync(join(tmpdir(), 'nession-web-metrics-'));
  const unitPath = join(temp, 'unit.json');
  const integrationPath = join(temp, 'integration.json');

  const unitRun = run(
    'npx',
    [
      'vitest',
      'run',
      '--project',
      'unit',
      '--reporter=json',
      `--outputFile=${unitPath}`,
    ],
    { cwd: 'web' },
  );
  const integrationRun = run(
    'npx',
    [
      'vitest',
      'run',
      '--project',
      'integration',
      '--reporter=json',
      `--outputFile=${integrationPath}`,
    ],
    { cwd: 'web' },
  );

  const unit = parseVitestJson(unitPath);
  const integration = parseVitestJson(integrationPath);
  if (!unit) {
    fail(
      'Vitest unit reporter JSON is missing',
      'run the unit project with the built-in JSON reporter.',
    );
  }
  if (!integration) {
    fail(
      'Vitest integration reporter JSON is missing',
      'run the integration project with the built-in JSON reporter.',
    );
  }

  const coverageRun = run(
    'npx',
    ['vitest', 'run', '--coverage', '--reporter=dot'],
    { cwd: 'web' },
  );
  const summaryPath = resolve('web/coverage/coverage-summary.json');
  let coverage;

  if (existsSync(summaryPath)) {
    try {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      const lines = summary?.total?.lines;
      if (!lines) throw new Error('coverage summary has no total.lines');

      coverage = {
        lines: {
          covered: Number(lines.covered ?? 0),
          total: Number(lines.total ?? 0),
          rate:
            Number(lines.total ?? 0) === 0
              ? null
              : Number(lines.covered ?? 0) / Number(lines.total),
        },
      };
    } catch (error) {
      if (unit.failed === 0 && integration.failed === 0) {
        fail(
          `Vitest coverage summary is invalid: ${error?.message ?? error}`,
          'verify @vitest/coverage-v8 JSON summary output.',
        );
      }
    }
  }

  if (!coverage) {
    if (unit.failed > 0 || integration.failed > 0) {
      coverage = unavailableCoverage(
        'coverage unavailable because the measured Web test revision has failing tests',
      );
    } else {
      fail(
        'Vitest coverage-summary.json is missing',
        'keep `json-summary` in web/vite.config.ts coverage reporters.',
      );
    }
  }

  write(output, {
    schema_version: 1,
    collector: 'web',
    commit_sha: gitSha(),
    measured_at: new Date().toISOString(),
    tests: { unit, integration },
    coverage,
    commands: {
      unit_exit_code: unitRun.code,
      integration_exit_code: integrationRun.code,
      coverage_exit_code: coverageRun.code,
    },
  });
}

function collectE2e(output) {
  const report = resolve(
    mkdtempSync(join(tmpdir(), 'nession-e2e-metrics-')),
    'playwright.json',
  );
  const e2eRun = run('npx', ['playwright', 'test', '--reporter=json'], {
    cwd: 'e2e',
    env: {
      CI: 'true',
      PLAYWRIGHT_JSON_OUTPUT_FILE: report,
    },
  });

  const tests = parsePlaywrightJson(report);
  if (!tests) {
    fail(
      'Playwright JSON report is missing',
      'run Playwright with its built-in JSON reporter and PLAYWRIGHT_JSON_OUTPUT_FILE.',
    );
  }

  write(output, {
    schema_version: 1,
    collector: 'e2e',
    commit_sha: gitSha(),
    measured_at: new Date().toISOString(),
    tests,
    commands: { e2e_exit_code: e2eRun.code },
  });
}

function selfTest() {
  const cargo = parseCargoSummaries(
    'test result: ok. 10 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out;\n' +
      'test result: ok. 3 passed; 0 failed; 1 ignored;',
  );
  if (
    cargo?.passed !== 13 ||
    cargo?.failed !== 1 ||
    cargo?.skipped !== 3
  ) {
    fail(
      'self-test failed: cargo summary aggregation',
      'fix parseCargoSummaries.',
    );
  }

  const ex = execution(8, 2, 5);
  if (ex.total !== 15 || ex.pass_rate !== 0.8) {
    fail(
      'self-test failed: pass-rate semantics',
      'keep skipped tests outside the denominator.',
    );
  }

  console.log('✓ Repository health collector self-test passed');
}

try {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else {
    const mode = process.argv[2];
    const output = process.argv[3];

    if (!mode || !output) {
      fail(
        'usage: collect-repo-health.mjs <rust|web|e2e> <output.json>',
        'provide a collector mode and output path.',
      );
    }

    if (mode === 'rust') collectRust(output);
    else if (mode === 'web') collectWeb(output);
    else if (mode === 'e2e') collectE2e(output);
    else fail(`unknown collector mode: ${mode}`, 'use rust, web, or e2e.');

    console.log(`✓ ${mode} repository health written to ${output}`);
  }
} catch (error) {
  console.error(
    `✗ Repository health collection failed: ${error?.message ?? error}`,
  );
  process.exit(1);
}
