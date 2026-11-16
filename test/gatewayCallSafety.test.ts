import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayCallAs } from '../src/orchestrator/consoleAccess.js';

class Socket {
  static latest: Socket;
  onmessage: ((event: { data: unknown }) => Promise<void> | void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  closed = false;
  failSend = false;
  constructor() { Socket.latest = this; }
  send(_message: string) { if (this.failSend) throw new Error('fixture send failed'); }
  close() { this.closed = true; }
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket); });
afterEach(() => { Socket.latest?.onerror?.(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('gateway console handshake error containment', () => {
  it.each(['null', '[]', '42', '"invalid frame"'])('refuses non-object frame %s without an unhandled message-handler rejection', async (data) => {
    const result = gatewayCallAs({ host: '127.0.0.1', port: 1234 }, 'fixture-identity', []).catch((error: unknown) => error);
    const socket = Socket.latest;
    await expect(Promise.resolve(socket.onmessage!({ data }))).resolves.toBeUndefined();
    expect(socket.closed).toBe(true);
    expect(await result).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains a send failure during the asynchronous challenge handler', async () => {
    const result = gatewayCallAs({ host: '127.0.0.1', port: 1234 }, 'fixture-identity', []).catch((error: unknown) => error);
    const socket = Socket.latest; socket.failSend = true;
    await expect(Promise.resolve(socket.onmessage!({ data: JSON.stringify({ type: 'event', event: 'connect.challenge' }) }))).resolves.toBeUndefined();
    expect(socket.closed).toBe(true);
    expect(await result).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
