import { tailnetInfo, type TailnetInfo } from '../../ops/tailnet.js';

/**
 * The app's own addresses (HB-0808 step 15 part B): the one to SHOW people
 * and the one for links SENT to people. Every feature that puts the app's
 * address on a page, a QR code, an invitation, a reset link or a note reads
 * these two, from here.
 */

/** A loopback address is not a public address: it is useless on a QR code,
 *  in an invite link, or anywhere else it would be sent to another device.
 *  A machine that set HATCHABOT_PUBLIC_URL to localhost meant well; prefer
 *  the address the machine is actually reachable at. */
export const loopbackUrl = (u: string | undefined): boolean =>
  !!u && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u);

export interface AppAddress {
  /**
   * The address to SHOW people, when nobody has set `HATCHABOT_PUBLIC_URL`.
   *
   * A machine serving itself on a tailnet already has a real HTTPS address,
   * and printing `http://localhost:8080` on a QR code for a phone is useless
   * — the phone is not this machine. So the detected address stands in for
   * display: the install QR, the invite links, the address the app shows.
   *
   * Refreshed on a timer and whenever the Tailscale routes run — never inline
   * from a request, least of all the unauthenticated /v1/config, because the
   * probe spawns a process.
   */
  appUrl(): string | undefined;
  /**
   * The address for links that are SENT to people (an invitation, a reset
   * link): the public one while public access is on and serving, because the
   * person opening it may not be on the tailnet; the private one otherwise.
   * Never from a request's Host. The owner's own pages (the app's QR code,
   * Google's consent coming back) stay on the private address.
   */
  linkUrl(): string | undefined;
  /** What a Tailscale probe found: the detected address, unless a real `HATCHABOT_PUBLIC_URL` is set. */
  saw(url: string | undefined): void;
  /** This address, written for links: in force now, whatever is set (the file is for the next restart). */
  use(url: string): void;
  /** End the refresh's timers. */
  stop(): void;
}

export interface AppAddressDeps {
  /** `HATCHABOT_PUBLIC_URL` as the server was started with (read at each call). */
  publicUrl: () => string | undefined;
  /** The port Hatchabot listens on (`PORT`, read at each call). */
  port: () => number;
  /** The proxy's listener, where `tailscale serve` lands (src/api/proxyListener.ts); unset, the app's own port. */
  proxyPort?: () => number;
  /** Public access, as the gate says it is now: on, serving and its address (undefined with no gate). */
  publicStatus: () => { on: boolean; serving: boolean; url?: string } | undefined;
  /** Look again at the tailnet 4 s after the start and every 10 minutes (off under tests). */
  refreshOn: boolean;
  /** The tests' stand-in for the Tailscale probe. */
  tailnetInfo?: (port: number, mainPort?: number) => Promise<TailnetInfo>;
}

/**
 * The address `use` wrote for links in this process, for the two readers
 * that judge a request with no AppAddress to hand (HB-1314): the origin
 * check (`foreignRequest`, src/api/requestOrigin.ts) and the session
 * cookie's https fallback (`requestIsHttps`, src/api/signIn/sessionCookie.ts),
 * which a WebSocket upgrade calls too. Each counts it beside
 * HATCHABOT_PUBLIC_URL as the process started with, which it replaces at
 * the next restart (the .env has it). One a process: the service builds one
 * AppAddress, which starts from the settings (a new one clears it), and
 * whose `stop` clears it.
 */
let writtenInThisProcess: string | undefined;
export const publicUrlWritten = (): string | undefined => writtenInThisProcess;

export function createAppAddress(deps: AppAddressDeps): AppAddress {
  writtenInThisProcess = undefined;
  const probe = deps.tailnetInfo ?? tailnetInfo;
  let detectedUrl: string | undefined;
  // What `use` wrote to the .env since the start: the setting from now on, as
  // it will be after a restart. Only `detectedUrl` changed, so a real
  // HATCHABOT_PUBLIC_URL from the start kept winning, and every link went on
  // naming the old address until a restart (HB-1008).
  let writtenUrl: string | undefined;
  const setting = (): string | undefined => writtenUrl ?? deps.publicUrl();
  const refreshDetectedUrl = async (): Promise<void> => {
    if (setting() && !loopbackUrl(setting())) return; // a real setting wins
    // Serve at the proxy's listener, or still at the app's own port (HB-1239): the address is the same.
    const info = await probe(deps.proxyPort?.() ?? deps.port(), deps.port()).catch(() => undefined);
    detectedUrl = info?.url;
  };
  const appUrlFor = (): string | undefined => {
    const set = setting()?.replace(/\/$/, '') || undefined;
    if (set && !loopbackUrl(set)) return set;
    return detectedUrl ?? set;
  };
  const linkUrlFor = (): string | undefined => {
    const st = deps.publicStatus();
    return st?.on && st.serving && st.url ? st.url : appUrlFor();
  };
  const timers: NodeJS.Timeout[] = [];
  if (deps.refreshOn) {
    timers.push(setTimeout(() => { void refreshDetectedUrl(); }, 4_000).unref());
    timers.push(setInterval(() => { void refreshDetectedUrl(); }, 10 * 60_000).unref());
  }
  return {
    appUrl: appUrlFor,
    linkUrl: linkUrlFor,
    saw: (url) => { if (!setting() || loopbackUrl(setting())) detectedUrl = url; },
    use: (url) => { writtenUrl = url; detectedUrl = url; writtenInThisProcess = url; },
    stop: () => {
      for (const t of timers) clearTimeout(t);
      if (writtenUrl !== undefined && writtenInThisProcess === writtenUrl) writtenInThisProcess = undefined;
    },
  };
}
