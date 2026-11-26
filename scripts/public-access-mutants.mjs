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
 *   node scripts/public-access-mutants.mjs --check    # only that every entry is well formed (its text there once)
 *
 * It works on a COPY of the tree in a temp directory (node_modules linked),
 * so the checkout is never touched and a crash cannot leave a mutant behind.
 * It is not part of `npm test` (about a minute per ten mutants); run it when
 * the gate, the trust rules or the route table change.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const REVIEW = 'test/publicReview.test.ts';
const REVIEW2 = 'test/publicReview2.test.ts';
// The owner's decisions after the second review (2026-10-01), a file per subject so a mutant runs only what watches it.
const DEFAULT2FA = 'test/publicSecondFactorDefault.test.ts';
const RECOVERY = 'test/publicRecovery.test.ts';
const NOTICE_LIMITS = 'test/publicNoticeLimits.test.ts';
const CRASH = 'test/publicCrash.test.ts';
const SMALLER = 'test/publicSmaller.test.ts';
/** The sign-in limits' buckets (HB-1434). */
const NIGHT = 'test/nightAuth.test.ts';
const PROXY = 'test/proxyListener.test.ts';
const REACH_SERVICE = 'test/reachService.test.ts';
const PEER_USER = 'test/peerUser.test.ts';
/** A guest console's door (HB-0645): ConsoleAccess.admitGuest, and the upgrade handler that calls it. */
const GUEST_DOOR = 'test/guestAdmission.test.ts';
const CONSOLE_GUESTS = 'test/consoleGuests.test.ts';

/**
 * name, file, the guard's exact text, what replaces it, the tests that must then fail,
 * and optionally: a note ('equivalent': expected to survive), and a pattern
 * of test names (vitest -t) when only part of a slow file watches the guard.
 */
