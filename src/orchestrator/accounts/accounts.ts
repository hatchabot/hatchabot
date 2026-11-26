import { createCliTokens, type CliTokens } from './cliTokens.js';
import { createFamilyAccounts, type FamilyAccounts, type FamilyAccountsDeps } from './familyAccounts.js';
import { createPeople, type People, type PeopleDeps } from './people.js';
import { createTelegramRecovery, type TelegramRecovery, type TelegramRecoveryDeps } from './telegramRecovery.js';

/**
 * Accounts (HB-0808 step 15 part B):
 * what the routes registry did for accounts, beside the sign-in itself
 * (src/api/signIn/auth.ts, src/api/signIn/accountsAuth.ts), which stays where it is. Four
 * parts:
 *
 *  - `family` (familyAccounts.ts): one shared password switched to an
 *    account per person, once and never back;
 *  - `recovery` (telegramRecovery.ts): "Forgot password?" by a link sent
 *    on Telegram or Discord, with its throttles;
 *  - `cliTokens` (cliTokens.ts): the command-line tokens, made, listed and
 *    revoked;
 *  - `people` (people.ts): the roster of the people on one's agents, and
 *    the accounts a share can be addressed to.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and on the
 * shared context (`ctx.accounts`). Nothing here knows about HTTP. `stop()`
 * ends the switch's restart timer.
 */
export interface Accounts {
  family: FamilyAccounts;
  recovery: TelegramRecovery;
  cliTokens: CliTokens;
  people: People;
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type AccountsDeps = Omit<FamilyAccountsDeps, 'store'> & Omit<TelegramRecoveryDeps, 'store'> & Omit<PeopleDeps, 'store'> & {
  store: FamilyAccountsDeps['store'] & TelegramRecoveryDeps['store'] & PeopleDeps['store'] & Parameters<typeof createCliTokens>[0]['store'];
};

export function createAccounts(deps: AccountsDeps): Accounts {
  const family = createFamilyAccounts(deps);
  const recovery = createTelegramRecovery(deps);
  const cliTokens = createCliTokens(deps);
  const people = createPeople(deps);
  return { family, recovery, cliTokens, people, stop: () => family.stop() };
}
