// End-to-end tests: a real upstream server, a real bridge server, real sockets.
//
// BLOCK_PRIVATE is off here because the upstream is on loopback. That is
// itself part of what is under test — the escape hatch has to work, or the
// guard would make the bridge impossible to run behind a private gateway.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createNodeHandler } from '../app/adapters.js';
import { loadConfig } from '../app/core.js';

const noop = () => {};

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function startBridge(env = {}) {
  const config = loadConfig(
    { BLOCK_PRIVATE: 'false', LOG_LEVEL: 'error', ...env },
    { onWarn: noop },
  );
  const handler = createNodeHandler({ config });
  return listen((req, res) => handler(req, res));
}

// --- upstream fixture -------------------------------------------------------

async function startUpstream() {
  return listen((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      return;
    }

    // Compressed response: exercises the content-length/content-encoding rule.
    if (url.pathname === '/gzip') {
      const payload = Buffer.from('x'.repeat(4096));
      const gz = zlib.gzipSync(payload);
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': gz.length });
      res.end(gz);
      return;
    }

    // Server-Sent Events: several chunks spread over time.
    if (url.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        res.write(`data: chunk-${n}\n\n`);
        if (n === 3) {
          clearInterval(timer);
          res.end('data: done\n\n');
        }
      }, 40);
      req.on('close', () => clearInterval(timer));
      return;
    }

    // Stalls forever after the headers: exercises the stream idle timeout.
    if (url.pathname === '/stall') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      // never ends
      req.on('close', () => {});
      return;
    }

    if (url.pathname === '/redirect-loop') {
      res.writeHead(302, { location: '/redirect-loop' });
      res.end();
      return;
    }

    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/echo?redirected=1' });
      res.end();
      return;
    }

    if (url.pathname === '/status') {
      const code = Number(url.searchParams.get('code') || 200);
      res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(`status ${code}`);
      return;
    }

    if (url.pathname === '/setcookie') {
      res.writeHead(200, { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
      res.end('ok');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('upstream 404');
  });
}

// --- tests ------------------------------------------------------------------

