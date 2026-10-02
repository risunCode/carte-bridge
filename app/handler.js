// Core application handler.
//
// Platform-agnostic: takes a standard Web `Request`, returns a standard Web
// `Response`. Every runtime we target (Node 18+, Vercel, Netlify) provides
// both natively, so this file has no imports from any platform SDK and needs
// no adapter to reason about.

import { loadConfig, createLogger, BridgeError, environment } from './core.js';
import { createAuth, createGuard } from './policy.js';
import { createResolver } from './target.js';
import { createForwarder } from './forward.js';
import { createStats, createEgressIp, countingStream, formatBytes, formatSpeed } from './stats.js';
import { renderStatus } from './status.js';

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  504: 'Gateway Timeout',
};

function errorResponse(err, { corsOrigin, requestId }) {
  const status = err instanceof BridgeError ? err.status : 500;
  const code = err instanceof BridgeError ? err.code : 'internal_error';
  const message =
    err instanceof BridgeError && err.expose ? err.message : 'Internal bridge error';

  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (err instanceof BridgeError && err.headers) {
    for (const [k, v] of Object.entries(err.headers)) headers.set(k, v);
  }
  if (status === 401) {
    headers.set('www-authenticate', 'Bearer realm="carte-bridge"');
  }
  if (corsOrigin) headers.set('access-control-allow-origin', corsOrigin);
  if (requestId) headers.set('x-bridge-id', requestId);

  return new Response(
    JSON.stringify({
      error: { code, message, status, text: STATUS_TEXT[status] || 'Error' },
      bridge: 'carte-bridge',
      ...(requestId ? { requestId } : {}),
    }),
    { status, headers },
  );
}

function isControlRequest(url) {
  return (
    url.pathname === '/healthz' ||
    url.pathname === '/readyz' ||
    url.pathname === '/__bridge' ||
    url.pathname === '/stats' ||
    url.pathname === '/'
  );
}

// Every response carries the request id, control responses included, so a log
// line can always be tied back to the response an operator is looking at.
function withRequestId(response, requestId) {
  if (!requestId) return response;
  response.headers.set('x-bridge-id', requestId);
  return response;
}

const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };

async function handleControl(url, config, requestId, context) {
  if (url.pathname === '/healthz') {
    return withRequestId(new Response('ok', { status: 200, headers: TEXT_HEADERS }), requestId);
  }

  // The status page. Plain text by choice: a bridge host is probed constantly,
  // and a text page is honest about what this is, renders in curl and a
  // browser alike, and carries no markup to sanitize.
  if (url.pathname === '/') {
    const { stats, getEgressIp, clientIp } = context;

    let egressIp = null;
    let egressError = null;
    try {
      egressIp = await getEgressIp();
    } catch (err) {
      egressError = err?.message || 'lookup failed';
    }

    const body = renderStatus({ config, stats, clientIp, egressIp, egressError });
    return withRequestId(new Response(body, { status: 200, headers: TEXT_HEADERS }), requestId);
  }

  // Machine-readable counters, for a dashboard or a health poller that wants
  // the numbers without parsing the text page.
  if (url.pathname === '/stats') {
    const snap = context.stats.snapshot();
    return withRequestId(
      Response.json(
        {
          bridge: 'carte-bridge',
          bytesPerSecond: Math.round(snap.bytesPerSecond),
          totalBytes: snap.totalBytes,
          totalBytesHuman: formatBytes(snap.totalBytes),
          speedHuman: formatSpeed(snap.bytesPerSecond),
          totalRequests: snap.totalRequests,
          uptimeSeconds: snap.uptimeSeconds,
        },
        { headers: { 'cache-control': 'no-store' } },
      ),
      requestId,
    );
  }

  // /readyz reports what the bridge will actually do, which is the thing an
  // operator needs to confirm after a deploy. It deliberately does not leak
  // the bridge key or the full route table's credentials — routes are origins
  // only, so they are safe to list.
  if (url.pathname === '/readyz') {
    return withRequestId(Response.json({
      status: 'ready',
      bridge: 'carte-bridge',
      auth: config.bridgeKey ? 'required' : 'open',
      ssrfGuard: config.blockPrivate ? 'enabled' : 'disabled',
      allowedHosts: config.allowedHosts.length ? config.allowedHosts : 'any-public-host',
      routes: Object.keys(config.routes),
      timeouts: {
        requestMs: config.requestTimeoutMs,
        streamIdleMs: config.streamIdleTimeoutMs,
      },
    }, { headers: { 'cache-control': 'no-store' } }), requestId);
  }

  // /__bridge describes the accepted URL shapes — a self-documenting endpoint
  // so a client author does not have to read this file.
  return withRequestId(Response.json(
    {
      bridge: 'carte-bridge',
      usage: {
        pathPrefix: 'GET /r/https://api.example.com/v1/foo',
        namedRoute: Object.keys(config.routes).length
          ? `GET /r/${Object.keys(config.routes)[0]}/v1/foo`
          : null,
        query: 'GET /?url=https%3A%2F%2Fapi.example.com%2Fv1%2Ffoo',
        absoluteForm: 'GET http://api.example.com/v1/foo (proxy-style clients)',
      },
      auth: config.bridgeKey
        ? {
            required: true,
            methods: ['Authorization: Bearer <key>', 'X-Bridge-Key: <key>', '?key=<key>'],
          }
        : { required: false },
      routes: config.routes,
    },
    { headers: { 'cache-control': 'no-store' } },
  ), requestId);
}

