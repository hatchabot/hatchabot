import { createRequire } from 'node:module';

/** The running Hatchabot version. Used to stamp the app shell, and to notice
 *  when a management agent is still holding an older version's tool list. */
export const APP_VERSION: string = (() => {
  try {
    return createRequire(import.meta.url)('../../package.json').version ?? 'dev';
  } catch {
    return 'dev';
  }
})();
