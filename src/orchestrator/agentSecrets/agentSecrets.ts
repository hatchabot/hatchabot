import { createBotTokenStep, type BotTokenStep, type BotTokenStepDeps } from './botTokenStep.js';
import { createEnvValues, type EnvValues, type EnvValuesDeps } from './envValues.js';

/**
 * An agent's secrets that its owner hands it (HB-0808 step 15, part C):
 * its environment values (`env`, envValues.ts), kept in the secret store
 * and never answered, and the bot token its parked setup waits for
 * (`botToken`, botTokenStep.ts), held by the Telegram channel for setup to
 * take. The gateway credential its owner reveals is read from its record
 * by the route.
 *
 * Built once in `registerRoutes` and on the route context as
 * `ctx.agentSecrets`; its routes are in src/api/agentSecretRoutes.ts. No
 * state and no timer of its own. Nothing here knows HTTP.
 */
export interface AgentSecrets {
  env: EnvValues;
  botToken: BotTokenStep;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type AgentSecretsDeps = EnvValuesDeps & BotTokenStepDeps;

export function createAgentSecrets(deps: AgentSecretsDeps): AgentSecrets {
  return { env: createEnvValues(deps), botToken: createBotTokenStep(deps) };
}
