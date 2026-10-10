import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyBrowserReport, extractGeometryEvidence } from './browser-report.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;

function normalizeEvidence(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('verifier evidence must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('evidence[' + index + '] must be an object');
    const type = String(item.type ?? '').trim();
    const evidence = String(item.value ?? '').trim();
    if (!type || !evidence || /[\r\n]/.test(type) || /[\r\n]/.test(evidence)) {
      throw new Error('evidence[' + index + '] requires single-line type and value');
    }
    return { type, value: evidence };
  });
}

function normalizeEntryResult(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('verifier must emit a JSON object');
  const status = String(raw.status ?? '').trim().toLowerCase();
  const result = status === 'pass'
    ? 'Pass'
    : status === 'fail'
      ? 'Fail'
      : status === 'skip' || status === 'pending'
        ? 'Pending'
        : null;
  if (!result) throw new Error('verifier status must be pass, fail, skip, or pending');
  const summary = String(raw.summary ?? '').trim();
  const evidence = normalizeEvidence(raw.evidence);
  if (result === 'Pass' && evidence.length === 0) {
    throw new Error('a passing verifier must emit concrete evidence');
  }
  return { result, summary, evidence };
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error: null, timedOut });
    });
  });
}

function parseVerifierStdout(stdout) {
  const lines = String(stdout).trim().split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('verifier emitted no JSON result');
  return JSON.parse(lines.at(-1));
}

async function executeNodeVerifier(verifier, context) {
  const entry = path.join(context.caseDir, verifier.entry);
  const started = Date.now();
  const processResult = await runProcess(process.execPath, [entry], {
    cwd: context.repoRoot,
    timeoutMs: context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: {
      ...process.env,
      NESSION_ACCEPTANCE_RUNTIME_FILE: context.runtimeFile,
      NESSION_ACCEPTANCE_CASE_DIR: context.caseDir,
      NESSION_ACCEPTANCE_TARGET_SHA: context.targetSha,
      NESSION_ACCEPTANCE_CONTRACT_SHA256: context.contractSha256,
      NESSION_ACCEPTANCE_CRITERION: context.criterion,
    },
  });

  if (processResult.timedOut) {
    return {
      type: verifier.type,
      entry: verifier.entry,
      result: 'Error',
      summary: 'verifier timed out',
      evidence: [],
      duration_ms: Date.now() - started,
      infrastructure_error: 'timeout',
    };
  }
  if (processResult.error) {
    return {
      type: verifier.type,
      entry: verifier.entry,
      result: 'Error',
      summary: String(processResult.error.message || processResult.error),
      evidence: [],
      duration_ms: Date.now() - started,
      infrastructure_error: 'spawn',
    };
  }

  try {
    const normalized = normalizeEntryResult(parseVerifierStdout(processResult.stdout));
    if (processResult.code !== 0 && normalized.result === 'Pass') {
      throw new Error('verifier exited non-zero while claiming pass');
    }
    return {
      type: verifier.type,
      entry: verifier.entry,
      ...normalized,
      duration_ms: Date.now() - started,
      exit_code: processResult.code,
      stderr: processResult.stderr.trim() || undefined,
    };
  } catch (error) {
    return {
      type: verifier.type,
      entry: verifier.entry,
      result: 'Error',
      summary: error instanceof Error ? error.message : String(error),
      evidence: [],
      duration_ms: Date.now() - started,
      exit_code: processResult.code,
      infrastructure_error: 'invalid-result',
      stderr: processResult.stderr.trim() || undefined,
    };
  }
}

async function executeBrowserVerifier(verifier, context) {
  const playwright = path.join(context.repoRoot, 'e2e', 'node_modules', '.bin', 'playwright');
  const config = path.join(context.repoRoot, 'e2e', 'runner', 'drivers', 'playwright.config.cjs');
  const entry = path.relative(
    path.join(context.repoRoot, 'e2e', 'acceptance', 'cases'),
    path.join(context.caseDir, verifier.entry),
  );
  const started = Date.now();
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-case-browser-'));
  const reportFile = path.join(reportDir, 'report.json');
  const proofFile = path.join(reportDir, 'proof.json');
  const assertionReporter = path.join(context.repoRoot, 'e2e', 'runner', 'drivers', 'assertion-reporter.cjs');
  const processResult = await runProcess(playwright, [
    'test', entry, '--config', config, '--reporter=json,' + assertionReporter,
  ], {
    cwd: path.join(context.repoRoot, 'e2e'),
    timeoutMs: context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: {
      ...process.env,
      NODE_PATH: path.join(context.repoRoot, 'e2e', 'node_modules'),
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
      NESSION_PLAYWRIGHT_PROOF_FILE: proofFile,
      NESSION_ACCEPTANCE_RUNTIME_FILE: context.runtimeFile,
      NESSION_ACCEPTANCE_BASE_URL: context.baseURL,
      NESSION_ACCEPTANCE_TARGET_SHA: context.targetSha,
      NESSION_ACCEPTANCE_CONTRACT_SHA256: context.contractSha256,
      NESSION_ACCEPTANCE_CRITERION: context.criterion,
    },
  });

  if (processResult.timedOut) {
    return {
      type: verifier.type,
      entry: verifier.entry,
      result: 'Error',
      summary: 'browser verifier timed out',
      evidence: [],
      duration_ms: Date.now() - started,
      infrastructure_error: 'timeout',
    };
  }
  if (processResult.error) {
    return {
      type: verifier.type,
      entry: verifier.entry,
      result: 'Error',
      summary: String(processResult.error.message || processResult.error),
      evidence: [],
      duration_ms: Date.now() - started,
      infrastructure_error: 'spawn',
    };
  }

  let report = null;
  let proof = null;
  try {
    if (fs.existsSync(reportFile)) report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    if (fs.existsSync(proofFile)) proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  } catch {
    // Missing/invalid reporter output is a hard Error rather than a false Pass.
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
  let verdict = classifyBrowserReport(report, processResult.code, proof);
  // #1482 SC-06/SC-08 must attach SHA-bound *measured* browser evidence.
  // Never mark these Cases Pass on assertion counts alone.
  if (verdict.result === 'Pass' && Number(context.issueNumber) === 1482 &&
      ['SC-06', 'SC-08'].includes(context.criterion)) {
    const measured = extractGeometryEvidence(report, processResult.stdout, context.targetSha);
    verdict = measured
      ? { ...verdict, evidence: [...verdict.evidence, measured] }
      : { ...verdict, result: 'Error',
          summary: 'Passing browser Case did not emit validated exact-SHA geometry evidence',
          evidence: [], infrastructure_error: 'missing-geometry-evidence' };
  }
  return {
    type: verifier.type,
    entry: verifier.entry,
    ...verdict,
    duration_ms: Date.now() - started,
    exit_code: processResult.code,
    stderr: processResult.stderr.trim() || undefined,
  };
}

export async function executeVerifier(verifier, context) {
  if (verifier.type === 'browser') return executeBrowserVerifier(verifier, context);
  if (verifier.type === 'protocol' || verifier.type === 'runtime') {
    return executeNodeVerifier(verifier, context);
  }
  throw new Error('unsupported verifier type: ' + verifier.type);
}
