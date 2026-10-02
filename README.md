# carte-bridge

A stateless HTTP bridge. One codebase, deploys to **Railway**, **Vercel**,
**Netlify**, **Deno Deploy** or **Docker** — no build step, no dependencies, no
database.

It forwards a request to an upstream URL you name, streams the response back,
and gets out of the way.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2FrisunCode%2Fcarte-bridge)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FrisunCode%2Fcarte-bridge)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/risunCode/carte-bridge)

---

## Quick start

```bash
node server.js
# [bridge] info  listening on 0.0.0.0:8080 {"transport":"connect+http","ssrfGuard":"enabled"}
```

```bash
curl "http://localhost:8080/r/https://api.github.com/repos/nodejs/node" | head -c 200
```

That is the whole setup. **No username, no password, no config.** The bridge
boots open — anyone with the URL can use it.

---

## How to call it

Four accepted shapes, all working on every platform.

| Shape | Example |
|---|---|
| Bridge relay headers | `x-bridge-target: https://api.example.com` + `x-bridge-path: /v1/foo` |
| Path prefix | `GET /r/https://api.example.com/v1/foo` |
| Named route | `GET /r/gh/repos/nodejs/node` (with `ROUTES` set) |
| Absolute-form | `GET http://api.example.com/v1/foo` (proxy-style clients) |

Bridge relay headers are the internal pool contract. The target is deliberately
not placed in a query string, where it can leak into access logs and CDN URLs.
Everything after the target is passed through: path, query, method, body,
headers. A POST stays a POST. An SSE stream stays an SSE stream.

```bash
# POST with a JSON body
curl -X POST "http://localhost:8080/r/https://httpbin.org/post" \
  -H 'content-type: application/json' -d '{"hello":"world"}'

# Streaming, delivered unbuffered
curl -N "http://localhost:8080/r/https://httpbin.org/stream/5"

# Named route
ROUTES='{"gh":"https://api.github.com"}' node server.js
curl "http://localhost:8080/r/gh/repos/nodejs/node"
```

### Status page

Open the root URL in a browser — it is plain text, `text/plain`:

```
carte-bridge
============

currentIP:
  client   : 203.0.113.7
  egress   : 198.51.100.4

CurrentSpeed: 8.39 Mb/s (1.00 MiB/s)
Bandwidth served: 2.41 GiB

  requests : 1841
  uptime   : 3h 12m
```

| Endpoint | Purpose |
|---|---|
| `/` | Status page: IPs, current speed, bandwidth served |
| `/healthz` | Liveness. Plain `ok` |
| `/readyz` | What this instance will do: SSRF state, routes |
| `/stats` | The same counters as JSON |
| `/__bridge` | Usage and configured routes as JSON |

What the numbers mean, precisely:

- **CurrentSpeed** is *forwarding throughput* — bytes moving through this instance,
  averaged over a sliding 60-second window. It is **not** a speedtest of the
  host's connection. A real speedtest would consume the bandwidth it measures,
  so it is deliberately not done.
- **Bandwidth served** is cumulative **since the process started**. The bridge
  holds no state, so this is in-memory and resets on restart.
- **egress IP** is the address upstream sees, resolved through `EGRESS_IP_URL`
  (default `api.ipify.org`), cached 5 minutes.

---

## Security

**Open by default.** There is no required key unless `BRIDGE_AUTH_MODE=basic`
is configured. Open mode is fine locally, on a private network, or behind an
allowlist; on the public internet it means anyone who finds the URL can
forward traffic through it — your bandwidth, your domain's reputation.

Two protections are on regardless:

- **SSRF guard** (`BLOCK_PRIVATE=true`) refuses loopback, private, link-local,
  CGNAT, multicast and cloud-metadata addresses — including a *public hostname
  that resolves to one*. Without it, `169.254.169.254` and your internal network
  are one request away.
- **No spoofable client IP.** Forwarding headers from a caller are discarded and
  replaced with the real peer address.

When bridge authentication is disabled, an upstream's own `Authorization`
header is passed through untouched. Basic bridge authentication uses the
separate `x-bridge-auth` header for exactly this reason.

### Optional bridge authentication

Authentication is open by default. To protect relay requests, configure:

```bash
BRIDGE_AUTH_MODE=basic
BRIDGE_USERNAME=cartethyia
BRIDGE_PASSWORD='change-this'
```

