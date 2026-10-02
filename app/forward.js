// carte-bridge — outbound: header sanitization and upstream forwarding.
//
// Merged because the header rules and the fetch call are two halves of one
// job, and keeping them apart only meant jumping between files to follow it.

// ---------------------------------------------------------------------------
// Header sanitization
// ---------------------------------------------------------------------------

// Header sanitization.
//
// Three distinct jobs, each with a failure mode that is silent if done naively:
//
//   1. Drop hop-by-hop headers. They describe a single TCP hop, so forwarding
//      them corrupts the next one. RFC 7230 also lets a `Connection` header
//      name *additional* hop-by-hop headers, so that list is parsed too —
//      otherwise "Connection: x-internal-trace" smuggles a header through.
//
//   2. Drop client-supplied forwarding headers. A caller sending its own
//      X-Forwarded-For is either confused or attacking; either way the bridge
//      must not append to it. See custom-server.js in 9router for the same
//      reasoning. The bridge writes its own chain from the socket address.
//
//   3. Drop content-length / content-encoding from the *response*. fetch()
//      transparently decompresses gzip/br, but the upstream's content-length
//      still describes the compressed size. Forwarding it makes the client
//      wait for bytes that will never arrive — the connection hangs until it
//      times out. This is the single most common bridge bug.

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Set by infrastructure and by the client; never trusted from the client.
const FORWARDING_HEADERS = new Set([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'fastly-client-ip',
]);

// Bridge-internal, must never reach upstream.
const INTERNAL_HEADERS = new Set([
  'x-bridge-peer',
  'x-bridge-hop',
  'x-bridge-target',
  'x-bridge-path',
]);

// Response headers that describe the upstream connection or an encoding the
// runtime already undid.
const RESPONSE_DROP = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'upgrade',
]);

function expandConnectionTokens(headers) {
  const extra = new Set();
  const raw = headers.get('connection');
  if (!raw) return extra;
  for (const token of raw.split(',')) {
    const name = token.trim().toLowerCase();
    if (name) extra.add(name);
  }
  return extra;
}

/**
 * Build the header set to send upstream.
 *
 * @param {Headers} inbound          headers from the client request
 * @param {object}  options
 * @param {string}  options.host     Host value to present upstream
 * @param {string}  options.clientIp resolved client address
 * @param {string}  options.proto    scheme the client used ("http"/"https")
 * @returns {Headers}
 */
export function buildUpstreamHeaders(inbound, { host, clientIp, proto }) {
  const extraHopByHop = expandConnectionTokens(inbound);
  const out = new Headers();

  for (const [name, value] of inbound) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (extraHopByHop.has(key)) continue;
    if (FORWARDING_HEADERS.has(key)) continue;
    if (INTERNAL_HEADERS.has(key)) continue;
    if (key === 'host') continue;
    out.append(name, value);
  }

  out.set('host', host);

  // Write our own forwarding chain. The client IP comes from the socket (or
  // from the platform's trusted header), never from anything the caller sent.
  if (clientIp) {
    out.set('x-forwarded-for', clientIp);
    out.set('x-real-ip', clientIp);
  }
  out.set('x-forwarded-proto', proto);
  out.set('x-forwarded-host', host);

  return out;
}

/**
 * Build the header set to return to the client.
 *
 * @param {Headers} upstream
 * @param {string}  corsOrigin  "" = no CORS headers, "*" or an origin otherwise
 * @returns {Headers}
 */
export function buildClientHeaders(upstream, corsOrigin) {
  const out = new Headers();

  for (const [name, value] of upstream) {
    const key = name.toLowerCase();
    if (RESPONSE_DROP.has(key)) continue;
    // A redirect target is resolved by our own follow loop, not the client.
    if (key === 'location') continue;
    out.append(name, value);
  }

  if (corsOrigin) {
    out.set('access-control-allow-origin', corsOrigin);
    if (corsOrigin !== '*') out.set('vary', 'Origin');
  }

  return out;
}

const __headersTest = { HOP_BY_HOP, FORWARDING_HEADERS, RESPONSE_DROP, expandConnectionTokens };

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

