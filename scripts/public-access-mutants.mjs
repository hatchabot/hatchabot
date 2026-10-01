#!/usr/bin/env node
/**
 * Mutant check for the public-access safeguards (docs/public-access.md).
 *
 * A test that passes with the guard in place proves little unless it also
 * FAILS with the guard taken out. Each mutant below removes one guard (one
 * exact piece of source text, replaced by text that disables it) and runs the
 * tests that are supposed to notice. A mutant the tests still pass on is
 * "survived": a guard nothing is watching. This script exits 1 on any.
 *
 *   node scripts/public-access-mutants.mjs            # all mutants
 *   node scripts/public-access-mutants.mjs pass idle  # only those whose name contains a word
 *
 * It works on a COPY of the tree in a temp directory (node_modules linked),
 * so the checkout is never touched and a crash cannot leave a mutant behind.
 * It is not part of `npm test` (about a minute per ten mutants); run it when
 * the gate, the trust rules or the route table change.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = 'test/publicGate.test.ts';
const TRUST = 'test/publicTrust.test.ts';
const SF = 'test/secondFactorApi.test.ts';
const NOTICES = 'test/publicNotices.test.ts';
const REACH = 'test/reach.test.ts';
const GUARDS = 'test/safeguards.test.ts';
const ROUTES = 'test/publicRoutes.test.ts';

/** name, file, the guard's exact text, what replaces it, the tests that must then fail. */
const MUTANTS = [
  ['trust: nothing is ever public', 'src/api/trust.ts', "if (socket && publicSockets.has(socket)) return true;", '', [GATE, TRUST]],
  ['trust: a replay of a public request is private', 'src/api/mgmtChat.ts', 'Object.assign(headers, publicReplayHeaders(req));', '', [TRUST]],
  ['trust: public traffic counts as "on this machine"', 'src/api/accountsAuth.ts', "  if (isPublic(req)) return false;\n  // A rootless", "  // A rootless", [TRUST]],
  ['trust: the in-process secret works publicly', 'src/api/principal.ts', "  if (isPublic(req)) return undefined;\n", '', [TRUST]],
  ['trust: the owner header works publicly', 'src/api/principal.ts', "typeof raw === 'string' && raw && !isPublic(req)", "typeof raw === 'string' && raw", [TRUST]],
  ['trust: command-line tokens work publicly', 'src/api/auth.ts', "  if (isPublic(req)) return undefined;\n  const authz = req.headers.authorization;", "  const authz = req.headers.authorization;", [TRUST]],
  ['trust: Google bearer tokens work publicly', 'src/api/auth.ts', "!CONSOLE_PATH.test(path) && !isPublic(req)", "!CONSOLE_PATH.test(path)", [NOTICES]],
  ['trust: https decided by a header publicly', 'src/api/sessionCookie.ts', "  if (isPublic(req)) return true;\n", '', [GATE, TRUST]],
  ['trust: the first forwarded address is believed', 'src/api/trust.ts', "return s?.split(',').pop()?.trim() || undefined;", "return s?.split(',')[0]?.trim() || undefined;", [TRUST]],
  ['gate: serves with a safeguard off', 'src/api/publicAccess.ts', "if (!serving) return reply.code(503)", "if (false) return reply.code(503)", [GATE]],
  ['gate: failing safeguards still count as serving', 'src/api/publicAccess.ts', "opts.mode !== 'password' && failing.length === 0;", "opts.mode !== 'password';", [GATE, SF]],
  // A second lock behind safeguard a (which already fails in password mode): removing it alone changes nothing, by design.
  ['gate: password mode may serve', 'src/api/publicAccess.ts', "!!store && opts.mode !== 'password' && failing", "!!store && failing", [GATE], 'equivalent'],
  ['gate: never-routes are let through', 'src/api/publicAccess.ts', "if (!rule || rule.cls === 'never') {", "if (!rule) {", [GATE]],
  ['gate: unclassified routes are signed-in', 'src/api/publicRoutes.ts', "return publicRuleFor(method, pattern)?.cls ?? 'never';", "return publicRuleFor(method, pattern)?.cls ?? 'signed-in';", [ROUTES]],
  ['gate: unclassified routes are let through', 'src/api/publicAccess.ts', "const rule = publicRuleFor(req.method, req.routeOptions?.url);\n    if (!rule || rule.cls === 'never') {", "const rule = publicRuleFor(req.method, req.routeOptions?.url) ?? { methods: '*', pattern: /x/, cls: 'signed-in', group: 'mutant' };\n    if (rule.cls === 'never') {", [GATE]],
  ['gate: the host name is not checked', 'src/api/publicAccess.ts', "if (askedHost && mine && askedHost !== mine)", "if (false)", [TRUST]],
  ['gate: no public pass needed', 'src/api/publicAccess.ts', "      if (!pass) {\n        // A session from the private address", "      if (false) {\n        // A session from the private address", [GATE]],
  ['pass: not bound to its session', 'src/api/publicAccess.ts', "if (pass.sess.length !== want.length || !timingSafeEqual(Buffer.from(pass.sess), Buffer.from(want))) return undefined;", '', [GATE]],
  ['pass: the signature is not checked', 'src/api/publicAccess.ts', "if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return undefined;", '', [GATE]],
  ['pass: never idles out', 'src/api/publicAccess.ts', "if (pass.seen > now + 60_000 || now - pass.seen > publicConfig().idleMs) return undefined;", '', [GATE]],
  ['pass: a new sign-in inherits the second factor', 'src/api/publicAccess.ts', "if (req.principal && req.routeOptions?.url === '/v1/local-accounts/:id/password') {\n      sfAt = passOf(req, sessionValue(req))?.sfAt ?? 0;\n    }", "sfAt = Date.now();", [GATE]],
  ['2fa: not asked for at sign-in', 'src/api/publicAccess.ts', "if (need === 'yes' && pass.sfAt === 0) {\n        return reply", "if (false) {\n        return reply", [GATE]],
  ['2fa: step-up never expires', 'src/api/publicAccess.ts', "if (now - pass.sfAt > publicConfig().stepUpMs) {", "if (false) {", [GATE, SF]],
  ['2fa: step-up open to people without a factor', 'src/api/publicAccess.ts', "          if (rule.firstFactorOk) return;\n          return reply.code(403)", "          return;\n          return reply.code(403)", [GATE]],
  ['2fa: the socket skips the second factor', 'src/api/publicAccess.ts', "if (need === 'yes' && pass.sfAt === 0) return 'second factor not given';", '', [NOTICES]],
  ['2fa: the socket needs no pass', 'src/api/publicAccess.ts', "if (!pass) return 'no public pass';", "if (!pass) return undefined;", [NOTICES]],
  ['2fa: a TOTP code works twice', 'src/api/secondFactor.ts', "if (step !== undefined && store.advanceTotpStep(row.id, step)) { method = 'totp'; break; }", "if (step !== undefined) { method = 'totp'; break; }", [SF]],
  ['2fa: any passkey of anyone', 'src/api/secondFactor.ts', "row.ownerId === ownerId && row.kind === 'passkey'", "row.kind === 'passkey'", [SF]],
  ['2fa: the passkey challenge can be reused', 'src/api/secondFactor.ts', "    const c = challenges.get(key);\n    challenges.delete(key);", "    const c = challenges.get(key);", [SF]],
  ['2fa: factors change without proof', 'src/api/secondFactor.ts', "    if (!local) return true; // a Google account: Google is its password", "    return true;", [SF]],
  ['2fa: guesses are not limited', 'src/api/secondFactor.ts', "if (api.throttle.throttled(req, bucket, '2fa')) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });\n    const body", "const body", [TRUST]],
  ['2fa: the owner may drop the last factor with public access on', 'src/api/secondFactor.ts', "if (api.config().on && api.hasOwnerRights(ownerId) && usableAfter === 0) {", "if (false) {", [SF]],
  ['2fa: anyone may reset anyone', 'src/api/secondFactor.ts', "    if (!api.hasOwnerRights(ownerId)) {", "    if (false) {", [SF]],
  ['invited: any Google account may sign in publicly', 'src/api/auth.ts', "if (isPublic(req) && !(opts.store?.identityIsInvited(token.sub, token.email) ?? false)) {", "if (false) {", [NOTICES]],
  ['invited: the owner may be claimed publicly (page)', 'src/api/accountsAuth.ts', "    if (ownerFirstClaimFromPublic(req, account)) return reply.code(403).send({ error: OWNER_CLAIM_PRIVATE_ONLY });\n    const { hash, salt }", "    const { hash, salt }", [TRUST]],
  ['limits: public failures share the private buckets', 'src/api/auth.ts', "  if (isPublic(req)) {\n    const keys = [`pub:ip:", "  if (false) {\n    const keys = [`pub:ip:", [TRUST]],
  ['limits: no ceiling on all public failures', 'src/api/auth.ts', "    keys.push('pub:all');\n", '', [TRUST]],
  ['limits: lockouts do not back off', 'src/api/auth.ts', "return Math.min(FAIL_WINDOW_MS * 2 ** (n - 1), STRIKE_MEMORY_MS);", "return FAIL_WINDOW_MS;", [TRUST]],
  ['limits: no request ceiling', 'src/api/publicAccess.ts', "return total > cfg.requestsPerMinute || n > cfg.requestsPerMinutePerAddress;", "return false;", [TRUST]],
  ['notice: no new-device notice', 'src/api/publicAccess.ts', "    tell(ownerId, mine);\n    for (const a of admins()) if (a.id !== ownerId) tell(a.id, theirs);", '', [NOTICES]],
  ['notice: the owner is not told about others', 'src/api/publicAccess.ts', "    for (const a of admins()) if (a.id !== ownerId) tell(a.id, theirs);", '', [NOTICES]],
  ['notice: every sign-in is "known"', 'src/api/publicAccess.ts', "if (device && store) isNew = store.noteDevice(ownerId, sha(device), label, source);", "isNew = false;", [NOTICES]],
  ['record: public sign-ins are not recorded', 'src/api/publicAccess.ts', "record('public.signin', ownerId, { from, device: label, newDevice: isNew });", '', [NOTICES]],
  ['record: failure bursts are not recorded', 'src/api/auth.ts', "req.server.publicAccess?.failureBurst(req, k, cur.until);", '', [TRUST]],
  ['record: the switch is not recorded', 'src/api/reachRoutes.ts', "store.recordSecurity('public.on', req.principal?.ownerId, { url: fun.url, provider: 'funnel' });", '', [REACH]],
  ['headers: no HSTS', 'src/api/publicAccess.ts', "reply.header('strict-transport-security', 'max-age=604800');", '', [GATE]],
  ['headers: no content security policy', 'src/api/publicAccess.ts', "if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', publicCsp(opts.mode));", '', [GATE]],
  ['switch: on without the safeguards', 'src/api/reachRoutes.ts', "      if (failing.length) {\n        return reply.code(409)", "      if (false) {\n        return reply.code(409)", [REACH]],
  ['switch: on without a confirmation', 'src/api/reachRoutes.ts', "if (req.body?.confirm !== true) {", "if (false) {", [REACH]],
  ['switch: a member may flip it', 'src/api/reachRoutes.ts', "return deps.ownsLocalHost(req) ? undefined : OWNER_ONLY;", "return undefined;", [REACH]],
  ['switch: Funnel on the private port is not noticed', 'src/api/safeguards.ts', "const listenerOk = !clash && !f.ownerHeader && f.funnelOnPrivatePort !== true;", "const listenerOk = !clash && !f.ownerHeader;", [GUARDS, REACH]],
  ['switch: off leaves Funnel on', 'src/api/reachRoutes.ts', "      const r = await funnelOff(cfg.port, cfg.funnelPort);\n      if (!r.ok) { funnelError = r.error; command = r.command; }", "", [REACH]],
  ['switch: off leaves the listener open', 'src/api/reachRoutes.ts', "    else await api.stopListener();", "", [REACH]],
  ['switch: invited-only can be turned off while on', 'src/api/reachRoutes.ts', "if (!on && api.config().on) return reply.code(409)", "if (false) return reply.code(409)", [REACH]],
  ['safeguard a: password mode passes', 'src/api/safeguards.ts', "const modeOk = f.authMode === 'accounts' || f.authMode === 'identity';", "const modeOk = true;", [GUARDS]],
  ['safeguard b: an owner without a factor passes', 'src/api/safeguards.ts', "ok: claimed && without.length === 0,", "ok: claimed,", [GUARDS]],
  ['safeguard b: an unclaimed machine passes', 'src/api/safeguards.ts', "ok: claimed && without.length === 0,", "ok: without.length === 0,", [GUARDS]],
  ['safeguard c: invited-only off passes', 'src/api/safeguards.ts', "title: 'Only invited people', ok: f.invitedOnly,", "title: 'Only invited people', ok: true,", [GUARDS]],
  ['safeguard i: no automatic upgrades passes', 'src/api/safeguards.ts', "title: 'Automatic upgrades on the stable channel', ok: f.autoUpgrade.ok,", "title: 'Automatic upgrades on the stable channel', ok: true,", [GUARDS]],
  ['safeguard i: a pinned machine counts as upgrading', 'src/ops/autoUpgrade.ts', "if (pin && /^v[0-9]/.test(pin)) return", "if (false) return", [GUARDS]],
  ['doctor: a safeguard off is only a warning', 'src/doctor.ts', "out.push({ level: c.ok ? 'ok' : 'fail', text: `  ${c.letter}.", "out.push({ level: c.ok ? 'ok' : 'warn', text: `  ${c.letter}.", [GUARDS]],
];

