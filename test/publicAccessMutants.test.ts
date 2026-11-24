import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * scripts/public-access-mutants.mjs refuses a malformed entry before it runs
 * anything (HB-0867 review). An entry whose tests were not a list of test
 * files ran `vitest run` naming none, the whole suite: "killed" by any
 * failure anywhere, or by the time limit, whatever its guard did.
 *
 * Run on a copy of the script in a temp folder whose src/, test/ and web/ are
 * this tree's (no docs/: a run that went past the check would stop at its
 * copy), with a temp HOME and only node on the PATH.
 */
const REPO = resolve(import.meta.dirname, '..');
const SCRIPT = readFileSync(join(REPO, 'scripts', 'public-access-mutants.mjs'), 'utf8');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** `tests`: more files in test/ (made up, beside this tree's). */
function run(args: string[], change: (script: string) => string = (s) => s, tests: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'hb-mutant-check-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'home'));
  symlinkSync(join(REPO, 'src'), join(root, 'src'));
  if (!tests.length) symlinkSync(join(REPO, 'test'), join(root, 'test'));
  else {
    mkdirSync(join(root, 'test'));
    for (const f of readdirSync(join(REPO, 'test'))) symlinkSync(join(REPO, 'test', f), join(root, 'test', f));
    for (const f of tests) writeFileSync(join(root, 'test', f), '// made up\n');
  }
  symlinkSync(join(REPO, 'web'), join(root, 'web'));
  writeFileSync(join(root, 'scripts', 'public-access-mutants.mjs'), change(SCRIPT));
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'public-access-mutants.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { HOME: join(root, 'home'), PATH: dirname(process.execPath) },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Replaces text the script has exactly once. */
const once = (find: string, put: string) => (s: string) => {
  expect(s.split(find)).toHaveLength(2);
  return s.replace(find, put);
};

describe('the public-access mutant script\'s entries (HB-0867 review)', () => {
  it('are each well formed: --check says so, and runs nothing', () => {
    const r = run(['--check']);
    expect(r.out).toMatch(/^\d+ mutants, each well formed$/m);
    expect(r.status).toBe(0);
  });

  it('one whose tests are not a list of test files, or name a file that is not there, is refused before anything runs', () => {
    const broken = (s: string) => [
      // A stray field before the list (the slip that ran the whole suite).
      once(`"typeof raw === 'string' && raw", [TRUST]],`, `"typeof raw === 'string' && raw", '', [TRUST]],`),
      // An empty list.
      once(`"if (false) return reply.code(503)", [GATE]],`, `"if (false) return reply.code(503)", []],`),
      // A test file that is not there.
      once(`const CRASH = 'test/publicCrash.test.ts';`, `const CRASH = 'test/publicCrsh.test.ts';`),
    ].reduce((acc, f) => f(acc), s);
    for (const args of [['--check'], [], ['owner header']]) {
      const r = run(args, broken);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.out).toContain('✗ malformed: trust: the owner header works publicly: its tests are "", not a list of test files');
      expect(r.out).toContain('✗ malformed: gate: serves with a safeguard off: its tests are [], not a list of test files');
      expect(r.out).toMatch(/✗ malformed: crash: [^\n]*no test file "test\/publicCrsh\.test\.ts"/);
      expect(r.out).toMatch(/entries malformed: nothing was run \(update this script\)$/m);
      expect(r.out).not.toMatch(/killed|survived/);
    }
  });

  it('one whose text is not once in its file (part of a longer line, there twice, or not there), or that has no name, is refused; a test file may be .mjs or .tsx', () => {
    const broken = (s: string) => [
      // Part of the line above it, which has four spaces more: the run changed that line, not this one.
      once(`"        { challenge, origins: api.origins(), rpId, requireUserVerification: uvFor(ownerId) === 'required' },\\n      );\\n      if (store.secondFactorByCredential",`,
        `"        { challenge, origins: api.origins(), rpId, requireUserVerification: uvFor(ownerId) === 'required' },",`),
      // The end of two lines.
      once(`" && !hasOwnerRights(ownerId) && !!store?.ownsNothing(ownerId);",`, `" && !!store?.ownsNothing(ownerId);",`),
      once(`"    else await api.stopListener();",`, `"    else await api.stopListenr();",`),
      once(`['switch: invited-only can be turned off while on',`, `['',`),
      // Test files vitest runs too.
      once(`"if (pin && /^v[0-9]/.test(pin)) return", "if (false) return", [GUARDS]],`, `"if (pin && /^v[0-9]/.test(pin)) return", "if (false) return", [GUARDS, 'test/madeUpGuards.test.mjs', 'test/madeUpGuards.test.tsx']],`),
    ].reduce((acc, f) => f(acc), s);
    for (const args of [['--check'], []]) {
      const r = run(args, broken, ['madeUpGuards.test.mjs', 'madeUpGuards.test.tsx']);
      expect(r.status, args.join(' ')).toBe(2);
      // Was: each well formed.
      expect(r.out).toContain("✗ malformed: smaller: an owner's new passkey need not verify its user: its text is there 2 times, not once");
      expect(r.out).toContain('✗ malformed: guests: someone with an agent may accept an invitation without a factor: its text is there 2 times, not once');
      expect(r.out).toContain('✗ malformed: switch: off leaves the listener open: its text is not there');
      expect(r.out).toContain('✗ malformed: "": no name');
      expect(r.out).toMatch(/^4 of \d+ entries malformed: nothing was run \(update this script\)$/m);
      expect(r.out).not.toContain('madeUpGuards');
    }
  });
});
