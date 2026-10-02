// carte-bridge — foundation: typed errors, logging, configuration.
//
// These three were separate files; they are merged because every other module
// imports from them and none of them imports anything internal.

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

// Typed errors. Anything thrown inside the core that is not a BridgeError is
// treated as an internal fault and reported as a generic 500, so upstream
// error text never leaks to the client by accident.

export class BridgeError extends Error {
  constructor(status, code, message, { expose = true, headers = null, cause = null } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.expose = expose;
    this.headers = headers;
    if (cause) this.cause = cause;
  }
}

export const badRequest = (code, message) => new BridgeError(400, code, message);
export const forbidden = (code, message) => new BridgeError(403, code, message);
export const notFound = (code, message) => new BridgeError(404, code, message);
export const badGateway = (message, cause) => new BridgeError(502, 'upstream_unreachable', message, { cause });
export const gatewayTimeout = (message, cause) => new BridgeError(504, 'upstream_timeout', message, { cause });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

// Minimal leveled logger. Two formats: human-readable text for a terminal,
// one JSON object per line for a container platform that ingests stdout.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger({ level = 'info', format = 'text' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const json = format === 'json';

  const emit = (name, stream, message, fields) => {
    if (LEVELS[name] > threshold) return;
    if (json) {
      stream(JSON.stringify({ level: name, time: new Date().toISOString(), message, ...fields }));
      return;
    }
    const suffix = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
    stream(`[bridge] ${name.padEnd(5)} ${message}${suffix}`);
  };

  return {
    level,
    error: (message, fields) => emit('error', console.error, message, fields),
    warn: (message, fields) => emit('warn', console.error, message, fields),
    info: (message, fields) => emit('info', console.log, message, fields),
    debug: (message, fields) => emit('debug', console.log, message, fields),
  };
}

export const silentLogger = createLogger({ level: 'error' });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Configuration: environment -> frozen config object.
//
// Every value has a working default, so the bridge boots with an empty
// environment. Parsing never throws on malformed input: a bad ROUTES blob
// logs a warning and falls back to the default rather than refusing to start,
// because a bridge that won't boot is worse than one running with fewer routes.

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUTHY.has(String(value).trim().toLowerCase());
}

function int(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function list(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function jsonObject(value, fallback, onError, label) {
  if (!value) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    onError(`${label}: invalid JSON (${err.message}) — ignoring`);
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    onError(`${label}: expected a JSON object — ignoring`);
    return fallback;
  }
  return parsed;
}

// A route target must be a bare http(s) origin with no path, query or hash.
// A path here would silently swallow the caller's path and produce confusing
// 404s from upstream, so reject it loudly at boot instead.
function normalizeOrigin(raw) {
  if (typeof raw !== 'string') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin;
}

function normalizeRoutes(raw, onError) {
  const out = {};
  for (const [name, origin] of Object.entries(raw)) {
    const key = String(name).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
      onError(`ROUTES: skipping "${name}" — prefix must be [a-z0-9._-]`);
      continue;
    }
    const normalized = normalizeOrigin(origin);
    if (!normalized) {
      onError(`ROUTES: skipping "${name}" — target must be an origin like https://api.example.com`);
      continue;
    }
    out[key] = normalized;
  }
  return out;
}

function normalizeFallbacks(raw, routes, onError) {
  const out = {};
  for (const [name, origins] of Object.entries(raw)) {
    const key = String(name).trim().toLowerCase();
    if (!Array.isArray(origins)) {
      onError(`FALLBACKS: skipping "${name}" — expected an array of origins`);
      continue;
    }
    const normalized = origins.map(normalizeOrigin).filter(Boolean);
    if (normalized.length !== origins.length) {
      onError(`FALLBACKS: "${name}" — some entries were not valid origins and were dropped`);
    }
    if (normalized.length) out[key] = normalized;
  }
  return out;
}

// Accepted values for LOG_LEVEL. Named distinctly from the numeric LEVELS map
// in the logging section above, which ranks the same names differently.
const VALID_LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

// `process` is a Node global; Deno and other isolates do not have it. Reading
// it through globalThis keeps this module importable everywhere — a runtime
// without `process` simply gets an empty environment and the defaults apply.
// Entrypoints that do have a native env object pass it in explicitly.
export const environment = globalThis.process?.env ?? {};

export function loadConfig(env = environment, { onWarn = () => {} } = {}) {
  const routes = normalizeRoutes(jsonObject(env.ROUTES, {}, onWarn, 'ROUTES'), onWarn);
  const fallbacks = normalizeFallbacks(jsonObject(env.FALLBACKS, {}, onWarn, 'FALLBACKS'), routes, onWarn);

  const logLevelRaw = String(env.LOG_LEVEL || 'info').trim().toLowerCase();
  const logFormatRaw = String(env.LOG_FORMAT || 'text').trim().toLowerCase();

  return Object.freeze({
    port: int(env.PORT, 8080, { min: 1, max: 65535 }),
    host: env.HOST || '0.0.0.0',

    allowedHosts: list(env.ALLOWED_HOSTS),
    blockPrivate: bool(env.BLOCK_PRIVATE, true),
    routes,
    fallbacks,

    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 30000, { min: 1 }),
    // Max gap between bytes on a streaming response. Without a separate idle
    // budget, a single REQUEST_TIMEOUT_MS would guillotine every SSE stream
    // that legitimately runs for minutes.
    streamIdleTimeoutMs: int(env.STREAM_IDLE_TIMEOUT_MS, 60000, { min: 1 }),
    // SSE comment frames keep otherwise-quiet serverless connections alive
    // without changing the event payload delivered to the client.
    streamHeartbeatMs: int(env.STREAM_HEARTBEAT_MS, 15000, { min: 0 }),
    maxBufferBytes: int(env.MAX_BUFFER_BYTES, 1048576, { min: 0 }),
    maxRedirects: int(env.MAX_REDIRECTS, 5, { min: 0, max: 20 }),

    corsOrigin: env.CORS_ORIGIN || '',

    // Lookup service used by the status page to show the address upstream sees.
    // Empty disables the lookup, and the page says so instead of guessing.
    egressIpUrl: env.EGRESS_IP_URL ?? 'https://api.ipify.org',

    // Whether to believe X-Forwarded-For / X-Real-IP. Off by default: those
    // headers are caller-controlled unless something you own terminates the
    // connection in front of the bridge.
    trustProxy: bool(env.TRUST_PROXY, false),

    logLevel: VALID_LOG_LEVELS.includes(logLevelRaw) ? logLevelRaw : 'info',
    logFormat: logFormatRaw === 'json' ? 'json' : 'text',
  });
}
