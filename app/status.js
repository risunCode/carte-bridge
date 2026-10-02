// Status page: plain text, served as text/plain.
//
// Deliberately not HTML. A bridge host gets probed constantly, and a text page
// is honest about what this is, renders anywhere (curl, a browser, a terminal),
// and has no markup to sanitize. Every value is generated per request, so the
// page is never cached and never stale.

import { formatBytes, formatSpeed } from './stats.js';

export function renderStatus({ config, stats, clientIp, egressIp, egressError }) {
  const snap = stats.snapshot();
  const lines = [];

  lines.push('carte-bridge');
  lines.push('='.repeat(12));
  lines.push('');
  lines.push('currentIP:');
  lines.push(`  client   : ${clientIp || 'unknown'}`);
  if (egressError) {
    lines.push(`  egress   : unavailable (${egressError})`);
  } else if (egressIp) {
    lines.push(`  egress   : ${egressIp}`);
  } else {
    lines.push('  egress   : not configured (set EGRESS_IP_URL to enable)');
  }
  lines.push('');
  lines.push(`CurrentSpeed: ${formatSpeedLine(snap.bytesPerSecond)}`);
  lines.push(`Bandwidth served: ${formatBytes(snap.totalBytes)}`);
  lines.push('');
  lines.push(`  requests : ${snap.totalRequests}`);
  lines.push(`  uptime   : ${formatUptime(snap.uptimeSeconds)}`);
  lines.push(`  auth     : ${config.bridgeKey ? 'required' : 'open'}`);
  lines.push(`  ssrfGuard: ${config.blockPrivate ? 'enabled' : 'disabled'}`);
  lines.push(`  routes   : ${Object.keys(config.routes).join(', ') || 'none'}`);
  lines.push('');
  lines.push('-'.repeat(12));
  lines.push('Usage');
  lines.push('  GET /r/https://api.example.com/v1/foo');
  lines.push('  GET /r/<route>/v1/foo            (when ROUTES is set)');
  lines.push('  GET /?url=https%3A%2F%2Fapi.example.com%2Fv1%2Ffoo');
  lines.push('  GET http://api.example.com/v1/foo (absolute-form clients)');
  lines.push('');
  lines.push('Endpoints');
  lines.push('  /          this page');
  lines.push('  /healthz   liveness');
  lines.push('  /readyz    machine-readable state');
  lines.push('  /stats     machine-readable counters');
  lines.push('  /__bridge   usage as JSON');
  lines.push('');

  return lines.join('\n');
}

// "CurrentSpeed" needs both numbers: the rate in the unit a person expects
// (Mb/s, what an ISP quotes) and in the unit this bridge deals in (binary).
// The binary side adapts its unit — printing "0.00 MiB/s" for 4 KiB/s would be
// technically true and completely useless.
function formatSpeedLine(bytesPerSecond) {
  if (bytesPerSecond <= 0) return '0 Mb/s (idle)';
  return `${formatSpeed(bytesPerSecond)} (${formatBytes(bytesPerSecond)}/s)`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
