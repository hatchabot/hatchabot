import { describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { LOOKUPS_WAITING_MAX, believePeer, capLookups, machineLookup, normalAddress, parseProcNetTcp, procNetLookup, sharedRead, socketInode, tailscaleInPs, tcpTable, trustedUids, uidFromLsof, uidFromProcNet, type PeerUserLookup } from '../src/ops/peerUser.js';

/**
 * HB-1239, the owner's call (2026-11-24): on the listener for tailscale
 * serve, X-Forwarded-For is believed only from a process of a user other
 * than Hatchabot's own. These are the pieces that find that user; the
 * addresses, ports and uids are made up.
 */
const PEER = { address: '127.0.0.1', port: 54321 };
const LISTENER = { address: '127.0.0.1', port: 8094 };
/** A made-up /proc/net/tcp, as a lookup reads it. */
const table = (text: string) => tcpTable(parseProcNetTcp(text));

describe('finding the user that made a connection', () => {
  it('reads /proc/net/tcp: the client\'s socket is the one whose local end is the peer, and its uid', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F9E 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 100 0 0 10 0',
      '   1: 0100007F:1F9E 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 41002 1 0000000000000000 20 4 30 10 -1',
      '   2: 0100007F:D431 0100007F:1F9E 01 00000000:00000000 00:00000000 00000000     0        0 41003 1 0000000000000000 20 4 30 10 -1',
    ].join('\n');
    const entries = parseProcNetTcp(tcp);
    expect(entries).toHaveLength(3);
    expect(entries[2]).toEqual({ local: PEER, remote: LISTENER, state: 1, uid: 0, inode: 41003 });
    // The client's end, not the listener's own accepted one (Hatchabot's uid) nor the listening socket.
    expect(uidFromProcNet(tcpTable(entries), PEER, LISTENER)).toBe(0);
    expect(uidFromProcNet(tcpTable(entries), { address: '127.0.0.1', port: 54999 }, LISTENER)).toBeUndefined();
  });

  it('counts the client\'s socket only while it is open (ESTABLISHED), and only one: a closed one is listed under uid 0 (HB-1239 review)', () => {
    const OWN = 1000;
    const line = (sl: number, st: string, uid: number, inode: number) =>
      `   ${sl}: 0100007F:D431 0100007F:1F9E ${st} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${inode} 1 0000000000000000 20 4 30 10 -1`;
    const believed = (text: string) => believePeer(uidFromProcNet(table(text), PEER, LISTENER), OWN, []);
    // Closed by its owner (a container's, through slirp4netns as Hatchabot's user): FIN_WAIT2 or TIME_WAIT, which the kernel lists under uid 0.
    for (const st of ['05', '06']) {
      expect(uidFromProcNet(table(line(0, st, 0, 0)), PEER, LISTENER)).toBeUndefined();
      expect(believed(line(0, st, 0, 0))).toBe(false);
    }
    // Open, another user's (tailscaled as root, Caddy as its own user): believed.
    expect(believed(line(0, '01', 0, 43001))).toBe(true);
    expect(believed(line(0, '01', 997, 43002))).toBe(true);
    // Two entries for the same two ends (a table read while it changed), whatever their states: cannot tell.
    for (const pair of [[line(0, '01', 0, 43003), line(1, '01', 0, 43004)], [line(0, '01', 0, 43005), line(1, '06', 0, 0)], [line(0, '06', 0, 0), line(1, '01', 0, 43006)]]) {
      expect(uidFromProcNet(table(pair.join('\n')), PEER, LISTENER)).toBeUndefined();
      expect(believed(pair.join('\n'))).toBe(false);
    }
  });

  it('believes the client\'s socket only while Hatchabot\'s own end of it, by its inode, is still open on a read after: an aborted connection frees its two ends at once (HB-1239 review)', async () => {
    const client = (uid: number) => `   0: 0100007F:D431 0100007F:1F9E 01 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 44001 1 0000000000000000 20 4 30 10 -1`;
    const ours = (inode: number) => `   1: 0100007F:1F9E 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 20 4 30 10 -1`;
    /** The tables a lookup reads, in turn. */
    const reads = (...texts: string[]) => { let i = 0; return async () => table(texts[i++] ?? ''); };
    expect(parseProcNetTcp(ours(4242))[0]!.inode).toBe(4242);
    // tailscaled's connection, and Hatchabot's end of it (inode 4242) still open when read again: root's.
    expect(await procNetLookup(reads(client(0), ours(4242)))(PEER, LISTENER, 4242)).toBe(0);
    // Reset before the second read: those ends were free, so the root socket on them may be another connection's.
    expect(await procNetLookup(reads(client(0), ''))(PEER, LISTENER, 4242)).toBeUndefined();
    expect(await procNetLookup(reads(`${client(0)}\n${ours(4242)}`, ''))(PEER, LISTENER, 4242)).toBeUndefined();
    // Another socket of Hatchabot's on those ends (the next connection, accepted on them): not this one.
    expect(await procNetLookup(reads(client(0), ours(4343)))(PEER, LISTENER, 4242)).toBeUndefined();
    // No inode for its own end: cannot tell.
    expect(await procNetLookup(reads(client(0), ours(4242)))(PEER, LISTENER, undefined)).toBeUndefined();
  });

  it('reads /proc/net/tcp6, its IPv4-mapped form as the IPv4 address Node gives', () => {
    const tcp6 = [
      '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0000000000000000FFFF00000100007F:D432 0000000000000000FFFF00000100007F:1F9E 01 00000000:00000000 00:00000000 00000000   105        0 42001 1 0000000000000000 20 4 30 10 -1',
      '   1: B80D0120000000000000000005000000:D433 B80D0120000000000000000006000000:1F9E 01 00000000:00000000 00:00000000 00000000   106        0 42002 1 0000000000000000 20 4 30 10 -1',
    ].join('\n');
    const entries = parseProcNetTcp(tcp6);
    expect(entries.map((e) => e.local.address)).toEqual(['127.0.0.1', '2001:0db8:0000:0000:0000:0000:0000:0005']);
    expect(uidFromProcNet(tcpTable(entries), { address: '::ffff:127.0.0.1', port: 54322 }, { address: '127.0.0.1', port: 8094 })).toBe(105);
    expect(uidFromProcNet(tcpTable(entries), { address: '127.0.0.1', port: 54322 }, { address: '::ffff:127.0.0.1', port: 8094 })).toBe(105);
    expect(uidFromProcNet(tcpTable(entries), { address: '2001:db8::5', port: 54323 }, { address: '2001:db8::6', port: 8094 })).toBe(106);
    expect(normalAddress('::ffff:7f00:1')).toBe('127.0.0.1');
    // Lines that are not sockets are left out, never misread.
    expect(parseProcNetTcp('garbage\n   9: nothing here\n')).toEqual([]);
  });

  it('reads lsof (macOS): the uid of the process that holds the client\'s end, by the name peer->listener; anything else, cannot tell', () => {
    const client = 'p321\nu0\nf12\nn127.0.0.1:54321->127.0.0.1:8094\n';
    const mine = 'p4242\nu1000\nf20\nn127.0.0.1:8094->127.0.0.1:54321\n';
    const ownClient = 'p77\nu1000\nf3\nn127.0.0.1:54321->127.0.0.1:8094\n';
    expect(uidFromLsof(client + mine, PEER, LISTENER)).toBe(0);
    expect(uidFromLsof(mine + ownClient, PEER, LISTENER)).toBe(1000);
    // Only Hatchabot's own end shows. lsof looks at one process after another, so a client of Hatchabot's own user
    // (Docker Desktop's backend) that closed while it looked shows the same as root's: not believed (HB-1239 review).
    expect(uidFromLsof(mine, PEER, LISTENER)).toBeUndefined();
    expect(believePeer(uidFromLsof(mine, PEER, LISTENER), 1000, [])).toBe(false);
    expect(uidFromLsof('', PEER, LISTENER)).toBeUndefined();
    // The client's end held by processes of two users: cannot tell.
    expect(uidFromLsof(client + ownClient, PEER, LISTENER)).toBeUndefined();
  });
});

