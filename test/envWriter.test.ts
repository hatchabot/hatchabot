import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unsetEnvVar, writeEnvVar } from '../src/ops/tailnet.js';
import { activeValues, syncEnvFile } from '../src/config/envFile.js';

/** The app writes settings into .env (Settings → Hosts → Defaults, rebuild policy): the line in force is the one it changes. */
describe('writeEnvVar', () => {
  it('writes the last uncommented line (the one systemd reads), drops earlier live duplicates, leaves comments', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'hb-env-')), '.env');
    writeFileSync(f, ['# HATCHABOT_AGENT_MEMORY=3g', 'HATCHABOT_AGENT_MEMORY=2g', 'OTHER=1', 'HATCHABOT_AGENT_MEMORY=4g', ''].join('\n'));
    expect((await writeEnvVar(f, 'HATCHABOT_AGENT_MEMORY', '6g', () => true)).ok).toBe(true);
    const out = readFileSync(f, 'utf8').split('\n');
    expect(out.filter((l) => /^HATCHABOT_AGENT_MEMORY=/.test(l))).toEqual(['HATCHABOT_AGENT_MEMORY=6g']);
    expect(out).toContain('# HATCHABOT_AGENT_MEMORY=3g');
    expect(out).toContain('OTHER=1');
  });
  it('with only a commented example, fills that line in; with nothing, appends', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'hb-env-')), '.env');
    writeFileSync(f, '# HATCHABOT_EMBEDDER_MEMORY=2g\n');
    await writeEnvVar(f, 'HATCHABOT_EMBEDDER_MEMORY', '3g', () => true);
    expect(readFileSync(f, 'utf8')).toBe('HATCHABOT_EMBEDDER_MEMORY=3g\n');
    await writeEnvVar(f, 'HATCHABOT_FILES_MB_SLACK', '25', () => true, 'a note');
    expect(readFileSync(f, 'utf8')).toMatch(/# a note\nHATCHABOT_FILES_MB_SLACK=25\n/);
  });
  it('two settings saved at once both land, and no staging file is left behind (#160)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-env-'));
    const f = join(dir, '.env');
    writeFileSync(f, 'HATCHABOT_PORT=8080\nHATCHABOT_REBUILD_POLICY=ask\n');
    // A stale `.env.tmp` from an old release must not be renamed into place.
    writeFileSync(`${f}.tmp`, 'STALE=1\n');
    const results = await Promise.all([
      writeEnvVar(f, 'HATCHABOT_REBUILD_CONCURRENCY', '2', () => true),
      writeEnvVar(f, 'HATCHABOT_REBUILD_POLICY', 'auto', () => true),
      writeEnvVar(f, 'HATCHABOT_DRILL_EVERY', 'weekly', () => true),
      unsetEnvVar(f, 'HATCHABOT_PORT'),
      syncEnvFile(f),
    ]);
    expect(results.slice(0, 4).every((r) => (r as { ok: boolean }).ok)).toBe(true);
    const env = activeValues(readFileSync(f, 'utf8'));
    expect(env.get('HATCHABOT_REBUILD_CONCURRENCY')).toBe('2');
    expect(env.get('HATCHABOT_REBUILD_POLICY')).toBe('auto');
    expect(env.get('HATCHABOT_DRILL_EVERY')).toBe('weekly');
    expect(env.has('HATCHABOT_PORT')).toBe(false);
    expect(env.has('STALE')).toBe(false);
    expect(readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});
