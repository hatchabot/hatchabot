#!/usr/bin/env -S npx tsx
import { defaultDbPath } from '../src/envCompat.js'; // first import: aliases AGENTCLAW_* env on load
/**
 * Merge an owner who got listed as a "member" of their own agent back into
 * the owner seat.
 *
 * This happens on agents created before the pair-once feature: the owner's
 * first Telegram message wasn't linked to their owner seat, so approving it
 * minted a `member-<uuid>` row named from their Telegram profile — the same
 * person shown twice ("You" + their name). The fix in admitMember prevents new
 * ones; this repairs the existing ones.
 *
 * For each agent where the OWNER seat has no Telegram id, but a `user`-role
 * membership carries the owner's own Telegram id (known from any of their
 * agents), it binds that id to the owner seat and deletes the duplicate rows.
 * Access is preserved: the id stays in the allowlist, just under the owner
 * seat now (verify with a Rebuild if you want the on-volume config to match).
 *
 * Dry-run by default. Re-run with --apply to make the changes. Stop the
 * control plane first (systemctl --user stop hatchabot) so the DB isn't in use.
 *
 *   ./scripts/link-owner-telegram.ts            # show what would change
 *   ./scripts/link-owner-telegram.ts --apply    # do it
 */
import Database from 'better-sqlite3';

const dbPath = process.env.HATCHABOT_DB ?? defaultDbPath();
const apply = process.argv.includes('--apply');
const db = new Database(dbPath);

// The owner's Telegram id, from the newest active seat that carries one on ANY
// of their agents — the same rule the app uses (Store.knownChannelUserId).
const knownTg = (ownerId: string): string | undefined =>
  (
    db
      .prepare(
        `SELECT channel_user_id FROM memberships
         WHERE user_id = ? AND channel_user_id IS NOT NULL AND status = 'active'
         ORDER BY joined_at DESC LIMIT 1`,
      )
      .get(ownerId) as { channel_user_id: string } | undefined
  )?.channel_user_id;

const agents = db
  .prepare(`SELECT id, name, owner_id FROM agents WHERE state != 'DELETED'`)
  .all() as Array<{ id: string; name: string; owner_id: string }>;

type Fix = { agent: (typeof agents)[number]; tg: string; dupes: Array<{ user_id: string; display_name: string | null; status: string }> };
const fixes: Fix[] = [];

for (const a of agents) {
  const ownerSeat = db
    .prepare(`SELECT channel_user_id FROM memberships WHERE agent_id = ? AND user_id = ? AND role = 'owner'`)
    .get(a.id, a.owner_id) as { channel_user_id: string | null } | undefined;
  if (!ownerSeat) continue; // no owner seat (shouldn't happen)
  if (ownerSeat.channel_user_id) continue; // owner already linked here — healthy

  const tg = knownTg(a.owner_id);
  if (!tg) continue; // we don't know the owner's Telegram id — nothing to merge

  const dupes = db
    .prepare(`SELECT user_id, display_name, status FROM memberships WHERE agent_id = ? AND role = 'user' AND channel_user_id = ?`)
    .all(a.id, tg) as Fix['dupes'];
  if (!dupes.length) continue; // owner unbound here, but no self-member to merge

  fixes.push({ agent: a, tg, dupes });
}

if (!fixes.length) {
  console.log('No owner-listed-as-member splits found. Nothing to do.');
  process.exit(0);
}

console.log(`Found ${fixes.length} agent(s) where the owner is listed as a member of their own agent:\n`);
for (const f of fixes) {
  console.log(`  • ${f.agent.name}`);
  console.log(`      bind owner seat → Telegram ${f.tg}`);
  for (const d of f.dupes) console.log(`      remove member "${d.display_name ?? d.user_id}" (${d.status})`);
}

if (!apply) {
  console.log('\nDry run — nothing changed. Re-run with --apply to make these changes.');
  process.exit(0);
}

const run = db.transaction(() => {
  const now = new Date().toISOString();
  for (const f of fixes) {
    db.prepare(
      `UPDATE memberships SET channel_user_id = ?, joined_at = COALESCE(joined_at, ?)
       WHERE agent_id = ? AND user_id = ? AND role = 'owner'`,
    ).run(f.tg, now, f.agent.id, f.agent.owner_id);
    db.prepare(`DELETE FROM memberships WHERE agent_id = ? AND role = 'user' AND channel_user_id = ?`).run(f.agent.id, f.tg);
  }
});
run();

console.log(`\n✅ Applied to ${fixes.length} agent(s). The owner now holds the Telegram link; the duplicate member rows are gone.`);
console.log('Access is unchanged (the id stayed in the allowlist). Rebuild the agent(s) if you want the on-volume config regenerated.');
