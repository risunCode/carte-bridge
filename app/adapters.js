// carte-bridge — adapters: platform I/O translation, nothing else.
//
// The core speaks Web Request/Response. These two translate whatever a
// platform hands us into that shape, and write the response back.

// ---------------------------------------------------------------------------
// Node http adapter — Docker, VPS, local
// ---------------------------------------------------------------------------

// Node http adapter: IncomingMessage/ServerResponse <-> Web Request/Response.
//
// Node 18+ ships both halves of the Web API, so this file is pure translation.
// The one thing it adds that the core cannot know: the real client address,
// read from the TCP socket. That value is unspoofable, which is why the core
// is handed it explicitly instead of trusting X-Forwarded-For.

import { Readable } from 'node:stream';
import { createApp } from './handler.js';
import { loadConfig, createLogger } from './core.js';

// The client address, taken from the TCP socket — the only value a caller
// cannot choose.
//
// Forwarding headers are ignored by default. Trusting them from a loopback peer
// (the shape 9router uses) is not enough on its own: on a container or a host
// where the bridge is reached directly, every caller is loopback, so "peer is
// loopback" stops distinguishing a local reverse proxy from an attacker. The
// decision is therefore explicit — set TRUST_PROXY=true only when something you
// control terminates the connection in front of this bridge.
function resolveClientIp(req, trustProxy) {
  const socketIp = req.socket?.remoteAddress || '';
  if (!trustProxy) return socketIp;

  const real = req.headers['x-real-ip'];
  const xff = req.headers['x-forwarded-for'];
  const forwarded = real || (xff ? String(xff).split(',')[0].trim() : '');
  return forwarded || socketIp;
}

// A proxy-style client sends "GET http://host/path HTTP/1.1", and Node
// surfaces that verbatim as req.url. Distinguishing it from an ordinary path
// request is only possible here, at the raw HTTP layer — once the request is
// wrapped as a Web Request, its url is absolute either way. That is why the
// adapter extracts it and the core never guesses.
function nodeAbsoluteFormTarget(req) {
  const raw = req.url || '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  // A plain "GET /path" is not absolute-form even though a proxy request to a
  // TLS terminator could look similar; only a scheme prefix qualifies.
  return raw;
}

