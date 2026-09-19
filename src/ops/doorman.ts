/**
 * The doorman: a tiny forwarder container that makes the management agent's
 * jail work the same on every host (docs/ops-agent-design.md).
 *
 * The jail is a Docker network with no route out. Hatchabot itself runs on the
 * HOST, so the agent has to reach it somehow. On Linux the bridge's gateway is
 * an address on the host, so Hatchabot could simply listen there — but on
 * Docker Desktop (macOS, Windows) that address lives inside Docker's virtual
 * machine and the host cannot listen on it at all.
 *
 * So the door is reached through a container instead:
 *
 *     agent ──► doorman:8091 ──► host.docker.internal:<ops port>   (tools + AI)
 *      ▲                                                            
 *      └──── doorman:18790 ◄── 127.0.0.1:<gateway port> on the host (console)
 *
 * The doorman runs no agent code: it is a fixed pair of TCP forwards with no
 * shell the agent can reach, and the agent still has exactly one reachable
 * address. Docker resolves `doorman` and the agent's container name on the
 * jail network's own DNS.
 */

export interface DoormanRoute {
  /** Port the doorman listens on, inside the jail. */
  listen: number;
  /** Where it forwards to (a container name, or host.docker.internal). */
  host: string;
  port: number;
}

/** Inside the jail, the agent reaches Hatchabot's door here. */
export const DOORMAN_ALIAS = 'doorman';
export const DOORMAN_DOOR_PORT = 8091;
/** The console's way in: published on the host, forwarded to the agent's gateway. */
export const DOORMAN_CONSOLE_PORT = 18790;
/** Docker maps this name to the host on every platform (`--add-host=…:host-gateway`). */
export const HOST_ALIAS = 'host.docker.internal';

/**
 * The forwarder, as a one-liner for `node -e`. It runs in the runtime image
 * (already on the machine, so nothing new is pulled) and keeps no state.
 * Bounded: a runaway agent cannot open unlimited sockets through it.
 */
export function doormanScript(): string {
  return [
    'const net=require("net");',
    'const routes=JSON.parse(process.env.DOORMAN_ROUTES||"[]");',
    'const MAX=Number(process.env.DOORMAN_MAX||64);',
    'let open=0;',
    'for(const r of routes){',
    'net.createServer((c)=>{',
    'if(open>=MAX){c.destroy();return;}',
    'open++;let done=false;const bye=()=>{if(!done){done=true;open--;}u.destroy();c.destroy();};',
    'const u=net.connect(r.port,r.host,()=>{u.pipe(c);c.pipe(u);});',
    'u.on("error",bye);c.on("error",bye);u.on("close",bye);c.on("close",bye);',
    '}).listen(r.listen,"0.0.0.0");',
    '}',
    'process.on("SIGTERM",()=>process.exit(0));',
  ].join('');
}

/**
 * What the doorman forwards for one management agent. The door's own address
 * decides how the doorman reaches it: a loopback door is only reachable
 * through Docker's host alias (Docker Desktop), while a door bound on the
 * bridge gateway (Linux) is reached at that address directly.
 */
export function doormanRoutes(opts: { opsHost: string; opsPort: number; agentContainer: string }): DoormanRoute[] {
  const host = /^(127\.|::1$|localhost$)/.test(opts.opsHost) ? HOST_ALIAS : opts.opsHost;
  return [
    { listen: DOORMAN_DOOR_PORT, host, port: opts.opsPort },
    { listen: DOORMAN_CONSOLE_PORT, host: opts.agentContainer, port: 18789 },
  ];
}
