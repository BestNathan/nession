import { readFileSync } from 'node:fs';
import path from 'node:path';

import { E2E_RUN_DIR } from '../runtime';

interface RuntimeControl {
  port: number;
  token: string;
}

/**
 * Restart the real Agent process through the e2e runtime control plane.
 *
 * An Agent restart is the one fault the browser cannot inject for itself: the
 * process that owns the stream epoch, the replay ring and the parser-applied
 * cursor has to die and come back while the tmux sessions survive it (#1926
 * SC-05). Playwright's global setup owns that process, workers are separate
 * processes, and the control plane is the file-mediated loopback surface
 * between them. It exists only for the duration of a provisioned e2e run.
 */
export async function restartAgent(): Promise<void> {
  const control = JSON.parse(
    readFileSync(path.join(E2E_RUN_DIR, 'runtime-control.json'), 'utf8'),
  ) as RuntimeControl;

  const response = await fetch(`http://127.0.0.1:${control.port}/restart-agent`, {
    method: 'POST',
    headers: { 'x-e2e-control': control.token },
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!response.ok || body.ok !== true) {
    throw new Error(
      `Agent restart failed: ${response.status} ${body.error ?? 'unknown error'}`,
    );
  }
}
