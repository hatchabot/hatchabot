import { createServer, type Server } from 'node:net';
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';

/**
 * A loopback port for a listener the test cannot open itself on port 0 (the
 * app's public listener reads its port from HATCHABOT_PUBLIC_PORT; sshd from
 * its config), so the port is chosen first and opened later.
 *
 * A port the kernel handed out for `listen(0)` and that was then closed is the
 * wrong choice (HB-0505): it is in the kernel's ephemeral range, which every
 * other `listen(0)` and every outgoing connection on the machine draws from,
 * and on a busy machine one of them took it before the app opened it
 * (EADDRINUSE on CI). So the port comes from a band below that range, which
 * the kernel never hands out by itself, above the agents' gateway ports
 * (HATCHABOT_GATEWAY_PORT_BASE, 19100 up), and below the fixed ports the
 * smoke-adopt live test uses on the same machine (scripts/smoke-adopt-full.ts:
 * gateways from 29100, memory search 28093). It is checked free before it is
 * returned. Another test choosing the same port in the same moment is still
 * possible, so whatever opens it chooses again when it was taken (onFreePort).
 */
const BAND_FIRST = 20_000;
const BAND_LAST = 26_999;

/** The kernel's range for `listen(0)` and outgoing connections. */
export function ephemeralRange(): [number, number] {
  try {
    const [a, b] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    if (Number.isInteger(a) && Number.isInteger(b) && a! > 0 && b! >= a!) return [a!, b!];
  } catch { /* not Linux */ }
  return process.platform === 'darwin' ? [49_152, 65_535] : [32_768, 60_999];
}

function opens(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function kernelPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}

export async function freePort(): Promise<number> {
  const [lo, hi] = ephemeralRange();
  for (let i = 0; i < 100; i++) {
    const p = randomInt(BAND_FIRST, BAND_LAST + 1);
    if (p >= lo && p <= hi) continue; // a machine whose ephemeral range covers the band
    if (await opens(p)) return p;
  }
  // No free port in the band (or the band is inside the ephemeral range): the kernel's choice, as before.
  return kernelPort();
}

/** A listener's error says its port was taken. */
export const portTaken = (text: string | undefined): boolean => /EADDRINUSE/.test(text ?? '');

/** What `open` answers when the port it was given turned out to be taken. */
export const TAKEN = Symbol('port taken');

/**
 * Choose a port and open something on it; when `open` answers TAKEN, choose
 * again, `tries` times at most. For listeners the test does not open itself
 * (a script, sshd) as well as its own.
 */
export async function onFreePort<T>(open: (port: number) => Promise<T | typeof TAKEN>, { tries = 5, choose = freePort }: { tries?: number; choose?: () => Promise<number> } = {}): Promise<{ port: number; opened: T }> {
  const taken: number[] = [];
  for (let i = 0; i < tries; i++) {
    const port = await choose();
    const opened = await open(port);
    if (opened !== TAKEN) return { port, opened: opened as T };
    taken.push(port);
  }
  throw new Error(`no port could be opened: ${taken.join(', ')} were each taken first`);
}

/** A server of the test's own on a port from freePort, choosing again if it was taken. Other listen errors reject. */
export async function listenOnFreePort(server: Server | import('node:http').Server, { host = '127.0.0.1', choose = freePort }: { host?: string; choose?: () => Promise<number> } = {}): Promise<number> {
  const { port } = await onFreePort((p) => new Promise<true | typeof TAKEN>((resolve, reject) => {
    const failed = (e: NodeJS.ErrnoException) => { server.off('listening', opened); if (e.code === 'EADDRINUSE') resolve(TAKEN); else reject(e); };
    const opened = () => { server.off('error', failed); resolve(true); };
    server.once('error', failed);
    server.once('listening', opened);
    server.listen(p, host);
  }), { choose });
  return port;
}

/**
 * A port from freePort held open on `host` until `release`, for a test that
 * shows its listener chooses again: the first port it is given is this one.
 */
export async function heldPort(host = '127.0.0.1'): Promise<{ port: number; release: () => Promise<void> }> {
  const s = createServer();
  const port = await listenOnFreePort(s, { host });
  return { port, release: () => new Promise<void>((r) => s.close(() => r())) };
}
/** A chooser that gives `first` and then free ports. */
export const firstThen = (first: number) => { let used = false; return async () => (used ? freePort() : (used = true, first)); };
