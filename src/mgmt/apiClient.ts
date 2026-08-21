import type { ApiClient, AgentSummary, Member, PairingRequest, EventRow } from './broker.js';

/**
 * The concrete owner-scoped /v1 client the broker drives. One bearer token (a
 * cli-token minted for this bot) authenticates every call, so results are
 * inherently scoped to that account. Uses global fetch (Node 22+); no deps.
 *
 * Response-shape coupling is deliberately forgiving — the control plane's
 * publicAgent already returns { id, name, slug, state, model, aiProfileId },
 * and the few list endpoints are normalized here so the broker sees clean types.
 */
export class HttpApiClient implements ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async #req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
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
      const o = r as { lines?: string[]; logs?: string };
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
  async getPool(): Promise<{ availableBots: number }> {
    return (await this.#req('GET', '/v1/pool')) as { availableBots: number };
  }
  async listEvents(agentId: string | undefined, limit: number): Promise<EventRow[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (agentId) q.set('agentId', agentId);
    return (await this.#req('GET', `/v1/events?${q.toString()}`)) as EventRow[];
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
  async removeMember(id: string, userId: string): Promise<void> {
    await this.#req('DELETE', `/v1/agents/${id}/members/${encodeURIComponent(userId)}`);
  }
}
