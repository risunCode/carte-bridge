// Policy: where may a request reach?
//
// There is no authentication — the bridge is open for all callers, and an
// upstream's own Authorization header is passed through untouched. The only
// gate left is the SSRF guard, which answers one question: is this request
// allowed to reach its target at all?

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

// SSRF guard.
//
// Ported from 9router's src/shared/utils/ssrfGuard.js, which is the right shape
// for this problem: parse IPv6 into eight numeric groups FIRST, then reason
// about the value. Pattern-matching the source string instead is what makes
// guards miss "::ffff:7f00:1" while catching "::ffff:127.0.0.1" — the same
// address in two textual forms.
//
// Two layers:
//   1. assertPublicUrl          — literal hostname/IP checks, synchronous.
//   2. assertPublicUrlResolved  — adds DNS resolution, so a domain that merely
//                                 *resolves* to 127.0.0.1 (nip.io, sslip.io, or
//                                 an attacker's own A record) is rejected too.
//
// DNS needs node:dns, which does not exist in Vercel Edge or Deno. It is
// loaded through a dynamic import inside try/catch: if unavailable, layer 1
// stays active rather than the whole guard silently switching off.

import { forbidden } from './core.js';

const BLOCKED_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);
const BLOCKED_SUFFIXES = ['.internal', '.local', '.localhost', '.home.arpa'];

function ipv4ToInt(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

const BLOCKED_V4_RANGES = [
  [ipv4ToInt('0.0.0.0'), 8], // "this network"
  [ipv4ToInt('10.0.0.0'), 8], // private
  [ipv4ToInt('100.64.0.0'), 10], // CGNAT — also fronts some cloud metadata proxies
  [ipv4ToInt('127.0.0.0'), 8], // loopback
  [ipv4ToInt('169.254.0.0'), 16], // link-local, includes 169.254.169.254 metadata
  [ipv4ToInt('172.16.0.0'), 12], // private
  [ipv4ToInt('192.0.0.0'), 24], // IETF protocol assignments
  [ipv4ToInt('192.168.0.0'), 16], // private
  [ipv4ToInt('198.18.0.0'), 15], // benchmarking
  [ipv4ToInt('224.0.0.0'), 4], // multicast
  [ipv4ToInt('240.0.0.0'), 4], // reserved, includes 255.255.255.255
];

function isBlockedIpv4Int(ip) {
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

function isBlockedIpv4(host) {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return isBlockedIpv4Int(ip);
}

function parseHextets(s) {
  if (s === '') return [];
  const out = [];
  for (const seg of s.split(':')) {
    if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
    out.push(Number.parseInt(seg, 16));
  }
  return out;
}

// Any textual IPv6 form -> 8 numeric groups, or null if not a valid literal.
function parseIPv6ToGroups(rawHost) {
  let host = rawHost.toLowerCase();

  const v4Tail = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let v4Groups = null;
  if (v4Tail) {
    const v4Int = ipv4ToInt(v4Tail[1]);
    if (v4Int === null) return null;
    v4Groups = [(v4Int >>> 16) & 0xffff, v4Int & 0xffff];
    host = host.slice(0, host.length - v4Tail[1].length);
    if (!host.endsWith('::') && host.endsWith(':')) host = host.slice(0, -1);
  }

  const halves = host.split('::');
  if (halves.length > 2) return null;

  let groups;
  if (halves.length === 2) {
    const head = parseHextets(halves[0]);
    const tail = parseHextets(halves[1]);
    if (head === null || tail === null) return null;
    const v4Len = v4Groups ? v4Groups.length : 0;
    const missing = 8 - head.length - tail.length - v4Len;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail, ...(v4Groups || [])];
  } else {
    const all = parseHextets(host);
    if (all === null) return null;
    groups = [...all, ...(v4Groups || [])];
  }
  return groups.length === 8 ? groups : null;
}

function isBlockedIpv6Groups(g) {
  if (g.length !== 8) return false;
  const zero = (n) => g[n] === 0;
  const low32 = ((g[6] << 16) | g[7]) >>> 0;

  if ([0, 1, 2, 3, 4, 5, 6].every(zero) && g[7] === 1) return true; // ::1
  if (g.every((x) => x === 0)) return true; // ::
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  // IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96 both embed a real IPv4
  // address in the low 32 bits — check it against the same blocklist.
  if ([0, 1, 2, 3, 4].every(zero) && g[5] === 0xffff) return isBlockedIpv4Int(low32);
  if (g[0] === 0x0064 && g[1] === 0xff9b && [2, 3, 4, 5].every(zero)) return isBlockedIpv4Int(low32);
  // Deprecated IPv4-compatible ::a.b.c.d/96, excluding :: and ::1 handled above.
  if ([0, 1, 2, 3, 4, 5].every(zero) && low32 !== 0 && low32 !== 1) return isBlockedIpv4Int(low32);
  return false;
}

// A trailing dot marks an FQDN and is semantically insignificant, so
// "localhost." and "localhost" are the same host. Comparing the raw string
// would let the dotted form slip past every check.
function normalizeHost(hostname) {
  return String(hostname).toLowerCase().replace(/\.+$/, '');
}

function isLiteralAddress(host) {
  const bare = host.replace(/^\[|\]$/g, '');
  return ipv4ToInt(bare) !== null || bare.includes(':');
}

function isBlockedHost(host) {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (isBlockedIpv4(host)) return true;
  if (host.includes(':')) {
    const groups = parseIPv6ToGroups(host.replace(/^\[|\]$/g, ''));
    if (groups && isBlockedIpv6Groups(groups)) return true;
  }
  return false;
}

// Host allowlist. Empty list = allow anything (still subject to the SSRF
// guard). Entries match a host exactly, or match subdomains when written with
// a leading "*." — "*.example.com" allows "a.example.com" but not "example.com".
function hostAllowed(host, patterns) {
  if (!patterns.length) return true;
  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return host.endsWith(`.${suffix}`);
    }
    return host === pattern;
  });
}

