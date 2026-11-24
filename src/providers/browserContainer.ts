/**
 * The browser container an agent's browser runs in (docs/browser.md): where
 * the agent's OpenClaw reaches it, the network fence and privilege drop its
 * startup runs, and the kept-logins volume. What a provider needs to start,
 * close and clean up a browser. The sweep that decides which agents have one
 * is orchestrator/console/browser.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
/** Where an agent's OpenClaw finds its browser (in its own network namespace). */
export const BROWSER_CDP_URL = 'http://127.0.0.1:9222';
/** The attach-only OpenClaw profile Hatchabot writes for it. */
export const BROWSER_PROFILE = 'hatchabot';

export interface BrowserSpec {
  /** The agent's container: the browser joins its network namespace. */
  agentContainer: string;
  /** The agent's id: a kept profile's volume is labelled with it. */
  agentId?: string;
  /** Keep its logins: the profile it keeps (its volume's id). Unset, the profile is in memory only. */
  logins?: string;
  image: string;
  /** Built from this when the image is missing (on that machine). */
  dockerfile: string;
  /** docker --memory for the browser container. */
  memory: string;
  /** Rechecked around slow provider work: a changed owner/runtime/profile cancels this request. */
  stillWanted?: () => boolean;
}


/**
 * The user Chromium runs as in its image: not the agent's (1000), so a rule in
 * the network namespace they share can hold the browser alone (HB-0679).
 */
export const BROWSER_UID = 1001;
/**
 * Where the browser may not open a connection: this machine and the agent's
 * own ports (loopback), the LAN, the tailnet (100.64/10), link-local (cloud
 * metadata), and the reserved rest. Docker's own DNS (127.0.0.11:53) stays open.
 */
export const BROWSER_FENCED_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4'];
export const BROWSER_FENCED_V6 = ['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'];
/**
 * The fence (HB-0679), run by the browser's startup shell in its own network
 * namespace before it drops privileges and starts Chromium. OpenClaw refuses
 * a private address the agent asks for, and guards
 * page loads while an action runs; a page that sends itself to one LATER (a
 * timer) went out unguarded and reached it (2026-11-12). This holds the
 * browser's user off those addresses in the kernel; the agent (another user)
 * keeps its own reach (Ollama on the LAN, say). Its own chain, flushed and
 * filled again, so a second run leaves one copy. Prints FENCED when the rule
 * is in place; anything else, and the browser is not started.
 */
export const BROWSER_FENCE_SCRIPT = `set -e
fence() {
  t=$1; shift
  $t -w -N HB_BROWSER 2>/dev/null || true
  $t -w -F HB_BROWSER
  if [ "$t" = iptables ]; then
    for p in udp tcp; do
      $t -w -A HB_BROWSER -d 127.0.0.11 -p "$p" -m conntrack --ctorigdst 127.0.0.11 --ctorigdstport 53 --ctdir ORIGINAL -j RETURN
    done
  fi
  for d in "$@"; do $t -w -A HB_BROWSER -d "$d" -m conntrack --ctstate NEW -j REJECT; done
  $t -w -C OUTPUT -m owner --uid-owner ${BROWSER_UID} -j HB_BROWSER 2>/dev/null || $t -w -I OUTPUT 1 -m owner --uid-owner ${BROWSER_UID} -j HB_BROWSER
}
fence iptables ${BROWSER_FENCED_V4.join(' ')}
if [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null)" = 1 ]; then echo "IPv6 is off here"; else fence ip6tables ${BROWSER_FENCED_V6.join(' ')}; fi
iptables -w -C OUTPUT -m owner --uid-owner ${BROWSER_UID} -j HB_BROWSER && echo FENCED`;
/**
 * Docker redirects port 53 to an internal resolver port before the filter
 * chain, so the exception matches the connection's original port. Opening
 * every port on its address also opened wildcard listeners in this namespace.
 * A changed fence replaces existing browsers too, even on the same image.
 */
