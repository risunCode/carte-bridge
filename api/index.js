// Vercel entrypoint.
//
// Vercel's Node.js runtime hands the handler a Node-style (req, res) pair, so
// the shared adapter does the translation. The rewrite in vercel.json sends
// every path here — this is a bridge, so there is no other content to serve.

import { handler } from '../app/adapters.js';

export default handler;

// Fluid compute keeps a warm instance alive between requests, which is what
// makes the module-level handler cache in adapters.js pay off.
export const config = {
  runtime: 'nodejs',
};