describe('many connections at once (HB-1239 review)', () => {
  const tick = () => new Promise<void>((r) => setImmediate(r));
  /** A read the test ends by hand: one entry per call made. */
  const byHand = () => {
    const calls: Array<(v: string) => void> = [];
    return { calls, read: () => new Promise<string>((r) => { calls.push(r); }) };
  };

  it('an ask gets the next read to start, never one already under way; one read runs at a time', async () => {
    const h = byHand();
    const shared = sharedRead(h.read);
    const a = shared(), b = shared();
    await tick();
    expect(h.calls).toHaveLength(1);
    // Asked while that read runs: not its answer (it may have started before this connection was accepted), the next one's.
    const c = shared(), d = shared();
    await tick();
    expect(h.calls).toHaveLength(1);
    h.calls[0]!('first');
    expect([await a, await b]).toEqual(['first', 'first']);
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    let cAnswer: string | undefined;
    void c.then((v) => { cAnswer = v; }).catch(() => {});
    await tick();
    expect(cAnswer).toBeUndefined();
    h.calls[1]!('second');
    expect([await c, await d]).toEqual(['second', 'second']);
    // A read that fails fails its own asks only; the next ask gets a new read.
    const failing = sharedRead(async () => { throw new Error('no /proc here'); });
    await expect(failing()).rejects.toThrow('no /proc here');
    await expect(failing()).rejects.toThrow('no /proc here');
  });

  it('200 connections looked up at once: two reads in all, the second started after the first finished', async () => {
    const n = 200;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      const port = (40000 + i).toString(16).toUpperCase();
      lines.push(`   ${2 * i}: 0100007F:${port} 0100007F:1F9E 01 00000000:00000000 00:00000000 00000000     0        0 ${60000 + 2 * i} 1 0000000000000000 20 4 30 10 -1`);
      lines.push(`   ${2 * i + 1}: 0100007F:1F9E 0100007F:${port} 01 00000000:00000000 00:00000000 00000000  1000        0 ${60001 + 2 * i} 1 0000000000000000 20 4 30 10 -1`);
    }
    const order: string[] = [];
    let running = 0;
    const lookup = procNetLookup(sharedRead(async () => {
      order.push('start');
      expect(++running).toBe(1);
      await tick();
      running--;
      order.push('end');
      return table(lines.join('\n'));
    }));
    const uids = await Promise.all(Array.from({ length: n }, (_, i) => lookup({ address: '127.0.0.1', port: 40000 + i }, LISTENER, 60001 + 2 * i)));
    expect(uids).toEqual(Array(n).fill(0));
    expect(order).toEqual(['start', 'end', 'start', 'end']);
  });

  it('reads only the lines with the listener\'s port at either end, found before a line is split', () => {
    const text = [
      '   0: 0100007F:D431 0100007F:1F9E 01 00000000:00000000 00:00000000 00000000     0        0 45001 1 0000000000000000 20 4 30 10 -1',
      '   1: 0100007F:1F9E 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 45002 1 0000000000000000 20 4 30 10 -1',
      // Another port's (ssh), and one whose queue holds the same digits: neither is the listener's.
      '   2: 0100007F:0016 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 45003 1 0000000000000000 20 4 30 10 -1',
      '   3: 0100007F:0016 0100007F:C351 01 00001F9E:00001F9E 00:00001F9E 00000000     0        0 45004 1 0000000000000000 20 4 30 10 -1',
    ].join('\n');
    expect(parseProcNetTcp(text, 8094).map((e) => e.inode)).toEqual([45001, 45002]);
    expect(parseProcNetTcp(text)).toHaveLength(4);
  });

  it('this machine\'s lookup on Linux: 200 connections at once read the tables twice in all', async () => {
    const n = 200;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      const port = (40000 + i).toString(16).toUpperCase();
      lines.push(`   ${2 * i}: 0100007F:${port} 0100007F:1F9E 01 00000000:00000000 00:00000000 00000000     0        0 ${60000 + 2 * i} 1 0000000000000000 20 4 30 10 -1`);
      lines.push(`   ${2 * i + 1}: 0100007F:1F9E 0100007F:${port} 01 00000000:00000000 00:00000000 00000000  1000        0 ${60001 + 2 * i} 1 0000000000000000 20 4 30 10 -1`);
    }
    let reads = 0;
    const lookup = machineLookup({ port: 8094, own: 1000, trusted: [], platform: 'linux', readProcNet: async () => { reads++; await tick(); return [lines.join('\n'), ''] } });
    const uids = await Promise.all(Array.from({ length: n }, (_, i) => lookup({ address: '127.0.0.1', port: 40000 + i }, LISTENER, 60001 + 2 * i)));
    expect(uids).toEqual(Array(n).fill(0));
    expect(reads).toBe(2);
  });

  it('this machine\'s lookup on a Mac: lsof is never run unless Hatchabot\'s own uid is listed; listed, one run serves them all', async () => {
    const own = 501;
    const out = Array.from({ length: 20 }, (_, i) => `p${300 + i}\nu${own}\nf12\nn127.0.0.1:${40000 + i}->127.0.0.1:8094\n`).join('');
    let runs = 0;
    const lsof = async (port: number) => { runs++; expect(port).toBe(8094); await tick(); return out; };
    const twenty = (lookup: PeerUserLookup) => Promise.all(Array.from({ length: 20 }, (_, i) => lookup({ address: '127.0.0.1', port: 40000 + i }, LISTENER, 1)));
    // What lsof can find there is only Hatchabot's own user's, believed only when listed: not listed, nothing is run.
    expect(await twenty(machineLookup({ port: 8094, own, trusted: [], platform: 'darwin', runLsof: lsof }))).toEqual(Array(20).fill(undefined));
    expect(runs).toBe(0);
    const listed = await twenty(machineLookup({ port: 8094, own, trusted: [own], platform: 'darwin', runLsof: lsof }));
    expect(listed).toEqual(Array(20).fill(own));
    expect(listed.every((u) => believePeer(u, own, [own]))).toBe(true);
    expect(runs).toBe(1);
  });

  it(`at most ${LOOKUPS_WAITING_MAX} lookups wait at once: one more is "cannot tell" at once, without a lookup`, async () => {
    const answers: Array<() => void> = [];
    let asked = 0;
    const slow: PeerUserLookup = () => { asked++; return new Promise((r) => { answers.push(() => r(0)); }); };
    const lookup = capLookups(slow);
    const waiting = Array.from({ length: LOOKUPS_WAITING_MAX }, (_, i) => lookup({ address: '127.0.0.1', port: 40000 + i }, LISTENER, 1));
    const beyond = await lookup(PEER, LISTENER, 1);
    expect(beyond).toBeUndefined();
    expect(believePeer(beyond, 1000, [])).toBe(false);
    expect(asked).toBe(LOOKUPS_WAITING_MAX);
    answers.forEach((a) => a());
    expect(await Promise.all(waiting)).toEqual(Array(LOOKUPS_WAITING_MAX).fill(0));
    // Room again: the next one is looked up, and one that failed leaves room too.
    const next = lookup(PEER, LISTENER, 1);
    answers.at(-1)!();
    expect(await next).toBe(0);
    const failing = capLookups(async () => { throw new Error('gone'); }, 1);
    await expect(failing(PEER, LISTENER, 1)).rejects.toThrow('gone');
    await expect(failing(PEER, LISTENER, 1)).rejects.toThrow('gone');
  });
});

