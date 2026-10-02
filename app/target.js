// Target resolution: turn an inbound bridge request into an absolute upstream URL.
//
// Four accepted shapes, checked in this order:
//
//   1. bridge headers   x-bridge-target + x-bridge-path
//   2. absolute-form   GET http://api.example.com/v1/foo HTTP/1.1
//                      (classic proxy form; Node's http server surfaces it
//                       verbatim as req.url)
//   3. path prefix     /r/https://api.example.com/v1/foo
//   4. named route     /r/anthropic/v1/messages     (via ROUTES env)
//
// Bridge headers are deliberately separate from the public URL forms. They
// keep the target out of query strings and access-log URLs used by pool relays.

import { badRequest, notFound } from './core.js';

// Any scheme-shaped prefix. Used only to decide "the caller meant this as an
// absolute URL", so that a non-http scheme reaches buildUrl and gets a clear
// "scheme not supported" error instead of falling through to a confusing
// "no target given".
const SCHEME_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;

function buildUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('invalid_target', `Target is not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('invalid_scheme', `Only http and https targets are supported, got ${url.protocol}`);
  }
  if (!url.hostname) {
    throw badRequest('invalid_target', 'Target URL has no hostname');
  }
  return url;
}

function buildBridgeUrl(rawTarget, rawPath) {
  const origin = buildUrl(rawTarget);
  if (
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw badRequest('invalid_bridge_target', 'x-bridge-target must be a bare http(s) origin');
  }

  const path = rawPath || '/';
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw badRequest('invalid_bridge_path', 'x-bridge-path must be an origin-form path');
  }
  return new URL(path, origin.origin);
}

export function createResolver(config) {
  const { routes } = config;
  const routeNames = Object.keys(routes).sort((a, b) => b.length - a.length);

  return function resolveTarget(
    requestUrl,
    { absoluteTarget = null, bridgeTarget = null, bridgePath = null } = {},
  ) {
    if (bridgeTarget !== null) {
      return {
        url: buildBridgeUrl(bridgeTarget, bridgePath),
        matchedBy: 'bridge',
      };
    }

    // --- 1. absolute-form ---------------------------------------------------
    // The target comes from the raw request line, passed in by the adapter.
    // It is NOT derived from request.url: on a Web Request that field is always
    // an absolute URL, so testing it would classify every ordinary path request
    // as absolute-form and point the bridge at itself.
    if (absoluteTarget) {
      const url = buildUrl(absoluteTarget);
      return { url, matchedBy: 'absolute' };
    }

    const { pathname, searchParams } = requestUrl;

    // --- 2 & 3. /r/ prefix --------------------------------------------------
    if (pathname === '/r' || pathname.startsWith('/r/')) {
      const remainder = pathname.slice(3); // after "/r/"

      if (!remainder) {
        throw badRequest('missing_target', 'No target after /r/ — use /r/https://host/path or /r/<route>/path');
      }

      // Absolute URL in the path. Try the raw remainder first; clients that
      // percent-encode the whole URL (some do, to keep proxies from rewriting
      // it) get a second attempt on the decoded form.
      if (SCHEME_FORM.test(remainder)) {
        const url = buildUrl(remainder);
        if (searchParams.toString()) {
          for (const [k, v] of searchParams) url.searchParams.append(k, v);
        }
        return { url, matchedBy: 'path' };
      }

      if (remainder.includes('%3A%2F%2F') || remainder.includes('%3a%2f%2f')) {
        let decoded;
        try {
          decoded = decodeURIComponent(remainder);
        } catch {
          throw badRequest('invalid_target', 'Target in path is not valid percent-encoding');
        }
        if (SCHEME_FORM.test(decoded)) {
          const url = buildUrl(decoded);
          if (searchParams.toString()) {
            for (const [k, v] of searchParams) url.searchParams.append(k, v);
          }
          return { url, matchedBy: 'path-encoded' };
        }
      }

      // Named route: first path segment must match a configured prefix.
      const slash = remainder.indexOf('/');
      const name = (slash === -1 ? remainder : remainder.slice(0, slash)).toLowerCase();
      const rest = slash === -1 ? '' : remainder.slice(slash);

      if (routeNames.includes(name)) {
        const base = new URL(routes[name]);
        const url = new URL(rest || '/', base);
        // A route target is an origin, so anything after it is caller-chosen
        // path — carry it over verbatim along with the query.
        for (const [k, v] of searchParams) url.searchParams.append(k, v);
        return { url, matchedBy: 'route', route: name };
      }

      if (routeNames.length) {
        throw notFound('unknown_route', `Unknown route "${name}". Configured: ${routeNames.join(', ')}`);
      }
      throw badRequest(
        'invalid_target',
        'Target after /r/ is neither an absolute URL nor a configured route',
      );
    }


    throw badRequest(
      'missing_target',
      'No target. Use x-bridge-target/x-bridge-path, /r/https://host/path, /r/<route>/path, or absolute-form request.',
    );
  };
}
