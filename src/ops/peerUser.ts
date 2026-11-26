/**
 * Which user made a connection to this machine's loopback (HB-1239, the
 * owner's call 2026-11-24). On the listener `tailscale serve` is pointed at,
 * X-Forwarded-For is believed only from a process of a user other than
 * Hatchabot's own: tailscaled runs as root and Caddy or nginx as their own
 * users, while under rootless Docker an agent's container reaches 127.0.0.1
 * through slirp4netns or pasta and rootlesskit, which run as Hatchabot's
 * user, and Docker Desktop's backend runs as the signed-in user. Any process
 * of Hatchabot's own user can read its database already, so nothing is lost
 * by not believing it. A peer that cannot be found is not believed.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { execFile } from 'node:child_process';

export interface Endpoint { address: string; port: number }
export interface TcpEntry { local: Endpoint; remote: Endpoint; state: number; uid: number; inode: number }

/** An address as both sides compare it: an IPv4-mapped one as its IPv4 form, IPv6 written out in full, lower case. */
export function normalAddress(a: string): string {
  const s = a.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1]!;
  if (!s.includes(':')) return s;
  const [head = '', tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  const full = groups.map((g) => g.padStart(4, '0'));
  // ::ffff:7f00:1 is 127.0.0.1 too.
  if (full.slice(0, 5).every((g) => g === '0000') && full[5] === 'ffff') {
    const n = (i: number) => parseInt(full[i]!, 16);
    return `${n(6) >> 8}.${n(6) & 255}.${n(7) >> 8}.${n(7) & 255}`;
  }
  return full.join(':');
}

/** /proc/net/tcp's address: IPv4 as one 32-bit word, IPv6 as four, each in the host's (little-endian) byte order. */
function procAddress(hex: string): string {
  const word = (w: string) => w.match(/../g)!.reverse().join('');
  if (hex.length === 8) {
    const n = word(hex);
    return [0, 2, 4, 6].map((i) => parseInt(n.slice(i, i + 2), 16)).join('.');
  }
  const be = [0, 8, 16, 24].map((i) => word(hex.slice(i, i + 8))).join('');
  return normalAddress(be.match(/.{4}/g)!.join(':'));
}

/**
 * The lines of /proc/net/tcp or /proc/net/tcp6: each socket's two ends, its
 * state, the uid that owns it and its inode. With `port`, only the lines with
 * that port at either end, found in the text before a line is split (HB-1239
 * review): on a busy machine the rest is most of the table.
 */
export function parseProcNetTcp(text: string, port?: number): TcpEntry[] {
  const out: TcpEntry[] = [];
  const atPort = port === undefined ? undefined : `:${port.toString(16).toUpperCase().padStart(4, '0')} `;
  // Each address worked out once a read: a table full of connections repeats 127.0.0.1.
  const addresses = new Map<string, string>();
  const address = (hex: string) => { let a = addresses.get(hex); if (a === undefined) addresses.set(hex, a = procAddress(hex)); return a; };
  const end = (s: string): Endpoint | undefined => {
    const m = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/.exec(s);
    return m ? { address: address(m[1]!), port: parseInt(m[2]!, 16) } : undefined;
  };
  for (const line of text.split('\n')) {
    if (atPort !== undefined && !line.includes(atPort)) continue;
    const f = line.trim().split(/\s+/);
    if (!/^\d+:$/.test(f[0] ?? '') || f.length < 10) continue;
    const local = end(f[1]!), remote = end(f[2]!);
    const uid = Number(f[7]), inode = Number(f[9]);
    if (!local || !remote || !Number.isInteger(uid) || !Number.isInteger(inode)) continue;
    out.push({ local, remote, state: parseInt(f[3]!, 16), uid, inode });
  }
  return out;
}

/** The entries of one read, by their two ends: each lookup sharing the read finds its own at once (HB-1239 review). */
export interface TcpTable { ends(local: Endpoint, remote: Endpoint): TcpEntry[] }
const endsKey = (local: Endpoint, remote: Endpoint) => `${local.address}:${local.port}>${remote.address}:${remote.port}`;
const normalEnd = (e: Endpoint): Endpoint => ({ address: normalAddress(e.address), port: e.port });

/** `entries` (parseProcNetTcp's, their addresses already in normalAddress's form) by their two ends. */
export function tcpTable(entries: TcpEntry[]): TcpTable {
  const byEnds = new Map<string, TcpEntry[]>();
  for (const e of entries) {
    const k = endsKey(e.local, e.remote);
    const at = byEnds.get(k);
    if (at) at.push(e); else byEnds.set(k, [e]);
  }
  return { ends: (local, remote) => byEnds.get(endsKey(normalEnd(local), normalEnd(remote))) ?? [] };
}

/** TCP_ESTABLISHED, in /proc/net/tcp's `st` column. */
const ESTABLISHED = 0x01;

