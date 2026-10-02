// Core application handler.
//
// Platform-agnostic: takes a standard Web `Request`, returns a standard Web
// `Response`. Every runtime we target (Node 18+, Vercel, Netlify) provides
// both natively, so this file has no imports from any platform SDK and needs
// no adapter to reason about.

import { loadConfig, createLogger, BridgeError, environment } from './core.js';
import { createGuard } from './policy.js';
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

function errorResponse(err, { corsOrigin }) {
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
  if (corsOrigin) headers.set('access-control-allow-origin', corsOrigin);

  return new Response(
    JSON.stringify({
      error: { code, message, status, text: STATUS_TEXT[status] || 'Error' },
    }),
    { status, headers },
  );
}

function isControlRequest(url, hasBridgeTarget) {
  // The bare root is the status page. A bridge relay request is identified by
  // its internal target header, while the retired query form must be rejected
  // instead of silently returning the status page.
  if (url.pathname === '/') return !hasBridgeTarget && !url.searchParams.has('url');
  return (
    url.pathname === '/healthz' ||
    url.pathname === '/readyz' ||
    url.pathname === '/__bridge' ||
    url.pathname === '/stats'
  );
}

const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
function bridgeAuthFailure() {
  const err = new BridgeError(401, 'bridge_auth_required', 'Bridge credentials are required');
  err.headers = { 'www-authenticate': 'Basic realm="carte-bridge"' };
  return err;
}

function assertBridgeAuth(request, config) {
  if (config.bridgeAuthMode !== 'basic') return;

  const value = request.headers.get('x-bridge-auth') || '';
  const match = /^Basic\s+(.+)$/i.exec(value);
  if (!match) throw bridgeAuthFailure();

  let decoded;
  try {
    decoded = atob(match[1]);
  } catch {
    throw bridgeAuthFailure();
  }

  if (decoded !== `${config.bridgeUsername}:${config.bridgePassword}`) {
    throw bridgeAuthFailure();
  }
}


async function handleControl(url, config, context) {
  if (url.pathname === '/healthz') {
    return new Response('ok', { status: 200, headers: TEXT_HEADERS });
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
    return new Response(body, { status: 200, headers: TEXT_HEADERS });
  }

  // Machine-readable counters, for a dashboard or a health poller that wants
  // the numbers without parsing the text page.
  if (url.pathname === '/stats') {
    const snap = context.stats.snapshot();
    return Response.json(
      {
        bytesPerSecond: Math.round(snap.bytesPerSecond),
        totalBytes: snap.totalBytes,
        totalBytesHuman: formatBytes(snap.totalBytes),
        speedHuman: formatSpeed(snap.bytesPerSecond),
        totalRequests: snap.totalRequests,
        uptimeSeconds: snap.uptimeSeconds,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  // /readyz reports what the bridge will actually do, which is the thing an
  // operator needs to confirm after a deploy. Routes are origins only, so
  // they are safe to list.
  if (url.pathname === '/readyz') {
    return Response.json({
      status: 'ready',
      ssrfGuard: config.blockPrivate ? 'enabled' : 'disabled',
      allowedHosts: config.allowedHosts.length ? config.allowedHosts : 'any-public-host',
      routes: Object.keys(config.routes),
      timeouts: {
        requestMs: config.requestTimeoutMs,
        streamIdleMs: config.streamIdleTimeoutMs,
        streamHeartbeatMs: config.streamHeartbeatMs,
      },
    }, { headers: { 'cache-control': 'no-store' } });
  }

  // /__bridge describes the accepted URL shapes — a self-documenting endpoint
  // so a client author does not have to read this file.
  return Response.json(
    {
      usage: {
        bridgeTarget: 'x-bridge-target: https://api.example.com',
        bridgePath: 'x-bridge-path: /v1/foo',
        pathPrefix: 'GET /r/https://api.example.com/v1/foo',
        namedRoute: Object.keys(config.routes).length
          ? `GET /r/${Object.keys(config.routes)[0]}/v1/foo`
          : null,
        absoluteForm: 'GET http://api.example.com/v1/foo (proxy-style clients)',
      },
      routes: config.routes,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
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

  const guard = createGuard(config);
  const resolveTarget = createResolver(config);
  const forward = createForwarder(config, { guard, log });

  // Process-wide counters. In-memory by design: a bridge is stateless, and the
  // status page says "since start" rather than implying a lifetime total.
  const stats = options.stats ?? createStats();
  const getEgressIp = createEgressIp({ url: config.egressIpUrl });

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
      const bridgeTarget = request.headers.get('x-bridge-target');
      const bridgePath = request.headers.get('x-bridge-path');

      // The status page is GET-only; a stray POST to / should not look like a
      // successful page fetch, and every other control path is JSON.
      if (
        isControlRequest(url, bridgeTarget !== null) &&
        (url.pathname !== '/' || request.method === 'GET')
      ) {
        return handleControl(url, config, {
          stats,
          getEgressIp,
          clientIp: context.clientIp || '',
        });
      }

      assertBridgeAuth(request, config);

      const { url: target, matchedBy, route } = resolveTarget(url, {
        absoluteTarget: context.absoluteTarget ?? null,
        bridgeTarget,
        bridgePath,
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
      });

      stats.recordRequest();

      const headers = new Headers(result.headers);

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
      return errorResponse(err, { corsOrigin: cors });
    }
  };
}
