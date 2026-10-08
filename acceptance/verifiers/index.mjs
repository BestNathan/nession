import { spawn } from 'node:child_process';
import path from 'node:path';

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
  const config = path.join(context.repoRoot, 'acceptance', 'verifiers', 'playwright.config.ts');
  const entry = path.relative(
    path.join(context.repoRoot, 'acceptance', 'cases'),
    path.join(context.caseDir, verifier.entry),
  );
  const started = Date.now();
  const processResult = await runProcess(playwright, ['test', entry, '--config', config], {
    cwd: path.join(context.repoRoot, 'e2e'),
    timeoutMs: context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: {
      ...process.env,
      NODE_PATH: path.join(context.repoRoot, 'e2e', 'node_modules'),
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

  return {
    type: verifier.type,
    entry: verifier.entry,
    result: processResult.code === 0 ? 'Pass' : 'Fail',
    summary: processResult.code === 0
      ? 'Playwright verifier completed successfully'
      : 'Playwright verifier reported assertion failures',
    evidence: [{
      type: 'browser',
      value: 'Playwright case ' + verifier.entry + ' exit=' + processResult.code,
    }],
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