/**
 * Linux: the client's own socket, whose local end is the peer and whose
 * remote end is the listener, while it is open. Once its owner closes it
 * (FIN_WAIT2, TIME_WAIT) the kernel lists it under uid 0, whoever made it,
 * and Node still runs a request it received whole: so a closed one says
 * nothing, and neither do two for the same ends (a table read while it
 * changed). Either is "cannot tell" (HB-1239 review).
 */
export function uidFromProcNet(table: TcpTable, peer: Endpoint, listener: Endpoint): number | undefined {
  const ends = table.ends(peer, listener);
  return ends.length === 1 && ends[0]!.state === ESTABLISHED ? ends[0]!.uid : undefined;
}

/** Hatchabot's own end of the connection, by the inode of its socket: local end the listener, remote end the peer. */
function holdsOwnEnd(table: TcpTable, peer: Endpoint, listener: Endpoint, inode: number): boolean {
  return table.ends(listener, peer).some((e) => e.inode === inode);
}

/**
 * Linux, from `read` (/proc/net/tcp and tcp6, as sharedRead shares them): the client's
 * uid, read first, and then, on a second read, Hatchabot's own end of the
 * connection (`inode`, its accepted socket) still open. While that end is
 * open no other connection can have the same two ends, so the client's
 * socket read before it is this connection's. A connection reset frees its
 * ends at once, and one of root's (tailscaled's next) may then be made on
 * them before the first read: without its own end on the second, "cannot
 * tell" (HB-1239 review).
 */
export function procNetLookup(read: () => Promise<TcpTable>): PeerUserLookup {
  return async (peer, listener, inode) => {
    if (!inode) return undefined;
    const uid = uidFromProcNet(await read(), peer, listener);
    if (uid === undefined) return undefined;
    return holdsOwnEnd(await read(), peer, listener, inode) ? uid : undefined;
  };
}

/** The inode of a socket of this process (the listener's accepted end), as /proc/net/tcp lists it; undefined when it cannot be read. */
export function socketInode(socket: unknown): number | undefined {
  const fd = (socket as { _handle?: { fd?: unknown } } | undefined)?._handle?.fd;
  if (typeof fd !== 'number' || fd < 0) return undefined;
  try { return fstatSync(fd).ino || undefined; } catch { return undefined; }
}

/**
 * `lsof -F pun` (macOS): the uid of the process that holds the client's
 * end, by its name `peer->listener`, when lsof shows one, of one user.
 * Run as Hatchabot's user, lsof sees only that user's programs, and it
 * looks at one process after another, not at one moment: a client it does
 * not show may be root's or one of Hatchabot's own user that closed while
 * it looked, so that is "cannot tell", never another user's. On a Mac only
 * a listed uid is believed, then (HB-1239 review).
 */
export function uidFromLsof(out: string, peer: Endpoint, listener: Endpoint): number | undefined {
  return lsofTable(out).uid(peer, listener);
}

/** One run of lsof, by the name of each end it shows: each lookup sharing the run finds its client at once. */
export interface LsofTable { uid(peer: Endpoint, listener: Endpoint): number | undefined }
export function lsofTable(out: string): LsofTable {
  const fmt = (e: Endpoint) => `${e.address.includes(':') ? `[${e.address}]` : e.address}:${e.port}`;
  const byName = new Map<string, Set<number>>();
  let uid: number | undefined;
  for (const line of out.split('\n')) {
    const k = line[0], v = line.slice(1).trim();
    if (k === 'p') uid = undefined;
    else if (k === 'u') uid = Number(v);
    else if (k === 'n' && uid !== undefined && Number.isInteger(uid)) {
      const at = byName.get(v);
      if (at) at.add(uid); else byName.set(v, new Set([uid]));
    }
  }
  return {
    uid: (peer, listener) => {
      const uids = byName.get(`${fmt(peer)}->${fmt(listener)}`);
      return uids?.size === 1 ? [...uids][0] : undefined;
    },
  };
}

/**
 * One read at a time, shared by every lookup that asks for it (HB-1239
 * review): an ask gets the next read to start, never one already under
 * way, so each lookup's read starts after it asked (its first after its
 * connection was accepted, its second after its first finished). However
 * many connections are being looked up, one read runs and one waits.
 */
export function sharedRead<T>(read: () => Promise<T>): () => Promise<T> {
  let last: Promise<unknown> = Promise.resolve(); // the latest read started; never rejects
  let next: Promise<T> | undefined; // the read not started yet, for every ask until it starts
  return () => {
    if (next) return next;
    const mine = last.then(() => {
      next = undefined;
      const r = read();
      last = r.catch(() => undefined);
      return r;
    });
    next = mine;
    return mine;
  };
}

/** Lookups waiting at once, at most: one more is "cannot tell" at once, so not believed, and its connection is not dropped. */
export const LOOKUPS_WAITING_MAX = 256;

/**
 * `lookup`, with at most `max` waiting at once (HB-1239 review): a flood of
 * connections costs a bounded number of lookups, and tailscaled's few
 * keep-alive connections, decided already, never wait behind it.
 */
