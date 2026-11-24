import { createAdopts, type Adopts, type AdoptsDeps } from './adopts.js';
import { createCopies, type Copies, type CopiesDeps } from './copies.js';
import { createInbox, type Inbox } from './inbox.js';
import { createMoves, type Moves, type MovesDeps } from './moves.js';

/**
 * The moves, import and export service (HB-0808 step 12):
 * an agent going somewhere else, or coming in from
 * somewhere else. Four parts:
 *
 *  - `moves` (moves.ts): to another machine of this install, to another
 *    Hatchabot, the servers this account knows, and the questions another
 *    server asks before and after it sends one here;
 *  - `copies` (copies.ts): the whole agent as a file and back, a template and
 *    back, a clone and a derived child;
 *  - `inbox` (inbox.ts): a template sent to another account in the app, and
 *    accepted or turned away there;
 *  - `adopts` (adopts.ts): what was made outside Hatchabot brought in: the
 *    OpenClaw agents on this machine, a workspace's folders, a workspace
 *    copied into an agent and its tasks carried after it.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route files on the shared context (`ctx.transfers`). The schedules
 * service's quick pass gives the deferred adopts their turn
 * (`adopts.finishDeferredAdopts`). Nothing here knows about HTTP. No timer,
 * so no `stop()`: a move or an import is an operation on disk, settled at
 * the start (`resumeOperations`), and a deferred adopt is the store's.
 *
 * Moving (moveHost.ts, migrate.ts), the archive (transfer.ts), templates
 * (template.ts) and adopting a workspace (adopt.ts, openclawImport.ts) are
 * their own modules, used beyond this feature (the boot resume, the
 * channel-token route, the census); this is what the API built on them.
 */
export interface Transfers {
  moves: Moves;
  copies: Copies;
  inbox: Inbox;
  adopts: Adopts;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type TransfersDeps = MovesDeps & CopiesDeps & AdoptsDeps;

export function createTransfers(deps: TransfersDeps): Transfers {
  const moves = createMoves(deps);
  const copies = createCopies(deps);
  const inbox = createInbox({ ...deps, copies });
  const adopts = createAdopts(deps);
  return { moves, copies, inbox, adopts };
}
