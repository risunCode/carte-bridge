// Statistics tests: the counters and formatters behind the status page.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStats,
  createEgressIp,
  countingStream,
  formatBytes,
  formatSpeed,
} from '../app/stats.js';

// A controllable clock, so window behaviour is tested rather than waited for.
function fakeClock(startMs = 1_700_000_000_000) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test('counts bytes and requests', () => {
  const clock = fakeClock();
  const stats = createStats({ now: clock.now });

  stats.recordRequest();
  stats.recordRequest();
  stats.recordBytes(1000);
  stats.recordBytes(500);

  const snap = stats.snapshot();
  assert.equal(snap.totalBytes, 1500);
  assert.equal(snap.totalRequests, 2);
});

test('speed divides by the window actually covered, not a fixed 60s', () => {
  // A bridge that started 2 seconds ago and moved 1 MiB in those 2 seconds is
  // doing 512 KiB/s. Dividing by a flat 60 would report ~17 KiB/s — a number
  // that is wrong in the direction that makes an operator think nothing works.
  const clock = fakeClock();
  const stats = createStats({ now: clock.now });

  stats.recordBytes(1048576);
  clock.advance(2000);

  const { bytesPerSecond } = stats.snapshot();
  assert.ok(
    Math.abs(bytesPerSecond - 524288) < 1000,
    `expected ~524288 B/s, got ${bytesPerSecond}`,
  );
});

test('speed uses the full window once the process is older than it', () => {
  const clock = fakeClock();
  const stats = createStats({ windowSeconds: 10, now: clock.now });

  // Age past the window first.
  clock.advance(60_000);
  stats.recordBytes(10_000);
  clock.advance(1000);

  const { bytesPerSecond } = stats.snapshot();
  // 10000 bytes over a 10s window.
  assert.ok(Math.abs(bytesPerSecond - 1000) < 50, `expected ~1000 B/s, got ${bytesPerSecond}`);
});

test('old buckets leave the window instead of lingering', () => {
  const clock = fakeClock();
  const stats = createStats({ windowSeconds: 5, now: clock.now });

  stats.recordBytes(5000);
  clock.advance(30_000); // well past the window

  const { bytesPerSecond } = stats.snapshot();
  assert.equal(bytesPerSecond, 0, 'traffic from 30s ago must not still count as current speed');
});

test('a burst decays as the window slides rather than dropping off a cliff', () => {
  const clock = fakeClock();
  const stats = createStats({ windowSeconds: 10, now: clock.now });

  stats.recordBytes(10_000);
  const atZero = stats.snapshot().bytesPerSecond;

  clock.advance(5000); // half the window has passed
  const atHalf = stats.snapshot().bytesPerSecond;

  assert.ok(atHalf > 0, 'the burst should still be partly visible');
  assert.ok(atHalf < atZero, 'but decayed');
});

test('totalBytes is cumulative and unaffected by the window', () => {
  const clock = fakeClock();
  const stats = createStats({ windowSeconds: 5, now: clock.now });

  stats.recordBytes(1000);
  clock.advance(60_000);
  stats.recordBytes(2000);

  const snap = stats.snapshot();
  assert.equal(snap.totalBytes, 3000, 'total is a lifetime-of-process figure');
  assert.equal(snap.bytesPerSecond, 2000 / 5, 'window only holds the recent traffic');
});

test('uptime tracks the clock', () => {
  const clock = fakeClock();
  const stats = createStats({ now: clock.now });
  clock.advance(90_000);
  assert.equal(stats.snapshot().uptimeSeconds, 90);
});

test('ignores zero and negative byte counts', () => {
  const stats = createStats();
  stats.recordBytes(0);
  stats.recordBytes(-5);
  stats.recordBytes(undefined);
  assert.equal(stats.snapshot().totalBytes, 0);
});

// --- formatters -------------------------------------------------------------

test('formatBytes uses binary units with sane precision', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(1048576), '1.00 MiB');
  assert.equal(formatBytes(1073741824), '1.00 GiB');
  assert.equal(formatBytes(1099511627776), '1.00 TiB');
  assert.equal(formatBytes(1536), '1.50 KiB');
});

test('formatBytes handles nonsense without printing NaN', () => {
  assert.equal(formatBytes(NaN), '0 B');
  assert.equal(formatBytes(-100), '0 B');
  assert.equal(formatBytes(Infinity), '0 B');
});

