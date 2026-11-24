/**
 * HB-1375: setup saves https://<bind or localhost>:<port> for the CLI when
 * Hatchabot serves TLS itself, but a plain fetch trusts only Node's bundled
 * authorities and checks the name, so a self-signed or mkcert certificate, or
 * one naming the machine's real name, failed every command. The CLI now
 * trusts the install's own certificate at its own address, pinned to it.
 * Certificates are made here with openssl for made-up names; the servers
 * listen on loopback only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFetch, installTlsSettings, ownTls, pinnedFetch } from '../src/config/installTls.js';
import { noAnswer } from '../src/cli.js';

const haveOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const dir = mkdtempSync(join(tmpdir(), 'hb-install-tls-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore', cwd: dir });
/** A self-signed certificate for `san`. */
function selfSigned(name: string, san: string) {
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-subj', `/CN=${name}`, '-addext', `subjectAltName=${san}`);
  return { key: join(dir, `${name}.key`), cert: join(dir, `${name}.pem`) };
}
/** A certificate a local authority signed, as mkcert makes one: the file holds it, not the authority. */
function localCaSigned(name: string, san: string) {
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', `${name}-ca.key`, '-out', `${name}-ca.pem`, '-subj', `/CN=${name} made-up local CA`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
  ssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${name}-ca.pem`, '-CAkey', `${name}-ca.key`, '-CAcreateserial', '-days', '1', '-out', `${name}.pem`, '-extfile', `${name}.ext`);
  return { key: join(dir, `${name}.key`), cert: join(dir, `${name}.pem`) };
}

/** A certificate for `san` that `ca` (a key and certificate) signed. */
function signedBy(name: string, san: string, ca: { key: string; cert: string }) {
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
  ssl('x509', '-req', '-in', `${name}.csr`, '-CA', ca.cert, '-CAkey', ca.key, '-CAcreateserial', '-days', '1', '-out', `${name}.pem`, '-extfile', `${name}.ext`);
  return { key: join(dir, `${name}.key`), cert: join(dir, `${name}.pem`) };
}
/** An https listener on 127.0.0.1 presenting `pair`, counting the requests that reach it. */
async function counting(pair: { key: string; cert: string }) {
  const seen: string[] = [];
  const s = createServer({ key: readFileSync(pair.key), cert: readFileSync(pair.cert) }, (req, res) => { seen.push(String(req.headers.authorization)); res.writeHead(200); res.end('answered'); });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `https://127.0.0.1:${(s.address() as { port: number }).port}`, seen };
}

const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });
/** An https listener on 127.0.0.1 presenting `pair`: /v1/config, a login that sets a cookie, and an echo of what was sent. */
async function serve(pair: { key: string; cert: string }): Promise<string> {
  const s = createServer({ key: readFileSync(pair.key), cert: readFileSync(pair.cert) }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/v1/config') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"authMode":"accounts"}'); return; }
      if (req.url === '/v1/login') { res.writeHead(204, { 'set-cookie': 'made-up-session=abc; Path=/; HttpOnly' }); res.end(); return; }
      if (req.url === '/slow') return; // never answers
      if (req.url === '/drop') { req.socket.destroy(); return; } // the connection drops
      if (req.url === '/trickle') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('the first part '); return; } // its body never ends
      if (req.url === '/redirect') { res.writeHead(302, { location: 'https://made-up-elsewhere.example.org/v1/config' }); res.end(); return; }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, type: req.headers['content-type'], auth: req.headers.authorization, body }));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `https://127.0.0.1:${(s.address() as { port: number }).port}`;
}
const envFile = (lines: string[]) => { const f = join(dir, `env-${Math.random().toString(36).slice(2)}`); writeFileSync(f, lines.join('\n') + '\n'); return f; };

