// Entry point for Docker, VPS and local runs.
//
// This is the only adapter with a real TCP socket, so it is the only one that
// could ever implement a CONNECT tunnel. It deliberately does not: this bridge
// speaks HTTP on every platform, so there is no behaviour that exists here and
// nowhere else.

import http from 'node:http';
import { createNodeHandler } from './app/adapters.js';
import { loadConfig } from './app/core.js';
import { createLogger } from './app/core.js';

const onWarn = (msg) => console.warn(`[bridge] warn  ${msg}`);
const config = loadConfig(process.env, { onWarn });
const log = createLogger(config);

const handler = createNodeHandler({ config });

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
    auth: config.bridgeKey ? 'required' : 'open',
    ssrfGuard: config.blockPrivate ? 'enabled' : 'disabled',
    routes: Object.keys(config.routes).length,
    allowedHosts: config.allowedHosts.length || 'any',
  });
  if (!config.bridgeKey) {
    log.warn('BRIDGE_KEY is empty — this instance is an open bridge. Set BRIDGE_KEY before exposing it publicly.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    log.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Don't wait forever on in-flight streams.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