test('forwards a GET and returns the upstream body', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, '/echo');
    assert.equal(res.headers.get('x-bridge-match'), 'path');
    assert.ok(res.headers.get('x-bridge-id'));
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('forwards a POST body upstream unchanged', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const body = await res.json();
    assert.equal(body.method, 'POST');
    assert.equal(body.body, '{"hello":"world"}');
    assert.equal(body.headers['content-type'], 'application/json');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('query parameters reach upstream', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo?a=1&b=two`);
    const body = await res.json();
    assert.deepEqual(body.query, { a: '1', b: 'two' });
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('upstream Authorization survives when the bridge has no key of its own', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo`, {
      headers: { authorization: 'Bearer sk-upstream-credential' },
    });
    const body = await res.json();
    assert.equal(body.headers.authorization, 'Bearer sk-upstream-credential');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('the bridge key is consumed, not forwarded upstream', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge({ BRIDGE_KEY: 'bridgekey' });
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo`, {
      headers: { authorization: 'Bearer bridgekey' },
    });
    const body = await res.json();
    assert.equal(body.headers.authorization, undefined, 'bridge key must not leak upstream');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('a missing bridge key is rejected with 401 before any upstream call', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge({ BRIDGE_KEY: 'bridgekey' });
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'unauthorized');
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="carte-bridge"');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('client-supplied X-Forwarded-For does not survive', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo`, {
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
    });
    const body = await res.json();
    assert.notEqual(body.headers['x-forwarded-for'], '1.2.3.4');
    assert.notEqual(body.headers['x-real-ip'], '5.6.7.8');
    // TRUST_PROXY is off by default, so the socket address wins.
    assert.match(body.headers['x-forwarded-for'], /127\.0\.0\.1$/);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('X-Forwarded-For is honoured only when TRUST_PROXY is on', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge({ TRUST_PROXY: 'true' });
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    const body = await res.json();
    assert.equal(body.headers['x-forwarded-for'], '203.0.113.7');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('a gzip upstream response is delivered whole, not truncated', async () => {
  // Regression guard for the content-length trap: if the stale length were
  // forwarded, this read would hang instead of returning 4096 bytes.
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/gzip`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), null, 'stale length must be dropped');
    assert.equal(res.headers.get('content-encoding'), null);
    const text = await res.text();
    assert.equal(text.length, 4096);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('SSE streams arrive incrementally, not buffered to the end', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/sse`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const arrivals = [];
    const started = Date.now();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push({ at: Date.now() - started, text: decoder.decode(value) });
    }

    const text = arrivals.map((a) => a.text).join('');
    assert.match(text, /chunk-1/);
    assert.match(text, /chunk-3/);
    assert.match(text, /done/);

    // The upstream spaces chunks 40ms apart. If the bridge buffered, every
    // chunk would land at essentially the same instant.
    assert.ok(arrivals.length >= 3, `expected multiple reads, got ${arrivals.length}`);
    assert.ok(
      arrivals[arrivals.length - 1].at - arrivals[0].at >= 50,
      `expected chunks spread over time, span was ${arrivals[arrivals.length - 1].at - arrivals[0].at}ms`,
    );
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('a stalled stream is cut by the idle timeout', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge({ STREAM_IDLE_TIMEOUT_MS: '300' });
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/stall`);
    assert.equal(res.status, 200);
    const reader = res.body.getReader();

    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /first/);

    await assert.rejects(async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }, 'the stream should be errored, not closed cleanly');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('redirects are followed', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/redirect`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.query.redirected, '1');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('a redirect loop is bounded, not followed forever', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge({ MAX_REDIRECTS: '3' });
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/redirect-loop`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error.message, /redirects/);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('upstream status codes pass through unchanged', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    for (const code of [201, 400, 404, 418, 500]) {
      const res = await fetch(`${bridge.base}/r/${upstream.base}/status?code=${code}`);
      assert.equal(res.status, code, `expected ${code}`);
    }
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('multiple Set-Cookie headers survive the bridge', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/setcookie`);
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.ok(cookies.some((c) => c.startsWith('a=1')));
    assert.ok(cookies.some((c) => c.startsWith('b=2')));
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('an unreachable upstream is a 502, not a hang', async () => {
  const bridge = await startBridge();
  try {
    // Port 1 on loopback: nothing listens there.
    const res = await fetch(`${bridge.base}/r/http://127.0.0.1:1/`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'upstream_unreachable');
  } finally {
    await bridge.close();
  }
});

test('a slow upstream is cut by the request timeout', async () => {
  const slow = await listen((req, res) => {
    // Never respond at all.
    req.on('close', () => {});
  });
  const bridge = await startBridge({ REQUEST_TIMEOUT_MS: '250' });
  try {
    const res = await fetch(`${bridge.base}/r/${slow.base}/anything`);
    assert.equal(res.status, 504);
    const body = await res.json();
    assert.equal(body.error.code, 'upstream_timeout');
  } finally {
    await bridge.close();
    await slow.close();
  }
});

test('SSRF guard blocks loopback even when the bridge is otherwise open', async () => {
  const upstream = await startUpstream();
  // BLOCK_PRIVATE left at its default (true) for this one.
  const config = loadConfig({ LOG_LEVEL: 'error' }, { onWarn: noop });
  const handler = createNodeHandler({ config });
  const bridge = await listen((req, res) => handler(req, res));
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'blocked_host');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('host allowlist blocks an unlisted host', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge({ ALLOWED_HOSTS: 'api.example.com' });
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'host_not_allowed');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('named route maps a short path to the configured origin', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge({
    ROUTES: JSON.stringify({ local: upstream.base }),
  });
  try {
    const res = await fetch(`${bridge.base}/r/local/echo?via=route`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, '/echo');
    assert.equal(body.query.via, 'route');
    assert.equal(res.headers.get('x-bridge-match'), 'route');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('failover tries the next origin when the first is unreachable', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge({
    ROUTES: JSON.stringify({ svc: 'http://127.0.0.1:1' }),
    FALLBACKS: JSON.stringify({ svc: ['http://127.0.0.1:1', upstream.base] }),
  });
  try {
    const res = await fetch(`${bridge.base}/r/svc/echo`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, '/echo');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('a streaming body too large to buffer still forwards', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge({ MAX_BUFFER_BYTES: '64' });
  try {
    const payload = 'y'.repeat(5000);
    const res = await fetch(`${bridge.base}/r/${upstream.base}/echo`, {
      method: 'POST',
      body: payload,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.body.length, 5000);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('control endpoints answer without a target', async () => {
  const bridge = await startBridge({ ROUTES: JSON.stringify({ anthropic: 'https://api.anthropic.com' }) });
  try {
    const health = await fetch(`${bridge.base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const ready = await fetch(`${bridge.base}/readyz`);
    const readyBody = await ready.json();
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.auth, 'open');
    assert.equal(readyBody.ssrfGuard, 'disabled');
    assert.deepEqual(readyBody.routes, ['anthropic']);

    const docs = await fetch(`${bridge.base}/__bridge`);
    const docsBody = await docs.json();
    assert.ok(docsBody.usage.pathPrefix);
    assert.equal(docsBody.usage.namedRoute, 'GET /r/anthropic/v1/foo');
  } finally {
    await bridge.close();
  }
});

test('GET / serves a plain-text status page', async () => {
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();
    assert.match(text, /carte-bridge/);
    assert.match(text, /currentIP:/);
    assert.match(text, /CurrentSpeed:/);
    assert.match(text, /Bandwidth served:/);
    // It must not be HTML: that is the point of the page.
    assert.doesNotMatch(text, /<html|<div|<!doctype/i);
  } finally {
    await bridge.close();
  }
});

test('the status page shows the client IP and reports byte counters', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    // Bridge something so the counters move.
    const forwarded = await fetch(`${bridge.base}/r/${upstream.base}/echo`);
    assert.equal(forwarded.status, 200);
    await forwarded.text();

    const res = await fetch(`${bridge.base}/`);
    const text = await res.text();

    assert.match(text, /client\s+: 127\.0\.0\.1/);
    // 200 bytes have demonstrably passed, so the total must not read as zero.
    assert.doesNotMatch(text, /Bandwidth served: 0 B/);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('/stats returns machine-readable counters', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    await (await fetch(`${bridge.base}/r/${upstream.base}/echo`)).text();

    const res = await fetch(`${bridge.base}/stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bridge, 'carte-bridge');
    assert.ok(body.totalBytes > 0, 'bytes should have been counted');
    assert.ok(body.totalRequests >= 1);
    assert.ok(typeof body.speedHuman === 'string');
    assert.ok(typeof body.bytesPerSecond === 'number');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('byte counting works for a streamed response, not just a buffered one', async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${upstream.base}/sse`);
    const text = await res.text();
    assert.match(text, /done/);

    const stats = await (await fetch(`${bridge.base}/stats`)).json();
    assert.ok(stats.totalBytes > 0, 'streamed bytes must be counted too');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('a request with no resolvable target gets an explanatory 400', async () => {
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/some/other/path`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'missing_target');
    assert.match(body.error.message, /\/r\//);
  } finally {
    await bridge.close();
  }
});

test('the bridge refuses to forward to itself', async () => {
  // Regression guard: before this check, an ordinary path request was
  // classified as absolute-form and the bridge called its own URL, recursing
  // until it exhausted itself. The failure was a storm of 502s, not an error.
  const bridge = await startBridge();
  try {
    const res = await fetch(`${bridge.base}/r/${bridge.base}/healthz`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'self_reference');
  } finally {
    await bridge.close();
  }
});
