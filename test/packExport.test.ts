/**
 * The full copy's file made through a stream (packExport, HB-0925): what a
 * large one and a failing gzip do to the process around it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Transform } from 'node:stream';

/** When set, the gzip the export makes fails at its nth piece. */
const failing = vi.hoisted(() => ({ atPiece: 0 }));
vi.mock('node:zlib', async (load) => {
  const real = await load<typeof import('node:zlib')>();
  return {
    ...real,
    createGzip: (...args: Parameters<typeof real.createGzip>) => {
      const gz = real.createGzip(...args) as Transform;
      if (!failing.atPiece) return gz;
      let n = 0;
      const transform = gz._transform.bind(gz);
      gz._transform = (chunk, enc, done) => (++n === failing.atPiece ? done(new Error('made-up compression failure')) : transform(chunk, enc, done));
      return gz;
    },
  };
});

const { packExport } = await import('../src/orchestrator/transfer/transfer.js');
type Manifest = Parameters<typeof packExport>[0];
const meta = { format: 'hatchabot-export', version: 1, agent: { name: 'Kitchen' }, state: '' } as unknown as Manifest;

/** What the process says while `fn` runs, and a moment after: its warnings and the rejections nothing handled. */
async function watch(fn: () => Promise<unknown>) {
  const warnings: string[] = [];
  const unhandled: unknown[] = [];
  const warned = (w: Error) => { warnings.push(`${w.name}: ${w.message}`); };
  const rejected = (r: unknown) => { unhandled.push(r); };
  process.on('warning', warned);
  process.on('unhandledRejection', rejected);
  try {
    const outcome = await fn().then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    await new Promise((r) => setTimeout(r, 50));
    return { outcome, warnings, unhandled };
  } finally {
    process.off('warning', warned);
    process.off('unhandledRejection', rejected);
  }
}

afterEach(() => { failing.atPiece = 0; });

describe('the full copy\'s file through a stream (review of HB-0925)', () => {
  it('a large export makes it with no warning from the process', async () => {
    // 16 MiB: some thirty pieces, many of them waiting for the gzip to drain.
    const seen = await watch(() => packExport(meta, randomBytes(16 * 1024 * 1024)));
    expect(seen.outcome.ok).toBe(true);
    expect(seen.warnings).toEqual([]);
  });

  it('a gzip that fails part way rejects the export, and leaves no rejection unhandled', async () => {
    failing.atPiece = 12;
    const seen = await watch(() => packExport(meta, randomBytes(16 * 1024 * 1024)));
    expect(seen.outcome).toMatchObject({ ok: false, e: { message: 'made-up compression failure' } });
    expect(seen.unhandled).toEqual([]);
    expect(seen.warnings).toEqual([]);
  });
});
