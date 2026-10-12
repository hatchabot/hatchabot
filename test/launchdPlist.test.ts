import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * The launchd jobs a macOS host runs (scripts/launchd-plist.sh, written by
 * setup-host.sh): a checkout path with XML or shell characters in it used to
 * be pasted in raw, so "Audit & Demo" made a file launchd could not read
 * (#227). Rendered and run here against a sandbox folder, never launchd.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Every <string> in the file, decoded — after checking nothing in it is raw markup. */
function strings(xml: string): string[] {
  // Outside the declarations, an & always starts an entity; text holds no < or >.
  const body = xml.slice(xml.indexOf('<plist'));
  expect(body.match(/&(?!(amp|lt|gt|quot|apos);)/g), body).toBeNull();
  const out: string[] = [];
  for (const m of body.matchAll(/<string>([^<]*)<\/string>/g)) out.push(decode(m[1]!));
  // Every element is a known one: nothing from the path opened a tag.
  for (const tag of body.matchAll(/<\/?([A-Za-z]+)/g)) expect(['plist', 'dict', 'key', 'string', 'array', 'true', 'integer']).toContain(tag[1]);
  return out;
}

describe('launchd jobs for a checkout path with & < > quotes, $ and spaces (#227)', () => {
  it('both jobs are well-formed, name the path exactly, and run in it', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-plist-')); dirs.push(root);
    const home = join(root, 'home'); mkdirSync(home);
    const repo = join(root, `Audit & Demo <"it's"> $HOME \`x\``, 'hatchabot');
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(repo, 'scripts'));
    writeFileSync(join(repo, '.env'), 'GREETING=hello\n');
    // Stand-ins for the jobs: they say where they run and what .env gave them.
    for (const f of [join(repo, 'node_modules', '.bin', 'tsx'), join(repo, 'scripts', 'backup-volumes.sh')]) {
      writeFileSync(f, '#!/bin/sh\nprintf "%s|%s" "$PWD" "$GREETING"\n', { mode: 0o755 });
    }
    const env = scriptEnv(home, '/usr/bin:/bin');
    const jobPath = `/opt/node & co/bin:/usr/bin:/bin`;
    for (const [kind, log] of [['service', 'server.log'], ['backup', 'backup.log']] as const) {
      const r = spawnSync('bash', [resolve('scripts/launchd-plist.sh'), kind, repo, jobPath], { encoding: 'utf8', env });
      expect(r.status, r.stderr).toBe(0);
      const s = strings(r.stdout);
      expect(s).toContain(`${repo}/data/${log}`);
      expect(s).toContain(jobPath);
      const args = s.slice(s.indexOf('/bin/bash'), s.indexOf('/bin/bash') + 5);
      expect(args[1]).toBe('-c');
      expect(args[4]).toBe(repo);
      // What launchd would run: bash -c <command> hatchabot <repo>.
      const ran = spawnSync('bash', ['-c', args[2]!, args[3]!, args[4]!], { encoding: 'utf8', env, cwd: root });
      expect(ran.stdout, ran.stderr).toBe(`${repo}|hello`);
      // install.sh and uninstall.sh read the install dir back out of it.
      const plist = join(root, `${kind}.plist`);
      writeFileSync(plist, r.stdout);
      for (const script of ['install.sh', 'scripts/uninstall.sh']) {
        const src = readFileSync(script, 'utf8');
        const fn = src.slice(src.indexOf('plist_dir() {'), src.indexOf('\n}\n', src.indexOf('plist_dir() {')) + 2);
        const read = spawnSync('bash', ['-c', `${fn}\nplist_dir "$1"`, '_', plist], { encoding: 'utf8', env });
        expect(read.stdout, script).toBe(repo);
      }
    }
  });

  it('a plist from before still reads back: `cd "<dir>"` baked into the command', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-plist-')); dirs.push(root);
    const plist = join(root, 'old.plist');
    writeFileSync(plist, '    <string>cd &quot;/Users/demo/hatchabot&quot; &amp;&amp; set -a &amp;&amp; . ./.env</string>\n');
    const src = readFileSync('scripts/uninstall.sh', 'utf8');
    const fn = src.slice(src.indexOf('plist_dir() {'), src.indexOf('\n}\n', src.indexOf('plist_dir() {')) + 2);
    expect(spawnSync('bash', ['-c', `${fn}\nplist_dir "$1"`, '_', plist], { encoding: 'utf8' }).stdout).toBe('/Users/demo/hatchabot');
    expect(readFileSync('install.sh', 'utf8')).toContain(fn);
  });
});
