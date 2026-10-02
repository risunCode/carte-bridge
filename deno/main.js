// Deno entrypoint.
//
// The core already speaks Web Request/Response, so this file is the thinnest
// adapter of the set: no translation at all, just wiring Deno's runtime values
// into the places the core expects them.
//
// Two Deno-specific details:
//
//   Environment. Deno does not have `process.env`; it has `Deno.env.toObject()`.
//   It is passed in explicitly rather than left to the globalThis fallback, so
//   configuration works without a compatibility layer.
//
//   Permissions. Deno is deny-by-default, so the deploy needs
//   --allow-net (upstream fetch, and the egress IP lookup) and --allow-env.
//   `node:dns` is not available, so the SSRF guard runs its literal layer only
//   — which is why the guard must stay enabled and ALLOWED_HOSTS should be set
//   for any public deployment.

import { createApp } from '../app/handler.js';
import { loadConfig } from '../app/core.js';

const env = (() => {
  try {
    return Deno.env.toObject();
  } catch {
    // --allow-env was not granted. Falling back to an empty environment means
    // the bridge still boots in open mode rather than crashing, and the startup
    // log makes that visible.
    return {};
  }
})();

const config = loadConfig(env, { onWarn: (m) => console.warn(`[bridge] warn  ${m}`) });
const app = createApp({ config });

const clientIpOf = (request, info) => {
  // Deno.serve supplies the peer address on the connection info. Fall back to
  // the proxy header only when the runtime did not provide one.
  const fromConn = info?.remoteAddr?.hostname;
  if (fromConn) return fromConn;
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded ? forwarded.split(',')[0].trim() : '';
};

Deno.serve((request, info) => {
  // `path` is the URL pattern; everything is routed inside the core.
  return app(request, { clientIp: clientIpOf(request, info) });
});