test('formatSpeed reports Mb/s, the unit an ISP quotes', () => {
  // 1 MiB/s = 1048576 bytes/s = 8.39 Mb/s (decimal bits, binary bytes)
  assert.match(formatSpeed(1048576), /^8\.39 Mb\/s$/);
  assert.match(formatSpeed(125000), /^1\.00 Mb\/s$/);
  assert.match(formatSpeed(1250), /^10\.0 kb\/s$/);
  // Low rates stay in bits, so the unit never silently switches meaning.
  assert.match(formatSpeed(10), /^80 b\/s$/);
  assert.match(formatSpeed(0), /^0 b\/s$/);
});

test('the status page speed line adapts its binary unit', async () => {
  const { renderStatus } = await import('../app/status.js');
  const { createStats } = await import('../app/stats.js');

  const clock = { now: () => 1_700_000_000_000 };
  const config = { blockPrivate: true, routes: {} };

  // A slow rate must not render as "0.00 MiB/s".
  const slow = createStats({ now: clock.now });
  slow.recordBytes(2744);
  const slowLine = renderStatus({
    config,
    stats: slow,
    clientIp: '127.0.0.1',
    egressIp: null,
    egressError: null,
  }).split('\n').find((l) => l.startsWith('CurrentSpeed:'));

  assert.match(slowLine, /kb\/s/, 'a slow rate should read in kb/s');
  assert.doesNotMatch(slowLine, /0\.00 MiB\/s/, 'must not collapse to a useless zero');
  assert.match(slowLine, /KiB\/s|MiB\/s/, 'and should show the binary rate too');
});

// --- counting stream --------------------------------------------------------

test('countingStream reports every chunk it passes through', async () => {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(100));
      controller.enqueue(new Uint8Array(250));
      controller.close();
    },
  });

  const seen = [];
  const counted = countingStream(source, (n) => seen.push(n));

  const reader = counted.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }

  assert.equal(total, 350, 'the body must pass through unmodified');
  assert.deepEqual(seen, [100, 250], 'each chunk is reported once');
});

test('countingStream propagates cancellation to the source', async () => {
  let cancelled = false;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10));
    },
    cancel() {
      cancelled = true;
    },
  });

  const counted = countingStream(source, () => {});
  const reader = counted.getReader();
  await reader.read();
  await reader.cancel();

  assert.equal(cancelled, true, 'cancelling downstream must cancel upstream');
});

// --- egress IP --------------------------------------------------------------

test('egress lookup is disabled when no URL is configured', async () => {
  const getIp = createEgressIp({ url: '' });
  assert.equal(await getIp(), null);
});

test('egress lookup caches and does not refetch within the TTL', async () => {
  let calls = 0;
  const getIp = createEgressIp({
    url: 'https://example.test/ip',
    fetchImpl: async () => {
      calls += 1;
      return new Response('203.0.113.9');
    },
  });

  assert.equal(await getIp(), '203.0.113.9');
  assert.equal(await getIp(), '203.0.113.9');
  assert.equal(calls, 1, 'the second call should be served from cache');
});

test('egress lookup returns the cached value when the service fails', async () => {
  let calls = 0;
  const getIp = createEgressIp({
    url: 'https://example.test/ip',
    ttlMs: 0, // force a refetch every time
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('203.0.113.9');
      throw new Error('network down');
    },
  });

  assert.equal(await getIp(), '203.0.113.9');
  assert.equal(await getIp(), '203.0.113.9', 'a failed refresh keeps the last known value');
});

test('egress lookup parses a JSON-wrapped address', async () => {
  const getIp = createEgressIp({
    url: 'https://example.test/ip',
    fetchImpl: async () => new Response(JSON.stringify({ ip: '198.51.100.4' })),
  });
  assert.equal(await getIp(), '198.51.100.4');
});

test('egress lookup collapses concurrent callers into one request', async () => {
  let calls = 0;
  const getIp = createEgressIp({
    url: 'https://example.test/ip',
    fetchImpl: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return new Response('203.0.113.9');
    },
  });

  const results = await Promise.all([getIp(), getIp(), getIp()]);
  assert.deepEqual(results, ['203.0.113.9', '203.0.113.9', '203.0.113.9']);
  assert.equal(calls, 1, 'three concurrent callers, one lookup');
});