The bridge credentials use the internal `x-bridge-auth` header, not the
upstream `Authorization` header. This keeps provider credentials intact while
allowing Cartethyia to authenticate the bridge itself. Health and status
endpoints remain available for platform probes; forwarding requests require
the bridge credentials.

### Restricting where it may reach

```bash
ALLOWED_HOSTS='api.anthropic.com,*.example.com' node server.js
```

`*.example.com` matches subdomains but not the bare domain. Empty
`ALLOWED_HOSTS` means any public host.

---

## Transports

The bridge speaks two transports and picks the best one its runtime can offer.

| Transport | Where | Shape |
|---|---|---|
| **HTTP relay** | Vercel, Netlify, Deno Deploy, Cloudflare Workers | `x-bridge-target` + `x-bridge-path` |

The CONNECT path is a real forward proxy: the client asks for `host:port`, the
bridge dials it, and bytes are piped both ways. The serverless entrypoints have
no raw socket, so there the same codebase serves the HTTP relay instead. A
client that can try CONNECT first and fall back to the relay works everywhere.

---

## Configuration

Every variable is optional.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port (Docker / Railway / local) |
| `HOST` | `0.0.0.0` | Bind address |
| `ALLOWED_HOSTS` | *empty* | Comma-separated allowlist. Empty = any public host |
| `BLOCK_PRIVATE` | `true` | SSRF guard |
| `ROUTES` | *empty* | JSON map of prefix → origin |
| `FALLBACKS` | *empty* | JSON map of prefix → origins tried in order |
| `REQUEST_TIMEOUT_MS` | `30000` | Time to first byte from upstream |
| `STREAM_IDLE_TIMEOUT_MS` | `60000` | Max gap between bytes once streaming |
| `STREAM_HEARTBEAT_MS` | `15000` | SSE comment heartbeat while upstream is quiet; `0` disables |
| `MAX_BUFFER_BYTES` | `1048576` | Bodies under this are buffered so a retry is possible |
| `MAX_REDIRECTS` | `5` | Redirect hops, each re-validated by the SSRF guard |
| `CORS_ORIGIN` | *empty* | `*` or a specific origin. Empty = no CORS headers |
| `TRUST_PROXY` | `false` | Believe `X-Forwarded-For`. Only behind a proxy you run |
| `EGRESS_IP_URL` | `api.ipify.org` | Egress lookup for the status page. Empty disables |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `LOG_FORMAT` | `text` | `text` or `json` |

A malformed `ROUTES` or `FALLBACKS` logs a warning and is ignored — the bridge
still boots. A bridge that refuses to start is worse than one with fewer routes.

### Named routes and failover

```bash
ROUTES='{"anthropic":"https://api.anthropic.com","openai":"https://api.openai.com"}'
FALLBACKS='{"anthropic":["https://api.anthropic.com","https://backup.example.com"]}'
```

Route targets must be bare origins — `https://api.example.com`, not
`https://api.example.com/v1`. A path there would swallow the caller's path.

---

## Deploy


All providers use the same application and the same environment variables.
Start with the open mode if the relay is protected by a private network or an
upstream firewall. Set `BRIDGE_AUTH_MODE=basic` when the public endpoint needs a
second access gate.

<details>
<summary><strong>Railway — long-lived Node server with CONNECT support</strong></summary>

1. Click **Deploy on Railway** above, or create a new project from this GitHub
   repository.
2. In **Variables**, add the values you need. Railway supplies `PORT`
   automatically:

   ```text
   BLOCK_PRIVATE=true
   BRIDGE_AUTH_MODE=basic
   BRIDGE_USERNAME=cartethyia
   BRIDGE_PASSWORD=replace-me
   ```

3. Deploy and open the generated domain.
4. Verify the instance:

   ```bash
   curl https://YOUR-APP.up.railway.app/healthz
   curl https://YOUR-APP.up.railway.app/readyz
   ```

Railway finds the root `Dockerfile` automatically. This deployment runs
`server.js`, so it supports both the HTTP relay and the real CONNECT tunnel.

</details>

<details>
<summary><strong>Vercel — serverless HTTP relay</strong></summary>

Using the button above:

1. Import the repository.
2. In **Project → Settings → Environment Variables**, add
   `BLOCK_PRIVATE`, `ALLOWED_HOSTS`, and the optional bridge authentication
   variables.
3. Redeploy after changing environment variables.

Using the CLI:

