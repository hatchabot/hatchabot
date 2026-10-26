import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';

// docker stats says nothing of when a container started; one inspect of every
// row does, so cap hits are judged against the right container (HB-0234).
describe('stats rows carry when each container started (HB-0234)', () => {
  it('reads every row\'s start in one inspect; a row it cannot read has none', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const dir = mkdtempSync(join(tmpdir(), 'hb-stats-'));
    const stub = join(dir, 'docker');
    writeFileSync(stub, `#!/usr/bin/env bash
case "$1" in
  stats)
    echo '{"Name":"hatchabot-pantry","ID":"aaaaaaaaaaaa","CPUPerc":"1.5%","MemUsage":"100MiB / 2GiB","PIDs":"9"}'
    echo '{"Name":"hatchabot-garden","ID":"bbbbbbbbbbbb","CPUPerc":"0.5%","MemUsage":"50MiB / 2GiB","PIDs":"4"}'
    echo '{"Name":"someone-else","ID":"cccccccccccc","CPUPerc":"0%","MemUsage":"1MiB / 1GiB","PIDs":"1"}' ;;
  inspect)
    echo "$*" > ${JSON.stringify(join(dir, 'inspect.argv'))}
    echo 'aaaaaaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdef0123|2026-10-25T08:00:00.123456789Z'
    echo 'bbbbbbbbbbbb0123456789abcdef0123456789abcdef0123456789abcdef0123|0001-01-01T00:00:00Z' ;;
esac
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: stub, image: 'test-image:latest' });
    const rows = await p.stats();
    expect(rows.map((r) => [r.name, r.startedAt])).toEqual([['hatchabot-pantry', '2026-10-25T08:00:00.123Z'], ['hatchabot-garden', undefined]]);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(dir, 'inspect.argv'), 'utf8').trim()).toBe('inspect -f {{.Id}}|{{.State.StartedAt}} aaaaaaaaaaaa bbbbbbbbbbbb');
  });
});
