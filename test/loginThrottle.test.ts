import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAuth, _resetLoginThrottle } from '../src/api/auth.js';

async function app(password = 'pw') {
  const f = Fastify();
  await registerAuth(f, { password, secret: Buffer.alloc(32, 7), mode: 'password' });
  f.get('/v1/x', async () => ({ ok: true }));
  await f.ready();
  return f;
}

describe('password login throttle (audit 2026-09-13)', () => {
  afterEach(() => { _resetLoginThrottle(); delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; });
  it('429s a client after repeated wrong passwords, and a right one still counts as blocked', async () => {
    process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '3';
    const f = await app();
    const bad = () => f.inject({ method: 'POST', url: '/v1/login', payload: { password: 'nope' } });
    for (let i = 0; i < 3; i++) expect((await bad()).statusCode).toBe(401);
    expect((await bad()).statusCode).toBe(429);
    expect((await f.inject({ method: 'POST', url: '/v1/login', payload: { password: 'pw' } })).statusCode).toBe(429);
    await f.close();
  }, 15_000);
});
