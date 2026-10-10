'use strict';
// Default-deny in-memory collection of bounded operational facts.
// No URLs, addresses, session identities, process command lines, env, bodies,
// raw frames or terminal text are admitted to the persisted projection.
const assert = require('node:assert/strict');

const OPS = new Set(['server.auth', 'server.agent.list', 'agent.connect']);
const TYPES = new Set(['protocol', 'process', 'browser', 'terminal', 'artifact']);
function integer(value, label, upper = 1000000000000) {
  assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= upper,
    label + ' invalid or unbounded');
  return value;
}
function timestamp(clock) {
  const at = clock();
  assert.ok(typeof at === 'string' && Number.isFinite(Date.parse(at)),
    'invalid observation timestamp');
  return at;
}
function digest(value) {
  assert.match(value, /^[a-f0-9]{64}$/, 'immutable SHA-256 digest required');
  return value;
}
function optInCollector({ enabled = false, maximum = 24, clock = () => new Date().toISOString() } = {}) {
  assert.equal(typeof enabled, 'boolean');
  integer(maximum, 'maximum', 24);
  assert.ok(maximum >= 1, 'minimum bound required');
  const events = [];
  const add = (kind, project) => {
    assert.ok(TYPES.has(kind), 'unknown collector event');
    if (!enabled) return null; // no readings or private fields when disabled
    if (events.length >= maximum) throw new Error('observation budget exceeded');
    const payload = project(); // throws on invalid data; never stores raw input
    const result = Object.freeze({ at: timestamp(clock), kind, ...payload });
    events.push(result);
    return result;
  };
  return Object.freeze({
    protocol({ operation, success, elapsed_ms, request_bytes = 0, response_bytes = 0 }) {
      return add('protocol', () => {
        assert.ok(OPS.has(operation), 'unsupported protocol operation');
        assert.equal(typeof success, 'boolean');
        return { operation, success, elapsed_ms: integer(elapsed_ms, 'elapsed_ms', 300000),
          request_bytes: integer(request_bytes, 'request_bytes', 1048576),
          response_bytes: integer(response_bytes, 'response_bytes', 1048576) };
      });
    },
    process({ memory, cpu } = {}) {
      return add('process', () => {
        // This instrumented process is the CI Collector worker, not a customer process.
        const m = memory ?? globalThis.process.memoryUsage();
        const c = cpu ?? globalThis.process.cpuUsage();
        return { rss_bytes: integer(m.rss, 'rss'), heap_used_bytes: integer(m.heapUsed, 'heap'),
          user_cpu_us: integer(c.user, 'user_cpu'), system_cpu_us: integer(c.system, 'system_cpu') };
      });
    },
    browser({ mounted, marker_count, viewport = null }) {
      return add('browser', () => {
        assert.equal(typeof mounted, 'boolean');
        const view = viewport === null ? null : {
          baseY: integer(viewport.baseY, 'baseY', 1000000),
          viewportY: integer(viewport.viewportY, 'viewportY', 1000000) };
        return { mounted, marker_count: integer(marker_count, 'marker_count', 1000000), viewport: view };
      });
    },
    terminal({ marker_count, bytes, sha256 }) {
      return add('terminal', () => ({ marker_count: integer(marker_count, 'terminal markers', 1000000),
        bytes: integer(bytes, 'terminal bytes', 1048576), sha256: digest(sha256) }));
    },
    artifact({ artifact_id, sha256, retention_days }) {
      return add('artifact', () => {
        assert.match(artifact_id, /^[a-z0-9][a-z0-9_-]{0,71}$/, 'opaque artifact identifier required');
        const days = integer(retention_days, 'retention_days', 90);
        assert.ok(days > 0, 'finite artifact retention required');
        return { artifact_id, sha256: digest(sha256), retention_days: days,
          durability: 'external time-limited artifact; not an archived blob' };
      });
    },
    snapshot() { return { schema_version: 1, mode: 'observation', evaluation: null,
      enabled, maximum, events: events.map(item => ({ ...item })) }; },
  });
}
function selfTest() {
  const off = optInCollector();
  assert.equal(off.protocol({ operation: 'server.auth', success: true, elapsed_ms: 1 }), null);
  assert.equal(off.snapshot().events.length, 0);
  const c = optInCollector({ enabled: true, maximum: 5, clock: () => '2026-10-10T00:00:00Z' });
  c.protocol({ operation: 'server.auth', success: true, elapsed_ms: 1,
    authorization: 'DO_NOT_LEAK', body: 'DO_NOT_LEAK' });
  c.process({ memory: { rss: 8, heapUsed: 4, secret: 'DO_NOT_LEAK' },
    cpu: { user: 2, system: 1, argv: 'DO_NOT_LEAK' } });
  c.browser({ mounted: true, marker_count: 5, viewport: null, cookie: 'DO_NOT_LEAK' });
  c.terminal({ marker_count: 5, bytes: 10, sha256: 'a'.repeat(64), raw: 'DO_NOT_LEAK' });
  c.artifact({ artifact_id: 'run_123', sha256: 'b'.repeat(64), retention_days: 14,
    href: 'https://private.example', token: 'DO_NOT_LEAK' });
  const record = c.snapshot();
  assert.equal(record.events.length, 5);
  assert.equal(record.evaluation, null);
  assert.ok(!JSON.stringify(record).includes('DO_NOT_LEAK'));
  assert.ok(!JSON.stringify(record).includes('private.example'));
  assert.throws(() => c.process(), /observation budget exceeded/);
  for (const input of [
    { operation: 'server.auth', success: true, elapsed_ms: -1 },
    { operation: 'arbitrary.http.body', success: true, elapsed_ms: 1 },
    { operation: 'server.auth', success: true, elapsed_ms: 1, response_bytes: 1048577 },
  ]) assert.throws(() => optInCollector({ enabled: true }).protocol(input));
  assert.throws(() => optInCollector({ enabled: true }).artifact({
    artifact_id: 'https://internal.example', sha256: 'c'.repeat(64), retention_days: 14 }));
  assert.throws(() => optInCollector({ enabled: true }).artifact({
    artifact_id: 'sample', sha256: 'c'.repeat(64), retention_days: 999 }));
  assert.throws(() => optInCollector({ enabled: true }).terminal({
    marker_count: 1, bytes: 1, sha256: 'invalid' }));
  const live = optInCollector({ enabled: true, maximum: 1 });
  const sampled = live.process();
  assert.ok(sampled.rss_bytes > 0 && sampled.user_cpu_us >= 0);
  assert.equal(Object.hasOwn(sampled, 'pid'), false);
  console.log('opt-in observational Collector: enabled/disabled, real Process sample, bounds and redaction fixtures passed');
}
module.exports = { optInCollector };
if (require.main === module && process.argv[2] === 'self-test') selfTest();
