# carte-bridge

A stateless HTTP bridge. One codebase, deploys to **Railway**, **Vercel**,
**Netlify**, **Deno Deploy** or **Docker** — no build step, no dependencies, no
database.

It forwards a request to an upstream URL you name, streams the response back,
and gets out of the way.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Frisuncode%2Fcarte-bridge)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Frisuncode%2Fcarte-bridge)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/risuncode/carte-bridge)

> Replace `risuncode/carte-bridge` with your own repo path once you push.

---

## Quick start

```bash
node server.js
# [bridge] info  listening on 0.0.0.0:8080 {"auth":"open","ssrfGuard":"enabled"}
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
| Path prefix | `GET /r/https://api.example.com/v1/foo` |
| Named route | `GET /r/gh/repos/nodejs/node` (with `ROUTES` set) |
| Query param | `GET /?url=https%3A%2F%2Fapi.example.com%2Fv1%2Ffoo` |
| Absolute-form | `GET http://api.example.com/v1/foo` (proxy-style clients) |

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
| `/readyz` | What this instance will do: auth mode, SSRF state, routes |
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

**Open by default.** No key, no allowlist. Fine locally and on a private
network; on the public internet it means anyone who finds the URL can forward
traffic through it — your bandwidth, your domain's reputation.

Two protections are on regardless:

- **SSRF guard** (`BLOCK_PRIVATE=true`) refuses loopback, private, link-local,
  CGNAT, multicast and cloud-metadata addresses — including a *public hostname
  that resolves to one*. Without it, `169.254.169.254` and your internal network
  are one request away.
- **No spoofable client IP.** Forwarding headers from a caller are discarded and
  replaced with the real peer address.

### Locking it down

```bash
BRIDGE_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

Callers then present the key as `Authorization: Bearer <key>`,
`X-Bridge-Key: <key>`, or `?key=<key>` (the query form is for `<img>`/`<script>`,
which cannot set headers). Combine with an allowlist for a tighter setup:

```bash
BRIDGE_KEY=... ALLOWED_HOSTS='api.anthropic.com,*.example.com'
```

`*.example.com` matches subdomains but not the bare domain. Empty
`ALLOWED_HOSTS` means any public host.

> With `BRIDGE_KEY` set, an incoming `Authorization` header is treated as the
> bridge key and is not forwarded. If your upstream needs its own, send the bridge
> key via `X-Bridge-Key` or `?key=` so the upstream credential passes through.

---

## Configuration

Every variable is optional.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port (Docker / Railway / local) |
| `HOST` | `0.0.0.0` | Bind address |
| `BRIDGE_KEY` | *empty* | Empty = open. Set = required on every request |
| `ALLOWED_HOSTS` | *empty* | Comma-separated allowlist. Empty = any public host |
| `BLOCK_PRIVATE` | `true` | SSRF guard |
| `ROUTES` | *empty* | JSON map of prefix → origin |
| `FALLBACKS` | *empty* | JSON map of prefix → origins tried in order |
| `REQUEST_TIMEOUT_MS` | `30000` | Time to first byte from upstream |
| `STREAM_IDLE_TIMEOUT_MS` | `60000` | Max gap between bytes once streaming |
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

### Railway

Click the badge above, or: **New Project → Deploy from GitHub → pick this repo**.

Railway builds with the `Dockerfile` at the root — it uses one automatically
when it finds it, so no `railway.json` is needed (and config-as-code is
deprecated anyway). Railway injects `PORT`, which the bridge reads.

Plain HTTP is enough. Unlike a CONNECT tunnel, this bridge does **not** need a TCP
Proxy. Set `BRIDGE_KEY` in the service's **Variables** tab only if you want to
close it.

### Vercel

Click the badge above, or `vercel --prod`.

`vercel.json` rewrites every path to `api/index.js` on the Node.js runtime. Set
variables in **Project → Settings → Environment Variables**.

### Netlify

Click the badge above, or `netlify deploy --prod`.

`netlify.toml` points the functions directory at `netlify/` and sets the Node
runtime. It is **not** the Edge runtime on purpose: the SSRF guard needs
`node:dns` to catch a public hostname that resolves to a private address. On Edge
that layer would silently degrade to literal-only checks.

### Docker

```bash
docker build -t carte-bridge .
docker run -p 8080:8080 -e BRIDGE_KEY=yourkey carte-bridge
```

Or with Compose, reading the same variables from `.env`:

```bash
cp .env.example .env   # then edit
docker compose up -d
```

`node:22-alpine`, runs as the unprivileged `node` user, `HEALTHCHECK` on
`/healthz`. No volumes — the bridge holds no state.

### Deno Deploy

```bash
deno task start                       # local
deployctl deploy --project=carte-bridge deno/main.js
```

Or connect the repo in the Deno Deploy dashboard and set the entrypoint to
`deno/main.js`.

Deno is deny-by-default, so the process needs `--allow-net` (upstream fetch and
the egress IP lookup) and `--allow-env`. `deno.json` already sets both.

**One difference worth knowing:** Deno has no `node:dns`, so the SSRF guard runs
its literal layer only. `169.254.169.254`, `127.0.0.1` and the private ranges are
still refused, but a *public hostname that resolves to* a private address is not
caught. On Deno, set `ALLOWED_HOSTS` if the instance is public.

### What works where

| | Railway | Docker / VPS | Vercel | Netlify | Deno |
|---|---|---|---|---|---|
| HTTP bridge | ✅ | ✅ | ✅ | ✅ | ✅ |
| Streaming (SSE) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Unbounded request duration | ✅ | ✅ | ❌ ceiling | ❌ ceiling | ✅ |
| SSRF guard: literal IPs | ✅ | ✅ | ✅ | ✅ | ✅ |
| SSRF guard: DNS resolution | ✅ | ✅ | ✅ | ✅ | ❌ no `node:dns` |

Serverless functions have a wall-clock limit (`maxDuration`, set to 60s in
`vercel.json`). Streaming starts delivering immediately, but one request cannot
outlive that ceiling. Check the current limits for your plan.

---

## How it works

```
server.js              the only file at the root: starts the listener (Node)
app/
  bridge.js             typed errors, leveled logger, env -> frozen config
  policy.js            the two gates: who may call (auth), where it may reach (SSRF)
  forward.js           header sanitization + fetch, redirects, streaming, failover
  target.js            the four accepted URL shapes
  stats.js             byte counters, speed window, egress IP lookup
  status.js            renders the plain-text status page
  handler.js           the handler
  adapters.js          Node I/O translation
api/index.js           Vercel entrypoint
netlify/bridge.js       Netlify entrypoint
deno/main.js           Deno entrypoint
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

108 tests, no network required: config parsing, constant-time auth, SSRF
(including IPv6 textual equivalence and DNS-resolved private targets), header
sanitization, the four URL shapes, adapter seams, the byte counters and speed
window, runtime portability (the core runs with no Node `process` global), and
end-to-end bridge behaviour against a real upstream — gzip integrity,
incremental SSE delivery, stream idle cutoff, redirect bounds, failover, and
large-body pass-through.

---

## License

MIT