describe('the rule', () => {
  it('another user\'s peer is believed; Hatchabot\'s own, or one not found, is not; a listed uid is', () => {
    expect(believePeer(0, 1000, [])).toBe(true);
    expect(believePeer(997, 1000, [])).toBe(true);
    expect(believePeer(1000, 1000, [])).toBe(false);
    expect(believePeer(undefined, 1000, [])).toBe(false);
    expect(believePeer(undefined, 1000, [1000])).toBe(false);
    expect(believePeer(1000, 1000, [1000])).toBe(true);
    // No uid of its own to compare with (not a POSIX system): only a listed one.
    expect(believePeer(0, undefined, [])).toBe(false);
  });

  it('HATCHABOT_PROXY_TRUST_UIDS is a list of uids, empty by default', () => {
    expect(trustedUids({})).toEqual([]);
    expect(trustedUids({ HATCHABOT_PROXY_TRUST_UIDS: '501, 1000 x -3 7' })).toEqual([501, 1000, 7]);
  });

  it('finds Tailscale\'s processes in ps (macOS): the system extension, the App Store app\'s network extension, tailscaled', () => {
    const ps = [
      '    1     0 /sbin/launchd',
      '  812     0 /Library/SystemExtensions/0A1B/io.tailscale.ipn.macsys.network-extension.systemextension/Contents/MacOS/io.tailscale.ipn.macsys.network-extension',
      '  913   501 /Applications/Tailscale.app/Contents/PlugIns/IPNExtension.appex/Contents/MacOS/IPNExtension',
      '  914   501 /usr/local/bin/tailscaled',
      '  915   501 /Applications/Safari.app/Contents/MacOS/Safari',
    ].join('\n');
    expect(tailscaleInPs(ps)).toEqual([
      { pid: 812, uid: 0, name: 'io.tailscale.ipn.macsys.network-extension' },
      { pid: 913, uid: 501, name: 'IPNExtension' },
      { pid: 914, uid: 501, name: 'tailscaled' },
    ]);
  });
});

