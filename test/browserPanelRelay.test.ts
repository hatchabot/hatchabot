import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { PANEL_RELAY_SOURCE } from '../src/providers/browserPanelRelay.js';

/** Execute the shipped relay itself, with synthetic CDP responses and no
 * process, network, Docker or real browser access. */
async function relay(closeReply: () => Promise<unknown>, options: {
  createReply?: (signal: AbortSignal) => Promise<unknown>;
  connect?: boolean;
} = {}) {
  const stdin = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stdout = Object.assign(new EventEmitter(), { write: vi.fn() });
  const exit = vi.fn();
  let socket!: Socket;
  class Socket {
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (m: { data: string }) => void;
    send = vi.fn();
    close = vi.fn(() => this.onclose?.());
    constructor() { socket = this; }
  }
  const fetch = vi.fn(async (url: string, init?: { signal: AbortSignal }) => {
    if (url.includes('/json/new')) return options.createReply ? options.createReply(init!.signal)
      : { json: async () => ({ id: 'fixture-tab', webSocketDebuggerUrl: 'ws://fixture.invalid/tab' }) };
    return closeReply();
  });
  const initialized = runInNewContext(`(async () => { ${PANEL_RELAY_SOURCE} })()`, {
    process: { stdin, stdout, exit }, fetch, WebSocket: Socket, setTimeout, clearTimeout, AbortController,
    AbortSignal: { any: AbortSignal.any, timeout: (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    } },
  });
  if (!options.createReply) await initialized;
  if (options.connect !== false) socket?.onopen?.();
  return { stdin, stdout, exit, get socket() { return socket; }, fetch, initialized };
}

describe('browser panel relay cleanup', () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('exits within the child channel grace period even when DevTools never answers tab close', async () => {
    vi.useFakeTimers();
    const r = await relay(() => new Promise(() => {}));
    r.stdin.emit('end');
    expect(r.socket.close).toHaveBeenCalledOnce();
    expect(r.fetch.mock.calls.at(-1)![0]).toBe('http://127.0.0.1:9222/json/close/fixture-tab');
    await vi.advanceTimersByTimeAsync(2500);
    expect(r.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('closes its tab and exits promptly after ordinary stream end', async () => {
    vi.useFakeTimers();
    const r = await relay(async () => ({}));
    r.stdin.emit('end');
    await vi.advanceTimersByTimeAsync(101);
    expect(r.stdout.write).toHaveBeenCalledWith('{"relay":"closed"}\n');
    expect(r.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(r.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(r.exit).toHaveBeenCalledTimes(1);
  });

  it('aborts startup and exits when the owner closes before DevTools creates a tab', async () => {
    vi.useFakeTimers();
    const r = await relay(async () => ({}), { createReply: (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled synthetic startup')));
    }) });
    expect(r.fetch).toHaveBeenCalledTimes(1);
    r.stdin.emit('end');
    await r.initialized;
    await vi.advanceTimersByTimeAsync(101);
    expect(r.fetch.mock.calls[0]![1]!.signal.aborted).toBe(true);
    expect(r.socket).toBeUndefined();
    expect(r.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('cleans up the created tab when its DevTools WebSocket never opens', async () => {
    vi.useFakeTimers();
    const r = await relay(async () => ({}), { connect: false });
    await vi.advanceTimersByTimeAsync(5101);
    expect(r.stdout.write).toHaveBeenCalledWith('{"relay":"error","message":"its browser did not answer"}\n');
    expect(r.socket.close).toHaveBeenCalledOnce();
    expect(r.exit).toHaveBeenCalledExactlyOnceWith(4);
    expect(r.fetch).toHaveBeenCalledTimes(2);
  });

  it('times out a DevTools create-tab request and reports why the panel closed', async () => {
    vi.useFakeTimers();
    const r = await relay(async () => ({}), { createReply: (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('synthetic timeout')));
    }) });
    await vi.advanceTimersByTimeAsync(5101);
    await r.initialized;
    expect(r.stdout.write).toHaveBeenCalledWith('{"relay":"error","message":"its browser did not answer"}\n');
    expect(r.socket).toBeUndefined();
    expect(r.exit).toHaveBeenCalledExactlyOnceWith(4);
  });
});
