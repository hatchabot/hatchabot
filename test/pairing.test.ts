import { describe, expect, it } from 'vitest';
import { PAIRING_UNKNOWN, parsePendingPairing, pendingPairingShell } from '../src/orchestrator/pairing.js';

describe('pending console-pairing requests across OpenClaw versions', () => {
  it('the shell reads the JSON file first, then the 2026.9 state database, else says it does not know', () => {
    const sh = pendingPairingShell();
    expect(sh).toContain('devices/pending.json');
    expect(sh).toContain('state/openclaw.sqlite');
    expect(sh).toContain('device_pairing_pending');
    expect(sh).toContain(PAIRING_UNKNOWN);
    // the node script is single-quoted in the shell: it must not contain one
    const node = /node -e '([^']*)'/.exec(sh)?.[1] ?? '';
    expect(node).toContain('DatabaseSync');
    expect(sh.split("node -e '")[1]!.split("' ")[0]).toBe(node);
  });

  it('a 2026.7 file: an object of rows, or an array', () => {
    expect(parsePendingPairing(JSON.stringify({ a: { requestId: 'r-00000001', ts: 5 } }))).toEqual([{ requestId: 'r-00000001', ts: 5 }]);
    expect(parsePendingPairing(JSON.stringify([{ requestId: 'r-00000001', createdAtMs: 7 }]))).toEqual([{ requestId: 'r-00000001', ts: 7 }]);
    expect(parsePendingPairing('{}')).toEqual([]); // a real file with nothing in it
  });

  it('a 2026.9 database: rows the shell already shaped, refreshed time included', () => {
    expect(parsePendingPairing('[{"requestId":"5c8b83a2-a6f9-4e9f-9248-8ac1a6fcd6a1","ts":1790280413534}]')).toEqual([
      { requestId: '5c8b83a2-a6f9-4e9f-9248-8ac1a6fcd6a1', ts: 1790280413534 },
    ]);
  });

  it('no store, garbage, or an unknown shape means "ask the CLI", never "nothing pending"', () => {
    expect(parsePendingPairing(PAIRING_UNKNOWN)).toBeUndefined();
    expect(parsePendingPairing(`${PAIRING_UNKNOWN}\n`)).toBeUndefined();
    expect(parsePendingPairing('')).toBeUndefined();
    expect(parsePendingPairing('not json')).toBeUndefined();
    expect(parsePendingPairing('[{"id":"x"}]')).toBeUndefined();
  });
});
