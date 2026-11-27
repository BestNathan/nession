// Browser HTTP reachability measurement (#4618).
//
// A credential-free GET against an owner-approved probe URL, timed with a
// monotonic clock until validated headers. The response must be the canonical
// `204` + `Nession-Probe: v1` marker — a generic proxy/SPA 204, a redirect, or
// an opaque response is never success. Repeated failure is reported as "no
// response in this observation" (`blocked-or-network`), not proof the network
// is physically down: a browser cannot distinguish CORS/TLS/mixed-content
// policy from a dead route.

import { PROBE_HTTP_DEADLINE_MS, type ProbeFailureReason } from './types';

export interface HttpProbeResult {
  reachability: 'reachable' | 'unreachable';
  latencyMs: number | null;
  failureReason?: ProbeFailureReason;
}

export interface HttpProbeOptions {
  deadlineMs?: number;
  /** Supersession signal from the scheduler; aborting it settles `cancelled`. */
  signal?: AbortSignal;
}

const MARKER_HEADER = 'Nession-Probe';
const MARKER_VALUE = 'v1';

/** Whether a URL is an HTTP(S) endpoint the browser may probe. The scheduler
 *  only passes advertised/configured candidates; this is a defensive guard so
 *  a non-HTTP scheme can never reach `fetch`. */
export function isHttpProbeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Derive the probe URL for a configured WebSocket ingress (the app's Server).
 *
 * Mirrors the Rust owner `nession_runtime::probe::default_probe_url`: map the
 * scheme (`ws`→`http`, `wss`→`https`), keep the authority verbatim, and use the
 * reserved root `/probe` path the listener serves. This is only for the
 * explicitly configured/trusted Server origin — never an arbitrary discovered
 * host. A reverse proxy that prefixes the WS path must forward `/probe` on the
 * same authority (documented ingress requirement). Returns null for a URL with
 * no recognised scheme/authority.
 */
export function deriveProbeUrl(wsUrl: string): string | null {
  const match = /^(ws|wss|http|https):\/\/([^/]+)/i.exec(wsUrl.trim());
  if (!match) {
    return null;
  }
  const scheme = match[1].toLowerCase();
  const httpScheme = scheme === 'ws' || scheme === 'http' ? 'http' : 'https';
  return `${httpScheme}://${match[2]}/probe`;
}

/**
 * Measure one HTTP probe. Never rejects — a failure is a settled observation
 * the caller publishes. The internal deadline and the external supersession
 * signal are distinguished so a cancelled flight is not reported as a timeout.
 */
export async function measureHttpProbe(
  probeUrl: string,
  options: HttpProbeOptions = {},
): Promise<HttpProbeResult> {
  const { deadlineMs = PROBE_HTTP_DEADLINE_MS, signal } = options;
  if (!isHttpProbeUrl(probeUrl)) {
    return { reachability: 'unreachable', latencyMs: null, failureReason: 'invalid-response' };
  }

  const start = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  let externallyCancelled = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);

  const onExternalAbort = () => {
    externallyCancelled = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) {
      externallyCancelled = true;
      controller.abort();
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const response = await fetch(probeUrl, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    const elapsed = Math.round(performance.now() - start);
    const marker = response.headers.get(MARKER_HEADER);
    // Opaque (no-cors) responses expose neither status nor headers and are
    // never success; the default cors mode already prevents them.
    if (response.type !== 'opaque' && response.status === 204 && marker === MARKER_VALUE) {
      return { reachability: 'reachable', latencyMs: elapsed };
    }
    if (response.status === 404) {
      // The endpoint is absent — an old peer without probe support. Advisory
      // unknown for route policy; the legacy WS path remains eligible.
      return { reachability: 'unreachable', latencyMs: null, failureReason: 'unsupported' };
    }
    if (!response.ok) {
      return { reachability: 'unreachable', latencyMs: null, failureReason: 'http-error' };
    }
    // A 2xx (including 204) without the exact marker is not a Nession probe.
    return { reachability: 'unreachable', latencyMs: null, failureReason: 'invalid-response' };
  } catch {
    if (externallyCancelled) {
      return { reachability: 'unreachable', latencyMs: null, failureReason: 'cancelled' };
    }
    if (timedOut) {
      return { reachability: 'unreachable', latencyMs: null, failureReason: 'timeout' };
    }
    // fetch TypeError: network failure, CORS refusal, or redirect:'error'.
    // Indistinguishable in the browser — report the bounded ambiguity.
    return { reachability: 'unreachable', latencyMs: null, failureReason: 'blocked-or-network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
