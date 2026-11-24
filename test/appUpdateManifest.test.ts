/**
 * An app update takes the live release's tasks off by that release's
 * manifest. Read as none when it could not be read, an update that renamed a
 * task left the old job running beside the new release, and said it had
 * succeeded (deep audit of v2.166.2, #011). A fake agent: its release link,
 * its files and its cron list are in memory.
 */
import { describe, expect, it } from 'vitest';
import { installRelease, parseManifest, type InstallDeps } from '../src/orchestrator/apps/apps.js';
import { MockProvider } from '../src/providers/mockProvider.js';

const LIVE = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const OLD_MANIFEST = { app: 'garden-log', name: 'Garden log', tasks: [{ name: 'weekly', every: '7d', command: ['garden-log', 'run'] }] };
const NEW_MANIFEST = parseManifest(JSON.stringify({ app: 'garden-log', name: 'Garden log', tasks: [{ name: 'daily', every: '1d', command: ['garden-log', 'run'] }] }));

function agent(liveManifestOnVolume: string) {
  const provider = new MockProvider();
  let jobs = [{ id: 'job-old', name: 'garden-log-weekly', enabled: true }];
  const taskFiles = new Map<string, string>();
  let nextId = 0;
  const writes: string[] = [];
  provider.execShell = async (_ref, script) => {
    const taskFile = /\.tasks-(?:transition|settled)\.json/.exec(script)?.[0];
    if (taskFile) {
      if (script.startsWith('rm -f ')) taskFiles.delete(taskFile);
      const content = taskFiles.get(taskFile);
      return { code: 0, stdout: script.startsWith('if ') && content !== undefined ? `present\n${content}` : '', stderr: '' };
    }
    if (script.includes('readlink')) return { code: 0, stdout: `releases/${LIVE.slice(0, 12)}\n`, stderr: '' };
    if (script.startsWith('cat ') && script.includes('hatchabot.json')) return { code: 0, stdout: liveManifestOnVolume, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  provider.writeToVolume = async (_ref, argv, input) => {
    writes.push(argv.join(' '));
    const taskFile = /\.tasks-(?:transition|settled)\.json/.exec(argv.join(' '))?.[0];
    if (taskFile) taskFiles.set(taskFile, input.toString());
    return { code: 0, stdout: '', stderr: '' };
  };
  provider.exec = async (_ref, argv) => {
    if (argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ jobs }), stderr: '' };
    if (argv[1] === 'add') jobs.push({ id: `job-${++nextId}`, name: argv[argv.indexOf('--name') + 1]!, enabled: !argv.includes('--disabled') });
    if (argv[1] === 'enable' || argv[1] === 'disable') {
      const job = jobs.find((j) => j.id === argv[2]);
      if (job) job.enabled = argv[1] === 'enable';
    }
    if (argv[1] === 'rm') jobs = jobs.filter((j) => j.id !== argv[2]);
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const d: InstallDeps = { provider, runtimeRef: 'mock://garden-notes', facts: { slug: 'garden-notes', name: 'Garden Notes', timezone: 'UTC' } };
  return { d, writes, jobs: () => jobs.map((j) => j.name) };
}
const release = { manifest: NEW_MANIFEST, sha: NEXT, tar: Buffer.from('release archive') };

describe('an update needs the manifest of the release it replaces', () => {
  it('unreadable, and no record of it: refused before anything changes', async () => {
    const a = agent('');
    const err = (await installRelease(a.d, release).then(() => undefined, (e: unknown) => e)) as Error & { unchanged?: boolean };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Could not read the hatchabot\.json of the release running now \(aaaaaaaaaaaa\).*Nothing was changed/);
    expect(err.unchanged).toBe(true);
    expect(a.writes).toEqual([]);
    expect(a.jobs()).toEqual(['garden-log-weekly']);
  });

  it('corrupt on the volume, but the app record has that release: its tasks are the ones replaced', async () => {
    const a = agent('{ not json');
    const done = await installRelease({ ...a.d, recorded: { app: 'garden-log', sha: LIVE, manifest: OLD_MANIFEST } }, release);
    expect(done.tasks).toEqual(['garden-log-daily']);
    expect(a.jobs()).toEqual(['garden-log-daily']);
  });

  it('a record of another release does not stand in for the live one', async () => {
    const a = agent('');
    await expect(installRelease({ ...a.d, recorded: { app: 'garden-log', sha: 'c'.repeat(40), manifest: OLD_MANIFEST } }, release)).rejects.toThrow(/Nothing was changed/);
    expect(a.jobs()).toEqual(['garden-log-weekly']);
  });

  it('readable on the volume: the old task comes off, as before', async () => {
    const a = agent(JSON.stringify(OLD_MANIFEST));
    const done = await installRelease(a.d, release);
    expect(done.tasks).toEqual(['garden-log-daily']);
    expect(a.jobs()).toEqual(['garden-log-daily']);
  });
});
