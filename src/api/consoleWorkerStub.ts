/**
 * The stand-in for an agent console's service worker (OpenClaw's sw.js),
 * served by the console proxy at /v1/agents/<id>/ui/sw.js.
 *
 * OpenClaw's own worker caches the console's files (55 MB a build) so the
 * console loads offline. Through Hatchabot every agent's console lives under
 * its own path on ONE site address, so each agent registered its own worker
 * and cached its own copy, and the worker keeps three builds: fifty agents
 * filled the browser's storage for the site. Past the quota every console
 * warned "Could not store the previous draft in browser storage" on each
 * keystroke (the draft store shares the quota), and the worker's own cache
 * writes threw QuotaExceededError (2026-10-23).
 *
 * This worker keeps nothing. It installs where the console asked for one,
 * throws away every openclaw-control-* cache the real workers left behind,
 * and unregisters itself, so a browser cleans up on its next visit and the
 * console runs from the network as the rest of the app does. It answers no
 * fetch and no message: the console's version probe (sw-version-probe) gets
 * no reply within its second and so never asks for a reload.
 */
export const CONSOLE_WORKER_STUB = `// Hatchabot: the console's service worker keeps nothing here (see src/api/consoleWorkerStub.ts).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('openclaw-control-')).map((k) => caches.delete(k)));
    } catch {}
    try { await self.registration.unregister(); } catch {}
  })());
});
`;