```bash
npx vercel login
npx vercel link
npx vercel env add BLOCK_PRIVATE production
npx vercel env add BRIDGE_AUTH_MODE production
npx vercel env add BRIDGE_USERNAME production
npx vercel env add BRIDGE_PASSWORD production
npx vercel --prod
```

The repository's `vercel.json` routes every request to `api/index.js` and sets
the function maximum to 300 seconds, subject to the Vercel account plan.
Verify with:

```bash
curl https://YOUR-PROJECT.vercel.app/healthz
```

Vercel uses the HTTP relay contract. It does not provide a raw CONNECT socket.

</details>

<details>
<summary><strong>Netlify — serverless function relay</strong></summary>

Using the button above:

1. Import the repository.
2. In **Site configuration → Environment variables**, add
   `BLOCK_PRIVATE`, `ALLOWED_HOSTS`, and the optional bridge authentication
   variables.
3. Trigger a deploy.

Using the CLI:

```bash
npm install -g netlify-cli
netlify login
netlify init
netlify env:set BLOCK_PRIVATE true
netlify env:set BRIDGE_AUTH_MODE basic
netlify env:set BRIDGE_USERNAME cartethyia
netlify env:set BRIDGE_PASSWORD replace-me
netlify deploy --prod
```

`netlify.toml` points functions at `netlify/bridge.js` and pins Node 22. The
function is intentionally Node-based rather than Edge-based because the full
SSRF guard uses `node:dns`. Netlify is limited to short-lived function
requests, so use Railway, Docker, Deno, or Cloudflare for long SSE streams.

Verify with:

```bash
curl https://YOUR-SITE.netlify.app/healthz
```

</details>

<details>
<summary><strong>Docker — local, VPS, or any container platform</strong></summary>

Build and run directly:

```bash
docker build -t carte-bridge .
docker run --rm -p 8080:8080 \
  -e BLOCK_PRIVATE=true \
  -e BRIDGE_AUTH_MODE=basic \
  -e BRIDGE_USERNAME=cartethyia \
  -e BRIDGE_PASSWORD=replace-me \
  carte-bridge
```

For repeatable configuration, copy the example environment file and use
Compose:

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
curl http://localhost:8080/healthz
```

The image runs as the unprivileged `node` user, exposes port `8080`, and has a
`HEALTHCHECK` for `/healthz`. Docker/VPS deployments support both HTTP relay and
CONNECT.

</details>

<details>
<summary><strong>Deno Deploy — portable HTTP relay</strong></summary>

Local smoke run:

```bash
deno task start
curl http://localhost:8000/healthz
```

Deploy with `deployctl`:

```bash
deployctl deploy \
  --project=carte-bridge \
  --prod \
  deno/main.js
```

Or connect the repository in the Deno Deploy dashboard and set the entrypoint
to `deno/main.js`. Configure environment variables in the project settings:
`BLOCK_PRIVATE`, `ALLOWED_HOSTS`, `BRIDGE_AUTH_MODE`, `BRIDGE_USERNAME`, and
`BRIDGE_PASSWORD`.

`deno.json` grants `--allow-net` and `--allow-env`. Deno has no `node:dns`, so
the SSRF guard can reject literal private addresses but cannot detect every
public hostname that resolves to a private address. For a public Deno
deployment, set `ALLOWED_HOSTS` to a narrow allowlist.

</details>

<details>
<summary><strong>Cloudflare Workers — edge HTTP relay</strong></summary>

Authenticate Wrangler and deploy from the repository root:

```bash
npx wrangler login
npx wrangler deploy --config cloudflare/wrangler.toml
```

Set runtime variables in the Cloudflare dashboard under **Workers & Pages →
your Worker → Settings → Variables and Secrets**. Use a secret for the
password:

```bash
npx wrangler secret put BRIDGE_PASSWORD --config cloudflare/wrangler.toml
```

Set `BRIDGE_AUTH_MODE=basic` and `BRIDGE_USERNAME` as encrypted or plain
variables according to your account policy. Redeploy after changing variables.
Verify the Worker:

```bash
curl https://YOUR-WORKER.workers.dev/healthz
```

Cloudflare Workers use the HTTP relay contract and cannot provide raw CONNECT.
The runtime has no `node:dns`, so literal SSRF checks remain active; use
`ALLOWED_HOSTS` for a public Worker. Cloudflare is the preferred serverless
target for long HTTP/SSE streams while the client remains connected.

</details>

### What works where

| | Railway | Docker / VPS | Vercel | Netlify | Deno | Cloudflare |
|---|---|---|---|---|---|---|
| HTTP bridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Streaming (SSE) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Unbounded request duration | ✅ | ✅ | ❌ ceiling | ❌ ceiling | ❌ eviction possible | ✅ HTTP request |
| SSRF guard: literal IPs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| SSRF guard: DNS resolution | ✅ | ✅ | ✅ | ✅ | ❌ no `node:dns` | ❌ no `node:dns` |

Vercel is configured for a 300-second maximum in `vercel.json`; the effective
limit still depends on the account plan. Netlify streaming functions have a
60-second execution limit and a 20 MB response limit. Deno and Cloudflare can
keep active streams alive longer, but deployments, runtime updates, and
instance eviction can still close a connection, so clients must reconnect.


<details>
<summary><strong>Use the deployed relay</strong></summary>

For an open relay, send the target origin and path as bridge headers:

```bash
curl "https://YOUR-RELAY.example/" \
  -H 'x-bridge-target: https://httpbin.org' \
  -H 'x-bridge-path: /anything?source=carte'
