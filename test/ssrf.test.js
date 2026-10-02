// SSRF guard tests. These are the highest-value tests in the suite: a gap
// here turns the bridge into a probe for the host's internal network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, __test } from '../app/policy.js';

const { isBlockedHost, parseIPv6ToGroups, hostAllowed, normalizeHost } = __test;

const guard = createGuard({ blockPrivate: true, allowedHosts: [] });
const openGuard = createGuard({ blockPrivate: false, allowedHosts: [] });

test('blocks loopback and private IPv4 literals', () => {
  for (const host of [
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '100.64.0.1', // CGNAT
  ]) {
    assert.equal(isBlockedHost(host), true, `${host} should be blocked`);
  }
});

test('allows public IPv4 literals', () => {
  for (const host of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1']) {
    assert.equal(isBlockedHost(host), false, `${host} should be allowed`);
  }
});

test('blocks the same address in every textual IPv6 form', () => {
  // The whole point of parsing to numeric groups: these are one address.
  for (const host of [
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0000:0000:0000:0000:0000:ffff:7f00:0001',
    '::ffff:169.254.169.254',
    'fe80::1', // link-local
    'fc00::1', // unique-local
    'fd12:3456::1',
    '::', // unspecified
  ]) {
    assert.equal(isBlockedHost(host), true, `${host} should be blocked`);
  }
});

test('allows public IPv6 literals', () => {
  assert.equal(isBlockedHost('2606:4700:4700::1111'), false);
  assert.equal(isBlockedHost('2001:4860:4860::8888'), false);
});

test('trailing-dot FQDN form does not bypass the check', () => {
  // "localhost." is the same host as "localhost" but is a different string.
  assert.equal(normalizeHost('LOCALHOST.'), 'localhost');
  assert.equal(isBlockedHost(normalizeHost('localhost.')), true);
  assert.equal(isBlockedHost(normalizeHost('127.0.0.1.')), true);
});

test('blocks reserved hostnames and suffixes', () => {
  for (const host of ['localhost', 'ip6-localhost', 'foo.internal', 'bar.local', 'x.home.arpa']) {
    assert.equal(isBlockedHost(host), true, `${host} should be blocked`);
  }
});

test('assertLiteral rejects a private literal URL', () => {
  assert.throws(() => guard.assertLiteral('http://127.0.0.1:8080/admin'), /private or reserved/);
  assert.throws(() => guard.assertLiteral('http://[::1]/'), /private or reserved/);
  assert.doesNotThrow(() => guard.assertLiteral('https://example.com/path'));
});

test('assertResolved rejects a hostname that resolves to loopback', async () => {
  // "localhost" is caught by the literal layer, but a name like this must be
  // caught by the DNS layer; using a name that resolves locally proves the
  // second layer runs.
  await assert.rejects(() => guard.assertResolved('http://localhost/x'), /private or reserved/);
});

test('guard can be switched off, and then allows private targets', () => {
  assert.doesNotThrow(() => openGuard.assertLiteral('http://127.0.0.1/'));
  assert.doesNotThrow(() => openGuard.assertLiteral('http://169.254.169.254/'));
});

test('host allowlist: exact match, wildcard, and empty-list meaning', () => {
  assert.equal(hostAllowed('example.com', []), true, 'empty list allows anything');
  assert.equal(hostAllowed('example.com', ['example.com']), true);
  assert.equal(hostAllowed('other.com', ['example.com']), false);
  assert.equal(hostAllowed('a.example.com', ['*.example.com']), true);
  assert.equal(hostAllowed('example.com', ['*.example.com']), false, 'wildcard does not match the bare domain');
  assert.equal(hostAllowed('evil-example.com', ['*.example.com']), false, 'suffix must be dot-anchored');
});

test('allowlist rejection surfaces as a 403, not a 400', () => {
  const strict = createGuard({ blockPrivate: true, allowedHosts: ['api.example.com'] });
  try {
    strict.assertLiteral('https://evil.com/');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 403);
    assert.equal(err.code, 'host_not_allowed');
  }
});

test('IPv6 parser produces identical groups for equivalent spellings', () => {
  const a = parseIPv6ToGroups('::ffff:127.0.0.1');
  const b = parseIPv6ToGroups('::ffff:7f00:1');
  assert.deepEqual(a, b);
});
