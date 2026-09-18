import type { ApiClient, AgentSummary, Member, PairingRequest, PendingJoin, EventRow, HealthResult, UsageResult, ProfileSummary, HostSummary, ImageSummary } from './broker.js';

/** How a request reaches /v1: over the network (fetch, the mgmt bot) or
 *  in-process (app.inject, the web chat pane). Resolves the parsed body or
 *  throws an Error whose message is the server's `error` field. */
export type Requester = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** The mgmt bot's transport: real HTTP with its cli-token. Global fetch, no deps. */
export function fetchRequester(baseUrl: string, token: string): Requester {
  return async (method, path, body) => {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try {
        msg = JSON.parse(text).error ?? text;
      } catch {
        /* not json */
      }
      throw new Error(`${res.status} ${msg}`.trim());
    }
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('application/json') ? res.json() : res.text();
  };
}

/**
 * The concrete owner-scoped /v1 client the broker drives. The transport
 * carries the caller's identity (bearer token over HTTP, or the web session's
 * own headers via app.inject), so results are inherently scoped to that
 * account — the broker never has more authority than whoever it acts for.
 *
 * Response-shape coupling is deliberately forgiving — the control plane's
 * publicAgent already returns { id, name, slug, state, model, aiProfileId },
 * and the few list endpoints are normalized here so the broker sees clean types.
 */
export class HttpApiClient implements ApiClient {
  #request: Requester;

  constructor(requester: Requester);
  constructor(baseUrl: string, token: string);
  constructor(a: Requester | string, b?: string) {
    this.#request = typeof a === 'string' ? fetchRequester(a, b!) : a;
  }

