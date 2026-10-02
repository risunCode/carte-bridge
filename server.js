// Entry point for Docker, VPS and local runs.
//
// This is the only adapter with a raw TCP socket, so it is the only one that
// can implement a CONNECT tunnel — and it does. On this runtime the bridge is a
// real forward proxy: a client opens `CONNECT host:port`, the bridge dials that
// host and pipes bytes both ways, so the upstream sees a plain TCP session with
// no HTTP relay shape in front of it.
//
// The serverless entrypoints (Vercel, Netlify, Deno) cannot hold a raw socket,
// so there the bridge serves the HTTP relay instead. Same codebase, the best
// transport each runtime can offer.

import http from 'node:http';
import net from 'node:net';
import { createNodeHandler } from './app/adapters.js';
import { loadConfig } from './app/core.js';
import { createLogger } from './app/core.js';
import { createGuard } from './app/policy.js';

const onWarn = (msg) => console.warn(`[bridge] warn  ${msg}`);
const config = loadConfig(process.env, { onWarn });
const log = createLogger(config);

const handler = createNodeHandler({ config });
const guard = createGuard(config);

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    log.error('request failed', { message: err?.message });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Bridge failure' } }));
    } else {
      res.destroy();
    }
  });
});

/**
 * CONNECT tunnel: the forward-proxy path.
 *
 * `req.url` is `host:port` for a CONNECT request. The target is validated by
 * the same SSRF guard the relay uses, so a CONNECT cannot reach a private or
 * link-local address any more than an HTTP forward can. The guard's resolved
 * check needs a hostname and port, which is exactly what we have here.
 *
 * Bytes are piped with `pipe`, which propagates backpressure in both
 * directions; the two sockets are torn down together so a half-closed tunnel
 * cannot leak the other end.
 */
server.on('connect', async (req, clientSocket, head) => {
  const target = req.url || '';
  const separator = target.lastIndexOf(':');
  const host = separator === -1 ? target : target.slice(0, separator);
  const port = separator === -1 ? 443 : Number.parseInt(target.slice(separator + 1), 10);

  const refuse = (status, reason) => {
    if (clientSocket.writable) clientSocket.end(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
    clientSocket.destroy();
  };

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    log.warn('connect rejected', { reason: 'malformed_target', target });
    return refuse(400, 'Bad Request');
  }

  try {
    // Literal checks first (cheap, synchronous), then the resolved check that
    // catches a public hostname pointing at a private address.
    guard.assertLiteral(`https://${host}`);
    await guard.assertResolved(`https://${host}`);
  } catch (err) {
    log.warn('connect rejected', { reason: err?.code || 'blocked', target });
    return refuse(403, 'Forbidden');
  }

  const upstream = net.connect(port, host);
  let established = false;

  const teardown = () => {
    upstream.destroy();
    clientSocket.destroy();
  };

  upstream.on('connect', () => {
    established = true;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    log.info('connect tunnelled', { target });
  });

  upstream.on('error', (err) => {
    log.warn('connect upstream error', { target, message: err?.message });
    // Only a failure before the tunnel is up can be answered with a status
    // line; after that the socket carries raw bytes and a status line would be
    // injected into the tunnel as garbage. Just tear it down.
    if (established) teardown();
    else refuse(502, 'Bad Gateway');
  });
  clientSocket.on('error', teardown);
  upstream.on('close', teardown);
  clientSocket.on('close', teardown);
});

// A bridge holds long-lived upstream connections. The defaults (5s) would cut
// streaming responses short, so keep-alive is generous and only the truly idle
// socket is reaped.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 0; // the per-request deadline lives in the core

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(config.port, config.host, () => {
  log.info(`listening on ${config.host}:${config.port}`, {
    transport: 'connect+http',
    ssrfGuard: config.blockPrivate ? 'enabled' : 'disabled',
    routes: Object.keys(config.routes).length,
    allowedHosts: config.allowedHosts.length || 'any',
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    log.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Don't wait forever on in-flight streams.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