// Upstream forwarding: fetch, follow redirects safely, stream the body back.
//
// The two decisions worth explaining:
//
//   Buffering. A retry is only possible if the request body can be sent twice.
//   Bodies at or under MAX_BUFFER_BYTES are read into memory so a failed
//   attempt can fall over to a fallback origin; larger bodies stream straight
//   through and get exactly one attempt. Uploads are the case where a retry
//   would otherwise mean holding a gigabyte in RAM.
//
//   Timeouts. REQUEST_TIMEOUT_MS bounds time-to-first-byte, and
//   STREAM_IDLE_TIMEOUT_MS bounds the gap *between* bytes once the body starts
//   flowing. One shared deadline would kill every long-lived SSE stream, which
//   is exactly the traffic a bridge like this carries.

import { badGateway, gatewayTimeout, BridgeError } from './core.js';

// Statuses worth trying the next origin for. A 500 is deliberately excluded:
// that is usually the application answering, and repeating the request
// elsewhere rarely helps. 502/503/504 mean the edge itself failed.
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

async function readBodyWithLimit(request, limit) {
  if (!request.body) return { buffered: new Uint8Array(0), tooLarge: false };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (limit > 0 && total > limit) {
        // This chunk is part of the body and must still be forwarded. Pushing
        // it before returning is what keeps the recombined stream byte-exact;
        // dropping it would leave the body shorter than the content-length
        // header promises, and undici rejects that outright.
        chunks.push(value);
        return { buffered: null, tooLarge: true, reader, firstChunks: chunks };
      }
      chunks.push(value);
    }
  } catch (err) {
    throw badGateway(`Failed to read request body: ${err.message}`, err);
  }

  const buffered = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { buffered, tooLarge: false };
}

// Re-assemble a body for pass-through when it was too large to buffer: the
// already-consumed chunks first, then whatever is left in the original reader.
function recombineStream(reader, chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// Abort the stream if no chunk arrives within idleMs. SSE responses may also
// receive comment heartbeats while upstream is quiet; those are valid SSE and
// keep serverless connections alive without buffering or rewriting data events.
function withIdleTimeout(stream, idleMs, onIdle, { heartbeatMs = 0 } = {}) {
  const reader = stream.getReader();
  let timer = null;
  let heartbeatTimer = null;
  let finished = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  return new ReadableStream({
    start(controller) {
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (finished) return;
          finished = true;
          try {
            await reader.cancel();
          } catch {
            /* already gone */
          }
          clear();
          onIdle();
          try {
            controller.error(new BridgeError(504, 'upstream_timeout', 'Upstream stream stalled'));
          } catch {
            /* controller already closed */
          }
        }, idleMs);
        if (typeof timer.unref === 'function') timer.unref();
      };

      arm();
      if (heartbeatMs > 0) {
        const heartbeat = new TextEncoder().encode(': bridge-heartbeat\n\n');
        heartbeatTimer = setInterval(() => {
          if (!finished) controller.enqueue(heartbeat);
        }, heartbeatMs);
        if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
      }

      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (finished) return;
            if (done) break;
            arm();
            controller.enqueue(value);
          }
          finished = true;
          clear();
          controller.close();
        } catch (err) {
          finished = true;
          clear();
          try {
            controller.error(err);
          } catch {
            /* already errored by the timeout path */
          }
        }
      })();
    },
    cancel(reason) {
      finished = true;
      clear();
      return reader.cancel(reason);
    },
  });
}

function makeSignal(timeoutMs, external) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    controller,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function swapOrigin(target, origin) {
  const next = new URL(target.toString());
  const base = new URL(origin);
  next.protocol = base.protocol;
  next.host = base.host;
  return next;
}

// Redirects are followed manually so each hop is re-validated by the SSRF
// guard. fetch's own redirect: "follow" would chase a public URL into
// 169.254.169.254 without ever asking us.
async function followRedirects(initialUrl, init, { guard, maxRedirects, log, method, body }) {
  let currentUrl = initialUrl;
  let currentMethod = method;
  let currentBody = body;

  for (let hop = 0; ; hop++) {
    await guard.assertResolved(currentUrl.toString());

    const res = await fetch(currentUrl, {
      ...init,
      method: currentMethod,
      body: currentBody,
      redirect: 'manual',
    });

    const isRedirect = res.status >= 300 && res.status < 400;
    const location = isRedirect ? res.headers.get('location') : null;
    if (!location) return { res, url: currentUrl, method: currentMethod, body: currentBody };

    if (hop >= maxRedirects) {
      // Drain so the socket can be reused.
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      throw badGateway(`Too many redirects (limit ${maxRedirects})`);
    }

    const nextUrl = new URL(location, currentUrl);
    log.debug('redirect', { from: currentUrl.toString(), to: nextUrl.toString(), status: res.status });

    // 303, and 301/302 in practice, mean "go GET that instead". 307/308 keep
    // both method and body. Rewriting on 307 would silently drop a POST body.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod !== 'GET')) {
      currentMethod = 'GET';
      currentBody = undefined;
    }

    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    currentUrl = nextUrl;
  }
}

