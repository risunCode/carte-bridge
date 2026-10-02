// Target resolution tests — the four accepted URL shapes and their edge cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createResolver } from '../app/target.js';

const resolver = createResolver({
  routes: { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com' },
});

const req = (path) => new URL(path, 'https://bridge.example.com');

test('absolute-form URL arrives from the adapter, not from request.url', () => {
  // The adapter extracts the raw request line and passes it in. Deriving this
  // from request.url would be wrong: on a Web Request that field is always
  // absolute, so every path request would look like absolute-form.
  const { url, matchedBy } = resolver(req('/'), { absoluteTarget: 'http://api.example.com/v1/foo?a=1' });
  assert.equal(url.toString(), 'http://api.example.com/v1/foo?a=1');
  assert.equal(matchedBy, 'absolute');
});

test('a plain path request is never mistaken for absolute-form', () => {
  const { matchedBy } = resolver(req('/r/https://api.example.com/v1/foo'), {});
  assert.equal(matchedBy, 'path');
});

test('path-prefix form', () => {
  const { url, matchedBy } = resolver(req('/r/https://api.example.com/v1/foo'), '/r/https://api.example.com/v1/foo');
  assert.equal(url.toString(), 'https://api.example.com/v1/foo');
  assert.equal(matchedBy, 'path');
});

test('path-prefix form keeps query string', () => {
  const path = '/r/https://api.example.com/v1/foo';
  const { url } = resolver(req(`${path}?model=x&stream=true`), `${path}?model=x&stream=true`);
  assert.equal(url.searchParams.get('model'), 'x');
  assert.equal(url.searchParams.get('stream'), 'true');
});

test('percent-encoded absolute URL in path', () => {
  const encoded = encodeURIComponent('https://api.example.com/v1/foo');
  const { url, matchedBy } = resolver(req(`/r/${encoded}`), `/r/${encoded}`);
  assert.equal(url.toString(), 'https://api.example.com/v1/foo');
  assert.equal(matchedBy, 'path-encoded');
});

test('named route expands to its configured origin', () => {
  const { url, matchedBy, route } = resolver(req('/r/anthropic/v1/messages'), '/r/anthropic/v1/messages');
  assert.equal(url.toString(), 'https://api.anthropic.com/v1/messages');
  assert.equal(matchedBy, 'route');
  assert.equal(route, 'anthropic');
});

test('named route with query and no path', () => {
  const { url } = resolver(req('/r/openai?x=1'), '/r/openai?x=1');
  assert.equal(url.origin, 'https://api.openai.com');
  assert.equal(url.searchParams.get('x'), '1');
});


test('bridge header form builds an origin-form target', () => {
  const { url, matchedBy } = resolver(req('/'), {
    bridgeTarget: 'https://api.example.com',
    bridgePath: '/v1/foo?stream=true',
  });
  assert.equal(url.toString(), 'https://api.example.com/v1/foo?stream=true');
  assert.equal(matchedBy, 'bridge');
});

test('bridge header form rejects non-origin paths', () => {
  assert.throws(
    () => resolver(req('/'), {
      bridgeTarget: 'https://api.example.com',
      bridgePath: 'https://evil.example/',
    }),
    /origin-form path/,
  );
});

test('a `key` query param is ordinary payload now that auth is gone', () => {
  // The bridge is open, so `key` is no longer its secret and must reach the
  // upstream like any other caller parameter.
  const path = '/r/https://api.example.com/v1/foo?key=secret&a=1';
  const { url } = resolver(req(path), path);
  assert.equal(url.searchParams.get('key'), 'secret');
  assert.equal(url.searchParams.get('a'), '1');
});

test('non-http schemes are rejected', () => {
  assert.throws(() => resolver(req('/'), { absoluteTarget: 'file:///etc/passwd' }), /http and https/);
  assert.throws(() => resolver(req('/'), { absoluteTarget: 'ftp://example.com/x' }), /http and https/);
  // The same applies to a scheme in the path form.
  assert.throws(() => resolver(req('/r/file:///etc/passwd'), {}), /http and https/);
});

test('unknown route name is a 404 that lists what is configured', () => {
  try {
    resolver(req('/r/nope/path'), '/r/nope/path');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 404);
    assert.match(err.message, /anthropic/);
  }
});

test('no target at all is a 400', () => {
  assert.throws(() => resolver(req('/'), '/'), (err) => err.status === 400);
  assert.throws(() => resolver(req('/r/'), '/r/'), (err) => err.status === 400);
});

test('a route name is not confused with a URL that merely looks similar', () => {
  // "anthropic" as a path segment is a route; a full URL is a URL.
  const { matchedBy } = resolver(req('/r/anthropic/x'), '/r/anthropic/x');
  assert.equal(matchedBy, 'route');
  const { matchedBy: asUrl } = resolver(req('/r/https://x.com/'), '/r/https://x.com/');
  assert.equal(asUrl, 'path');
});
