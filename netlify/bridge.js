// Netlify entrypoint.
//
// Netlify Functions v2 uses the same Web Request/Response API the core already
// speaks, so this file needs no adapter at all — the core handler is called
// directly. That is the payoff of keeping the core platform-agnostic.
//
// Node runtime, not Edge: the SSRF guard resolves hostnames through node:dns to
// catch a public name that points at a private address. Deno has no node:dns,
// so on Edge the guard would silently degrade to literal-only checks.

import { createApp } from '../app/handler.js';

const app = createApp();

export default async function bridge(request, context) {
  // context.ip is Netlify's resolved peer address. It is supplied to the core
  // as the client IP so the bridge never has to trust a caller-sent header.
  return app(request, {
    clientIp: context?.ip || '',
    requestId: context?.requestId,
  });
}

// Custom path: this function answers every route. Netlify matches this before
// any static content, which is what a bridge wants.
export const config = {
  path: '/*',
};