  async #req(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.#request(method, path, body);
  }

  async listAgents(): Promise<AgentSummary[]> {
    const rows = (await this.#req('GET', '/v1/agents')) as AgentSummary[];
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      state: a.state,
      model: a.model,
      aiProfileId: a.aiProfileId,
    }));
  }
  async getAgent(id: string): Promise<AgentSummary> {
    return (await this.#req('GET', `/v1/agents/${id}`)) as AgentSummary;
  }
  async getLogs(id: string, lines: number): Promise<string> {
    const r = (await this.#req('GET', `/v1/agents/${id}/logs?lines=${lines}`)) as unknown;
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object') {
      // The real route returns { text } — the shape this method somehow never
      // handled, so every live /logs rendered raw JSON (audit 2026-09-03).
      const o = r as { text?: string; lines?: string[]; logs?: string };
      if (typeof o.text === 'string') return o.text;
      if (Array.isArray(o.lines)) return o.lines.join('\n');
      if (typeof o.logs === 'string') return o.logs;
    }
    return JSON.stringify(r);
  }
  async listMembers(id: string): Promise<Member[]> {
    return (await this.#req('GET', `/v1/agents/${id}/members`)) as Member[];
  }
  async listPairing(id: string): Promise<PairingRequest[]> {
    const r = (await this.#req('GET', `/v1/agents/${id}/pairing`)) as
      | PairingRequest[]
      | { requests?: PairingRequest[] };
    return Array.isArray(r) ? r : (r.requests ?? []);
  }
  async listAllPending(): Promise<PendingJoin[]> {
    const r = (await this.#req('GET', '/v1/pending')) as PendingJoin[];
    return Array.isArray(r) ? r : [];
  }
  async getPool(): Promise<{ availableBots: number }> {
    return (await this.#req('GET', '/v1/pool')) as { availableBots: number };
  }
  async listEvents(agentId: string | undefined, limit: number): Promise<EventRow[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (agentId) q.set('agentId', agentId);
    return (await this.#req('GET', `/v1/events?${q.toString()}`)) as EventRow[];
  }
  async getHealth(id: string): Promise<HealthResult> {
    return (await this.#req('GET', `/v1/agents/${id}/health`)) as HealthResult;
  }
  async getUsage(id: string): Promise<UsageResult> {
    return (await this.#req('GET', `/v1/agents/${id}/usage`)) as UsageResult;
  }
  async availableModels(profileId: string): Promise<string[]> {
    const r = (await this.#req('GET', `/v1/ai-profiles/${profileId}/available-models`)) as
      | string[]
      | { models?: string[] };
    return Array.isArray(r) ? r : (r.models ?? []);
  }
  async startAgent(id: string): Promise<void> {
    await this.#req('POST', `/v1/agents/${id}/start`, {});
  }
  async stopAgent(id: string): Promise<void> {
    await this.#req('POST', `/v1/agents/${id}/stop`, {});
  }
  async rebuildAgent(id: string): Promise<void> {
    await this.#req('POST', `/v1/agents/${id}/rebuild`, {});
  }
  async setModel(id: string, model: string): Promise<void> {
    await this.#req('PATCH', `/v1/agents/${id}`, { model });
  }
  async approvePairing(id: string, code: string): Promise<void> {
    await this.#req('POST', `/v1/agents/${id}/pairing/approve`, { code });
  }
  async denyPairing(id: string, code: string): Promise<void> {
    await this.#req('POST', `/v1/agents/${id}/pairing/deny`, { code });
  }
  async removeMember(id: string, userId: string): Promise<void> {
    await this.#req('DELETE', `/v1/agents/${id}/members/${encodeURIComponent(userId)}`);
  }

  // ---- authoring ----------------------------------------------------------

  async listProfiles(): Promise<ProfileSummary[]> {
    const rows = (await this.#req('GET', '/v1/ai-profiles')) as ProfileSummary[];
    return rows.map((p) => ({ id: p.id, name: p.name, vendor: p.vendor, model: p.model }));
  }
  async listHosts(): Promise<HostSummary[]> {
    const rows = (await this.#req('GET', '/v1/hosts')) as HostSummary[];
    return rows.map((h) => ({ id: h.id, name: h.name, kind: h.kind }));
  }
  async createAgent(body: {
    name: string;
    persona?: string;
    aiProfileId: string;
    hostId: string;
  }): Promise<AgentSummary> {
    return (await this.#req('POST', '/v1/agents', body)) as AgentSummary;
  }
  async getFile(id: string, name: string): Promise<string> {
    const r = (await this.#req('GET', `/v1/agents/${id}/files/${encodeURIComponent(name)}`)) as {
      content?: string;
    };
    return r.content ?? '';
  }
  async putFile(id: string, name: string, content: string): Promise<void> {
    await this.#req('PUT', `/v1/agents/${id}/files/${encodeURIComponent(name)}`, { content });
  }
  async patchAgent(
    id: string,
    body: { persona?: string; parameters?: Array<Record<string, unknown>> },
  ): Promise<void> {
    await this.#req('PATCH', `/v1/agents/${id}`, body);
  }

  // ---- images -------------------------------------------------------------

  async getRuntime(): Promise<{ imageVersion?: string; npmLatest?: string; upgradeAvailable: boolean }> {
    return (await this.#req('GET', '/v1/runtime')) as {
      imageVersion?: string;
      npmLatest?: string;
      upgradeAvailable: boolean;
    };
  }
  async listImages(): Promise<{ base: string; images: ImageSummary[] }> {
    return (await this.#req('GET', '/v1/images')) as { base: string; images: ImageSummary[] };
  }
  async imageLog(name: string): Promise<{ status: string; error?: string; log: string }> {
    return (await this.#req('GET', `/v1/images/${encodeURIComponent(name)}/log`)) as {
      status: string;
      error?: string;
      log: string;
    };
  }
  async buildImage(body: { name: string; dockerfile: string; base?: string }): Promise<void> {
    await this.#req('POST', '/v1/images', body);
  }
  async rebuildImage(name: string, base?: string): Promise<void> {
    await this.#req('POST', `/v1/images/${encodeURIComponent(name)}/rebuild`, base ? { base } : {});
  }
  async listBaseImages(): Promise<BaseImages> {
    return (await this.#req('GET', '/v1/runtime/images')) as BaseImages;
  }
  async baseBuild(): Promise<{ running?: boolean; version?: string; candidate?: boolean; ok?: boolean; error?: string; log?: string }> {
    return (await this.#req('GET', '/v1/runtime/build')) as { running?: boolean; ok?: boolean; error?: string; log?: string };
  }
  async buildBaseCandidate(version?: string): Promise<void> {
    await this.#req('POST', '/v1/runtime/build', { version, candidate: true });
  }
  async setAgentImage(id: string, image: string | null): Promise<void> {
    await this.#req('PATCH', `/v1/agents/${id}`, { image });
  }
  async removeImage(name: string): Promise<void> {
    await this.#req('DELETE', `/v1/images/${encodeURIComponent(name)}`);
  }

  // ---- LLM via the control plane's proxy ----------------------------------

  async llmStatus(): Promise<{
    available: boolean;
    profileName?: string;
    model?: string;
    credential?: string;
  }> {
    return (await this.#req('GET', '/v1/mgmt/llm')) as {
      available: boolean;
      profileName?: string;
      model?: string;
      credential?: string;
    };
  }

  async llmComplete(req: {
    system: string;
    tools: unknown[];
    messages: unknown[];
    maxTokens: number;
  }): Promise<{ stopReason: string; content: never[] }> {
    return (await this.#req('POST', '/v1/mgmt/llm/complete', req)) as {
      stopReason: string;
      content: never[];
    };
  }

  /** Phase-A presence: tell the control plane this bot is alive and how it's
   *  armed, so the web UI can show a real card instead of guessing. */
  async heartbeat(hb: {
    botUsername: string;
    mode: 'read-only' | 'read-write';
    llm?: string;
    allowlisted: number;
  }): Promise<void> {
    await this.#req('POST', '/v1/mgmt/heartbeat', hb);
  }
}

/** GET /v1/runtime/images, the parts the management tools read. */
export interface BaseImages {
  default: string;
  defaultInfo: { openclawVersion?: string; resolvesTo?: string[] } | null;
  building?: { base: { version?: string } | null };
  tags: Array<{
    tag: string;
    exists: boolean;
    isDefault: boolean;
    isLatest: boolean;
    openclawVersion?: string;
    relation: string;
    derived: unknown | null;
    pinned: Array<{ id: string; name: string }>;
  }>;
}
