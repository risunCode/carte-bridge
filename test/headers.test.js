// Header sanitization tests. The response-side rules here prevent the
// classic bridge hang: a forwarded content-length that no longer matches the
// (decompressed) body the client actually receives.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamHeaders, buildClientHeaders, __test } from '../app/forward.js';

const { expandConnectionTokens } = __test;

function inbound(pairs) {
  const h = new Headers();
  for (const [k, v] of pairs) h.append(k, v);
  return h;
}

const defaults = { host: 'api.example.com', clientIp: '203.0.113.9', stripAuthorization: false, proto: 'https' };

test('hop-by-hop headers are not forwarded', () => {
  const out = buildUpstreamHeaders(
    inbound([
      ['connection', 'keep-alive'],
      ['keep-alive', 'timeout=5'],
      ['te', 'trailers'],
      ['trailer', 'x-checksum'],
      ['transfer-encoding', 'chunked'],
      ['upgrade', 'h2c'],
      ['x-keep', 'yes'],
    ]),
    defaults,
  );
  for (const name of ['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    assert.equal(out.get(name), null, `${name} should be dropped`);
  }
  assert.equal(out.get('x-keep'), 'yes');
});

test('headers named by the Connection header are also dropped', () => {
  // RFC 7230 lets Connection name extra hop-by-hop headers. Ignoring that list
  // is how a private header gets smuggled to the next hop.
  const out = buildUpstreamHeaders(
    inbound([
      ['connection', 'x-internal-trace, close'],
      ['x-internal-trace', 'abc123'],
      ['x-keep', 'yes'],
    ]),
    defaults,
  );
  assert.equal(out.get('x-internal-trace'), null);
  assert.equal(out.get('x-keep'), 'yes');
});

test('client-supplied forwarding headers are replaced, not appended to', () => {
  const out = buildUpstreamHeaders(
    inbound([
      ['x-forwarded-for', '1.2.3.4, 5.6.7.8'],
      ['x-real-ip', '9.9.9.9'],
      ['forwarded', 'for=1.2.3.4'],
      ['cf-connecting-ip', '1.2.3.4'],
      ['true-client-ip', '1.2.3.4'],
    ]),
    defaults,
  );
  assert.equal(out.get('x-forwarded-for'), '203.0.113.9', 'must be the resolved peer, not the claim');
  assert.equal(out.get('x-real-ip'), '203.0.113.9');
  assert.equal(out.get('forwarded'), null);
  assert.equal(out.get('cf-connecting-ip'), null);
  assert.equal(out.get('true-client-ip'), null);
});

test('host is rewritten to the upstream host', () => {
  const out = buildUpstreamHeaders(inbound([['host', 'bridge.example.com']]), defaults);
  assert.equal(out.get('host'), 'api.example.com');
});

test('bridge-internal headers never reach upstream', () => {
  const out = buildUpstreamHeaders(
    inbound([
      ['x-bridge-key', 'secret'],
      ['x-bridge-peer', '127.0.0.1'],
      ['x-bridge-hop', '1'],
    ]),
    defaults,
  );
  assert.equal(out.get('x-bridge-key'), null);
  assert.equal(out.get('x-bridge-peer'), null);
  assert.equal(out.get('x-bridge-hop'), null);
});

test('authorization is stripped only when it was the bridge key', () => {
  const withStrip = buildUpstreamHeaders(
    inbound([['authorization', 'Bearer bridgekey']]),
    { ...defaults, stripAuthorization: true },
  );
  assert.equal(withStrip.get('authorization'), null);

  const withPass = buildUpstreamHeaders(
    inbound([['authorization', 'Bearer sk-upstream-key']]),
    { ...defaults, stripAuthorization: false },
  );
  assert.equal(withPass.get('authorization'), 'Bearer sk-upstream-key', 'upstream credential must survive');
});

test('via and x-forwarded-proto are set', () => {
  const out = buildUpstreamHeaders(inbound([]), defaults);
  assert.equal(out.get('x-forwarded-proto'), 'https');
  assert.equal(out.get('x-forwarded-host'), 'api.example.com');
  assert.match(out.get('via'), /carte-bridge/);
});

test('response content-length and content-encoding are dropped', () => {
  // This is the hang-preventer: fetch() decompresses the body, so the
  // upstream's content-length describes bytes the client will never see.
  const out = buildClientHeaders(
    inbound([
      ['content-length', '1234'],
      ['content-encoding', 'gzip'],
      ['transfer-encoding', 'chunked'],
      ['content-type', 'application/json'],
    ]),
    '',
  );
  assert.equal(out.get('content-length'), null);
  assert.equal(out.get('content-encoding'), null);
  assert.equal(out.get('transfer-encoding'), null);
  assert.equal(out.get('content-type'), 'application/json');
});

test('upstream location is dropped because we resolve redirects ourselves', () => {
  const out = buildClientHeaders(inbound([['location', 'http://169.254.169.254/']]), '');
  assert.equal(out.get('location'), null);
});

test('CORS headers appear only when configured', () => {
  assert.equal(buildClientHeaders(inbound([]), '').get('access-control-allow-origin'), null);
  assert.equal(buildClientHeaders(inbound([]), '*').get('access-control-allow-origin'), '*');
  const specific = buildClientHeaders(inbound([]), 'https://app.example.com');
  assert.equal(specific.get('access-control-allow-origin'), 'https://app.example.com');
  assert.equal(specific.get('vary'), 'Origin');
});

test('multiple set-cookie headers survive as separate values', () => {
  const h = inbound([]);
  h.append('set-cookie', 'a=1; Path=/');
  h.append('set-cookie', 'b=2; Path=/');
  const out = buildClientHeaders(h, '');
  assert.deepEqual(out.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
});

test('Connection token parsing tolerates whitespace and empties', () => {
  const h = inbound([['connection', ' keep-alive , x-a ,, x-b ']]);
  const tokens = expandConnectionTokens(h);
  assert.equal(tokens.has('keep-alive'), true);
  assert.equal(tokens.has('x-a'), true);
  assert.equal(tokens.has('x-b'), true);
  assert.equal(tokens.size, 3);
});
