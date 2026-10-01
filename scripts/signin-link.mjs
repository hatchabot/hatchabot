#!/usr/bin/env node
/**
 * One-time sign-in links for a Hatchabot (docs/signin-links.md): the reference
 * signer a provider's account page and its provisioner use. No dependencies.
 *
 *   node scripts/signin-link.mjs keygen <prefix>
 *       Writes <prefix>.key (the PRIVATE key, mode 600: stays with whoever
 *       mints links) and <prefix>.pub (the public key: goes to the Hatchabot,
 *       named by HATCHABOT_SIGNIN_KEY_FILE). Never overwrites.
 *
 *   node scripts/signin-link.mjs sign --key <prefix>.key --url <its public URL>
 *       [--owner | --account <username or email>] [--ttl <seconds, ≤ 600; default 300>]
 *       Prints the link. --owner (the default) is the machine's owner.
 *
 * Prints no key material. Import it to sign in-process: signinLink({ privateKey, url, owner | account, ttl }).
 */
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONTEXT = 'hatchabot-signin-link/v1\n';
export const MAX_TTL = 600;

/** The token: base64url(JSON claims) "." base64url(Ed25519 over CONTEXT + that first part). */
export function signinToken({ privateKey, url, owner, account, ttl = 300, now = Date.now(), nonce = randomBytes(18).toString('base64url') }) {
  const key = typeof privateKey === 'string' || Buffer.isBuffer(privateKey) ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the key must be an Ed25519 private key');
  const aud = new URL(url).origin;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL) throw new Error(`--ttl must be 1–${MAX_TTL} seconds`);
  if (!!owner === !!account) throw new Error('name either the owner or one account');
  const iat = Math.floor(now / 1000);
  const claims = { v: 1, aud, sub: owner ? 'owner' : `user:${account}`, iat, exp: iat + ttl, nonce };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = sign(null, Buffer.from(CONTEXT + body, 'ascii'), key).toString('base64url');
  return `${body}.${sig}`;
}

/** The whole link: <origin>/signin/link?t=<token>. */
export function signinLink(opts) {
  return `${new URL(opts.url).origin}/signin/link?t=${signinToken(opts)}`;
}

export function keygen(prefix) {
  const priv = `${prefix}.key`, pub = `${prefix}.pub`;
  for (const f of [priv, pub]) if (existsSync(f)) throw new Error(`${f} exists; not overwriting it`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  return { priv, pub };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = new Map();
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--owner') flags.set('owner', true);
    else if (a.startsWith('--')) flags.set(a.slice(2), rest[++i]);
    else pos.push(a);
  }
  if (cmd === 'keygen' && pos[0]) {
    const { priv, pub } = keygen(pos[0]);
    console.log(`Private key: ${priv} (keep it with whoever mints links; never put it on the Hatchabot)`);
    console.log(`Public key:  ${pub} (copy it to the Hatchabot, chmod 600, and set HATCHABOT_SIGNIN_KEY_FILE to its path)`);
    return 0;
  }
  if (cmd === 'sign' && flags.get('key') && flags.get('url')) {
    const account = flags.get('account');
    console.log(signinLink({
      privateKey: readFileSync(flags.get('key')),
      url: flags.get('url'),
      owner: account ? undefined : true,
      account,
      ttl: flags.has('ttl') ? Number(flags.get('ttl')) : 300,
    }));
    return 0;
  }
  console.error('Usage:\n  signin-link.mjs keygen <prefix>\n  signin-link.mjs sign --key <prefix>.key --url <public URL> [--owner | --account <username or email>] [--ttl <s>]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