describe.skipIf(!haveOpenssl)('the CLI reaches its own https listener (HB-1375)', () => {
  let named: { key: string; cert: string }; let mkcert: { key: string; cert: string }; let impostor: { key: string; cert: string };
  let namedUrl = '', mkcertUrl = '', impostorUrl = '';
  beforeAll(async () => {
    // The machine's real name, not the address setup saved.
    named = selfSigned('named', 'DNS:made-up-box.example.org');
    mkcert = localCaSigned('mkcert', 'DNS:made-up-box.example.org');
    impostor = selfSigned('impostor', 'IP:127.0.0.1,DNS:localhost');
    [namedUrl, mkcertUrl, impostorUrl] = await Promise.all([serve(named), serve(mkcert), serve(impostor)]);
  });

  it('a plain fetch cannot: the certificate is no authority Node knows, and names another name', async () => {
    await expect(fetch(`${namedUrl}/v1/config`)).rejects.toThrow();
  });

  it('a self-signed certificate naming the machine: config, a login\'s cookie, a body sent and answered', async () => {
    const env = envFile([`HATCHABOT_TLS_CERT=${named.cert}`]);
    const cfg = await installFetch(`${namedUrl}/v1/config`, {}, env);
    expect(cfg.status).toBe(200);
    expect(await cfg.json()).toEqual({ authMode: 'accounts' });
    const login = await installFetch(`${namedUrl}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"made-up"}' }, env);
    expect(login.status).toBe(204);
    expect(login.headers.get('set-cookie')?.split(';')[0]).toBe('made-up-session=abc');
    const up = await installFetch(`${namedUrl}/v1/agents/x/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer made-up-cli-credential' }, body: Buffer.from('made-up bytes') }, env);
    expect(up.status).toBe(201);
    expect(await up.json()).toEqual({ method: 'POST', type: 'application/octet-stream', auth: 'Bearer made-up-cli-credential', body: 'made-up bytes' });
  });

  it('a certificate a local authority signed (mkcert), with the authority not in the file', async () => {
    const r = await installFetch(`${mkcertUrl}/v1/config`, {}, envFile([`HATCHABOT_TLS_CERT='${mkcert.cert}'`]));
    expect(await r.json()).toEqual({ authMode: 'accounts' });
  });

  it('pinned: another certificate at that address is checked as fetch checks it, and refused', async () => {
    await expect(installFetch(`${impostorUrl}/v1/config`, {}, envFile([`HATCHABOT_TLS_CERT=${named.cert}`]))).rejects.toThrow();
  });

  it('trusts the file\'s first certificate as itself only: not a local authority beside it, nor a certificate it signed (review of HB-1375)', async () => {
    const bearer = { headers: { authorization: 'Bearer made-up-cli-credential' } };
    // The install's leaf, then a made-up local authority, in one file; another server here has a leaf that authority signed.
    const ca = { key: join(dir, 'beside-ca.key'), cert: join(dir, 'beside-ca.pem') };
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', ca.key, '-out', ca.cert, '-subj', '/CN=made-up beside CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
    const bundle = join(dir, 'bundle.pem');
    writeFileSync(bundle, readFileSync(named.cert, 'utf8') + readFileSync(ca.cert, 'utf8'));
    const other = await counting(signedBy('by-beside-ca', 'IP:127.0.0.1', ca));
    await expect(installFetch(`${other.url}/v1/agents`, bearer, envFile([`HATCHABOT_TLS_CERT=${bundle}`]))).rejects.toMatchObject({ message: 'fetch failed' });
    expect(other.seen).toEqual([]);
    // The install's own self-signed certificate is an authority too: one its key signed for this address.
    const pinned = { key: join(dir, 'pinned-ca.key'), cert: join(dir, 'pinned-ca.pem') };
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', pinned.key, '-out', pinned.cert, '-subj', '/CN=made-up-box.example.org',
      '-addext', 'subjectAltName=DNS:made-up-box.example.org', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment');
    const child = await counting(signedBy('by-pinned', 'IP:127.0.0.1', pinned));
    const refused = await installFetch(`${child.url}/v1/agents`, bearer, envFile([`HATCHABOT_TLS_CERT=${pinned.cert}`])).then(() => undefined, (e: { message?: string; cause?: { message?: string } }) => e);
    expect(refused).toMatchObject({ message: 'fetch failed', cause: { message: expect.stringContaining('is signed by it: that one is trusted as itself only') } });
    expect(child.seen).toEqual([]);
    // The pinned certificate itself still passes.
    const own = await counting(pinned);
    expect((await installFetch(`${own.url}/v1/agents`, bearer, envFile([`HATCHABOT_TLS_CERT=${pinned.cert}`]))).status).toBe(200);
    expect(own.seen).toEqual(['Bearer made-up-cli-credential']);
  });

  it('a request cut off by its signal ends, with the signal\'s reason as fetch gives it', async () => {
    const tls = ownTls(namedUrl, { cert: named.cert })!;
    const started = Date.now();
    await expect(pinnedFetch(`${namedUrl}/slow`, { signal: AbortSignal.timeout(200) }, tls)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('has fetch\'s own bounds: a connection, the answer\'s headers, and its body, each in time; an abort while the body streams ends it with the signal\'s reason; a redirect is not followed (review of HB-1375)', async () => {
    const tls = ownTls(namedUrl, { cert: named.cert })!;
    // What a hang would be, said in time: the old code had none of these bounds.
    const within = <T>(p: Promise<T>) => Promise.race([p.then((v) => ({ v }), (e: unknown) => ({ e })), new Promise<{ hung: true }>((r) => setTimeout(() => r({ hung: true }), 5_000))]);
    const bounds = { connect: 300, headers: 300, body: 300 };
    // A listener that takes the connection and never says a word of TLS.
    const silent = createTcpServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    try {
      const silentUrl = `https://127.0.0.1:${(silent.address() as { port: number }).port}`;
      expect(await within(pinnedFetch(`${silentUrl}/v1/config`, {}, tls, bounds))).toMatchObject({ e: { message: 'fetch failed', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } } });
    } finally { silent.close(); }
    expect(await within(pinnedFetch(`${namedUrl}/slow`, {}, tls, bounds))).toMatchObject({ e: { message: 'fetch failed', cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } } });
    const trickle = await pinnedFetch(`${namedUrl}/trickle`, {}, tls, bounds);
    expect(await within(trickle.text())).toMatchObject({ e: { message: 'terminated', cause: { code: 'UND_ERR_BODY_TIMEOUT' } } });
    // Within the bounds, an abort while the body streams: the signal's own reason, as fetch rejects.
    const signal = AbortSignal.timeout(300);
    const streaming = await pinnedFetch(`${namedUrl}/trickle`, { signal }, tls);
    const aborted = await within(streaming.text());
    expect(aborted).toMatchObject({ e: { name: 'TimeoutError' } });
    expect((aborted as { e?: unknown }).e).toBe(signal.reason);
    expect(await within(pinnedFetch(`${namedUrl}/redirect`, {}, tls))).toMatchObject({
      e: { message: `${namedUrl}/redirect answered 302, a redirect to https://made-up-elsewhere.example.org/v1/config: a request to the install's own https address follows none` },
    });
  });

  it('fails as fetch fails, so a dropped connection reads as no answer and a hand-over is sent again', async () => {
    const env = envFile([`HATCHABOT_TLS_CERT=${named.cert}`]);
    const dropped = await installFetch(`${namedUrl}/drop`, { method: 'POST', body: '{}' }, env).then(() => undefined, (e: unknown) => e);
    expect(dropped).toBeInstanceOf(TypeError);
    expect(dropped).toMatchObject({ message: 'fetch failed', cause: { code: 'ECONNRESET' } });
    expect(noAnswer(dropped)).toBe(true);
    // A certificate refused is fetch's "fetch failed" too, not an answer.
    const refused = await installFetch(`${impostorUrl}/v1/config`, {}, env).then(() => undefined, (e: unknown) => e);
    expect(refused).toMatchObject({ message: 'fetch failed', cause: { code: expect.any(String) } });
  });

  it('only for this install\'s own https address, with its certificate there', () => {
    const cert = named.cert;
    for (const url of ['https://localhost:8443', 'https://127.0.0.1:8443/', 'https://[::1]:8443', 'https://192.0.2.7:8443']) {
      expect(ownTls(url, { cert, bind: '192.0.2.7' }), url).toMatchObject({ fingerprint256: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/) });
    }
    expect(ownTls('https://[fd00::7]:8443', { cert, bind: 'fd00::7' })).toBeDefined();
    expect(ownTls('https://[fd00::7]:8443', { cert, bind: '[fd00::7]' })).toBeDefined();
    // Another machine, plain http, no certificate set, or one that does not read: a plain fetch.
    expect(ownTls('https://made-up-box.example.org:8443', { cert, bind: '192.0.2.7' })).toBeUndefined();
    expect(ownTls('https://192.0.2.8:8443', { cert, bind: '192.0.2.7' })).toBeUndefined();
    expect(ownTls('http://127.0.0.1:8080', { cert })).toBeUndefined();
    expect(ownTls('https://127.0.0.1:8443', {})).toBeUndefined();
    expect(ownTls('https://127.0.0.1:8443', { cert: join(dir, 'absent.pem') })).toBeUndefined();
  });

  it('reads the certificate and bind address from the install\'s .env as the service does', () => {
    expect(installTlsSettings(envFile(['HATCHABOT_TLS_CERT=/made-up/a.pem', 'HATCHABOT_BIND=192.0.2.7', '# HATCHABOT_BIND=192.0.2.9']))).toEqual({ cert: '/made-up/a.pem', bind: '192.0.2.7' });
    expect(installTlsSettings(envFile(['AGENTCLAW_TLS_CERT="/made-up/old.pem"']))).toEqual({ cert: '/made-up/old.pem', bind: undefined });
    expect(installTlsSettings(envFile(['HATCHABOT_TLS_CERT=']))).toEqual({ cert: undefined, bind: undefined });
    expect(installTlsSettings(join(dir, 'no-such.env'))).toEqual({});
  });
});

describe('the CLI sends its requests to its install through installRequest (HB-1375)', () => {
  it('no plain fetch of the install\'s address is left in src/cli.ts', () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).toMatch(/installRequest\(`\$\{ctx\.url\}\$\{path\}`/);
    // Every fetch in it, however it is written (in brackets, through a
    // variable, as globalThis.fetch), is one of these: installRequest's own,
    // for an address that is not https, or one of Google's. A guard that
    // looked for `fetch(` and `await fetch(` alone let
    // await (fetch(`${base}/v1/config`)) through (review of HB-1375).
    const plain = 'if (!/^https:/i.test(url)) return fetch(url, init);';
    const google = /^fetch\(\s*`https:\/\/[a-z]+\.googleapis\.com\//;
    let installs = 0, start = 0;
    src.split('\n').forEach((raw, i) => {
      // A comment's line, or the comment after the code, says fetch in words.
      const line = /^\s*(\*|\/\/|\/\*)/.test(raw) ? '' : raw.replace(/\s\/\/.*$/, '');
      for (const m of line.matchAll(/(?<![\w$])fetch(?![\w$])/g)) {
        const at = m.index!;
        if (/^['"]fetch failed['"]$/.test(line.slice(at - 1, at + 13))) continue; // the error's message, compared
        if (line.trim() === plain) { installs++; continue; }
        expect(google.test(src.slice(start + at)), `src/cli.ts:${i + 1}: ${raw.trim()}`).toBe(true);
      }
      start += raw.length + 1;
    });
    expect(installs).toBe(1);
  });
});