/**
 * Build the bridge handler.
 *
 * @param {object} [options]
 * @param {object} [options.config]  pre-built config (tests); otherwise env is read
 * @param {Function} [options.getClientIp]  async (request) => string, for
 *        platforms that resolve the peer address outside the request — Netlify
 *        passes it on the function context instead.
 */
export function createApp(options = {}) {
  const onWarn = (msg) => console.warn(`[bridge] warn  ${msg}`);
  const config = options.config ?? loadConfig(options.env ?? environment, { onWarn });
  const log = createLogger(config);

  const auth = createAuth(config);
  const guard = createGuard(config);
  const resolveTarget = createResolver(config);
  const forward = createForwarder(config, { guard, log });

  // Process-wide counters. In-memory by design: a bridge is stateless, and the
  // status page says "since start" rather than implying a lifetime total.
  const stats = options.stats ?? createStats();
  const getEgressIp = createEgressIp({ url: config.egressIpUrl });

  if (!auth.enabled) {
    log.warn('running in OPEN mode — anyone with the URL can forward through this instance');
  }

  return async function handle(request, context = {}) {
    const requestId = context.requestId || crypto.randomUUID().slice(0, 12);
    const started = Date.now();

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(new BridgeError(400, 'bad_request', 'Malformed request URL'), {
        corsOrigin: config.corsOrigin,
        requestId,
      });
    }

    const cors = config.corsOrigin;

    // CORS preflight. Answered before auth so a browser can complete the
    // preflight for a cross-origin call; the actual request is still gated.
    if (request.method === 'OPTIONS' && cors) {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': cors,
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
          'access-control-allow-headers': request.headers.get('access-control-request-headers') || '*',
          'access-control-max-age': '86400',
          ...(cors !== '*' ? { vary: 'Origin' } : {}),
        },
      });
    }

    try {
      // The status page is GET-only; a stray POST to / should not look like a
      // successful page fetch, and every other control path is JSON.
      if (isControlRequest(url) && (url.pathname !== '/' || request.method === 'GET')) {
        return handleControl(url, config, requestId, {
          stats,
          getEgressIp,
          clientIp: context.clientIp || '',
        });
      }

      auth.assert(request, url);

      const { url: target, matchedBy, route } = resolveTarget(url, {
        absoluteTarget: context.absoluteTarget ?? null,
      });

      // A bridge that forwards to itself recurses until something gives out.
      // This is a cheap, absolute guard against that whole class of mistake —
      // including a client that deliberately points the bridge at its own URL.
      if (target.host === url.host) {
        throw new BridgeError(400, 'self_reference', 'Refusing to forward a request back to this bridge');
      }

      // Literal checks run synchronously so an obviously-bad target is rejected
      // before we touch the network; the resolved check then catches a public
      // hostname that points at a private address.
      guard.assertLiteral(target.toString());
      await guard.assertResolved(target.toString());

      // The caller's Authorization header is the bridge key when auth is on;
      // when auth is off it is the caller's own upstream credential and must
      // be passed through untouched.
      const stripAuthorization = auth.enabled && Boolean(request.headers.get('authorization'));

      const clientIp =
        context.clientIp ||
        (options.getClientIp ? await options.getClientIp(request) : '') ||
        request.headers.get('x-bridge-peer') ||
        '';

      const result = await forward({
        request,
        url: target,
        route,
        clientIp,
        proto: url.protocol.replace(':', ''),
        stripAuthorization,
      });

      stats.recordRequest();

      const headers = new Headers(result.headers);
      headers.set('x-bridge-id', requestId);
      if (matchedBy) headers.set('x-bridge-match', matchedBy);

      log.info('forwarded', {
        method: request.method,
        target: result.upstreamUrl,
        status: result.status,
        matchedBy,
        ms: Date.now() - started,
        requestId,
      });

      // Counted as bytes leave, not when a transfer ends: a stream that runs
      // for a minute would otherwise report nothing until it finished.
      const body = result.body ? countingStream(result.body, (n) => stats.recordBytes(n)) : null;

      return new Response(body, { status: result.status, headers });
    } catch (err) {
      if (err instanceof BridgeError) {
        log.warn('rejected', {
          code: err.code,
          status: err.status,
          message: err.message,
          ms: Date.now() - started,
          requestId,
        });
      } else {
        log.error('unhandled error', {
          message: err?.message,
          stack: err?.stack,
          requestId,
        });
      }
      return errorResponse(err, { corsOrigin: cors, requestId });
    }
  };
}