export function capLookups(lookup: PeerUserLookup, max: number = LOOKUPS_WAITING_MAX): PeerUserLookup {
  let waiting = 0;
  return async (peer, listener, inode) => {
    if (waiting >= max) return undefined;
    waiting++;
    try { return await lookup(peer, listener, inode); } finally { waiting--; }
  };
}

export type PeerUser = number | undefined;
/** `inode`: of Hatchabot's own end of the connection, its accepted socket (socketInode). */
export type PeerUserLookup = (peer: Endpoint, listener: Endpoint, inode?: number) => Promise<PeerUser>;

const run = (cmd: string, args: string[], ms: number): Promise<string | undefined> => new Promise((resolve) => {
  execFile(cmd, args, { timeout: ms, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err && !stdout ? undefined : String(stdout)));
});

const readProcNet = (): Promise<string[]> => Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((p) => readFile(p, 'utf8').catch(() => '')));
const runLsof = (port: number): Promise<string | undefined> => run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpun'], 2000);

export interface MachineLookupOptions {
  /** The listener's port: only its lines are read. */
  port: number;
  /** Hatchabot's own uid, and HATCHABOT_PROXY_TRUST_UIDS. */
  own: number | undefined;
  trusted: number[];
  /** Tests: the platform, the tables' text and lsof's output, in place of this machine's. */
  platform?: NodeJS.Platform;
  readProcNet?: () => Promise<string[]>;
  runLsof?: (port: number) => Promise<string | undefined>;
}

/**
 * This machine's answer for one listener: /proc/net on Linux, lsof on macOS,
 * each read shared by the lookups waiting for it (sharedRead); undefined
 * anywhere else, or when it cannot tell.
 *
 * On a Mac, lsof run as Hatchabot's user finds only that user's programs, so
 * what it finds is believed only when Hatchabot's own uid is listed: unless it
 * is, lsof is never run (HB-1239 review).
 */
export function machineLookup(o: MachineLookupOptions): PeerUserLookup {
  const platform = o.platform ?? process.platform;
  if (platform === 'linux') {
    const read = o.readProcNet ?? readProcNet;
    return procNetLookup(sharedRead(async () => tcpTable((await read()).flatMap((t) => parseProcNetTcp(t, o.port)))));
  }
  if (platform === 'darwin') {
    if (o.own === undefined || !o.trusted.includes(o.own)) return async () => undefined;
    const lsof = o.runLsof ?? runLsof;
    const read = sharedRead(async () => {
      const out = await lsof(o.port);
      return out === undefined ? undefined : lsofTable(out);
    });
    return async (peer, listener) => (await read())?.uid(peer, listener);
  }
  return async () => undefined;
}

/** HATCHABOT_PROXY_TRUST_UIDS: users whose connections are believed too (a Tailscale run as Hatchabot's own user). */
export function trustedUids(env: NodeJS.ProcessEnv = process.env): number[] {
  return (env.HATCHABOT_PROXY_TRUST_UIDS ?? '').split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
}

/** The rule: a peer of another user is believed, or one listed; Hatchabot's own, or one not found, is not. */
export function believePeer(peer: PeerUser, own: number | undefined, trusted: number[]): boolean {
  if (peer === undefined) return false;
  if (trusted.includes(peer)) return true;
  if (own === undefined || peer === own) return false;
  return true;
}

/** A process of Tailscale's that makes serve's connections: tailscaled, or the macOS app's network extension. */
export interface TailscaleProcess { pid: number; uid: number; name: string }
const TAILSCALE_PROC = /(?:^|\/)tailscaled$|tailscale.*(?:IPNExtension|network-extension)|(?:IPNExtension|network-extension).*tailscale/i;

/** `ps -axo pid=,uid=,comm=` (macOS): Tailscale's processes in it. */
export function tailscaleInPs(out: string): TailscaleProcess[] {
  return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m && TAILSCALE_PROC.test(m[3]!))
    .map((m) => ({ pid: Number(m[1]), uid: Number(m[2]), name: m[3]!.split('/').pop()! }));
}

/** Tailscale's processes on this machine and the users they run as (hatchabot doctor). */
export async function tailscaleProcesses(): Promise<TailscaleProcess[]> {
  if (process.platform === 'darwin') return tailscaleInPs((await run('ps', ['-axo', 'pid=,uid=,comm='], 3000)) ?? '');
  if (process.platform !== 'linux') return [];
  const out: TailscaleProcess[] = [];
  for (const d of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(d)) continue;
    const comm = (await readFile(`/proc/${d}/comm`, 'utf8').catch(() => '')).trim();
    if (comm !== 'tailscaled') continue;
    const uid = /^Uid:\s+(\d+)/m.exec(await readFile(`/proc/${d}/status`, 'utf8').catch(() => ''))?.[1];
    if (uid !== undefined) out.push({ pid: Number(d), uid: Number(uid), name: comm });
  }
  return out;
}
