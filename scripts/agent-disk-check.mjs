#!/usr/bin/env node
// Read-only disk monitor: agent volume sizes vs the soft warn threshold.
// A hard per-container quota isn't available on overlay2+ext4, so this is the
// visibility that keeps a runaway volume from being a mystery "disk full".
// Complements the Security tab (which shows the threshold) and the daily sweep.
//   AGENTCLAW_AGENT_DISK_WARN_GB   per-agent warn threshold (default 10)
import { execSync } from 'node:child_process';

const warnGB = Number(process.env.AGENTCLAW_AGENT_DISK_WARN_GB) || 10;
const sh = (c) => { try { return execSync(c, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };

// `docker system df -v` reports each volume's size; parse the agentclaw ones.
const lines = sh('docker system df -v').split('\n');
const rows = [];
for (const l of lines) {
  const m = /^(agentclaw-\S+-vol)\s+\S+\s+([\d.]+)\s*([KMGT]?B)/.exec(l.trim());
  if (!m) continue;
  const [, name, num, unit] = m;
  const gb = Number(num) * ({ B: 1e-9, KB: 1e-6, MB: 1e-3, GB: 1, TB: 1e3 }[unit] ?? 0);
  rows.push({ name, gb });
}
rows.sort((a, b) => b.gb - a.gb);

if (!rows.length) { console.log('No agent volumes found (is Docker running / are you on the host?).'); process.exit(0); }
console.log(`Agent volume sizes — warn threshold ${warnGB} GB/agent:\n`);
let flagged = 0;
for (const r of rows) {
  const over = r.gb >= warnGB;
  if (over) flagged++;
  console.log(`  ${over ? '⚠' : '·'} ${r.name.padEnd(48)} ${r.gb.toFixed(2)} GB${over ? '  ← over threshold' : ''}`);
}
console.log(`\n${rows.length} volumes, ${flagged} over ${warnGB} GB. Total: ${rows.reduce((s, r) => s + r.gb, 0).toFixed(2)} GB.`);
process.exit(flagged ? 1 : 0);
