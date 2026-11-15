import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_COMMANDS, fixtureShell, loadPinnedContract, PINNED_CONTRACT_FILES, runContractCell, seedFixtureShell } from '../scripts/skills-contract.js';

const homes: string[] = [];
function temporaryHome() { const home = mkdtempSync(join(tmpdir(), 'hb-skills-contract-test-')); homes.push(home); return home; }
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe('isolated skill contract fixture shell', () => {
  it.each(Object.entries(FIXTURE_COMMANDS))('executes %s against only its invented fixture', (command, fixture) => {
    const home = temporaryHome();
    seedFixtureShell(home);
    expect(fixtureShell(home, command)).toBe(fixture.output);
  });

  it('does not inherit the parent HOME, PATH, credentials, or git hooks', () => {
    const home = temporaryHome();
    seedFixtureShell(home);
    const prior = process.env.HB_FIXTURE_PARENT_VALUE;
    process.env.HB_FIXTURE_PARENT_VALUE = 'parent-only';
    try {
      writeFileSync(join(home, 'bin', 'gog'), '#!/bin/sh\nprintf \'%s\\n\' "$HOME" "$PATH" "${HB_FIXTURE_PARENT_VALUE-unset}" "$GIT_CONFIG_NOSYSTEM" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0"\n', { mode: 0o700 });
      expect(fixtureShell(home, 'gog auth list --json').split('\n'))
        .toEqual([home, join(home, 'bin'), 'unset', '1', 'core.hooksPath', '/dev/null']);
    } finally {
      if (prior === undefined) delete process.env.HB_FIXTURE_PARENT_VALUE;
      else process.env.HB_FIXTURE_PARENT_VALUE = prior;
    }
  });

  it('rejects arbitrary commands before launching a shell', () => {
    const home = temporaryHome();
    const sentinel = join(home, 'unchanged');
    writeFileSync(sentinel, 'keep');
    expect(() => fixtureShell(home, `printf changed > '${sentinel}'`)).toThrow('not a fixture');
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
  });

  it('preserves nonzero fixture failures instead of reporting successful execution', () => {
    const home = temporaryHome();
    seedFixtureShell(home);
    writeFileSync(join(home, 'bin', 'gog'), '#!/bin/sh\nprintf \'%s\\n\' \'fixture refused\' >&2\nexit 7\n', { mode: 0o700 });
    expect(() => fixtureShell(home, 'gog auth list --json')).toThrow('fixture refused');
  });
});

describe('pinned runtime contract admission', () => {
  it('refuses another runtime version before importing any source', () => {
    const source = temporaryHome();
    writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '2026.9.7' }));
    expect(() => loadPinnedContract(source, source)).toThrow('requires OpenClaw 2026.9.8');
  });

  it('requires every source byte to match the reviewed pin before execution', () => {
    const source = temporaryHome();
    writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '2026.9.8' }));
    for (const file of Object.keys(PINNED_CONTRACT_FILES)) {
      const path = join(source, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'throw new Error("must never execute this source");');
    }
    expect(() => loadPinnedContract(source, source)).toThrow('Pinned source differs');
  });
});

describe('the contract runner itself (synthetic controller, not upstream evidence)', () => {
  const controller = `
    const pending = new Map(); let serial = 0;
    globalThis.fixture = (input) => new Promise((resolve, reject) => {
      const id = String(++serial); pending.set(id, {resolve,reject});
      __openclawHostRequest('callValue', JSON.stringify(['fixture', input]), id);
    });
    globalThis.__openclawSettleBridge = (id, ok, json) => {
      const entry = pending.get(id); pending.delete(id); const value = JSON.parse(json);
      if (ok) entry.resolve(value); else entry.reject(new Error(value.message));
    };
    globalThis.__openclawDrainQueuedRequests = () => {};
    globalThis.__openclawRunCell = async (run) => JSON.stringify(await run());
  `;

  it('delivers ordered tool results back into the running program without replay', async () => {
    const calls: unknown[] = [];
    const result = await runContractCell(controller, 'const a = await fixture({n:1}); return await fixture({n:a+1});', [], (_method, args) => {
      calls.push(args); return (args[1] as { n: number }).n;
    });
    expect(result).toBe(2);
    expect(calls).toEqual([['fixture', { n: 1 }], ['fixture', { n: 2 }]]);
  });

  it('propagates a bridge refusal and never dispatches a later action', async () => {
    const calls: unknown[] = [];
    await expect(runContractCell(controller, 'await fixture({n:1}); return await fixture({n:2});', [], (_method, args) => {
      calls.push(args); throw new Error('fixture unavailable');
    })).rejects.toThrow('fixture unavailable');
    expect(calls).toEqual([['fixture', { n: 1 }]]);
  });

  it('does not expose host process, imports, or network APIs to a scripted cell', async () => {
    expect(await runContractCell(controller, 'return [typeof process, typeof require, typeof fetch];', [], () => null))
      .toEqual(['undefined', 'undefined', 'undefined']);
  });

  it('fails an unsettled fixture cell within the bounded dispatch loop', async () => {
    await expect(runContractCell(controller, 'return await new Promise(() => {});', [], () => null)).rejects.toThrow('did not settle');
  });

  it('reports malformed completion data without an unhandled promise rejection', async () => {
    await expect(runContractCell(controller + '\nglobalThis.__openclawRunCell = async () => "not JSON";', 'return 1;', [], () => null))
      .rejects.toThrow(/JSON/);
  });
});