export function createForwarder(config, { guard, log }) {
  return async function forward({ request, url, route, clientIp, proto }) {
    const method = request.method.toUpperCase();
    const isBodyless = BODYLESS_METHODS.has(method) || method === 'OPTIONS';

    // --- request body -------------------------------------------------------
    let bufferedBody = null;
    let streamBody = null;

    if (!isBodyless && request.body) {
      const { buffered, tooLarge, reader, firstChunks } = await readBodyWithLimit(
        request,
        config.maxBufferBytes,
      );
      if (tooLarge) {
        streamBody = recombineStream(reader, firstChunks);
        log.debug('body too large to buffer, streaming with no retry');
      } else if (buffered && buffered.byteLength > 0) {
        bufferedBody = buffered;
      }
    }

    // --- candidate origins --------------------------------------------------
    // A named route may declare fallbacks; each keeps the caller's path and
    // query and only swaps the origin. A bare URL has exactly one candidate.
    const origins = route && config.fallbacks[route] ? config.fallbacks[route] : [];
    const candidates = origins.length ? origins.map((o) => swapOrigin(url, o)) : [url];

    const headers = buildUpstreamHeaders(request.headers, {
      host: url.host,
      clientIp,
      proto,
    });

    let lastError = null;

    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const target = candidates[attempt];
      if (attempt > 0) {
        headers.set('host', target.host);
        log.warn('failover', { attempt, origin: target.origin });
      }

      // Retrying is only sound when the body can be replayed.
      const canRetry = bufferedBody !== null || isBodyless;
      const body = bufferedBody ?? (isBodyless ? undefined : streamBody);

      const { signal, dispose } = makeSignal(config.requestTimeoutMs, request.signal);

      // `duplex: 'half'` is required by undici only when the body is a stream,
      // and passing it alongside a buffered body trips its argument validation.
      const init = { headers, signal };
      if (body instanceof ReadableStream) init.duplex = 'half';

      let res;
      try {
        ({ res } = await followRedirects(target, init, {
          guard,
          maxRedirects: config.maxRedirects,
          log,
          method,
          body,
        }));
      } catch (err) {
        dispose();
        if (err instanceof BridgeError) {
          // Policy rejections (SSRF, allowlist) must not be retried elsewhere.
          if (err.status === 403 || err.status === 400) throw err;
          lastError = err;
        } else if (signal.aborted) {
          lastError = gatewayTimeout(`Upstream did not respond within ${config.requestTimeoutMs}ms`, err);
        } else {
          lastError = badGateway(`Upstream request failed: ${err.message}`, err);
        }
        if (canRetry && attempt < candidates.length - 1) continue;
        throw lastError;
      }

      if (RETRYABLE_STATUS.has(res.status) && canRetry && attempt < candidates.length - 1) {
        log.warn('upstream returned retryable status', { status: res.status, origin: target.origin });
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        dispose();
        lastError = badGateway(`Upstream returned ${res.status}`);
        continue;
      }

      // Headers are in; the deadline now shifts to the inter-byte idle budget.
      dispose();

      const clientHeaders = buildClientHeaders(res.headers, config.corsOrigin);
      const hasBody = res.body && method !== 'HEAD' && res.status !== 204 && res.status !== 304;
      const isEventStream = clientHeaders.get('content-type')?.toLowerCase().startsWith('text/event-stream');

      return {
        status: res.status,
        headers: clientHeaders,
        body: hasBody
          ? withIdleTimeout(
              res.body,
              config.streamIdleTimeoutMs,
              () => log.warn('stream idle timeout', { url: target.toString() }),
              { heartbeatMs: isEventStream ? config.streamHeartbeatMs : 0 },
            )
          : null,
        upstreamUrl: target.toString(),
      };
    }

    throw lastError || badGateway('All upstream candidates failed');
  };
}

const __forwardTest = { withIdleTimeout, swapOrigin, RETRYABLE_STATUS };

// Both halves' test hooks, so tests can reach whichever they need.
export const __test = { ...__headersTest, ...__forwardTest };