const MUTANTS = [
  ['trust: nothing is ever public', 'src/api/trust.ts', "if (socket && publicSockets.has(socket)) return true;", '', [GATE, TRUST]],
  ['trust: a replay of a public request is private', 'src/api/ops/mgmtChat.ts', 'Object.assign(headers, publicReplayHeaders(req));', '', [TRUST]],
  ['trust: public traffic counts as "on this machine"', 'src/api/signIn/accountsAuth.ts', "  if (isPublic(req)) return false;\n  // Nor anything on the proxy's listener", "  // Nor anything on the proxy's listener", [TRUST]],
  ['trust: the in-process secret works publicly', 'src/api/principal.ts', "  if (isPublic(req)) return undefined;\n", '', [TRUST]],
  ['trust: the owner header works publicly', 'src/api/principal.ts', "typeof raw === 'string' && raw && !isPublic(req)", "typeof raw === 'string' && raw", [TRUST]],
  ['trust: command-line tokens work publicly', 'src/api/signIn/auth.ts', "  if (isPublic(req)) return undefined;\n  const authz = req.headers.authorization;", "  const authz = req.headers.authorization;", [TRUST]],
  ['trust: Google bearer tokens work publicly', 'src/api/signIn/auth.ts', "!CONSOLE_PATH.test(path) && !isPublic(req)", "!CONSOLE_PATH.test(path)", [NOTICES]],
  ['trust: https decided by a header publicly', 'src/api/signIn/sessionCookie.ts', "  if (isPublic(req)) return true;\n", '', [GATE, TRUST]],
  ['trust: the first forwarded address is believed', 'src/api/trust.ts', "return s?.split(',').pop()?.trim() || undefined;", "return s?.split(',')[0]?.trim() || undefined;", [TRUST]],
  // tailscale serve's own listener (HB-1239, HB-1435): the only place a forwarded address is the client's.
  ['proxy: a forwarded address is believed on any socket', 'src/api/trust.ts', "  if (!viaProxy(req)) return undefined;\n  // Its peer's user is Hatchabot's own, or was not found: the header is not believed.\n  if (proxySockets.get((req as Rawish).raw?.socket ?? (req as Rawish).socket!) !== true) return undefined;\n  const a = last(", "  const a = last(", [PROXY]],
  ['proxy: the listener\'s sockets are not marked', 'src/api/trust.ts', "  proxySockets.set(socket, believed);\n", '', [PROXY]],
  ['proxy: the client\'s own first address is believed there', 'src/api/trust.ts', "!== true) return undefined;\n  const a = last(req.headers['x-forwarded-for']);", "!== true) return undefined;\n  const a = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();", [PROXY]],
  ['proxy: any text there is an address', 'src/api/trust.ts', "  const a = last(req.headers['x-forwarded-for']);\n  return a && /^[0-9a-fA-F:.]{2,45}$/.test(a) ? a : 'unknown';\n}\n\n/**\n * The visitor's address", "  const a = last(req.headers['x-forwarded-for']);\n  return a || 'unknown';\n}\n\n/**\n * The visitor's address", [PROXY, NIGHT]],
  ['proxy: its listener counts as "on this machine"', 'src/api/signIn/accountsAuth.ts', "  if (viaProxy(req)) return false;\n", '', [PROXY]],
  ['proxy: Funnel may publish its port', 'src/ops/tailnet.ts', "  const onPrivate = (e: FunnelEntry) => targetsPort(e, privatePort) || (proxyPort !== undefined && targetsPort(e, proxyPort));", "  const onPrivate = (e: FunnelEntry) => targetsPort(e, privatePort);", [PROXY]],
  ['proxy: the doctor misses Funnel on its port', 'src/doctor.ts', "toPrivatePort: fs.entries.some((e) => targetsPort(e, mainPort) || targetsPort(e, proxy)) }", "toPrivatePort: fs.entries.some((e) => targetsPort(e, mainPort)) }", [PROXY]],
  // Never onto a listener that did not open (the owner's call, 2026-11-24): the tailnet address would stop answering.
  ['proxy: serve is moved at the start onto a listener that did not open', 'src/ops/tailnet.ts', "  if (!listener.listening) return { moved: [], left: serveLeftOnMainPort(", "  if (false) return { moved: [], left: serveLeftOnMainPort(", [PROXY]],
  ['proxy: the setup guide moves or turns on serve with its listener closed', 'src/orchestrator/reach/tailscaleSetup.ts', "      if (!listener.listening) {\n        const error = listenerNotOpen(", "      if (false) {\n        const error = listenerNotOpen(", [REACH_SERVICE]],
  ['proxy: the doctor offers the move with its listener closed', 'src/doctor.ts', "        fix: f.proxyListener?.ok === true\n", "        fix: true\n", [PROXY]],
  ['proxy: the doctor does not say the listener is closed', 'src/doctor.ts', "  if (f.proxyListener && !f.proxyListener.ok) {", "  if (false) {", [PROXY]],
  ['proxy: the doctor asks a port the listener refuses, and finds the app there', 'src/doctor.ts', "  if (clash) return { port, ok: false, clash };", "  if (false) return { port, ok: false, clash };", [PROXY]],
  // X-Forwarded-For only from a peer of another user (the owner's call, 2026-11-24).
  ['proxy: the peer\'s user is not checked', 'src/api/trust.ts', "  if (proxySockets.get((req as Rawish).raw?.socket ?? (req as Rawish).socket!) !== true) return undefined;", "  // unchecked", [PROXY]],
  ['proxy: Hatchabot\'s own user is believed', 'src/ops/peerUser.ts', "  if (own === undefined || peer === own) return false;", "  if (own === undefined) return false;", [PROXY, PEER_USER]],
  ['proxy: a peer that was not found is believed', 'src/ops/peerUser.ts', "  if (peer === undefined) return false;\n  if (trusted.includes(peer)) return true;", "  if (peer === undefined) return true;\n  if (trusted.includes(peer)) return true;", [PROXY, PEER_USER]],
  ['proxy: a client lsof shows under two users is believed', 'src/ops/peerUser.ts', "      return uids?.size === 1 ? [...uids][0] : undefined;", "      return uids ? [...uids][0] : undefined;", [PEER_USER]],
  ['proxy: a closed client socket (listed under uid 0) is believed', 'src/ops/peerUser.ts', "  return ends.length === 1 && ends[0]!.state === ESTABLISHED ? ends[0]!.uid : undefined;", "  return ends.length === 1 ? ends[0]!.uid : undefined;", [PEER_USER]],
  ['proxy: one of two entries for the same ends is believed', 'src/ops/peerUser.ts', "  return ends.length === 1 && ends[0]!.state === ESTABLISHED ? ends[0]!.uid : undefined;", "  return ends.length >= 1 && ends[0]!.state === ESTABLISHED ? ends[0]!.uid : undefined;", [PEER_USER]],
  // The client's socket read first, then Hatchabot's own end of it, by inode, still open: no other connection had those ends between.
  ['proxy: the client\'s socket is believed without its own end still open after', 'src/ops/peerUser.ts', "    return holdsOwnEnd(await read(), peer, listener, inode) ? uid : undefined;", "    return uid;", [PEER_USER]],
  ['proxy: its own end is found by its addresses alone, not its inode', 'src/ops/peerUser.ts', "  return table.ends(listener, peer).some((e) => e.inode === inode);", "  return table.ends(listener, peer).length > 0;", [PEER_USER]],
  ['proxy: the lookup is not told its own end', 'src/api/proxyListener.ts', "retrying: false, inode: socketInode(socket) };", "retrying: false, inode: undefined };", [PROXY]],
  // A flood of connections costs a bounded number of reads and lookups (the review of HB-1239).
  ['proxy: every lookup reads the tables itself', 'src/ops/peerUser.ts', "    if (next) return next;\n    const mine = last.then(", "    if (false) return next;\n    const mine = last.then(", [PEER_USER]],
  ['proxy: a lookup is given a read already under way', 'src/ops/peerUser.ts', "      next = undefined;\n      const r = read();", "      const r = read();", [PEER_USER]],
  ['proxy: lookups waiting at once have no cap', 'src/ops/peerUser.ts', "    if (waiting >= max) return undefined;", "    if (false) return undefined;", [PEER_USER, PROXY]],
  ['proxy: a socket handed to upgrade has no error listener (a reset ends the process)', 'src/api/proxyListener.ts', "    socket.on('error', () => socket.destroy());\n", "", [PROXY]],
  ['proxy: lsof runs on a Mac for every connection, though nothing it finds is believed unlisted', 'src/ops/peerUser.ts', "    if (o.own === undefined || !o.trusted.includes(o.own)) return async () => undefined;", "", [PEER_USER]],
  ['proxy: a connection left "cannot tell" is never asked again (a flood keeps tailscaled\'s in one bucket)', 'src/api/proxyListener.ts', "      if (d && afterAnswer && d.peer === undefined && !d.retrying) {", "      if (false) {", [PROXY]],
  ['proxy: a connection is asked again while it is being asked', 'src/api/proxyListener.ts', "      if (d && afterAnswer && d.peer === undefined && !d.retrying) {", "      if (d && afterAnswer && d.peer === undefined) {", [PROXY]],
  // The alert for a proxy still on the app's port (the review of HB-1239): only true sightings.
  ['alert: a proxy on the app\'s port counted before serve has left it', 'src/api/proxyListener.ts', "    if (!armed || asking || req.headers['x-forwarded-for'] === undefined) return;", "    if (asking || req.headers['x-forwarded-for'] === undefined) return;", [PROXY]],
  ['alert: counted when serve\'s configuration could not be read', 'src/api/proxyListener.ts', "!r.left.length && !r.error;", "!r.left.length;", [PROXY]],
  ['alert: counted from a peer the listener would not believe (a container)', 'src/api/proxyListener.ts', "        if (!believePeer(peer, own, trusted)) return;\n", "", [PROXY]],
  ['alert: counted from the public listener', 'src/api/proxyListener.ts', "    if (viaProxy(req) || isPublic(req) || !LOOPBACK", "    if (viaProxy(req) || !LOOPBACK", [PROXY]],
  ['alert: counted from a peer not on loopback', 'src/api/proxyListener.ts', " || !LOOPBACK.test(req.socket?.remoteAddress ?? '')) return;\n    const socket = req.raw.socket;", ") return;\n    const socket = req.raw.socket;", [PROXY]],
  ['alert: shown however long ago it was seen', 'src/api/proxyListener.ts', "  onAppPort && now - onAppPort.lastSeen < ON_APP_PORT_SHOWN_MS\n", "  onAppPort\n", [PROXY]],
  ['proxy: doctor misses a tailscaled without a TUN device, which lets the tailnet reach the listener itself', 'src/ops/tailnet.ts', "    userspace = st.TUN === false;", "    userspace = false;", [PROXY]],
  ['proxy: the listener for serve opens on every interface', 'src/api/proxyListener.ts', "      s.listen(port, '127.0.0.1', () => {", "      s.listen(port, () => {", [PROXY]],
  ['proxy: the running gate misses Funnel on the listener for serve', 'src/api/machine/reachRoutes.ts', "  return st.readable ? st.entries.some((e) => targetsPort(e, privatePort) || targetsPort(e, proxyPort())) : undefined;", "  return st.readable ? st.entries.some((e) => targetsPort(e, privatePort)) : undefined;", [PROXY]],
  ['proxy: a Funnel entry on the app\'s own port is moved to the listener for serve', 'src/ops/tailnet.ts', "  const stale = before.handlers.filter((h) => !h.funnel && !h.foreground && loopbackTarget(h.proxy, mainPort));", "  const stale = before.handlers.filter((h) => !h.foreground && loopbackTarget(h.proxy, mainPort));", [PROXY]],
  ['proxy: the public listener may have its port', 'src/api/safeguards.ts', "f.ports.embed, ...(f.ports.proxy !== undefined ? [f.ports.proxy] : [])].includes(f.ports.public);", "f.ports.embed].includes(f.ports.public);", [PROXY]],
  ['gate: serves with a safeguard off', 'src/api/publicAccess.ts', "if (!serving) return reply.code(503)", "if (false) return reply.code(503)", [GATE]],
  ['gate: failing safeguards still count as serving', 'src/api/publicAccess.ts', "opts.mode !== 'password' && failing.length === 0;", "opts.mode !== 'password';", [GATE, SF]],
  // A second lock behind safeguard a (which already fails in password mode): removing it alone changes nothing, by design.
  ['gate: password mode may serve', 'src/api/publicAccess.ts', "!!store && opts.mode !== 'password' && failing", "!!store && failing", [GATE], 'equivalent'],
  ['gate: never-routes are let through', 'src/api/publicAccess.ts', "if (!rule || rule.cls === 'never') {", "if (!rule) {", [GATE]],
  ['gate: unclassified routes are signed-in', 'src/api/publicRoutes.ts', "return publicRuleFor(method, pattern)?.cls ?? 'never';", "return publicRuleFor(method, pattern)?.cls ?? 'signed-in';", [ROUTES]],
  ['gate: unclassified routes are let through', 'src/api/publicAccess.ts', "const rule = publicRuleFor(req.method, req.routeOptions?.url);\n    if (!rule || rule.cls === 'never') {", "const rule = publicRuleFor(req.method, req.routeOptions?.url) ?? { methods: '*', pattern: /x/, cls: 'signed-in', group: 'mutant' };\n    if (rule.cls === 'never') {", [GATE]],
  ['gate: the host name is not checked', 'src/api/publicAccess.ts', "if (askedHost && mine && askedHost !== mine)", "if (false)", [TRUST]],
  ['gate: no public pass needed', 'src/api/publicAccess.ts', "      if (!pass) {\n        // A session from the private address", "      if (false) {\n        // A session from the private address", [GATE]],
  ['pass: not bound to its session', 'src/api/publicAccess.ts', "if (!safeEqual(pass.sess, want)) return undefined;", '', [GATE]],
  ['pass: the signature is not checked', 'src/api/publicAccess.ts', "if (!safeEqual(sig, want)) return undefined;", '', [GATE]],
  ['pass: never idles out', 'src/api/publicAccess.ts', "if (pass.seen > now + 60_000 || now - pass.seen > publicConfig().idleMs) return undefined;", '', [GATE]],
  ['pass: a new sign-in inherits the second factor', 'src/api/publicAccess.ts', "if (req.principal && req.routeOptions?.url === '/v1/local-accounts/:id/password') {\n      const old = passOf(req, sessionValue(req));\n      sfAt = old ? factorAt(req, old, req.principal.ownerId) : 0;\n      g = factorGen(req.principal.ownerId);\n      en = old?.en ?? 0;\n    }", "sfAt = Date.now();", [GATE]],
  ['2fa: not asked for at sign-in', 'src/api/publicAccess.ts', "if (need === 'yes' && sfAt === 0) {\n        return reply", "if (false) {\n        return reply", [GATE]],
  ['2fa: step-up never expires', 'src/api/publicAccess.ts', "if (now - sfAt > publicConfig().stepUpMs) {", "if (false) {", [GATE, SF]],
  ['2fa: step-up open to people without a factor', 'src/api/publicAccess.ts', "          if (rule.firstFactorOk) return;\n          return reply.code(403)", "          return;\n          return reply.code(403)", [DEFAULT2FA], undefined, 'Google sign-in'],
  ['2fa: the socket skips the second factor', 'src/api/publicAccess.ts', "    if (need === 'yes' && factorAt({ headers }, pass, ownerId) === 0) return 'second factor not given';\n    return undefined;\n  };\n\n  const factorRefusal", "    return undefined;\n  };\n\n  const factorRefusal", [NOTICES]],
  ['2fa: the socket needs no pass', 'src/api/publicAccess.ts', "if (!pass) return 'no public pass';", "if (!pass) return undefined;", [NOTICES]],
  ['2fa: a TOTP code works twice', 'src/api/signIn/secondFactor.ts', "if (step !== undefined && store.advanceTotpStep(row.id, step)) { method = 'totp'; break; }", "if (step !== undefined) { method = 'totp'; break; }", [SF]],
  ['2fa: any passkey of anyone', 'src/api/signIn/secondFactor.ts', "row.ownerId === ownerId && row.kind === 'passkey'", "row.kind === 'passkey'", [SF]],
  ['2fa: the passkey challenge can be reused', 'src/api/signIn/secondFactor.ts', "    if (sent) mine?.delete(sent);\n", '', [SF]],
  ['2fa: factors change without proof', 'src/api/signIn/secondFactor.ts', "    if (!local) return true; // a Google account: Google is its password", "    return true;", [SF]],
  ['2fa: guesses are not limited', 'src/api/signIn/secondFactor.ts', "if (api.throttle.throttled(req, bucket, '2fa')) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });\n    const body", "const body", [TRUST]],
  ['2fa: the owner may drop the last factor with public access on', 'src/api/signIn/secondFactor.ts', "return api.config().on && api.hasOwnerRights(ownerId) && usableAfter === 0;", "return false;", [SF]],
  ['2fa: anyone may reset anyone', 'src/api/signIn/secondFactor.ts', "    if (!api.hasOwnerRights(ownerId)) {", "    if (false) {", [SF]],
  ['invited: any Google account may sign in publicly', 'src/api/signIn/auth.ts', "if (isPublic(req) && !(opts.store?.identityIsInvited(token.sub, token.email) ?? false)) {", "if (false) {", [NOTICES]],
  ['invited: the owner may be claimed publicly (page)', 'src/api/signIn/accountsAuth.ts', "    if (ownerFirstClaimFromPublic(req, account)) return reply.code(403).send({ error: OWNER_CLAIM_PRIVATE_ONLY });\n    if (ownerRecoveryFromPublic(req, account)) return reply.code(403).send({ error: OWNER_RECOVERY_PRIVATE_ONLY, privateOnly: true });\n    const { hash, salt }", "    if (ownerRecoveryFromPublic(req, account)) return reply.code(403).send({ error: OWNER_RECOVERY_PRIVATE_ONLY, privateOnly: true });\n    const { hash, salt }", [TRUST]],
  ['limits: public failures share the private buckets', 'src/api/signIn/auth.ts', "  if (isPublic(req)) {\n    const keys = [`pub:ip:", "  if (false) {\n    const keys = [`pub:ip:", [TRUST]],
  ['limits: no ceiling on all public failures', 'src/api/signIn/auth.ts', "    keys.push('pub:all');\n", '', [TRUST]],
  ['limits: lockouts do not back off', 'src/api/signIn/auth.ts', "return Math.min(FAIL_WINDOW_MS * 2 ** (n - 1), STRIKE_MEMORY_MS);", "return FAIL_WINDOW_MS;", [TRUST]],
  ['limits: no request ceiling', 'src/api/publicAccess.ts', "return total > cfg.requestsPerMinute || n > cfg.requestsPerMinutePerAddress;", "return false;", [TRUST]],
  ['notice: no new-device notice', 'src/api/publicAccess.ts', "    tell(ownerId, mine);\n    for (const a of admins()) if (a.id !== ownerId) tell(a.id, theirs);", '', [NOTICES]],
  ['notice: the owner is not told about others', 'src/api/publicAccess.ts', "    for (const a of admins()) if (a.id !== ownerId) tell(a.id, theirs);", '', [NOTICES]],
  ['notice: every sign-in is "known"', 'src/api/publicAccess.ts', "if (device && store) isNew = store.noteDevice(ownerId, sha(device), label, source);", "isNew = false;", [NOTICES]],
  ['record: public sign-ins are not recorded', 'src/api/publicAccess.ts', "record('public.signin', ownerId, { from, device: label, newDevice: isNew });", '', [NOTICES]],
  ['record: failure bursts are not recorded', 'src/api/signIn/auth.ts', "req.server.publicAccess?.failureBurst(req, k, cur.until);", '', [TRUST]],
  ['record: the switch is not recorded', 'src/api/machine/reachRoutes.ts', "store.recordSecurity('public.on', req.principal?.ownerId, { url: fun.url, provider: 'funnel' });", '', [REACH]],
  ['headers: no HSTS', 'src/api/publicAccess.ts', "reply.header('strict-transport-security', 'max-age=604800');", '', [GATE]],
  ['headers: no content security policy', 'src/api/publicAccess.ts', "if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', publicCsp(opts.mode));", '', [GATE]],
  ['switch: on without the safeguards', 'src/api/machine/reachRoutes.ts', "      if (failing.length) {\n        return reply.code(409)", "      if (false) {\n        return reply.code(409)", [REACH]],
  ['switch: on without a confirmation', 'src/api/machine/reachRoutes.ts', "if (req.body?.confirm !== true) {", "if (false) {", [REACH]],
  ['switch: a member may flip it', 'src/api/machine/reachRoutes.ts', "return deps.ownsLocalHost(req) ? undefined : OWNER_ONLY;", "return undefined;", [REACH]],
  ['switch: Funnel on the private port is not noticed', 'src/api/safeguards.ts', "const listenerOk = !clash && !f.ownerHeader && f.funnelOnPrivatePort !== true && !unreadable;", "const listenerOk = !clash && !f.ownerHeader && !unreadable;", [GUARDS, REACH]],
  ['switch: unreadable Funnel passes while on', 'src/api/safeguards.ts', "const unreadable = !!f.publicOn && f.funnelOnPrivatePort === undefined;", "const unreadable = false;", [REVIEW]],
  ['switch: only loopback Funnel targets are seen', 'src/ops/tailnet.ts', "return entry.targets.some((t) => new RegExp(`:${localPort}(/|$)`).test(t) || t === String(localPort));", "return entry.targets.some((t) => new RegExp(`(127\\.0\\.0\\.1|localhost):${localPort}(/|$)`).test(t));", [REVIEW]],
  ['review: large bodies are read before sign-in', 'src/api/publicAccess.ts', "if ((rule.cls === 'open' || rule.cls === 'second-step') && len > PRE_SIGNIN_BODY_MAX) {", "if (false) {", [REVIEW]],
  ['review: bodies with no length are read', 'src/api/publicAccess.ts', "if (te !== undefined || !Number.isFinite(len) || len < 0) return reply.code(411)", "if (false) return reply.code(411)", [REVIEW]],
  ['review: undecodable addresses reach the router', 'src/api/publicAccess.ts', "catch { res.writeHead(400,", "catch { app.routing(req, res); return; res.writeHead(400,", [REVIEW]],
  ['review: sockets outlive a failed safeguard', 'src/api/publicAccess.ts', "        dropUpgraded(); // open console sockets do not outlive the safeguard\n", "", [REVIEW]],
  ['review: off waits for open sockets', 'src/api/publicAccess.ts', "    dropUpgraded();\n    if (!s) return;\n    await new Promise<void>((resolve) => {\n      s.close(() => resolve());\n      for (const sock of sockets) sock.destroy();\n      sockets.clear();", "    if (!s) return;\n    await new Promise<void>((resolve) => {\n      s.close(() => resolve());\n      s.closeAllConnections?.();", [REVIEW]],
  ['review: a socket-only sign-in is not recorded', 'src/api/publicAccess.ts', "if (!pass.used) firstUse({ headers }, ownerId, pass);", "", [REVIEW]],
  ['review: usernames are throttle keys at any length', 'src/api/signIn/auth.ts', "return w.length <= 64 && !w.startsWith('*') ? w : `#${createHash('sha256').update(w).digest('hex').slice(0, 32)}`;", "return w;", [REVIEW]],
  ['limits: a typed name can be a shared bucket', 'src/api/signIn/auth.ts', "w.length <= 64 && !w.startsWith('*') ? w", "w.length <= 64 ? w", [NIGHT], undefined, 'HB-1434'],
  // A second lock behind the one above (a typed name never makes a shared bucket's key): removing it alone changes nothing, by design.
  ['limits: a shared bucket is ranked with made-up names', 'src/api/signIn/auth.ts', "PUBLIC_KEY.test(k) || SHARED_KEY.test(k) ? 2", "PUBLIC_KEY.test(k) ? 2", [NIGHT], 'equivalent', 'HB-1434'],
  ['review: IPv6 addresses are their own buckets', 'src/api/signIn/auth.ts', "const keys = [`pub:ip:${addressBucket(publicClientAddress(req))}`];", "const keys = [`pub:ip:${publicClientAddress(req)}`];", [REVIEW]],
  ['review: the roster lists claim codes publicly', 'src/api/signIn/accountsAuth.ts', "claimPath: pending && !isPublic(req) ?", "claimPath: pending ?", [REVIEW]],
  ['review: Files are signed-in', 'src/api/publicRoutes.ts', "r('*', /^\\/v1\\/agents\\/:id\\/fs(\\/file)?$/, 'step-up',", "r('*', /^\\/v1\\/agents\\/:id\\/fs(\\/file)?$/, 'signed-in',", [REVIEW]],
  ['review: join accepts a session the gate has not passed', 'src/api/chat/memberRoutes.ts', "    if (fromCookie && isPublic(req)) {\n      const refused = app.publicAccess", "    if (false) {\n      const refused = app.publicAccess", [REVIEW]],
  ['review: config tells strangers the private address', 'src/orchestrator/reach/appConfig.ts', "  if (!fromPublic) return full;\n  const { appUrl", "  if (true) return full;\n  const { appUrl", [REVIEW]],
  ['review: the pass and device cookies go to the gateway', 'src/api/signIn/sessionCookie.ts', "_(session|pub|factor|device)$/;", "_session$/;", [REVIEW]],
  ['review: any factor counts as proof publicly', 'src/api/signIn/secondFactor.ts', "if (isPublic(req) && api.secondFactorNeed(ownerId) === 'yes') return true;", "if (isPublic(req) && real(ownerId).length > 0) return true;", [REVIEW]],
  ['review: passkey origins include unserved ports', 'src/api/publicAccess.ts', "const out = new Set<string>([`https://${host}${fp === 443 ? '' : `:${fp}`}`]);", "const out = new Set<string>([`https://${host}`, `https://${host}:8443`, `https://${host}:10000`]);", [REVIEW]],
  // The second review (test/publicReview2.test.ts).
  ['review 2: a burst of guesses outruns the sign-in limit', 'src/api/signIn/auth.ts', "    if (counted >= limitFor(k)) return undefined;\n", '', [REVIEW2]],
  ['review 2: a guess in flight is not counted', 'src/api/signIn/auth.ts', "const counted = (f && now <= f.until ? f.n : 0) + (pending.get(k) ?? 0);", "const counted = (f && now <= f.until ? f.n : 0);", [REVIEW2]],
  ['review 2: foreground Funnel sessions are not read', 'src/ops/tailnet.ts', "  for (const fg of Object.values(cfg.Foreground ?? {})) if (fg && typeof fg === 'object') read(fg);\n", '', [REVIEW2]],
  ['review 2: a signed-out pass still works', 'src/api/publicAccess.ts', "if (!evenIfSignedOut && (!readRevocations() || revoked.has(passName(pass)))) return undefined;", "if (!evenIfSignedOut && !readRevocations()) return undefined;", [REVIEW2]],
  ['review 2: signing out revokes nothing', 'src/api/publicAccess.ts', "      revoked.add(name);\n", '', [REVIEW2]],
  ['review 2: a signed-out pass is not kept across a restart', 'src/api/publicAccess.ts', "try { store?.revokePublicPass(name, until); unsaved.delete(name); }", "try { /* not kept */ unsaved.delete(name); }", [REVIEW2]],
  ['review 2: open sockets are not re-judged after a change', 'src/api/console/consoleRoutes.ts', "        if (ended) signedOut(ended);\n      }\n      revalidateConsoleSockets();", "        if (ended) signedOut(ended);\n      }", [REVIEW2]],
  ['review 2: an open socket\'s session is not checked again', 'src/orchestrator/console/consoleGate.ts', "    if (!who || who.ownerId !== s.ownerId) return 'signed out';\n", '', [REVIEW2]],
  ['review 2: an open public socket is not held to the public rules', 'src/orchestrator/console/consoleGate.ts', "      if (why) return why;\n    }\n    const now = consoleCaller", "    }\n    const now = consoleCaller", [REVIEW2]],
  ['review 2: an open public socket never idles out', 'src/api/publicAccess.ts', "    if (Date.now() - lastActive > publicConfig().idleMs) return 'idle';\n", '', [REVIEW2]],
  ['review 2: an open socket outlives the caller\'s standing on the agent', 'src/orchestrator/console/consoleGate.ts', "    if (!now || now.role !== s.role) return 'no longer allowed on this agent';\n", '', [REVIEW2]],
  ['review 2: a socket that cannot be re-judged is kept', 'src/orchestrator/console/consoleSockets.ts', "catch { why = 'could not be checked'; }", "catch { why = undefined; }", [REVIEW2]],
  ['review 2: a factor reset leaves public consoles open', 'src/api/signIn/secondFactor.ts', "    app.consoleSockets?.closeFor(target, { publicOnly: true });\n", '', [REVIEW2]],
  ['review 2: removing a factor leaves public consoles open', 'src/api/signIn/secondFactor.ts', "    app.consoleSockets?.closeFor(ownerId, { publicOnly: true });\n", '', [REVIEW2]],
  // A guest's consoles at the door (HB-0645): each may hold up to its queue limit, so how many is the bound on what one guest makes this process hold.
  // Elsewhere the one more is refused as 'full' anyway: this rule tells only while one timed out is still closing, with room it gave back.
  ['guest door: one more than the limit connects, on room a timed-out one gave back before its socket closed', 'src/orchestrator/console/consoleAccess.ts', "    if (seen.connecting >= door.max) return { refused: 'connecting' };\n", '', [GUEST_DOOR], undefined, 'its socket closing'],
  ['guest door: with no room to promise, one more is let in past the limit', 'src/orchestrator/console/consoleAccess.ts', "      if (!room) return { refused: 'full' };", '', [GUEST_DOOR, CONSOLE_GUESTS], undefined, 'full|refused at the door as too many'],
  ['guest door: no limit on open consoles', 'src/orchestrator/console/consoleAccess.ts', "    if (seen.open >= door.max) {", "    if (false) {", [GUEST_DOOR, CONSOLE_GUESTS], undefined, 'full|refused at the door as too many'],
  ['guest door: a console promised as room is promised again', 'src/orchestrator/console/consoleAccess.ts', "if (e.userId !== userId || e.promised) continue;", "if (e.userId !== userId) continue;", [GUEST_DOOR, CONSOLE_GUESTS], undefined, 'promised once|chats still connecting are counted first'],
  ['guest door: other people\'s consoles are counted as theirs', 'src/orchestrator/console/consoleAccess.ts', "if (e.userId !== userId || e.promised) continue;", "if (e.promised) continue;", [GUEST_DOOR, CONSOLE_GUESTS], undefined, "nobody else's"],
  ['guest door: idle tabs reconnecting close each other in turn', 'src/orchestrator/console/consoleAccess.ts', "    if (!dead && !this.#roomDue(userId, how.every)) return undefined;\n", '', [GUEST_DOOR, CONSOLE_GUESTS], undefined, 'full|do not close each other'],
  ['guest door: a chat being answered counts as idle', 'src/orchestrator/console/consoleAccess.ts', "      lastActive: () => line?.answering() ? performance.now() : usedAt,", "      lastActive: () => usedAt,", [GUEST_DOOR, CONSOLE_GUESTS], undefined, 'being answered'],
  ['guest door: a console may take forever to connect', 'src/orchestrator/console/consoleAccess.ts', "    timer = setTimeout(() => { door.timedOut?.(); drop(); }, door.connectTimeoutMs);\n    timer.unref?.();\n", '', [GUEST_DOOR, CONSOLE_GUESTS], undefined, 'connectTimeoutMs|time to connect|times out'],
  // Issue #9: a second factor given before a reset or a removal must not count again once a new factor is added.
  ['generation: a factor given before a reset counts again', 'src/api/publicAccess.ts', "return Math.max(pass.sfAt > 0 && pass.g === g ? pass.sfAt : 0, f && f.sfAt > 0 && f.g === g ? f.sfAt : 0);", "return Math.max(pass.sfAt, f?.sfAt ?? 0);", [REVIEW2], undefined, 'before a reset or a removal'],
  ['generation: a reset does not move it', 'src/api/signIn/secondFactor.ts', "    api.secondFactorsChanged(target);\n", '', [REVIEW2], undefined, 'before a reset or a removal'],
  ['generation: removing a factor does not move it', 'src/api/signIn/secondFactor.ts', "    api.secondFactorsChanged(ownerId, { req, reply });\n", '', [REVIEW2], undefined, 'before a reset or a removal'],
  ['review 2: a factor change is not on the record', 'src/api/signIn/secondFactor.ts', "try { store.recordSecurity(kind, ownerId, {", "try { void ({", [REVIEW2]],
  ['review 2: a slow sign-in form is held for minutes', 'src/api/publicAccess.ts', "const slow = setTimeout(() => { if (!raw.complete) raw.destroy(); }, PRE_SIGNIN_READ_MS);", "const slow = setTimeout(() => {}, PRE_SIGNIN_READ_MS);", [REVIEW2]],
  ['review 2: no limit on public connections', 'src/api/publicAccess.ts', "    s.maxConnections = PUBLIC_MAX_CONNECTIONS;\n", '', [REVIEW2]],
  ['review 2: sockets are outside the request ceiling', 'src/api/publicAccess.ts', "      if (overCeiling(publicClientAddress(req as never))) { socket.destroy(); return; }\n", '', [REVIEW2]],
  ['review 2: client data that is not an object crashes', 'src/api/signIn/webauthn.ts', "  if (c === null || typeof c !== 'object' || Array.isArray(c)) return fail('client data is not an object');\n", '', [REVIEW2]],
  ['review 2: client data fields of any type', 'src/api/signIn/webauthn.ts', "  if (typeof c.type !== 'string' || typeof c.challenge !== 'string' || typeof c.origin !== 'string') return fail('client data is malformed');\n", '', [REVIEW2]],
  // PATCH /v1/agents/:id's checks are the agent edits service's (HB-0825); its route hands it the step-up.
  ['review 2: host folders need no step-up publicly', 'src/orchestrator/lifecycle/agentEdits.ts', "        if (again) return again;\n", '', [REVIEW2]],
  ['review 2: the route hands no step-up for host folders', 'src/api/agents/lifecycleRoutes.ts', "          if (!again) return undefined;\n", "          if (again) return undefined;\n", [REVIEW2]],
  ['review 2: a stale judgement says serving after off', 'src/api/publicAccess.ts', "  const evaluate = async (): Promise<SafeguardCheck[]> => {\n    const [autoUpgrade, funnelOnPrivatePort] = await Promise.all([\n      probes.autoUpgrade().catch((err: unknown) => ({ ok: false, why: `Automatic upgrades could not be checked (${String((err as Error)?.message ?? err).slice(0, 80)}).` })),\n      probes.funnelOnPrivatePort(mainPort()).catch(() => undefined),\n    ]);\n    // Read AFTER the probes answered: a judgement that began while public\n    // access was on must not say \"serving\" once it has been turned off.\n    const cfg = publicConfig();", "  const evaluate = async (): Promise<SafeguardCheck[]> => {\n    const cfg = publicConfig();\n    const [autoUpgrade, funnelOnPrivatePort] = await Promise.all([\n      probes.autoUpgrade().catch((err: unknown) => ({ ok: false, why: `Automatic upgrades could not be checked (${String((err as Error)?.message ?? err).slice(0, 80)}).` })),\n      probes.funnelOnPrivatePort(mainPort()).catch(() => undefined),\n    ]);\n    // Read AFTER the probes answered: a judgement that began while public\n    // access was on must not say \"serving\" once it has been turned off.", [REVIEW2]],
  ['review 2: a password alone adds the first factor publicly', 'src/api/publicAccess.ts', "          if (rule.firstFactorOk && rule.enrols && !(pass.en > now)) return reply.code(403).send({ error: rule.refusal ?? FIRST_FACTOR_NEEDS_LINK, secondFactor: 'enrol-link' });\n", '', [DEFAULT2FA], undefined, 'Google sign-in'],
  ['review 2: a password alone adds the first factor publicly (everyone must have one)', 'src/api/publicAccess.ts', "          if (rule.enrols && !(pass.en > now)) return reply.code(403).send({ error: rule.refusal ?? FIRST_FACTOR_NEEDS_LINK, secondFactor: 'enrol-link' });\n", '', [TRUST]],
  ['review 2: any sign-in may add the first factor publicly', 'src/api/publicAccess.ts', "let en = FIRST_FACTOR_PROOF.test(req.routeOptions?.url ?? '') ? now + FIRST_FACTOR_WINDOW_MS : 0;", "let en = now + FIRST_FACTOR_WINDOW_MS;", [SF, TRUST]],
  ['review 2: the first-factor window never closes', 'src/api/publicAccess.ts', "? now + FIRST_FACTOR_WINDOW_MS : 0;", "? now + 400 * 86_400_000 : 0;", [DEFAULT2FA], undefined, 'half an hour later'],
  ['review 2: the request ceiling counts single IPv6 addresses', 'src/api/publicAccess.ts', "const addr = addressBucket(visitor);", "const addr = visitor;", [REVIEW2]],
  // ---- The owner's decisions after the second review (2026-10-01) ----
  // A. A second factor for every password account, by default.
  ['default: a member with a password needs no second factor', 'src/api/publicAccess.ts', "    if (publicConfig().guestsWithoutSecondFactor && store.isChatOnlyGuest(ownerId)) return 'guest';\n    return 'missing';", "    if (publicConfig().guestsWithoutSecondFactor && store.isChatOnlyGuest(ownerId)) return 'guest';\n    return 'no';", [GATE, DEFAULT2FA], undefined, 'member'],
  ['default: the old setting =0 switches it off', 'src/api/publicAccess.ts', "    if (!store.localAccount(ownerId)) return 'no';", "    if (!store.localAccount(ownerId) || process.env.HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL === '0') return 'no';", [DEFAULT2FA], undefined, 'old setting'],
  ['default: a Google account without owner rights is not exempt', 'src/api/publicAccess.ts', "    if (!store.localAccount(ownerId)) return 'no';", "", [NOTICES]],
  ['default: =0 is not reported as ignored', 'src/api/safeguards.ts', "v.trim() !== '1' ? v.trim() : undefined))", "v.trim() === 'never' ? v.trim() : undefined))", [DEFAULT2FA], undefined, 'old setting'],
  ['default: the doctor says nothing of an ignored setting', 'src/doctor.ts', "  if (p.forAllIgnored !== undefined) {", "  if (false) {", [DEFAULT2FA], undefined, 'old setting'],
  ['default: sent to enrolment without a link', 'src/api/publicAccess.ts', "        if (pass.en > now) return reply.code(403).send({ error: MUST_ENROL_NOW, secondFactor: 'enrol' });", "        return reply.code(403).send({ error: MUST_ENROL_NOW, secondFactor: 'enrol' });", [DEFAULT2FA], undefined, 'member with only a password'],
  ['guests: exempt without the owner\'s switch', 'src/api/publicAccess.ts', "if (publicConfig().guestsWithoutSecondFactor && store.isChatOnlyGuest(ownerId)) return 'guest';", "if (store.isChatOnlyGuest(ownerId)) return 'guest';", [DEFAULT2FA], undefined, 'off by default'],
  ['guests: values other than 1 turn the switch on', 'src/api/safeguards.ts', "guestsWithoutSecondFactor: env.HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR === '1',", "guestsWithoutSecondFactor: !!env.HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR && env.HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR !== '0',", [DEFAULT2FA], undefined, 'old setting'],
  ['guests: with the switch on everyone is exempt', 'src/api/publicAccess.ts', "if (publicConfig().guestsWithoutSecondFactor && store.isChatOnlyGuest(ownerId)) return 'guest';", "if (publicConfig().guestsWithoutSecondFactor) return 'guest';", [DEFAULT2FA], undefined, 'with the switch on'],
  ['guests: a guest may use everything signed-in', 'src/api/publicAccess.ts', "        if (need === 'guest' && guestMay(req.method, req.routeOptions?.url)) return;", "        if (need === 'guest' && rule.cls === 'signed-in') return;", [DEFAULT2FA], undefined, 'with the switch on'],
  ['guests: a guest may use step-up routes', 'src/api/publicAccess.ts', "        if (need === 'guest') return reply.code(403).send({ error: GUEST_CHAT_ONLY, secondFactor: 'guest' });", "        if (need === 'guest') return;", [DEFAULT2FA], undefined, 'with the switch on'],
  ['guests: a guest may write anything of the signed-in class', 'src/api/publicRoutes.ts', "  if ((READ as readonly string[]).includes(method.toUpperCase())) return true;\n  return GUEST_WRITES.some((re) => re.test(pattern));", "  return true;", [DEFAULT2FA], undefined, 'with the switch on'],
  ['guests: a guest may use other classes', 'src/api/publicRoutes.ts', "  if (!rule || rule.cls !== 'signed-in' || !pattern) return false;", "  if (!rule || rule.cls === 'never' || !pattern) return false;", [DEFAULT2FA], undefined, 'with the switch on'],
  ['guests: someone with an agent of their own is a guest', 'src/store/store.ts', "    if (one(`SELECT 1 FROM agents WHERE owner_id = ? AND state != 'DELETED' LIMIT 1`, userId)) return false;\n", "", [DEFAULT2FA], undefined, 'chat-only guest'],
  ['guests: someone with an AI source is a guest', 'src/store/store.ts', "    if (one(`SELECT 1 FROM ai_profiles WHERE owner_id = ? LIMIT 1`, userId)) return false;\n", "", [DEFAULT2FA], undefined, 'who is a chat-only guest'],
  ['guests: someone with a host is a guest', 'src/store/store.ts', "    if (one(`SELECT 1 FROM hosts WHERE owner_id = ? LIMIT 1`, userId)) return false;\n", "", [DEFAULT2FA], undefined, 'who is a chat-only guest'],
  ['guests: a seat without web chat counts', 'src/store/store.ts', "AND m.status = 'active' AND m.web_chat = 1\n", "AND m.status = 'active'\n", [DEFAULT2FA], undefined, 'who is a chat-only guest'],
  ['guests: a seat that was taken away counts', 'src/store/store.ts', "AND m.status = 'active' AND m.web_chat = 1\n", "AND m.web_chat = 1\n", [DEFAULT2FA], undefined, 'who is a chat-only guest'],
  ['guests: a seat on a deleted agent counts', 'src/store/store.ts', "          AND a.state != 'DELETED' AND a.owner_id != ?", "          AND a.owner_id != ?", [DEFAULT2FA], undefined, 'who is a chat-only guest'],
  ['guests: a seat on the management agent counts', 'src/store/store.ts', " AND COALESCE(a.ops, 0) = 0 LIMIT 1`, userId, userId);", " LIMIT 1`, userId, userId);", [DEFAULT2FA], undefined, 'who is a chat-only guest'],
  ['guests: an account with no seat at all is a guest', 'src/store/store.ts', "    if (!this.ownsNothing(userId)) return false;\n    return one(", "    if (!this.ownsNothing(userId)) return false;\n    return true || one(", [DEFAULT2FA], undefined, 'guest'],
  ['guests: a socket is opened without a second factor by anyone', 'src/api/publicAccess.ts', "      if (!becomesGuest) return 'no second factor';", "", [DEFAULT2FA], undefined, 'with the switch on'],
  ['guests: the switch needs no confirmation', 'src/api/machine/reachRoutes.ts', "    if (on && req.body?.confirm !== true) return reply.code(400)", "    if (false) return reply.code(400)", [DEFAULT2FA], undefined, 'guest switch'],
  ['guests: the switch can be turned on from the public address', 'src/api/machine/reachRoutes.ts', "    if (on && isPublic(req)) return reply.code(403).send({ error: 'This is turned on from the private address.' });\n", "", [DEFAULT2FA], undefined, 'guest switch'],
  ['guests: a member may flip the guest switch', 'src/api/machine/reachRoutes.ts', "    if (no) return reply.code(403).send({ error: no });\n    const on = req.body?.on === true;\n    if (on && isPublic(req))", "    const on = req.body?.on === true;\n    if (on && isPublic(req))", [DEFAULT2FA], undefined, 'guest switch'],
  ['guests: the switch is not written down', 'src/api/machine/reachRoutes.ts', "    store.recordSecurity('public.guests_without_second_factor', req.principal?.ownerId, { on });\n", "", [DEFAULT2FA], undefined, 'guest switch'],
  ['guests: accepting an invitation without a factor needs no switch', 'src/api/publicAccess.ts', "!!o.acceptingWebChat && publicConfig().guestsWithoutSecondFactor && ", "!!o.acceptingWebChat && ", [DEFAULT2FA], undefined, 'accepting a web-chat invitation'],
  ['guests: someone with an agent may accept an invitation without a factor', 'src/api/publicAccess.ts', " && !hasOwnerRights(ownerId) && !!store?.ownsNothing(ownerId);", " && !hasOwnerRights(ownerId);", [DEFAULT2FA], undefined, 'accepting a web-chat invitation'],
  ['guests: any session read may skip the factor, not only accepting web chat', 'src/api/publicAccess.ts', "const becomesGuest = !!o.acceptingWebChat && ", "const becomesGuest = ", [DEFAULT2FA], undefined, 'with the switch on'],
  // B1. Owner-rights recovery is refused at the public address.
  ['owner recovery: a reset link for the owner works publicly (form)', 'src/api/signIn/accountsAuth.ts', "    if (ownerRecoveryFromPublic(req, account)) return reply.code(403).send({ error: OWNER_RECOVERY_PRIVATE_ONLY, privateOnly: true });\n    const { hash, salt } = await hashPassword(password);", "    const { hash, salt } = await hashPassword(password);", [RECOVERY], undefined, 'reset link for the owner'],
  ['owner recovery: a reset link for the owner opens publicly (page)', 'src/api/signIn/accountsAuth.ts', "    if (ownerRecoveryFromPublic(req, account)) return reply.code(403).send({ error: OWNER_RECOVERY_PRIVATE_ONLY, privateOnly: true });\n    // An account that already has a password is being RESET", "    // An account that already has a password is being RESET", [RECOVERY], undefined, 'reset link for the owner'],
  ['owner recovery: the recovery code works publicly', 'src/api/signIn/accountsAuth.ts', "    // Said only to someone who gave the right code (so it tells a stranger nothing), and the code is not spent.\n    if (ownerRecoveryFromPublic(req, account)) return reply.code(403).send({ error: OWNER_RECOVERY_PRIVATE_ONLY, privateOnly: true });\n", "", [RECOVERY], undefined, 'recovery code'],
  ['owner recovery: only the account flag counts as owner rights', 'src/api/signIn/accountsAuth.ts', "account.pwHash !== '' && (account.hostOwner || (req.server.publicAccess?.hasOwnerRights(account.id) ?? false));", "account.pwHash !== '' && account.hostOwner;", [RECOVERY], undefined, 'reset link for the owner'],
  ['owner recovery: members are refused too', 'src/api/signIn/accountsAuth.ts', "account.pwHash !== '' && (account.hostOwner || (req.server.publicAccess?.hasOwnerRights(account.id) ?? false));", "account.pwHash !== '';", [RECOVERY, SF]],
  ['owner recovery: a Telegram link is made for the owner from the internet', 'src/orchestrator/accounts/telegramRecovery.ts', "const code = ownerFromPublic ? undefined : randomBytes(16).toString('base64url');", "const code = randomBytes(16).toString('base64url');", [RECOVERY], undefined, 'Forgot password'],
  ['owner recovery: the owner\'s link is made for the public address', 'src/orchestrator/accounts/telegramRecovery.ts', "const base = ownerRights ? appUrlFor() : linkUrlFor();", "const base = linkUrlFor();", [RECOVERY], undefined, 'Forgot password'],
  // B2. "Forgot password?" asked from the internet.
  ['public recovery: held only to the private interval', 'src/orchestrator/accounts/telegramRecovery.ts', "    if (fromPublic) {\n      if (!publicRecoveryAllowed(asker, key)) return;\n    } else {", "    {", [RECOVERY], undefined, 'held tight'],
  ['public recovery: no hour between asks', 'src/orchestrator/accounts/telegramRecovery.ts', "    if (byName.length && now - byName[byName.length - 1]! < PUBLIC_RECOVERY_EVERY_MS) return false;\n", "", [RECOVERY], undefined, 'a username'],
  ['public recovery: no limit a day', 'src/orchestrator/accounts/telegramRecovery.ts', "    if (byName.length >= PUBLIC_RECOVERY_PER_DAY) return false;\n", "", [RECOVERY], undefined, 'a username'],
  ['public recovery: a pending link is replaced', 'src/orchestrator/accounts/telegramRecovery.ts', "    if (fromPublic && account.claimCode && account.claimExpires && Date.parse(account.claimExpires) > Date.now()) return;\n", "", [RECOVERY], undefined, 'pending link'],
  ['public recovery: an expired link counts as pending', 'src/orchestrator/accounts/telegramRecovery.ts', "account.claimExpires && Date.parse(account.claimExpires) > Date.now()) return;", "account.claimExpires) return;", [RECOVERY], undefined, 'held tight'],
  ['public recovery: no ceiling per address', 'src/orchestrator/accounts/telegramRecovery.ts', "    if (!underCeiling(byAddr, 3_600_000, PUBLIC_RECOVERY_PER_ADDRESS, now)) return false;\n", "", [RECOVERY], undefined, 'an address'],
  ['public recovery: no ceiling for everyone together', 'src/orchestrator/accounts/telegramRecovery.ts', "    if (!underCeiling(pr.all, 3_600_000, PUBLIC_RECOVERY_ALL, now)) return false;\n", "", [RECOVERY], undefined, 'an address'],
  ['public recovery: IPv6 addresses are counted singly', 'src/api/signIn/accountsRoutes.ts', "address: () => addressBucket(publicClientAddress(req))", "address: () => publicClientAddress(req)", [RECOVERY], undefined, 'an address'],
  ['public recovery: the public counts lock the private address', 'src/orchestrator/accounts/telegramRecovery.ts', "    const fromPublic = asker.fromPublic;\n    if (fromPublic) {", "    const fromPublic = asker.fromPublic;\n    if (!publicRecoveryAllowed(asker, key)) return;\n    if (fromPublic) {", [RECOVERY], undefined, 'a username'],
  // B3. New-device notices are limited.
  ['notice limits: a notice for every sign-in', 'src/api/publicAccess.ts', "    const soon = pair.last > 0 && now - pair.last < NOTICE_EVERY_MS && now >= pair.last;", "    const soon = false;", [NOTICE_LIMITS]],
  ['notice limits: one account\'s notices silence another\'s', 'src/api/publicAccess.ts', "    const key = `${to}\\n${about}`;", "    const key = to;", [NOTICE_LIMITS], undefined, 'ten minutes'],
  ['notice limits: the next notice does not say how many were left out', 'src/api/publicAccess.ts', "      const text = limit.suppressed ? ", "      const text = false ? ", [NOTICE_LIMITS], undefined, 'ten minutes'],
  ['notice limits: no ceiling a day per person', 'src/api/publicAccess.ts', "mine >= NOTICE_DAILY_PER_PERSON || ", "", [NOTICE_LIMITS], undefined, 'ceiling a day'],
  ['notice limits: no ceiling a day overall', 'src/api/publicAccess.ts', " || noticeDay.all >= NOTICE_DAILY_ALL", "", [NOTICE_LIMITS], undefined, 'ceiling a day'],
  ['notice limits: the ceiling never starts again', 'src/api/publicAccess.ts', "    if (day !== noticeDay.day) { noticeDay.day = day; noticeDay.all = 0; noticeDay.per.clear(); }\n", "", [NOTICE_LIMITS], undefined, 'ceiling a day'],
  ['notice limits: a held-back notice is still sent on Telegram', 'src/api/publicAccess.ts', "'public.notice_suppressed'); return; }", "'public.notice_suppressed'); void probes.telegram(to, said).catch(() => false); return; }", [NOTICE_LIMITS], undefined, 'ten minutes'],
  // B4. A crash while switching.
  ['crash: "on" writes no note first', 'src/api/machine/reachRoutes.ts', "      try { writePublicIntent(cfg, envPath()); }", "      try { void 0; }", [CRASH], undefined, 'writes its note'],
  ['crash: the note is written after Funnel is on', 'src/api/machine/reachRoutes.ts', "      const fun = await funnelOn(cfg.port, cfg.funnelPort, mainPort(), proxyPort());", "      clearPublicIntent(envPath());\n      const fun = await funnelOn(cfg.port, cfg.funnelPort, mainPort(), proxyPort());\n      writePublicIntent(cfg, envPath());", [CRASH], undefined, 'writes its note'],
  ['crash: the note is never removed', 'src/api/machine/reachRoutes.ts', "      funnelMayBeOn = false;\n      clearPublicIntent(envPath());", "      funnelMayBeOn = false;", [CRASH], undefined, 'writes its note'],
  ['crash: a failed "on" leaves its note', 'src/api/machine/reachRoutes.ts', "    if (!funnelError) { try { clearPublicIntent(envPath()); } catch { /* the next start clears it */ } }", "", [CRASH, REACH]],
  ['crash: the start ignores the note', 'src/api/machine/reachRoutes.ts', "    if (intent) {\n      switching = true;", "    if (false) {\n      switching = true;", [CRASH], undefined, 'died'],
  ['crash: the recovery leaves Funnel\'s entry', 'src/api/machine/reachRoutes.ts', "        const left = await undo(target, true);", "        const left = await undo(target, false);", [CRASH], undefined, 'died after Funnel'],
  ['crash: the recovery leaves the setting', 'src/api/machine/reachRoutes.ts', "    await unsetEnvVar(envPath(), 'HATCHABOT_PUBLIC_ACCESS').catch(() => undefined);", "", [CRASH, REACH], undefined, 'died after the setting|turns off'],
  ['crash: the recovery uses today\'s ports, not the note\'s', 'src/api/machine/reachRoutes.ts', "const target = { port: port(intent.port, cfg.port), funnelPort: port(intent.funnelPort, cfg.funnelPort) };", "const target = { port: 1, funnelPort: 10000 };", [CRASH], undefined, 'died after Funnel'],
  ['crash: the note goes even when Tailscale kept its entry', 'src/api/machine/reachRoutes.ts', "    if (!funnelError) { try { clearPublicIntent(envPath()); }", "    if (true) { try { clearPublicIntent(envPath()); }", [CRASH], undefined, 'will not let go'],
  ['crash: a step that throws leaves Funnel on', 'src/api/machine/reachRoutes.ts', "      if (funnelMayBeOn) await undo({ port: api.config().port, funnelPort: api.config().funnelPort }, true).catch(() => undefined);\n", "", [CRASH], undefined, 'throws'],
  ['crash: a leftover Funnel entry is not removed', 'src/api/machine/reachRoutes.ts', "    if (!st.readable || !st.entries.some((e) => targetsPort(e, cfg.port))) return {};", "    if (true) return {};", [CRASH], undefined, 'pointing at the public port'],
  ['crash: the leftover check removes a live public address', 'src/api/machine/reachRoutes.ts', "    if (cfg.on || inTests) return {};", "    if (inTests) return {};", [CRASH], undefined, 'pointing at the public port'],
  ['crash: looking (reach status) does not check for leftovers', 'src/api/machine/reachRoutes.ts', "    const recovered = await recover('status').catch(() => ({} as PublicRecovery));", "    const recovered = {} as PublicRecovery;", [CRASH], undefined, 'pointing at the public port'],
  ['crash: a leftover removed is not on the record', 'src/api/machine/reachRoutes.ts', "    try { store.recordSecurity('public.funnel_leftover', undefined, { when, port: cfg.port, removed: r.ok }); } catch { /* best effort */ }\n", "", [CRASH], undefined, 'pointing at the public port'],
  ['crash: a recovery is not on the record', 'src/api/machine/reachRoutes.ts', "        try { store.recordSecurity('public.recovered', undefined,", "        try { void ({ when } &&", [CRASH], undefined, 'died after the note'],
  ['crash: the doctor never removes a leftover', 'src/doctor.ts', "  if (!cfg.on && funnel?.toPublicPort && (!pending || pending.stale)) {", "  if (false) {", [CRASH], undefined, 'doctor'],
  ['crash: the doctor removes during a switch under way', 'src/doctor.ts', "  if (!cfg.on && funnel?.toPublicPort && (!pending || pending.stale)) {", "  if (!cfg.on && funnel?.toPublicPort) {", [CRASH], undefined, 'doctor'],
  ['crash: the doctor removes a live public address', 'src/doctor.ts', "  if (!cfg.on && funnel?.toPublicPort && (!pending || pending.stale)) {", "  if (funnel?.toPublicPort && (!pending || pending.stale)) {", [CRASH], undefined, 'doctor'],
  ['crash: a note is never stale', 'src/ops/publicIntent.ts', "  return !Number.isFinite(at) || now - at > PUBLIC_INTENT_STALE_MS || at > now + 60_000;", "  return false;", [CRASH], undefined, 'doctor'],
  ['crash: an unreadable note is no note', 'src/ops/publicIntent.ts', "  } catch { return {}; }", "  } catch { return undefined; }", [CRASH], undefined, 'doctor'],
  // C. The smaller ones.
  ['smaller: clearing your own second factor needs no password', 'src/api/signIn/secondFactor.ts', "    if (target === ownerId && !(await proveManage(req, reply, ownerId, req.body?.current))) return reply;\n", "", [SF]],
  ['smaller: only "me" asks for the password, not your own name', 'src/api/signIn/secondFactor.ts', "    if (target === ownerId && !(await proveManage(", "    if (req.params.id === 'me' && !(await proveManage(", [SF]],
  ['smaller: guesses at an invitation code are not counted', 'src/api/chat/memberRoutes.ts', "      if (check.reason === 'unknown') guard?.noteFailure(req, undefined, 'link');\n", "", [SMALLER], undefined, 'invitation code'],
  ['smaller: counted guesses are never refused', 'src/api/chat/memberRoutes.ts', "    if (guard?.throttled(req, undefined, 'link')) return reply.code(429).send({ valid: false, reason: 'Too many attempts — try again later.' });\n", "", [SMALLER], undefined, 'invitation code'],
  ['smaller: a used link counts as a guess', 'src/api/chat/memberRoutes.ts', "      if (check.reason === 'unknown') guard?.noteFailure(req, undefined, 'link');", "      guard?.noteFailure(req, undefined, 'link');", [SMALLER], undefined, 'invitation code'],
  ['smaller: invitation guesses lock the password form', 'src/api/chat/memberRoutes.ts', "      if (check.reason === 'unknown') guard?.noteFailure(req, undefined, 'link');", "      if (check.reason === 'unknown') guard?.noteFailure(req);", [SMALLER], undefined, 'invitation code'],
  ['smaller: factors are listed before the second factor is given', 'src/api/signIn/secondFactor.ts', "    const shown = api.secondFactorGiven(req);", "    const shown = true;", [SMALLER], undefined, 'before the second factor'],
  ['smaller: "given" is true for any public pass', 'src/api/publicAccess.ts', "    return !!pass && !!ownerId && factorAt(req, pass, ownerId) > 0;", "    return !!pass;", [SMALLER], undefined, 'before the second factor'],
  ['smaller: an owner\'s passkey answer need not verify its user', 'src/api/signIn/secondFactor.ts', "            { challenge, origins: api.origins(), rpId, requireUserVerification: uvFor(ownerId) === 'required' },", "            { challenge, origins: api.origins(), rpId },", [SMALLER], undefined, 'passkey'],
  ['smaller: an owner\'s new passkey need not verify its user', 'src/api/signIn/secondFactor.ts', "        { challenge, origins: api.origins(), rpId, requireUserVerification: uvFor(ownerId) === 'required' },\n      );\n      if (store.secondFactorByCredential", "        { challenge, origins: api.origins(), rpId },\n      );\n      if (store.secondFactorByCredential", [SMALLER], undefined, 'passkey'],
  ['smaller: user verification is only preferred for owners', 'src/api/signIn/secondFactor.ts', "(api.hasOwnerRights(ownerId) ? 'required' : 'preferred');", "'preferred';", [SMALLER], undefined, 'passkey'],
  ['smaller: user verification is required of members too', 'src/api/signIn/secondFactor.ts', "(api.hasOwnerRights(ownerId) ? 'required' : 'preferred');", "'required';", [SMALLER], undefined, 'passkey'],
  ['smaller: the page puts the address in the button\'s own code', 'web/app/signin.js', "data-copy=\"${esc(r.url)}\" ${onAction('click', 'copyAndSay', [{ $: 'data', k: 'copy' }", "data-copy=\"${esc(r.url)}\" ${onAction('click', 'copyAndSay', [r.url", [SMALLER], undefined, 'data attribute'],
  ['switch: off leaves Funnel on', 'src/api/machine/reachRoutes.ts', "      const r = await funnelOff(cfg.port, cfg.funnelPort);\n      if (!r.ok) { funnelError = r.error; command = r.command; }", "", [REACH]],
  ['switch: off leaves the listener open', 'src/api/machine/reachRoutes.ts', "    else await api.stopListener();", "", [REACH]],
  ['switch: invited-only can be turned off while on', 'src/api/machine/reachRoutes.ts', "if (!on && api.config().on) return reply.code(409)", "if (false) return reply.code(409)", [REACH]],
  ['safeguard a: password mode passes', 'src/api/safeguards.ts', "const modeOk = f.authMode === 'accounts' || f.authMode === 'identity';", "const modeOk = true;", [GUARDS]],
  ['safeguard b: an owner without a factor passes', 'src/api/safeguards.ts', "ok: claimed && without.length === 0,", "ok: claimed,", [GUARDS]],
  ['safeguard b: an unclaimed machine passes', 'src/api/safeguards.ts', "ok: claimed && without.length === 0,", "ok: without.length === 0,", [GUARDS]],
  ['safeguard c: invited-only off passes', 'src/api/safeguards.ts', "title: 'Only invited people', ok: f.invitedOnly,", "title: 'Only invited people', ok: true,", [GUARDS]],
  ['safeguard i: no automatic upgrades passes', 'src/api/safeguards.ts', "title: 'Automatic upgrades on the stable channel', ok: f.autoUpgrade.ok,", "title: 'Automatic upgrades on the stable channel', ok: true,", [GUARDS]],
  ['safeguard i: a pinned machine counts as upgrading', 'src/ops/autoUpgrade.ts', "if (pin && /^v[0-9]/.test(pin)) return", "if (false) return", [GUARDS]],
  ['doctor: a safeguard off is only a warning', 'src/doctor.ts', "out.push({ level: c.ok ? 'ok' : 'fail', text: `  ${c.letter}.", "out.push({ level: c.ok ? 'ok' : 'warn', text: `  ${c.letter}.", [GUARDS]],
];

