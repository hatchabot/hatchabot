/** Peer servers may live on a LAN, but never on loopback or link-local addresses. */
export function allowedPeerAddress(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const localV4 = (h: string) => /^(?:127\.|0\.|169\.254\.)/.test(h);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || localV4(host)) return false;
  if (host === '::' || host === '::1' || /^fe[89ab][0-9a-f]:/.test(host)) return false;
  // URL canonicalizes IPv4-mapped literals to hex, e.g. ::ffff:7f00:1.
  const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
    if (localV4(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`)) return false;
  }
  return true;
}
