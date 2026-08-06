import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';

function world() {
  const store = new Store(new Database(':memory:'));
  store.insertAgent({
    id: 'a1', ownerId: 'o', name: 'A', slug: 'a1', state: 'PROVISIONING',
    aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
    createdAt: 'now', updatedAt: 'now',
  });
  return store;
}

describe('agent events', () => {
  it('round-trips a normal detail', () => {
    const store = world();
    store.recordEvent('a1', 'runtime.started', { runtimeRef: 'docker://x' });
    expect(store.listEvents(['a1'])[0]!.detail).toEqual({ runtimeRef: 'docker://x' });
  });

  it('truncates an oversized detail without corrupting the whole timeline', () => {
    const store = world();
    // The real producer of oversized details: provision.failed carrying up to
    // 2000 chars of docker stderr. Truncating the serialized JSON mid-string
    // made listEvents throw on read — the activity feed bricking itself
    // exactly when a long error was worth reading.
    store.recordEvent('a1', 'provision.failed', { error: 'x'.repeat(5000) });
    store.recordEvent('a1', 'runtime.started', { ok: true });
    const events = store.listEvents(['a1']);
    expect(events).toHaveLength(2);
    expect(events[1]!.detail).toMatchObject({ truncated: true });
  });

  it('tolerates a torn row written before truncation kept JSON valid', () => {
    const store = world();
    (store as any).db
      .prepare(`INSERT INTO agent_events (agent_id, at, event, detail) VALUES (?, ?, ?, ?)`)
      .run('a1', 'now', 'old.event', '{"error":"cut off mid-str');
    const events = store.listEvents(['a1']);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ unparseable: expect.any(String) });
  });
});
