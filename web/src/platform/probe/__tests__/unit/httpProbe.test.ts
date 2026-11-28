import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measureHttpProbe } from '../../httpProbe';

function response(init: { status: number; marker?: string | null; type?: ResponseType }): Response {
  const headers = new Headers();
  if (init.marker !== undefined && init.marker !== null) {
    headers.set('Nession-Probe', init.marker);
  }
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    type: init.type ?? 'cors',
    headers,
  } as unknown as Response;
}

describe('measureHttpProbe (#4618 SC-01)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends a credential-free, no-store, redirect-error GET and validates the marker', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 204, marker: 'v1' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await measureHttpProbe('http://192.168.1.5:8080/probe');
    expect(result.reachability).toBe('reachable');
    expect(typeof result.latencyMs).toBe('number');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://192.168.1.5:8080/probe');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a 204 without the exact marker (generic proxy/SPA false positive)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 204, marker: null })));
    const result = await measureHttpProbe('http://host/probe');
    expect(result.reachability).toBe('unreachable');
    expect(result.failureReason).toBe('invalid-response');
  });

  it('rejects a non-204 success even with a marker', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 200, marker: 'v1' })));
    const result = await measureHttpProbe('http://host/probe');
    expect(result.failureReason).toBe('invalid-response');
  });

  it('classifies an absent endpoint (404) as unsupported, not a dead network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 404 })));
    const result = await measureHttpProbe('http://host/probe');
    expect(result.failureReason).toBe('unsupported');
  });

  it('classifies a server error as http-error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 503 })));
    const result = await measureHttpProbe('http://host/probe');
    expect(result.failureReason).toBe('http-error');
  });

  it('never treats an opaque response as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 204, marker: 'v1', type: 'opaque' })));
    const result = await measureHttpProbe('http://host/probe');
    expect(result.reachability).toBe('unreachable');
    expect(result.failureReason).toBe('invalid-response');
  });

  it('reports a fetch TypeError as the bounded blocked-or-network ambiguity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const result = await measureHttpProbe('http://host/probe');
    expect(result.reachability).toBe('unreachable');
    expect(result.failureReason).toBe('blocked-or-network');
  });

  it('settles timeout at the deadline when the peer never answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const pending = measureHttpProbe('http://host/probe', { deadlineMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result.failureReason).toBe('timeout');
  });

  it('settles cancelled (not timeout) when the supersession signal aborts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const controller = new AbortController();
    const pending = measureHttpProbe('http://host/probe', { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.failureReason).toBe('cancelled');
  });

  it('refuses a non-HTTP scheme without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await measureHttpProbe('ws://host/ws');
    expect(result.failureReason).toBe('invalid-response');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
