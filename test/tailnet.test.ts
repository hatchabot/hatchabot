import { describe, expect, it } from 'vitest';
import { tailnetInfo } from '../src/ops/tailnet.js';

/**
 * The setup guide's HTTPS step reads this. Every probe is best-effort: a
 * machine with no Tailscale must answer "not installed" rather than throw,
 * because the step still has to render.
 */
describe('reading this machine’s tailnet', () => {
  it('says "not installed" instead of failing when the CLI is absent', async () => {
    const info = await tailnetInfo(8080);
    expect(typeof info.installed).toBe('boolean');
    if (!info.installed) {
      expect(info.url).toBeUndefined();
      expect(info.dns).toBeUndefined();
    }
  }, 20_000);

  it('never claims an address it did not find', async () => {
    const info = await tailnetInfo(65535); // nothing serves this
    expect(info.serving ?? false).toBe(false);
    expect(info.url).toBeUndefined();
  }, 20_000);

  it('offers a url only when the address actually answered', async () => {
    const info = await tailnetInfo(8080);
    // On a machine that serves, `url` and `reachable` agree; on one that does
    // not, there is no url at all. What must never happen is a url offered
    // for an address nobody checked.
    if (info.url) expect(info.reachable).toBe(true);
    if (info.serving && info.reachable === false) {
      expect(info.url).toBeUndefined();
      expect(typeof info.unreachableWhy).toBe('string');
    }
  }, 30_000);
});