const only = process.argv.slice(2);
const work = mkdtempSync(join(tmpdir(), 'hb-mutants-'));
let survived = 0, killed = 0, skipped = 0;
try {
  for (const d of ['src', 'test', 'web', 'docs', 'scripts']) cpSync(join(root, d), join(work, d), { recursive: true });
  for (const f of ['package.json', 'tsconfig.json', 'vitest.config.ts', 'channels.json', '.env.example']) cpSync(join(root, f), join(work, f));
  symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'));
  // No mutant below touches src/ops/tailnet.ts's rule that, under a test
  // runner, nothing changes Tailscale unless the test names its own shim: a
  // mutant of THAT rule would let a test run the real `tailscale funnel`.
  const env = { ...process.env };
  delete env.HATCHABOT_TAILSCALE_BIN;
  for (const [name, file, find, replace, tests, note] of MUTANTS) {
    if (only.length && !only.some((w) => name.includes(w))) continue;
    const path = join(work, file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(find)) { console.log(`✗ ${name} — the guard's text was not found in ${file} (update this script)`); survived++; continue; }
    writeFileSync(path, original.replace(find, replace));
    const r = spawnSync('npx', ['vitest', 'run', ...tests], { cwd: work, env, encoding: 'utf8', timeout: 300_000 });
    writeFileSync(path, original);
    if (r.status === 0) {
      if (note === 'equivalent') { console.log(`~ ${name} — survives, as expected (another check covers it)`); skipped++; }
      else { console.log(`✗ ${name} — SURVIVED: ${tests.join(', ')} still pass without this guard`); survived++; }
    } else { console.log(`✓ ${name}`); killed++; }
  }
  // The copy must pass untouched, or "killed" means nothing.
  const base = spawnSync('npx', ['vitest', 'run', GATE, TRUST, SF, NOTICES, REACH, GUARDS, ROUTES], { cwd: work, env, encoding: 'utf8', timeout: 600_000 });
  if (base.status !== 0) { console.log('✗ the unmutated copy does not pass its own tests: every result above is void'); survived++; }
  console.log(`${killed} killed, ${survived} survived, ${skipped} not counted`);
  process.exitCode = survived ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
}
