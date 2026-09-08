#!/usr/bin/env node
// Read-only health report for managed Google connections and the agents they're
// attached to. Cross-references the vault (DB) against each agent's container:
//   - is the gog wrapper installed (can it unlock headlessly)?
//   - is the materialized token STALE (older than the vault's last consent)?
//   - when was the token last materialized into the agent?
// No writes; docker exec is read-only inspection.
import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';

const db = new Database(process.env.AGENTCLAW_DB ?? 'data/agentclaw.sqlite', { readonly: true });
const sh = (cmd) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const days = (iso) => iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null;

// The container name ends in the first 8 chars of the agent id
// (agentclaw-<slug>-<idprefix>); the slug can be truncated, so match on the id.
const containers = sh("docker ps --format '{{.Names}}'").split('\n').filter(Boolean);
const containerFor = (agentId) => containers.find((c) => c.endsWith(`-${agentId.slice(0, 8)}`)) || null;
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');

const conns = db.prepare('SELECT id, email, services, created_at FROM connections ORDER BY email').all();

for (const c of conns) {
  const consentAge = days(c.created_at);
  const preRisk = c.created_at < '2026-09-07';   // issued before the app was published → 7-day Testing expiry
  console.log(`\n● ${c.email}`);
  console.log(`    services: ${JSON.parse(c.services).join(', ')}`);
  console.log(`    last consent: ${c.created_at.slice(0, 10)} (${consentAge}d ago)${preRisk ? '  ⚠ pre-publish token — reconnect before it expires' : '  ✓ post-publish'}`);

  const agents = db.prepare(
    `SELECT a.id, a.name, a.slug FROM agent_connections ac JOIN agents a ON a.id = ac.agent_id WHERE ac.connection_id = ? ORDER BY a.name`
  ).all(c.id);
  if (!agents.length) { console.log('    used by: (no agents attached)'); continue; }

  for (const a of agents) {
    const box = containerFor(a.id);
    if (!box) { console.log(`    → ${a.name}: container not running`); continue; }
    const wrapper = sh(`docker exec ${box} sh -lc 'test -x ~/.local/bin/gog && echo yes || echo no'`) === 'yes';
    // find the materialized token file for THIS email and its mtime
    const files = sh(`docker exec ${box} sh -lc 'ls /home/node/.openclaw/connections/gog/data/keyring/ 2>/dev/null'`).split('\n').filter(Boolean);
    let tokenMtime = null;
    for (const f of files) {
      const dec = b64(f.replace('_gogcli_key_v1_', ''));
      if (dec === `token:${c.email}` || dec === `token:default:${c.email}`) {
        const mt = sh(`docker exec ${box} sh -lc 'date -r /home/node/.openclaw/connections/gog/data/keyring/${f} -u +%Y-%m-%dT%H:%M:%SZ'`);
        tokenMtime = mt || null;
      }
    }
    const stale = tokenMtime && tokenMtime < c.created_at;
    const flags = [
      wrapper ? '✓ wrapper' : '✗ NO WRAPPER (will beg for password)',
      tokenMtime ? `materialized ${tokenMtime.slice(0, 10)}` : '✗ no token in container',
      tokenMtime ? (stale ? '⚠ STALE (older than last consent — re-attach)' : '✓ fresh') : '',
    ].filter(Boolean);
    console.log(`    → ${a.name.padEnd(24)} ${flags.join('  |  ')}`);
  }
}
db.close();