/** The marker is written only after the fence and the verified privilege drop. */
export const BROWSER_READY_FILE = '/tmp/.hatchabot-browser-fenced';
/** Kept equal to the browser image's default ENTRYPOINT + CMD. */
export const BROWSER_CHROMIUM_ARGV = ['chromium', '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--user-data-dir=/profile',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', 'about:blank'];
/** Refuse to launch if the kernel did not apply every part of the drop. */
export const BROWSER_UNPRIVILEGED_SCRIPT = `set -e
checked=0
while read -r key a b c d; do
  case "$key" in
    Uid:|Gid:) [ "$a $b $c $d" = "${BROWSER_UID} ${BROWSER_UID} ${BROWSER_UID} ${BROWSER_UID}" ] || exit 1; checked=$((checked+1)) ;;
    CapInh:|CapPrm:|CapEff:|CapBnd:|CapAmb:) case "$a" in ''|*[!0]*) exit 1 ;; esac; checked=$((checked+1)) ;;
    Groups:) [ -z "$a$b$c$d" ] || exit 1; checked=$((checked+1)) ;;
    NoNewPrivs:) [ "$a" = 1 ] || exit 1; checked=$((checked+1)) ;;
  esac
done < /proc/self/status
[ "$checked" -eq 9 ]
umask 077
: > ${BROWSER_READY_FILE}
exec "$@"`;
/**
 * Fence and Chromium start in the very same container namespace (HB-0724).
 * A separate fence container could finish before the agent restarted, then
 * Chromium joined the new, unfenced namespace. Startup alone has NET_ADMIN
 * and the three capabilities needed to drop uid/gid and the bounding set;
 * Chromium gets none. Docker exec callers must explicitly use BROWSER_UID.
 */
export const BROWSER_START_SCRIPT = `${BROWSER_FENCE_SCRIPT}
exec setpriv --reuid=${BROWSER_UID} --regid=${BROWSER_UID} --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs sh -c '${BROWSER_UNPRIVILEGED_SCRIPT.replace(/'/g, `'\\''`)}' sh "$@"`;
export const BROWSER_FENCE_VERSION = createHash('sha256').update(BROWSER_START_SCRIPT).update(JSON.stringify(BROWSER_CHROMIUM_ARGV)).digest('hex').slice(0, 16);

/**
 * Keep its logins (HB-0680, docs/browser-logins-design.md). The profile is a
 * volume per agent, named for the agent's container and an id the agent's
 * record holds. Forget gives the agent a new id: the old volume is never
 * mounted again, even when its machine cannot be reached at that moment, and
 * the sweep removes it once it can. Never in a backup, a download, a template
 * or a clone: its cookies are as good as passwords.
 */
export const newBrowserLogins = (): string => randomBytes(6).toString('hex');
export const BROWSER_LOGINS_RE = /^[0-9a-f]{12}$/;
export const browserLoginsVolume = (agentContainer: string, logins: string): string => `${agentContainer}-browser-logins-${logins}`;
/** Its label, which the backup script leaves out by (scripts/backup-volumes.sh). */
export const BROWSER_LOGINS_ROLE = 'browser-logins';
/**
 * A new profile volume, once, as root with only the right to change owners:
 * a new volume is root's, and Chromium (1001) did not start on it. "Continue
 * where you left off" too: without it Chromium drops session cookies when it
 * ends, and a session cookie is how most sites keep a sign-in (the trial).
 */
export const BROWSER_PROFILE_PREP = `set -e
mkdir -p /profile/Default
[ -e /profile/Default/Preferences ] || printf '%s' '{"session":{"restore_on_startup":1}}' > /profile/Default/Preferences
chown -R ${BROWSER_UID}:${BROWSER_UID} /profile
echo READY`;
/**
 * Before each start, as the browser's user: the lock a browser removed
 * without closing leaves (a power cut, an agent's container gone first).
 * Another Chromium may take it for its own and refuse the profile.
 * UNPREPARED first when the prep never finished on it (a start stopped
 * between the volume's making and its prep): still root's, Chromium could
 * not use it, and the volume being there kept it from being prepared again
 * (HB-0975).
 */
export const BROWSER_PROFILE_UNLOCK = 'if ! { [ -w /profile ] && [ -w /profile/Default ] && [ -f /profile/Default/Preferences ]; }; then echo UNPREPARED; exit 0; fi; rm -f /profile/SingletonLock /profile/SingletonSocket /profile/SingletonCookie && echo UNLOCKED';
/**
 * Closing a browser that keeps logins: run with node in the agent's container,
 * as the agent's user (the fence holds the browser's user off loopback, where
 * the port is). Browser.close writes the profile and Chromium exits in about
 * two seconds; `docker stop` or `rm -f` ends it first, and what changed in
 * the last half minute, a sign-in included, was lost (the trial). Prints
 * CLOSING once the browser has the command.
 */
export const BROWSER_CLOSE_SOURCE = `const quit = (c) => process.exit(c);
setTimeout(() => quit(2), 6000);
try {
  const v = await (await fetch('${BROWSER_CDP_URL}/json/version', { signal: AbortSignal.timeout(3000) })).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  const done = () => { console.log('CLOSING'); quit(0); };
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  ws.onmessage = (m) => { try { if (JSON.parse(String(m.data)).id === 1) done(); } catch {} };
  ws.onclose = done;
  ws.onerror = () => quit(1);
} catch { quit(1); }`;
