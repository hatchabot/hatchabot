import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CURATED_SKILLS } from '../src/openclaw/skills.js';
import { buildWorkspaceSeed } from '../src/openclaw/workspace.js';
import { mutateSkillFile, readSkillFile } from '../src/orchestrator/skillFiles.js';

const input = { agentName: 'Garden Notes', slug: 'garden-notes', persona: '', sharedMemory: true };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('initial catalog version baselines', () => {
  it('seeds a hash and version for each selected skill, including the legacy Google default', () => {
    for (const selection of [undefined, [], CURATED_SKILLS.map(({ id }) => id)]) {
      const files = buildWorkspaceSeed({ ...input, curatedSkills: selection });
      const selected = selection ?? ['gog'];
      expect(Object.keys(files).filter((name) => name.startsWith('.hatchabot-skills/'))).toHaveLength(selected.length);
      for (const id of selected) {
        const skill = CURATED_SKILLS.find((item) => item.id === id)!;
        expect(JSON.parse(files[`.hatchabot-skills/${id}.json`]!)).toEqual({ format: 1, id,
          base: { hash: sha(files[`skills/${id}/SKILL.md`]!), version: skill.version }, history: [] });
      }
    }
  });

  it('recognizes an untouched seeded version after a later catalog release and rolls it back exactly', async () => {
    const id = 'hatchabot-writing', skill = CURATED_SKILLS.find((item) => item.id === id)!;
    const old = { content: skill.content, version: skill.version };
    const home = mkdtempSync(join(tmpdir(), 'hb-skill-seed-')); dirs.push(home);
    const bin = join(home, 'bin'), workspace = join(home, '.openclaw/agents/garden-notes/agent');
    mkdirSync(bin); symlinkSync(process.execPath, join(bin, 'node'));
    const seed = buildWorkspaceSeed({ ...input, curatedSkills: [id] });
    for (const [name, content] of Object.entries(seed)) {
      const path = join(workspace, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
    }
    const execute = async (_ref: string, script: string) => {
      const result = spawnSync('/bin/sh', [], { input: script.replace("const root = '/home/node';", `const root = ${JSON.stringify(home)};`),
        cwd: home, env: { HOME: home, PATH: bin, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' },
        encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
      return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    const provider = { execShell: execute, execShellOnVolume: execute }, context = { runtimeRef: 'fixture://garden-notes', slug: 'garden-notes' };
    try {
      skill.version = '9.0.0'; skill.content = old.content + '\nA future reviewed instruction.\n';
      const before = await readSkillFile(provider, context, id);
      expect(before).toMatchObject({ state: 'update_available', canUpdate: true, installed: { version: old.version, content: old.content } });
      const changed = await mutateSkillFile(provider, context, id, { action: 'update', expectedRevision: before.revision });
      expect(changed).toMatchObject({ state: 'current', installed: { version: '9.0.0', content: skill.content } });
      const restored = await mutateSkillFile(provider, context, id, { action: 'rollback', expectedRevision: changed.revision });
      expect(restored).toMatchObject({ state: 'update_available', installed: { version: old.version, content: old.content } });
      expect(readFileSync(join(workspace, 'skills', id, 'SKILL.md'), 'utf8')).toBe(old.content);
    } finally { skill.version = old.version; skill.content = old.content; }
  });
});
