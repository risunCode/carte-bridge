// Portability tests: the core must run on a runtime that is not Node.
//
// These do not test Deno itself — they test the property that makes Deno (and
// any other Web-standard isolate) work: the core chain must not depend on Node
// globals. `process` is the one that would silently break it, because Deno has
// no `process.env`, and a top-level reference throws at import time.
//
// The check is done by deleting `process` from globalThis, importing the core
// fresh, and exercising a real request through it.

import test from 'node:test';
import assert from 'node:assert/strict';

test('the core imports and serves without a Node `process` global', async () => {
  const savedProcess = globalThis.process;

  // A child process would be cleaner, but deleting the global in-process is
  // enough: ESM caches per specifier, so a cache-busting query gives a fresh
  // module graph that evaluates while `process` is gone.
  const bust = `?deno-portability=${Date.now()}`;
  let handler;
  try {
    delete globalThis.process;
    assert.equal(globalThis.process, undefined, 'precondition: process is gone');

    const mod = await import(`../app/handler.js${bust}`);
    const coreMod = await import(`../app/core.js${bust}`);

    // No process -> empty environment -> defaults, and it must not throw.
    const config = coreMod.loadConfig();
    assert.equal(config.port, 8080);
    assert.equal(config.blockPrivate, true, 'the SSRF guard default must survive');

    handler = mod.createApp({ config });
  } finally {
    globalThis.process = savedProcess;
  }

  assert.equal(typeof handler, 'function');

  // A literal IP target, so the guard does not go to DNS. Using a hostname here
  // would make the test wait on a real resolution (and would fail outright
  // without network) — this test is about the absence of `process`, not about
  // DNS behaviour, which ssrf.test.js covers.
  const upstreamBody = JSON.stringify({ ok: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('203.0.113.9')) {
      return new Response(upstreamBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(url, init);
  };

  try {
    const response = await handler(
      new Request('http://bridge.test/r/https://203.0.113.9/data'),
      { clientIp: '203.0.113.5' },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), upstreamBody);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an entrypoint can inject its own environment object', async () => {
  // Deno passes Deno.env.toObject() this way; a runtime with no env at all
  // passes nothing and gets defaults. Both paths must work.
  const { createApp } = await import('../app/handler.js');

  const app = createApp({
    env: { BRIDGE_KEY: 'injected', BLOCK_PRIVATE: 'false', LOG_LEVEL: 'error' },
  });

  const denied = await app(new Request('http://bridge.test/r/https://example.test/'));
  assert.equal(denied.status, 401, 'the injected BRIDGE_KEY must be honoured');

  const allowed = await app(
    new Request('http://bridge.test/readyz', { headers: { authorization: 'Bearer injected' } }),
  );
  const body = await allowed.json();
  assert.equal(body.auth, 'required');
  assert.equal(body.ssrfGuard, 'disabled', 'the injected BLOCK_PRIVATE must be honoured');
});

test('the core chain imports nothing from node: except the optional DNS module', async () => {
  // This is the invariant that keeps the bridge deployable on Deno. If a future
  // change adds a top-level `node:` import to the core, this fails and says so.
  const { readFile } = await import('node:fs/promises');
  const coreFiles = [
    'core.js',
    'policy.js',
    'forward.js',
    'target.js',
    'stats.js',
    'status.js',
    'handler.js',
  ];
  const offenders = [];
  for (const file of coreFiles) {
    const source = await readFile(new URL(`../app/${file}`, import.meta.url), 'utf8');
    // Static imports only. A dynamic `await import('node:dns')` inside a
    // try/catch is fine — that is exactly how the DNS layer degrades.
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('import ') && trimmed.includes('node:')) {
        offenders.push(`${file}: ${trimmed}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `core files must not statically import node: modules:\n${offenders.join('\n')}`,
  );
});