/**
 * What is wrong with each malformed entry, checked before anything runs. An
 * entry whose tests were not a list of test files ran `vitest run` with none
 * named, the whole suite: "killed" by any failure anywhere, or by the time
 * limit (HB-0867 review). test/publicAccessMutants.test.ts runs `--check`.
 */
const malformed = MUTANTS.flatMap((m) => {
  const [name, file, find, replace, tests, note, named] = m;
  const why = [];
  if (m.length < 5 || m.length > 7) why.push(`${m.length} fields, not 5 to 7`);
  if (typeof name !== 'string' || !name) why.push('no name');
  const there = typeof file === 'string' && existsSync(join(root, file));
  if (!there) why.push(`no file ${JSON.stringify(file)}`);
  if (typeof find !== 'string' || !find) why.push('no text to find');
  // Exactly once: the run changes the first place it is, which was another
  // line than the one meant when the text was also part of a longer line, or
  // was there twice (HB-0867 review).
  else if (there) {
    const times = readFileSync(join(root, file), 'utf8').split(find).length - 1;
    if (times !== 1) why.push(times ? `its text is there ${times} times, not once` : 'its text is not there');
  }
  if (typeof replace !== 'string') why.push(`what replaces the text is ${JSON.stringify(replace)}, not text`);
  if (!Array.isArray(tests) || !tests.length) why.push(`its tests are ${JSON.stringify(tests)}, not a list of test files`);
  else for (const t of tests) if (typeof t !== 'string' || !/^test\/.+\.test\.(?:ts|tsx|mjs)$/.test(t) || !existsSync(join(root, t))) why.push(`no test file ${JSON.stringify(t)}`);
  if (note !== undefined && note !== 'equivalent') why.push(`its note is ${JSON.stringify(note)}, not 'equivalent'`);
  if (named !== undefined && (typeof named !== 'string' || !named)) why.push(`its test names are ${JSON.stringify(named)}, not a pattern`);
  return why.length ? [`${typeof name === 'string' && name ? name : JSON.stringify(name)}: ${why.join('; ')}`] : [];
});
const names = MUTANTS.map((m) => m[0]);
for (const n of new Set(names.filter((n, i) => names.indexOf(n) !== i))) malformed.push(`${n}: the name is used twice`);
if (malformed.length) {
  for (const line of malformed) console.log(`✗ malformed: ${line}`);
  console.log(`${malformed.length} of ${MUTANTS.length} entries malformed: nothing was run (update this script)`);
  process.exit(2);
}
/** What the unmutated copy must pass: each test file any mutant runs, once. */
const BASE_TESTS = [...new Set(MUTANTS.flatMap((m) => m[4]))];
if (process.argv[2] === '--check') {
  console.log(`${MUTANTS.length} mutants, each well formed`);
  process.exit(0);
}

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
  for (const [name, file, find, replace, tests, note, named] of MUTANTS) {
    if (only.length && !only.some((w) => name.includes(w))) continue;
    const path = join(work, file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(find)) { console.log(`✗ ${name} — the guard's text was not found in ${file} (update this script)`); survived++; continue; }
    writeFileSync(path, original.replace(find, replace));
    const r = spawnSync('npx', ['vitest', 'run', ...tests, ...(named ? ['-t', named] : [])], { cwd: work, env, encoding: 'utf8', timeout: 300_000 });
    writeFileSync(path, original);
    // (A name pattern that matches no test runs nothing and exits 0: reported as survived, which is the truth.)
    if (r.status === 0) {
      if (note === 'equivalent') { console.log(`~ ${name} — survives, as expected (another check covers it)`); skipped++; }
      else { console.log(`✗ ${name} — SURVIVED: ${tests.join(', ')}${named ? ` (tests named "${named}")` : ''} still pass without this guard`); survived++; }
    } else { console.log(`✓ ${name}`); killed++; }
  }
  // The copy must pass untouched, or "killed" means nothing: every file a
  // mutant runs, whole, taken from the list so none is left out (HB-0645:
  // five were, among them the guest door's).
  const base = spawnSync('npx', ['vitest', 'run', ...BASE_TESTS], { cwd: work, env, encoding: 'utf8', timeout: 900_000 });
  if (base.status !== 0) {
    console.log('✗ the unmutated copy does not pass its own tests: every result above is void');
    // Which ones, so it can be told from a slow machine (status null: the time limit).
    console.log(`  (exit ${base.status}${base.signal ? `, ${base.signal}` : ''})`);
    for (const line of `${base.stdout}\n${base.stderr}`.split('\n').filter((l) => /×|FAIL|AssertionError|Error:|Test Files|Tests  /.test(l)).slice(0, 40)) console.log(`  ${line.trim()}`);
    survived++;
  }
  console.log(`${killed} killed, ${survived} survived, ${skipped} not counted`);
  process.exitCode = survived ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
}
