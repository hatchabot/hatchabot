import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AgentBusyError, busyDone, busyWaiters, clearBusy, isBusy, markBusy, whileBusy } from '../src/orchestrator/lifecycle/busy.js';

/**
 * The busy flag knows its holder (HB-1385): the flags were a Set, so when
 * one operation let go of an agent, it let go of whoever held it then,
 * another operation that marked it meanwhile among them. Ids are made up.
 */

/** A promise held open until `release`, and one that says when it was reached. */
function gate() {
  let release!: () => void; let signal!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { signal = r; });
  return { held, reached, release, signal };
}
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

afterEach(() => { for (const id of ['kitchen', 'garden']) clearBusy(id); });

describe('the busy flag and its holder (HB-1385)', () => {
  it('a release lets go of its own mark only: one called late does not free the agent from the holder after it', async () => {
    const first = markBusy('kitchen');
    first();
    const g = gate();
    const holding = whileBusy('kitchen', async () => { g.signal(); await g.held; return 'done'; });
    await g.reached;
    let freed = false;
    void busyDone('kitchen').then(() => { freed = true; });
    first();                       // the first holder's finally, run a second time
    await ticks();
    expect(isBusy('kitchen')).toBe(true);
    expect(freed).toBe(false);
    expect(busyWaiters('kitchen')).toBe(1);
    // Taken by nobody else meanwhile.
    expect(() => markBusy('kitchen')).toThrow(AgentBusyError);
    await expect(whileBusy('kitchen', async () => 'second')).rejects.toBeInstanceOf(AgentBusyError);
    g.release();
    expect(await holding).toBe('done');
    await ticks();
    expect(freed).toBe(true);
    expect(isBusy('kitchen')).toBe(false);
  });

  it('a holder refused the agent lets go of nothing: the holder it ran into keeps it', async () => {
    const g = gate();
    const holding = whileBusy('kitchen', async () => { g.signal(); await g.held; });
    await g.reached;
    // A hand-paired holder that ran into it, refused, and whose finally runs anyway.
    let release: (() => void) | undefined;
    try { release = markBusy('kitchen'); } catch (err) { expect(err).toBeInstanceOf(AgentBusyError); }
    release?.();
    expect(release).toBeUndefined();
    expect(isBusy('kitchen')).toBe(true);
    g.release();
    await holding;
    expect(isBusy('kitchen')).toBe(false);
  });

  it('marks of two agents are two holders', () => {
    const kitchen = markBusy('kitchen');
    const garden = markBusy('garden');
    kitchen();
    kitchen();
    expect(isBusy('kitchen')).toBe(false);
    expect(isBusy('garden')).toBe(true);
    garden();
    expect(isBusy('garden')).toBe(false);
  });

  it('the agent is free again when its holder lets go, however its work ends', async () => {
    await expect(whileBusy('kitchen', async () => { throw new Error('made-up failure'); })).rejects.toThrow('made-up failure');
    expect(isBusy('kitchen')).toBe(false);
    const release = markBusy('kitchen');
    expect(isBusy('kitchen')).toBe(true);
    release();
    expect(isBusy('kitchen')).toBe(false);
  });

  // The tests stand for a restart with clearBusy: a new process has no flags.
  // In src a flag is let go only by its holder's release.
  it('src lets a flag go only through its holder\'s release: no clearBusy( outside busy.ts', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk('src');
    const calls = files
      .filter((f) => f !== join('src', 'orchestrator', 'lifecycle', 'busy.ts'))
      .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\bclearBusy\s*\(/g)].map(() => f));
    expect(calls).toEqual([]);
    // And in busy.ts only its definition.
    const own = readFileSync(join('src', 'orchestrator', 'lifecycle', 'busy.ts'), 'utf8');
    expect(own.match(/\bclearBusy\s*\(/g)).toHaveLength(1);
    expect(own).toMatch(/export function clearBusy\s*\(/);
  });
});
