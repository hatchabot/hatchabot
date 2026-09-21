import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePublicUrl } from '../src/ops/tailnet.js';

/**
 * Writing the public address into .env. It is the operator's file: the rules
 * are replace a placeholder, never clobber a real choice, and never leave it
 * half-written.
 */
const env = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-env-'));
  const p = join(dir, '.env');
  writeFileSync(p, body, { mode: 0o600 });
  return p;
};
const URL_ = 'https://macbook.tail1329ea.ts.net';

describe('writing HATCHABOT_PUBLIC_URL', () => {
  it('appends when there is no line, keeping everything else', async () => {
    const p = env('HATCHABOT_SECRET_KEY=abc\nPORT=8080\n');
    const out = await writePublicUrl(p, URL_);
    expect(out).toMatchObject({ ok: true, replaced: false });
    const body = readFileSync(p, 'utf8');
    expect(body).toContain('HATCHABOT_SECRET_KEY=abc');
    expect(body).toContain(`HATCHABOT_PUBLIC_URL=${URL_}`);
    expect(statSync(p).mode & 0o777).toBe(0o600); // still not world-readable
  });

  it('replaces the commented placeholder setup-host.sh writes', async () => {
    const p = env('PORT=8080\n# HATCHABOT_PUBLIC_URL=http://<this-machine>.<tailnet>.ts.net:8080\n');
    const out = await writePublicUrl(p, URL_);
    expect(out).toMatchObject({ ok: true, replaced: true });
    const body = readFileSync(p, 'utf8');
    expect(body).toContain(`HATCHABOT_PUBLIC_URL=${URL_}`);
    expect(body).not.toContain('<this-machine>');
  });

  it('replaces a localhost value, which was never a public address', async () => {
    const p = env('HATCHABOT_PUBLIC_URL=http://localhost:8080\n');
    expect(await writePublicUrl(p, URL_)).toMatchObject({ ok: true, replaced: true });
    expect(readFileSync(p, 'utf8')).toContain(`HATCHABOT_PUBLIC_URL=${URL_}`);
  });

  it('refuses to overwrite an address somebody chose', async () => {
    const p = env('HATCHABOT_PUBLIC_URL=https://hatchabot.example.com\n');
    const out = await writePublicUrl(p, URL_);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('hatchabot.example.com');
    expect(readFileSync(p, 'utf8')).toContain('hatchabot.example.com'); // untouched
  });

  it('refuses a url that is not one, and says when there is no .env', async () => {
    const p = env('PORT=8080\n');
    expect((await writePublicUrl(p, 'http://localhost:8080')).ok).toBe(false);
    expect((await writePublicUrl(join(p, 'nope'), URL_)).ok).toBe(false);
  });
});