/**
 * The real lookup on real sockets, Linux only (the review of HB-1239): a
 * connection from this process to a server of its own, on loopback, so its
 * peer is Hatchabot's own user and is not believed. Once with an IPv4 client,
 * once with a server on the IPv4-mapped loopback address, whose client is
 * named ::ffff:127.0.0.1 there. Nothing leaves this machine's loopback.
 */
describe.skipIf(process.platform !== 'linux')('the real lookup on a real loopback socket (Linux)', () => {
  const own = process.getuid!();
  const lookUp = async (host: string) => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, host, () => r()));
    const port = (server.address() as AddressInfo).port;
    const accepted = once(server, 'connection') as Promise<[Socket]>;
    const client = connect(port, '127.0.0.1');
    await once(client, 'connect');
    const [socket] = await accepted;
    try {
      const lookup = machineLookup({ port, own, trusted: [] });
      const peer = { address: socket.remoteAddress!, port: socket.remotePort! };
      const uid = await lookup(peer, { address: socket.localAddress!, port }, socketInode(socket));
      return { peer: peer.address, uid };
    } finally {
      client.destroy(); socket.destroy();
      await new Promise((r) => server.close(r));
    }
  };

  it('an IPv4 client is found as this process\'s own user, so not believed', async () => {
    const { peer, uid } = await lookUp('127.0.0.1');
    expect([peer, uid]).toEqual(['127.0.0.1', own]);
    expect(believePeer(uid, own, [])).toBe(false);
  });

  it('an IPv4-mapped client (::ffff:127.0.0.1) too', async () => {
    const { peer, uid } = await lookUp('::ffff:127.0.0.1');
    expect([peer, uid]).toEqual(['::ffff:127.0.0.1', own]);
    expect(believePeer(uid, own, [])).toBe(false);
  });
});
