import { createDefinitionPush, type DefinitionPush, type DefinitionPushDeps } from './definitionPush.js';
import { createSetupValues, type SetupValues, type SetupValuesDeps } from './setupValues.js';

/**
 * An agent's definition (HB-0808 step 15, part C): its setup values
 * applied to its files (`values`, setupValues.ts), and a master's
 * definition pushed to its children (`push`, definitionPush.ts). Both
 * write core files, each agent in its core-files turn (the files
 * service's) and under its busy flag.
 *
 * Built once in `registerRoutes` and on the route context as
 * `ctx.definition`; its routes are in src/api/definitionRoutes.ts. A merged
 * proposal's push to the children goes through the push route
 * (memoryRoutes.ts). No state and no timer of its own. Nothing here knows
 * HTTP.
 */
export interface AgentDefinition {
  values: SetupValues;
  push: DefinitionPush;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type AgentDefinitionDeps = SetupValuesDeps & DefinitionPushDeps;

export function createAgentDefinition(deps: AgentDefinitionDeps): AgentDefinition {
  return { values: createSetupValues(deps), push: createDefinitionPush(deps) };
}
