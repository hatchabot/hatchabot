import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEnvVar } from '../src/ops/tailnet.js';

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
});
