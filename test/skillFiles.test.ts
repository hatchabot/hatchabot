import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CURATED_SKILLS } from '../src/openclaw/skills.js';
import { MAX_SKILL_FILE_BYTES, mutateSkillFile, readSkillFile, SkillFileError, skillFileScript, type SkillFileContext } from '../src/orchestrator/skills/skillFiles.js';
import type { ExecResult } from '../src/providers/provider.js';

const ID = 'hatchabot-writing';
const catalog = () => CURATED_SKILLS.find(({ id }) => id === ID)!;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function world(content?: string) {
  const home = mkdtempSync(join(tmpdir(), 'hb-skill-files-')); dirs.push(home);
  const bin = join(home, 'bin'), workspace = join(home, '.openclaw/agents/garden-notes/agent');
  const skillDir = join(workspace, 'skills', ID), path = join(skillDir, 'SKILL.md');
  const historyDir = join(workspace, '.hatchabot-skills'), historyPath = join(historyDir, `${ID}.json`);
  mkdirSync(bin); symlinkSync(process.execPath, join(bin, 'node'));
  mkdirSync(workspace, { recursive: true });
  if (content !== undefined) { mkdirSync(skillDir, { recursive: true }); writeFileSync(path, content); }
  const calls: Array<{ via: string; options: unknown }> = [];
  let transform: ((script: string) => string) | undefined;
  const execute = async (script: string): Promise<ExecResult> => {
    const isolated = script.replace("const root = '/home/node';", `const root = ${JSON.stringify(home)};`);
    const result = spawnSync('/bin/sh', [], { input: transform?.(isolated) ?? isolated, cwd: home,
      env: { HOME: home, PATH: bin, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' },
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const provider = {
    async execShell(_ref: string, script: string, options?: unknown) { calls.push({ via: 'runtime', options }); return execute(script); },
    async execShellOnVolume(_ref: string, script: string, options?: unknown) { calls.push({ via: 'volume', options }); return execute(script); },
  };
  const context: SkillFileContext = { runtimeRef: 'fixture://garden-notes', slug: 'garden-notes' };
  const read = () => readSkillFile(provider, context, ID);
  const change = async (action: 'update' | 'replace' | 'rollback', revision?: string) =>
    mutateSkillFile(provider, context, ID, { action, expectedRevision: revision ?? (await read()).revision });
  const metadata = (base: { hash: string | null; version: string | null }, history: unknown[] = []) => {
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(historyPath, JSON.stringify({ format: 1, id: ID, base, history }));
  };
  return { home, workspace, skillDir, path, historyDir, historyPath, provider, context, calls, read, change, metadata,
    transform(fn: (script: string) => string) { transform = fn; } };
}

describe('skill previews and guarded catalog updates on isolated real files', () => {
  it('previews absent instructions without creating a directory, even on a stopped volume', async () => {
    const w = world(); w.context.onVolume = true; w.context.image = 'fixture-image';
    expect(await w.read()).toMatchObject({ id: ID, state: 'missing', installed: { content: null, hash: null, version: null },
      canUpdate: true, canReplace: true, canRollback: false, history: [], catalog: { version: catalog().version, content: catalog().content, hash: sha(catalog().content) } });
    expect(readdirSync(w.workspace)).toEqual([]);
    expect(w.calls).toEqual([{ via: 'volume', options: { readOnly: true, image: 'fixture-image' } }]);
  });

  it('recognizes a legacy seed by exact catalog bytes without inventing metadata', async () => {
    const w = world(catalog().content);
    expect(await w.read()).toMatchObject({ state: 'current', canUpdate: false, canReplace: false, canRollback: false,
      installed: { content: catalog().content, version: catalog().version } });
    expect(existsSync(w.historyDir)).toBe(false);
    const before = await w.read(); expect(await w.change('update', before.revision)).toEqual(before);
    expect(existsSync(w.historyDir)).toBe(false);
  });

  it('installs missing instructions explicitly, preserves a backup, and rolls back to absence', async () => {
    const w = world(); w.context.onVolume = true;
    const installed = await w.change('update');
    expect(installed).toMatchObject({ state: 'current', canRollback: true, history: [{ hash: null, version: null }] });
    expect(readFileSync(w.path, 'utf8')).toBe(catalog().content);
    expect(statSync(w.historyPath).mode & 0o777).toBe(0o600);
    expect(statSync(w.path).mode & 0o777).toBe(0o600);
    expect(w.calls.at(-1)).toMatchObject({ via: 'volume', options: { readOnly: false } });
    const absent = await w.change('rollback', installed.revision);
    expect(absent).toMatchObject({ state: 'missing', canRollback: true, history: [{ hash: sha(catalog().content), version: catalog().version }] });
    expect(existsSync(w.path)).toBe(false);
    expect((await w.change('rollback', absent.revision)).state).toBe('current');
    expect(readFileSync(w.path, 'utf8')).toBe(catalog().content);
  });

  it('preserves untracked customization until an explicit replacement, then restores it exactly', async () => {
    const text = '\ufeff# Garden Notes\r\nKeep my words, λ, quotes \'" and `$(private)` intact.\r\n';
    const w = world(text), before = await w.read();
    expect(before).toMatchObject({ state: 'untracked', installed: { content: text, hash: sha(text), version: null }, canUpdate: false, canReplace: true });
    await expect(w.change('update', before.revision)).rejects.toMatchObject({ code: 'customized' });
    expect(readFileSync(w.path, 'utf8')).toBe(text); expect(existsSync(w.historyDir)).toBe(false);
    const next = await w.change('replace', before.revision);
    expect(next.history).toHaveLength(1);
    expect(next.history[0]).toEqual({ hash: sha(text), version: null, at: expect.any(String) });
    expect(JSON.stringify(next.history)).not.toContain('Keep my words');
    await w.change('rollback', next.revision);
    expect(readFileSync(w.path, 'utf8')).toBe(text);
  });

  it('keeps restored custom instructions protected from an ordinary catalog update', async () => {
    const original = '# Keep my local writing guidance\n', w = world(original);
    const replaced = await w.change('replace');
    const restored = await w.change('rollback', replaced.revision);
    expect(restored).toMatchObject({ state: 'customized', installed: { content: original, version: null }, canUpdate: false, canReplace: true });
    await expect(w.change('update', restored.revision)).rejects.toMatchObject({ code: 'customized' });
    expect(readFileSync(w.path, 'utf8')).toBe(original);
  });

  it('updates an unchanged tracked older release and retains its version on rollback', async () => {
    const old = '# Previous reviewed content\n', w = world(old);
    w.metadata({ hash: sha(old), version: '0.9.0' });
    const before = await w.read(); expect(before).toMatchObject({ state: 'update_available', canUpdate: true, installed: { version: '0.9.0' } });
    const current = await w.change('update', before.revision);
    expect(current).toMatchObject({ state: 'current', history: [{ hash: sha(old), version: '0.9.0' }] });
    const restored = await w.change('rollback', current.revision);
    expect(restored).toMatchObject({ state: 'update_available', installed: { version: '0.9.0', content: old } });
  });

  it('marks edits of a tracked release as customized and refuses an ordinary update', async () => {
    const w = world('# Local edits\n'); w.metadata({ hash: sha('# Old catalog\n'), version: '0.9.0' });
    const before = await w.read();
    expect(before).toMatchObject({ state: 'customized', installed: { version: null }, canUpdate: false });
    await expect(w.change('update', before.revision)).rejects.toMatchObject({ code: 'customized' });
    expect(readFileSync(w.path, 'utf8')).toBe('# Local edits\n');
  });

  it.each(['file', 'history', 'catalog'] as const)('refuses a preview made before the %s changed', async (kind) => {
    const w = world('local instructions'), before = await w.read();
    if (kind === 'file') writeFileSync(w.path, 'new local instructions');
    if (kind === 'history') w.metadata({ hash: sha('local instructions'), version: null });
    if (kind === 'catalog') w.transform((script) => {
      const [line, ...rest] = script.split('\n');
      const encoded = /^node - '([^']+)'/.exec(line!)![1]!;
      const input = JSON.parse(Buffer.from(encoded, 'base64').toString()); input.catalog.version = '1.0.1';
      return line!.replace(encoded, Buffer.from(JSON.stringify(input)).toString('base64')) + '\n' + rest.join('\n');
    });
    await expect(w.change('replace', before.revision)).rejects.toMatchObject({ code: 'conflict' });
    expect(readFileSync(w.path, 'utf8')).toBe(kind === 'file' ? 'new local instructions' : 'local instructions');
  });

  it('retains only five previous copies after repeated explicit replacements', async () => {
    const w = world('local zero');
    for (let i = 0; i < 7; i++) { writeFileSync(w.path, `local ${i}`); await w.change('replace'); }
    const view = await w.read(), stored = JSON.parse(readFileSync(w.historyPath, 'utf8'));
    expect(view.history).toHaveLength(5); expect(stored.history.map((entry: { content: string }) => entry.content)).toEqual(['local 6', 'local 5', 'local 4', 'local 3', 'local 2']);
    expect(readdirSync(w.historyDir)).toEqual([`${ID}.json`]);
  });

  it.each(['\\', '\u0001'])('keeps maximum-size escaped backups readable through the full history limit: %j', async (escaped) => {
    const w = world();
    for (let i = 0; i < 5; i++) {
      const content = `${i}` + escaped.repeat(MAX_SKILL_FILE_BYTES - 1);
      mkdirSync(w.skillDir, { recursive: true }); writeFileSync(w.path, content);
      const updated = await w.change('replace');
      expect(updated.state).toBe('current');
      expect(updated.history).toHaveLength(i + 1);
    }
    const restored = await w.change('rollback');
    expect(restored.installed.content).toBe('4' + escaped.repeat(MAX_SKILL_FILE_BYTES - 1));
    expect((await w.read()).history).toHaveLength(5);
  });

  it('preserves recovery evidence when the final file replacement fails', async () => {
    const w = world('local original');
    w.transform((script) => script.replace("atomic(skill, 'SKILL.md', target.content);", "throw new Error('injected disk failure');"));
    await expect(w.change('replace')).rejects.toMatchObject({ code: 'unavailable' });
    expect(readFileSync(w.path, 'utf8')).toBe('local original');
    expect(JSON.parse(readFileSync(w.historyPath, 'utf8')).history[0].content).toBe('local original');
    expect(readdirSync(w.historyDir)).toEqual([`${ID}.json`]);
    w.transform((script) => script);
    expect(await w.read()).toMatchObject({ canRollback: true, installed: { version: null } });
    expect((await w.change('rollback')).installed.content).toBe('local original');
  });

  it.each([null, '0.9.0'])('does not evict distinct backups when a failed replacement is retried with unchanged content/version %j', async (version) => {
    const w = world('local original');
    const older = Array.from({ length: 4 }, (_, i) => ({ content: `older ${i}`, hash: sha(`older ${i}`), version: null, at: '2026-11-01T00:00:00.000Z' }));
    w.metadata({ hash: sha(version ? 'local original' : 'catalog baseline'), version: '0.9.0' }, older);
    w.transform((script) => script.replace("atomic(skill, 'SKILL.md', target.content);", "throw new Error('injected replacement failure');"));
    for (let i = 0; i < 6; i++) await expect(w.change('replace')).rejects.toMatchObject({ code: 'unavailable' });
    const stored = JSON.parse(readFileSync(w.historyPath, 'utf8'));
    expect(stored.history.map((entry: { content: string }) => entry.content)).toEqual(['local original', ...older.map((entry) => entry.content)]);
    expect(stored.history[0].version).toBe(version);
    expect(readFileSync(w.path, 'utf8')).toBe('local original');
  });

  it('does not overwrite an external edit made after recording the backup', async () => {
    const w = world('original');
    w.transform((script) => script.replace("if (file(skill, 'SKILL.md', MAX) !== before.content)", "fs.writeFileSync(pathAt(skill, 'SKILL.md'), 'changed concurrently'); if (file(skill, 'SKILL.md', MAX) !== before.content)"));
    await expect(w.change('replace')).rejects.toMatchObject({ code: 'conflict' });
    expect(readFileSync(w.path, 'utf8')).toBe('changed concurrently');
    expect(JSON.parse(readFileSync(w.historyPath, 'utf8')).history[0].content).toBe('original');
  });

  it('does not overwrite a new file that appeared inside a previously missing directory', async () => {
    const w = world();
    w.transform((script) => script.replace("skill ??= directory(skills, input.id, true);", "skill ??= directory(skills, input.id, true); fs.writeFileSync(pathAt(skill, 'SKILL.md'), 'created concurrently');"));
    await expect(w.change('update')).rejects.toMatchObject({ code: 'conflict' });
    expect(readFileSync(w.path, 'utf8')).toBe('created concurrently');
  });

  it.each([
    { where: 'skill', late: false }, { where: 'workspace', late: false },
    { where: 'skill', late: true }, { where: 'workspace', late: true },
  ])('refuses a renamed $where directory instead of writing detached files (late=$late)', async ({ where, late }) => {
    const w = world('original instructions'), before = await w.read();
    const swap = `
      const originalDir = ${where === 'skill' ? "pathAt(skills, input.id)" : "root + '/.openclaw/agents/' + input.slug + '/agent'"};
      fs.renameSync(originalDir, originalDir + '-moved');
      fs.mkdirSync(originalDir, {recursive:true});
      const replacementDir = ${where === 'skill' ? 'originalDir' : "originalDir + '/skills/' + input.id"};
      fs.mkdirSync(replacementDir, {recursive:true});
      fs.writeFileSync(replacementDir + '/SKILL.md', 'replacement instructions');
    `;
    const marker = late ? "atomic(skill, 'SKILL.md', target.content);" : 'let before = get();';
    w.transform((script) => script.replace(marker, swap + marker));
    await expect(w.change('replace', before.revision)).rejects.toMatchObject({ code: 'conflict' });
    expect(readFileSync(w.path, 'utf8')).toBe('replacement instructions');
    const moved = where === 'skill' ? `${w.skillDir}-moved/SKILL.md` : `${w.workspace}-moved/skills/${ID}/SKILL.md`;
    expect(readFileSync(moved, 'utf8')).toBe('original instructions');
    if (!late) expect(existsSync(w.historyPath)).toBe(false);
  });
});

describe('unsafe paths, malformed history and failed providers', () => {
  it.each(['workspace', 'skills', 'skill', 'file', 'history', 'metadata'] as const)('refuses a symlink at %s without reading or modifying its target', async (where) => {
    const w = world('safe'), outside = join(w.home, 'outside'); mkdirSync(outside);
    const secret = join(outside, 'private'); writeFileSync(secret, 'do not expose');
    const paths = { workspace: w.workspace, skills: join(w.workspace, 'skills'), skill: w.skillDir, file: w.path, history: w.historyDir, metadata: w.historyPath };
    if (where === 'metadata') mkdirSync(w.historyDir);
    rmSync(paths[where], { recursive: true, force: true });
    symlinkSync(['file', 'metadata'].includes(where) ? secret : outside, paths[where]);
    await expect(w.read()).rejects.toMatchObject({ code: 'unsafe' });
    expect(readFileSync(secret, 'utf8')).toBe('do not expose'); expect(readdirSync(outside)).toEqual(['private']);
  });

  it('refuses hardlinks and non-text bytes without returning partial content', async () => {
    const w = world('private'); linkSync(w.path, join(w.home, 'hardlink'));
    await expect(w.read()).rejects.toMatchObject({ code: 'unsafe' });
    rmSync(join(w.home, 'hardlink')); writeFileSync(w.path, Buffer.from([0xff]));
    await expect(w.read()).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('refuses oversized current files before creating history', async () => {
    const w = world('x'.repeat(MAX_SKILL_FILE_BYTES + 1));
    await expect(w.read()).rejects.toMatchObject({ code: 'too_large' }); expect(existsSync(w.historyDir)).toBe(false);
  });

  it.each(['invalid JSON', 'wrong ID', 'bad backup hash', 'unknown format'] as const)('refuses %s history', async (kind) => {
    const w = world('keep'); w.metadata({ hash: sha('keep'), version: '1.0.0' });
    const meta = JSON.parse(readFileSync(w.historyPath, 'utf8'));
    if (kind === 'wrong ID') meta.id = 'other';
    if (kind === 'unknown format') meta.format = 2;
    if (kind === 'bad backup hash') meta.history = [{ content: 'backup', hash: sha('wrong'), version: null, at: new Date().toISOString() }];
    writeFileSync(w.historyPath, kind === 'invalid JSON' ? '{' : JSON.stringify(meta));
    await expect(w.read()).rejects.toMatchObject({ code: 'unsafe' }); expect(readFileSync(w.path, 'utf8')).toBe('keep');
  });

  it('refuses a held or abandoned lock without removing it', async () => {
    const w = world('keep'); mkdirSync(join(w.historyDir, `${ID}.lock`), { recursive: true });
    await expect(w.read()).rejects.toMatchObject({ code: 'conflict' });
    expect(lstatSync(join(w.historyDir, `${ID}.lock`)).isDirectory()).toBe(true);
  });

  it('refuses rollback without history and invalid actions before execution', async () => {
    const w = world(catalog().content);
    await expect(w.change('rollback')).rejects.toMatchObject({ code: 'no_history' });
    const count = w.calls.length;
    expect(() => skillFileScript(w.context, '../gog', 'read')).toThrow(SkillFileError);
    expect(() => skillFileScript({ ...w.context, slug: '../other' }, ID, 'read')).toThrow(SkillFileError);
    expect(() => skillFileScript(w.context, ID, 'replace', 'not-a-revision')).toThrow(SkillFileError);
    expect(w.calls).toHaveLength(count);
  });

  it.each([
    { code: 1, stdout: '', stderr: 'private raw failure' },
    { code: 0, stdout: '{"id":"hatchabot-writing"}', stderr: '' },
    { code: 0, stdout: 'invalid JSON', stderr: '' },
    { code: 0, stdout: '{}', stderr: '', timedOut: true },
  ])('returns a safe failure for malformed or incomplete execution %#', async (result) => {
    const w = world(); w.provider.execShell = async () => result;
    await expect(w.read()).rejects.toMatchObject({ code: 'unavailable', userMessage: expect.not.stringContaining('private') });
  });

  it('distinguishes a missing volume and preserves provider exceptions as safe failures', async () => {
    const w = world(); w.provider.execShell = async () => ({ code: 1, stdout: '', stderr: '', volumeMissing: true });
    await expect(w.read()).rejects.toMatchObject({ code: 'volume_missing' });
    w.provider.execShell = async () => { throw new Error('private provider path'); };
    await expect(w.read()).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('a lock left by an operation that was cut off (HB-0958)', () => {
  const lockOf = (w: ReturnType<typeof world>) => join(w.historyDir, `${ID}.lock`);
  const boot = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const startOf = (pid: number) => { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; };
  const leave = (w: ReturnType<typeof world>, owner?: unknown, minutesAgo = 0) => {
    mkdirSync(lockOf(w), { recursive: true });
    if (owner !== undefined) writeFileSync(join(lockOf(w), 'owner'), JSON.stringify(owner));
    const at = new Date(Date.now() - minutesAgo * 60_000);
    utimesSync(lockOf(w), at, at);
  };
  const asides = (w: ReturnType<typeof world>) => readdirSync(w.historyDir).filter((n) => n.includes('.lock'));

  it('a change killed while it holds the lock does not refuse the next preview or change', async () => {
    const w = world('original instructions'), before = await w.read();
    w.transform((script) => script.replace("      before = get();\n      if (before.revision", "      process.kill(process.pid, 'SIGKILL');\n      before = get();\n      if (before.revision"));
    await expect(w.change('replace', before.revision)).rejects.toMatchObject({ code: 'unavailable' });
    expect(lstatSync(lockOf(w)).isDirectory()).toBe(true);
    w.transform((script) => script);
    const again = await w.read();
    expect(again).toMatchObject({ state: 'untracked', installed: { content: 'original instructions' } });
    w.context.onVolume = true;
    expect((await w.read()).revision).toBe(again.revision);
    w.context.onVolume = false;
    expect(await w.change('replace', again.revision)).toMatchObject({ state: 'current', canRollback: true });
    expect(asides(w)).toEqual([]);
    expect(await w.change('rollback')).toMatchObject({ installed: { content: 'original instructions' } });
    expect(asides(w)).toEqual([]);
  });

  it.each([
    { kind: 'with no owner file', owner: undefined },
    { kind: 'from another pid namespace', owner: () => ({ boot: boot(), ns: 'pid:[4000000001]', pid: 1, start: '1' }) },
  ])('a lock $kind stands for its lease, then gives way', async ({ owner }) => {
    const w = world('keep');
    leave(w, typeof owner === 'function' ? owner() : owner);
    await expect(w.read()).rejects.toMatchObject({ code: 'conflict' });
    await expect(w.change('replace', sha('x'.repeat(64)).slice(0, 64))).rejects.toMatchObject({ code: 'conflict' });
    expect(existsSync(lockOf(w))).toBe(true);
    const at = new Date(Date.now() - 3 * 60_000); utimesSync(lockOf(w), at, at);
    w.context.onVolume = true;
    const seen = await w.read();
    expect(seen).toMatchObject({ state: 'untracked', installed: { content: 'keep' } });
    expect(existsSync(lockOf(w))).toBe(true);
    w.context.onVolume = false;
    expect(await w.change('replace', seen.revision)).toMatchObject({ state: 'current' });
    expect(asides(w)).toEqual([]);
  });

  it('a lock from before the machine restarted gives way at once', async () => {
    const w = world('keep');
    leave(w, { boot: 'a-boot-before-this-one', ns: readlinkSync('/proc/self/ns/pid'), pid: process.pid, start: startOf(process.pid) });
    expect(await w.change('replace')).toMatchObject({ state: 'current' });
    expect(asides(w)).toEqual([]);
  });

  it('a lock whose process still runs stands, however old', async () => {
    const w = world('keep');
    leave(w, { boot: boot(), ns: readlinkSync('/proc/self/ns/pid'), pid: process.pid, start: startOf(process.pid) }, 60);
    await expect(w.read()).rejects.toMatchObject({ code: 'conflict' });
    expect(readFileSync(w.path, 'utf8')).toBe('keep');
    expect(existsSync(lockOf(w))).toBe(true);
  });

  it('an operation whose lock was taken from it writes nothing more, and leaves the other lock alone', async () => {
    const w = world('keep'), before = await w.read();
    const takeOver = "fs.renameSync(pathAt(history, input.id + '.lock'), pathAt(history, 'moved-lock')); fs.mkdirSync(pathAt(history, input.id + '.lock'));";
    w.transform((script) => script.replace('atomic(history, name, JSON.stringify(next));', takeOver + ' atomic(history, name, JSON.stringify(next));'));
    await expect(w.change('replace', before.revision)).rejects.toMatchObject({ code: 'conflict' });
    expect(existsSync(w.historyPath)).toBe(false);
    expect(readFileSync(w.path, 'utf8')).toBe('keep');
    expect(lstatSync(lockOf(w)).isDirectory()).toBe(true);
  });
});
