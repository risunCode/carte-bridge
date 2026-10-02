// Config parsing tests. The contract that matters: a malformed environment
// degrades to a working default instead of preventing boot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../app/core.js';
import { createAuth, ctEqual } from '../app/policy.js';

const noop = () => {};

test('empty environment yields working defaults', () => {
  const c = loadConfig({}, { onWarn: noop });
  assert.equal(c.port, 8080);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.bridgeKey, '');
  assert.equal(c.blockPrivate, true, 'SSRF guard is on by default');
  assert.equal(c.requestTimeoutMs, 30000);
  assert.equal(c.maxBufferBytes, 1048576);
  assert.deepEqual(c.routes, {});
});

test('booleans accept the usual spellings', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(loadConfig({ BLOCK_PRIVATE: v }, { onWarn: noop }).blockPrivate, true, v);
  }
  for (const v of ['0', 'false', 'no', 'off']) {
    assert.equal(loadConfig({ BLOCK_PRIVATE: v }, { onWarn: noop }).blockPrivate, false, v);
  }
});

test('an invalid integer falls back rather than producing NaN', () => {
  const c = loadConfig({ PORT: 'abc', REQUEST_TIMEOUT_MS: '-5' }, { onWarn: noop });
  assert.equal(c.port, 8080);
  assert.equal(c.requestTimeoutMs, 30000);
});

test('malformed ROUTES warns and disables routes instead of throwing', () => {
  const warnings = [];
  const c = loadConfig({ ROUTES: '{not json' }, { onWarn: (m) => warnings.push(m) });
  assert.deepEqual(c.routes, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ROUTES/);
});

test('route targets must be bare origins', () => {
  const warnings = [];
  const c = loadConfig(
    {
      ROUTES: JSON.stringify({
        good: 'https://api.example.com',
        withpath: 'https://api.example.com/v1', // would swallow the caller's path
        badscheme: 'ftp://api.example.com',
        noturl: 'example.com',
        trailing: 'https://api.example.com/',
      }),
    },
    { onWarn: (m) => warnings.push(m) },
  );
  assert.deepEqual(Object.keys(c.routes), ['good', 'trailing']);
  assert.equal(c.routes.good, 'https://api.example.com');
  assert.equal(c.routes.trailing, 'https://api.example.com');
  assert.equal(warnings.length, 3);
});

test('route names are lowercased so lookups are case-insensitive', () => {
  const c = loadConfig({ ROUTES: '{"Anthropic":"https://api.anthropic.com"}' }, { onWarn: noop });
  assert.ok(c.routes.anthropic);
});

test('FALLBACKS drops invalid entries and keeps the rest', () => {
  const warnings = [];
  const c = loadConfig(
    {
      FALLBACKS: JSON.stringify({ anthropic: ['https://api.anthropic.com', 'nonsense'] }),
    },
    { onWarn: (m) => warnings.push(m) },
  );
  assert.deepEqual(c.fallbacks.anthropic, ['https://api.anthropic.com']);
  assert.equal(warnings.length, 1);
});

test('ALLOWED_HOSTS splits, trims and lowercases', () => {
  const c = loadConfig({ ALLOWED_HOSTS: ' API.Example.com , *.foo.io ,' }, { onWarn: noop });
  assert.deepEqual(c.allowedHosts, ['api.example.com', '*.foo.io']);
});

test('log level and format are validated', () => {
  assert.equal(loadConfig({ LOG_LEVEL: 'DEBUG' }, { onWarn: noop }).logLevel, 'debug');
  assert.equal(loadConfig({ LOG_LEVEL: 'nonsense' }, { onWarn: noop }).logLevel, 'info');
  assert.equal(loadConfig({ LOG_FORMAT: 'json' }, { onWarn: noop }).logFormat, 'json');
  assert.equal(loadConfig({ LOG_FORMAT: 'nonsense' }, { onWarn: noop }).logFormat, 'text');
});

test('config is frozen', () => {
  const c = loadConfig({}, { onWarn: noop });
  assert.throws(() => {
    c.port = 1;
  }, TypeError);
});

// --- auth ------------------------------------------------------------------

test('auth is disabled when no key is configured', () => {
  const auth = createAuth(loadConfig({}, { onWarn: noop }));
  assert.equal(auth.enabled, false);
  assert.doesNotThrow(() => auth.assert(new Request('http://x/'), new URL('http://x/')));
});

test('auth accepts bearer, header and query forms', () => {
  const auth = createAuth(loadConfig({ BRIDGE_KEY: 'sekret' }, { onWarn: noop }));
  const url = new URL('http://bridge.example.com/r/https://api.example.com/');

  const cases = [
    new Request('http://bridge.example.com/', { headers: { authorization: 'Bearer sekret' } }),
    new Request('http://bridge.example.com/', { headers: { 'x-bridge-key': 'sekret' } }),
  ];
  for (const req of cases) assert.doesNotThrow(() => auth.assert(req, url));

  const qs = new URL('http://bridge.example.com/?key=sekret');
  assert.doesNotThrow(() => auth.assert(new Request(qs.toString()), qs));
});

test('auth rejects a wrong or missing key with 401', () => {
  const auth = createAuth(loadConfig({ BRIDGE_KEY: 'sekret' }, { onWarn: noop }));
  const url = new URL('http://bridge.example.com/');

  for (const req of [
    new Request('http://bridge.example.com/'),
    new Request('http://bridge.example.com/', { headers: { authorization: 'Bearer wrong' } }),
    new Request('http://bridge.example.com/', { headers: { authorization: 'sekret' } }), // no Bearer prefix
    new Request('http://bridge.example.com/', { headers: { 'x-bridge-key': 'sekret ' + 'x' } }),
  ]) {
    try {
      auth.assert(req, url);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 401);
      assert.equal(err.code, 'unauthorized');
    }
  }
});

test('constant-time comparison is correct at differing lengths', () => {
  assert.equal(ctEqual('abc', 'abc'), true);
  assert.equal(ctEqual('abc', 'abd'), false);
  assert.equal(ctEqual('abc', 'abcd'), false);
  assert.equal(ctEqual('', ''), true);
  assert.equal(ctEqual('', 'a'), false);
  assert.equal(ctEqual('a'.repeat(64), 'a'.repeat(64)), true);
});