```

When `BRIDGE_AUTH_MODE=basic`, add the bridge credential separately. Keep the
provider's own credential in `Authorization`:

```bash
curl "https://YOUR-RELAY.example/" \
  -H 'x-bridge-target: https://api.example.com' \
  -H 'x-bridge-path: /v1/messages' \
  -H "x-bridge-auth: Basic $(printf '%s' 'cartethyia:replace-me' | base64)" \
  -H "Authorization: Bearer PROVIDER_TOKEN"
```

The bridge auth header is consumed by Carte Relay and never reaches the
upstream. The provider `Authorization` header does reach the upstream.
Cartethyia's `bridge://username:password@host` pool endpoint generates this
header automatically during its relay fallback.

</details>

---

## How it works

```
server.js              the only file at the root: starts the listener (Node)
                       and serves the CONNECT tunnel
app/
  core.js              typed errors, leveled logger, env -> frozen config
  policy.js            the gate: where a request may reach (SSRF)
  forward.js           header sanitization + fetch, redirects, streaming, failover
  target.js            bridge headers + URL target resolution
  stats.js             byte counters, speed window, egress IP lookup
  status.js            renders the plain-text status page
  handler.js           the handler
  adapters.js          Node I/O translation
api/index.js           Vercel entrypoint
netlify/bridge.js      Netlify entrypoint
deno/main.js           Deno entrypoint
cloudflare/worker.js   Cloudflare Workers entrypoint
```

`app/` is the core and it never imports a platform SDK — or anything from
`node:` except an optional, dynamically-imported `node:dns`. That is what makes
it run unchanged on Deno. Each entrypoint above is a thin adapter; adding a
platform is a file, not a rewrite.

Two small affordances make that possible: configuration is read through a
`globalThis.process?.env` fallback (Deno has no `process`), and entrypoints can
inject their own environment object instead.

### Things that are easy to get wrong

- **Response `content-length` is dropped.** `fetch()` decompresses gzip and
  brotli, but the upstream's length still describes the *compressed* size.
  Forwarding it makes the client wait for bytes that never arrive.
- **Streaming is never buffered.** Buffering would deliver SSE all at once at
  the end and push long responses into function timeouts.
- **Two timeouts, not one.** `REQUEST_TIMEOUT_MS` bounds time-to-first-byte;
  `STREAM_IDLE_TIMEOUT_MS` bounds the gap *between* bytes. One shared deadline
  would guillotine every stream that legitimately runs for minutes.
- **Redirects are followed manually.** Each hop is re-validated by the SSRF
  guard, so a public URL cannot `30x` its way to `169.254.169.254`.
- **Absolute-form is detected at the HTTP layer.** A Web `Request`'s `url` is
  always absolute, so testing it would classify every path request as
  absolute-form and point the bridge at itself. The adapter reads the raw request
  line; the core never guesses.

---

## Tests

```bash
npm test
```

108 tests, no network required: config parsing, SSRF
(including IPv6 textual equivalence and DNS-resolved private targets), header
sanitization, the four URL shapes, adapter seams, the byte counters and speed
window, runtime portability (the core runs with no Node `process` global), the
CONNECT tunnel (bytes round-trip, blocked targets refused), optional bridge
authentication, and end-to-end bridge behaviour against a real upstream —
gzip integrity, incremental SSE delivery, stream idle cutoff, redirect bounds,
failover, and large-body pass-through.

---

## License

MIT
