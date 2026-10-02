// Usage statistics for the status page.
//
// Three numbers, each with a different honesty problem:
//
//   Bandwidth served — a cumulative byte count. Cheap and exact, but it lives
//   in memory, so it resets when the process restarts. The page says "since
//   start" rather than implying a lifetime total.
//
//   CurrentSpeed — bytes per second over a sliding window. Bucketed per second
//   so one burst does not linger for the whole window, and divided by the
//   window actually covered rather than a fixed 60, so a bridge that started
//   three seconds ago does not report a sixtieth of its real rate.
//
//   currentIP — the address upstream sees. This is the only one that needs a
//   network call, so it is lazy (only fetched when someone opens the page),
//   cached, and failure-tolerant: if the lookup service is unreachable the page
//   shows "unavailable" instead of hanging.

const WINDOW_SECONDS = 60;
const EGRESS_TTL_MS = 300000;

export function createStats({ windowSeconds = WINDOW_SECONDS, now = Date.now } = {}) {
  const buckets = new Map();
  let totalBytes = 0;
  let totalRequests = 0;
  const startedAt = now();

  function prune(currentSecond) {
    const cutoff = currentSecond - windowSeconds;
    for (const key of buckets.keys()) {
      if (key <= cutoff) buckets.delete(key);
    }
  }

  return {
    recordRequest() {
      totalRequests += 1;
    },

    // Called as bytes leave the bridge, not when a transfer finishes: a stream
    // that runs for a minute would otherwise report zero until it ended.
    recordBytes(count) {
      if (!count || count < 0) return;
      totalBytes += count;
      const second = Math.floor(now() / 1000);
      buckets.set(second, (buckets.get(second) || 0) + count);
      prune(second);
    },

    snapshot() {
      const nowMs = now();
      const currentSecond = Math.floor(nowMs / 1000);
      prune(currentSecond);

      let windowed = 0;
      for (const value of buckets.values()) windowed += value;

      const ageSeconds = Math.max(1, (nowMs - startedAt) / 1000);
      const divisor = Math.min(windowSeconds, ageSeconds);

      return {
        bytesPerSecond: windowed / divisor,
        totalBytes,
        totalRequests,
        uptimeSeconds: Math.floor((nowMs - startedAt) / 1000),
      };
    },
  };
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole bytes read oddly with decimals ("512.00 B"), larger units do not.
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(2)} ${BYTE_UNITS[unit]}`;
}

// Bits per second throughout, decimal (1 Mb = 1e6 bits) — the unit an ISP
// quotes, which is what "Internet speed" normally means. Using bits at every
// scale matters: a fallback that printed bytes/s at low rates would make the
// same number read as eight times faster or slower depending on magnitude.
export function formatSpeed(bytesPerSecond) {
  const bits = bytesPerSecond * 8;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(2)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} kb/s`;
  return `${Math.round(bits)} b/s`;
}

// Wrap a stream so every chunk that reaches the client is counted. Placed
// between the upstream response and the platform writer, which is the only
// point where "served" is actually true.
export function countingStream(stream, onBytes) {
  const reader = stream.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      onBytes(value.byteLength);
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// Resolve the address upstream sees, with a cache and a concurrent-call guard.
// Returns null rather than throwing: a status page must still render when the
// lookup fails, which is exactly when an operator is most likely to be looking
// at it.
export function createEgressIp({ url, ttlMs = EGRESS_TTL_MS, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  return async function getEgressIp() {
    if (!url) return null;
    if (cached && Date.now() - cachedAt < ttlMs) return cached;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return cached;
        const body = (await res.text()).trim();
        // ipify answers with a bare address; other services wrap it in JSON.
        const ip = body.startsWith('{') ? JSON.parse(body).ip : body;
        if (ip) {
          cached = String(ip);
          cachedAt = Date.now();
        }
        return cached;
      } catch {
        return cached;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  };
}

export const __test = { WINDOW_SECONDS, EGRESS_TTL_MS };
