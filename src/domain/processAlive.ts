/**
 * Whether a process with this id is running on this machine. Signal 0 tests
 * without sending anything; EPERM means it runs as another user, so it is
 * alive. One copy, used by the one-shot sweep, the backup lock and the
 * embedder's part files: three of their own could drift apart.
 */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}