let dnsPromise;
async function loadDns() {
  if (dnsPromise === undefined) {
    dnsPromise = import('node:dns')
      .then((m) => m.default ?? m)
      .catch(() => null);
  }
  return dnsPromise;
}

export function createGuard(config) {
  const { blockPrivate, allowedHosts } = config;

  function checkHost(hostname, url) {
    const host = normalizeHost(hostname);
    if (!hostAllowed(host, allowedHosts)) {
      throw forbidden('host_not_allowed', `Host not in allowlist: ${host}`);
    }
    if (blockPrivate && isBlockedHost(host)) {
      throw forbidden('blocked_host', `Blocked target: ${host} is a private or reserved address`);
    }
    return host;
  }

  return {
    // Literal checks only. Synchronous, so it can run before any await.
    assertLiteral(rawUrl) {
      const parsed = new URL(rawUrl);
      return checkHost(parsed.hostname, parsed);
    },

    // Literal checks plus DNS resolution. A resolution failure is not treated
    // as an SSRF signal — the fetch that follows will surface its own error.
    async assertResolved(rawUrl) {
      const parsed = new URL(rawUrl);
      const host = checkHost(parsed.hostname, parsed);
      if (!blockPrivate) return host;
      if (isLiteralAddress(host)) return host;

      const dns = await loadDns();
      if (!dns) return host; // edge runtime: literal checks only, guard stays on

      let addresses;
      try {
        addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
      } catch {
        return host;
      }
      for (const { address, family } of addresses) {
        const blocked =
          family === 4
            ? isBlockedIpv4(address)
            : isBlockedIpv6Groups(parseIPv6ToGroups(address) || []);
        if (blocked) {
          throw forbidden('blocked_host', `Blocked target: ${host} resolves to a private address`);
        }
      }
      return host;
    },
  };
}

export const __test = {
  ipv4ToInt,
  isBlockedIpv4,
  parseIPv6ToGroups,
  isBlockedIpv6Groups,
  isBlockedHost,
  normalizeHost,
  hostAllowed,
};
