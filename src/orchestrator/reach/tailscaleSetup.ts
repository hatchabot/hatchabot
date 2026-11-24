import { enableServe, tailnetInfo, writePublicUrl, type TailnetInfo } from '../../ops/tailnet.js';
import type { AppAddress } from './appAddress.js';

/**
 * Tailscale for this machine's own address (HB-0808 step 15 part B): is it
 * on a tailnet, and is Hatchabot already served over HTTPS on it; `tailscale
 * serve` turned on from the app; that address written for links; and the
 * address a QR code encodes. Each is the machine owner's (the routes check
 * that first). Every probe here tells the app's address what it found.
 */
export interface TailscaleSetup {
  /** What the machine knows: Tailscale's state, the port, and the address the app shows. */
  status(): Promise<Record<string, unknown>>;
  /** Turn on `tailscale serve`: already on, turned on, or refused (409) in its words. */
  serve(): Promise<SetupOutcome>;
  /** Write the tailnet address into the .env as HATCHABOT_PUBLIC_URL, and use it now. */
  useForLinks(): Promise<SetupOutcome>;
  /** The HTTPS address a QR code should encode: the tailnet's, else HATCHABOT_PUBLIC_URL as set. */
  qrAddress(): Promise<string | undefined>;
}

export type SetupOutcome =
  | { ok: true; answer: Record<string, unknown> }
  /** Answered 409 with this body. */
  | { ok: false; refusal: { error: string; command?: string } };

export interface TailscaleSetupDeps {
  address: AppAddress;
  /** `HATCHABOT_PUBLIC_URL` as the server was started with. */
  publicUrl: () => string | undefined;
  /** The port Hatchabot listens on (`PORT`, read at each call). */
  port: () => number;
  /** The .env the service reads (read at each call). */
  envPath: () => string;
  /** What sign-in links are checked against until a restart: undefined while they are off, else the origin, if any (src/api/signinLink.ts `signinLinkAudience`). */
  signinLinkAudience?: () => { origin: string | undefined } | undefined;
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  warn: (detail: Record<string, unknown>, msg: string) => void;
  /** The tests' stand-ins for the tailscale commands and the .env write. */
  tailnet?: {
    info?: (port: number) => Promise<TailnetInfo>;
    enableServe?: (port: number) => Promise<{ ok: boolean; error?: string }>;
    writePublicUrl?: (envPath: string, url: string) => Promise<{ ok: boolean; replaced?: boolean; error?: string }>;
  };
}

export function createTailscaleSetup(deps: TailscaleSetupDeps): TailscaleSetup {
  const info = deps.tailnet?.info ?? tailnetInfo;
  const serveOn = deps.tailnet?.enableServe ?? enableServe;
  const writeUrl = deps.tailnet?.writePublicUrl ?? writePublicUrl;
  const { address, trace } = deps;
  return {
    async status() {
      const port = deps.port();
      const found = await info(port).catch(() => ({ installed: false }));
      address.saw((found as { url?: string }).url);
      return { ...found, port, publicUrl: address.appUrl() };
    },

    /**
     * Turn on `tailscale serve`, rather than asking someone to paste a command
     * into a terminal. It is the machine owner's call and nothing else: serving
     * puts Hatchabot on the tailnet — every device signed into it, and nothing
     * on the public internet.
     */
    async serve() {
      const port = deps.port();
      const before = await info(port).catch(() => ({ installed: false }) as TailnetInfo);
      if (!before.installed) return { ok: false, refusal: { error: 'Tailscale is not installed on this machine.' } };
      if (!before.dns) return { ok: false, refusal: { error: 'Tailscale is installed but not connected — run `tailscale up` first.' } };
      if (before.serving) return { ok: true, answer: { ...before, alreadyOn: true } };
      const run = await serveOn(port);
      if (!run.ok) {
        deps.warn({ error: run.error }, 'tailscale.serve_failed');
        return { ok: false, refusal: {
          error: run.error || 'Could not turn it on.',
          command: `tailscale serve --bg http://localhost:${port}`,
        } };
      }
      const after = await info(port).catch(() => before);
      address.saw(after.url);
      trace()('tailscale.serve_enabled', { dns: after.dns, serving: after.serving === true });
      return { ok: true, answer: { ...after, turnedOn: true } };
    },

    /**
     * Remember this address for links, by writing it into the .env the service
     * reads. Detection already covers the screen; this covers an invite opened
     * next week, when the probe may not have run.
     */
    async useForLinks() {
      const found = await info(deps.port()).catch(() => undefined);
      const url = found?.url;
      if (!url) {
        return { ok: false, refusal: { error: 'There is no working HTTPS address to write yet — turn on HTTPS first.' } };
      }
      const envPath = deps.envPath();
      const out = await writeUrl(envPath, url).catch((err: unknown) => ({ ok: false, error: String(err) }));
      if (!out.ok) return { ok: false, refusal: { error: out.error ?? 'Could not write .env' } };
      address.use(url);   // in force now; the file is for the next restart
      trace()('app.public_url_written', { url, envPath, replaced: (out as { replaced?: boolean }).replaced === true });
      // Everything reads it now but sign-in links, which check the address
      // the process started with until a restart, or none (HB-1314).
      const links = deps.signinLinkAudience?.();
      let origin: string | undefined;
      try { origin = new URL(url).origin; } catch { /* the probe's own address: always a URL */ }
      return { ok: true, answer: { written: envPath, url, restartNeeded: !!links && links.origin !== origin } };
    },

    async qrAddress() {
      const found = await info(deps.port()).catch(() => ({ url: undefined }) as { url?: string });
      return found.url ?? deps.publicUrl();
    },
  };
}