function nodeToWebRequest(req, clientIp) {
  const scheme = req.socket?.encrypted ? 'https' : 'http';
  const host = req.headers.host || 'localhost';
  const absolute = nodeAbsoluteFormTarget(req);
  const url = new URL(req.url, `${scheme}://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.append(name, value);
  }
  headers.set('x-bridge-peer', clientIp);

  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  return {
    request: new Request(url, {
      method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      // Required by undici whenever a Request carries a stream body.
      duplex: hasBody ? 'half' : undefined,
    }),
    absoluteTarget: absolute,
  };
}

async function nodeWriteWebResponse(res, webResponse) {
  res.statusCode = webResponse.status;
  res.statusMessage = webResponse.statusText || '';

  // Set-Cookie must be written as an array. Iterating a Headers object folds
  // repeated Set-Cookie values into one comma-joined string, which silently
  // turns two cookies into one malformed cookie.
  const cookies = webResponse.headers.getSetCookie?.() ?? [];
  for (const [name, value] of webResponse.headers) {
    if (name.toLowerCase() === 'set-cookie') continue;
    res.setHeader(name, value);
  }
  if (cookies.length) res.setHeader('set-cookie', cookies);

  // Streaming responses are chunked; Node picks that automatically once no
  // content-length is set, which is exactly the case here because the core
  // strips it from upstream responses.
  res.flushHeaders?.();

  if (!webResponse.body) {
    res.end();
    return;
  }

  const reader = webResponse.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Respect backpressure: if the client is slow, wait before reading more.
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    // Headers are already out, so the only honest signal left is to cut the
    // connection — a truncated body with a 200 status would be worse.
    res.destroy(err);
  }
}

export function createNodeHandler(options = {}) {
  const onWarn = (msg) => console.warn(`[bridge] warn  ${msg}`);
  const config = options.config ?? loadConfig(process.env, { onWarn });
  const log = createLogger(config);
  const app = createApp({ ...options, config });

  return async function handler(req, res) {
    const clientIp = resolveClientIp(req, config.trustProxy);
    let webResponse;
    try {
      const { request, absoluteTarget } = nodeToWebRequest(req, clientIp);
      webResponse = await app(request, { clientIp, absoluteTarget });
    } catch (err) {
      log.error('adapter failure', { message: err?.message, stack: err?.stack });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'adapter_error', message: 'Bridge adapter error' } }));
      } else {
        res.destroy();
      }
      return;
    }
    await nodeWriteWebResponse(res, webResponse);
  };
}

export { resolveClientIp };

// ---------------------------------------------------------------------------
// Serverless adapter — Vercel, Netlify
// ---------------------------------------------------------------------------

// Universal handler for platforms that hand you a Node-style (req, res) pair
// with Web-API globals available — which is Vercel's Node.js runtime and
// Netlify's Functions runtime. Both also expose the peer address on the
// request, so it is read from there.

function platformClientIp(req) {
  // Vercel sets these at the edge; Netlify sets x-nf-client-connection-ip.
  const candidates = [
    req.headers['x-real-ip'],
    req.headers['x-nf-client-connection-ip'],
    req.headers['x-forwarded-for'],
  ];
  for (const value of candidates) {
    if (!value) continue;
    const first = String(value).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || '';
}

function collectBody(req) {
  // These runtimes give a Node stream that may already be consumed into
  // req.body by the platform's own parser. Reading the stream when it is
  // already drained would hang, so prefer an available buffer.
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body);
    if (req.body instanceof Uint8Array) return req.body;
    // A parsed object means the platform consumed and re-parsed the body;
    // re-serializing it is lossy for non-JSON content, so send what we have.
    return Buffer.from(JSON.stringify(req.body));
  }
  return undefined;
}

// req.url is the raw request line, so a proxy-style client sending
// "GET http://host/path" is still detectable here. Vercel and Netlify
// normally normalize to origin-form, but not every path through their edge
// does, and misreading it would send the bridge at itself.
function platformAbsoluteFormTarget(req) {
  const raw = req.url || '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : null;
}

function platformToWebRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const absolute = platformAbsoluteFormTarget(req);
  const url = new URL(req.url, `${proto}://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.append(name, value);
  }

  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? collectBody(req) : undefined;

  return {
    request: new Request(url, { method, headers, body }),
    absoluteTarget: absolute,
  };
}

async function platformWriteWebResponse(res, webResponse) {
  const headers = {};
  for (const [name, value] of webResponse.headers) {
    if (name.toLowerCase() === 'set-cookie') continue;
    headers[name] = value;
  }
  // Set-Cookie must stay an array; folding it into one string corrupts it.
  const cookies = webResponse.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers['set-cookie'] = cookies;

  res.writeHead(webResponse.status, headers);

  if (!webResponse.body) {
    res.end();
    return;
  }

  const reader = webResponse.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    res.destroy(err);
  }
}

let cached;

export function createHandler(options = {}) {
  const onWarn = (msg) => console.warn(`[bridge] warn  ${msg}`);
  const config = options.config ?? loadConfig(process.env, { onWarn });
  const log = createLogger(config);
  const app = createApp({ ...options, config });

  return async function handler(req, res) {
    const clientIp = platformClientIp(req);
    let webResponse;
    try {
      const { request, absoluteTarget } = platformToWebRequest(req);
      webResponse = await app(request, { clientIp, absoluteTarget });
    } catch (err) {
      log.error('adapter failure', { message: err?.message, stack: err?.stack });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'adapter_error', message: 'Bridge adapter error' } }));
      } else {
        res.destroy();
      }
      return;
    }
    await platformWriteWebResponse(res, webResponse);
  };
}

// Both serverless platforms import the same module repeatedly within a warm
// container; building the app once per process keeps config parsing and route
// compilation out of the request path.
export function handler(req, res) {
  if (!cached) cached = createHandler();
  return cached(req, res);
}
