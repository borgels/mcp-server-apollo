// The embeddable gateway (src/gateway.ts): the catalog, explicit credentials, the host's policy, the declared
// requests, the requests each tool makes and the projections of Apollo's answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apolloGatewayTools, apolloToolCatalog, createApolloGateway } from '../src/gateway.js';
import { pathFits } from '../src/apollo/gateway-client.js';

const TOKEN = 'qqqqwwwwzzzzxxxx1';
const ID = '64b2f0c1a1b2c3d4e5f60718';
const SEQ = '64b2f0c1a1b2c3d4e5f6aaaa';

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

function recording(answer: (seen: Seen) => unknown = () => ({})) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const entry: Seen = {
      method: String(init?.method),
      path: parsed.pathname,
      query: parsed.searchParams,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init?.headers as Record<string, string>,
    };
    seen.push(entry);
    return new Response(JSON.stringify(answer(entry)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetchImpl };
}

function gateway(fetchImpl: typeof fetch, enableWrites = true) {
  return createApolloGateway({ apiKey: TOKEN, fetchImpl, policy: { enableWrites } });
}

describe('catalog', () => {
  it('lists every tool with its risk, its upstream requests and no broad tool', () => {
    expect(apolloToolCatalog.map(tool => tool.name)).toEqual(apolloGatewayTools.map(tool => tool.name));
    expect(Object.isFrozen(apolloToolCatalog)).toBe(true);
    expect(apolloToolCatalog.every(tool => tool.broad === false)).toBe(true);
    const writes = apolloToolCatalog.filter(tool => tool.riskLevel === 'write').map(tool => tool.name);
    expect(writes).toEqual([
      'create_contact',
      'update_contact',
      'set_contact_stage',
      'set_contact_owner',
      'create_account',
      'update_account',
      'set_account_owner',
      'create_deal',
      'update_deal',
      'create_task',
      'complete_task',
      'add_contacts_to_sequence',
    ]);
    expect(apolloToolCatalog.some(tool => tool.riskLevel === 'destructive')).toBe(false);
    for (const tool of apolloToolCatalog) {
      for (const operation of tool.upstream) expect(operation.path, tool.name).toMatch(/^\/api\/v1\//);
      expect(tool.enabledByDefault).toBe(tool.riskLevel === 'read');
    }
  });

  it('has no phone reveal, webhook, deletion or user management', () => {
    const text = JSON.stringify(apolloToolCatalog);
    expect(text).not.toMatch(/webhook|revealPhone|delete|DELETE/i);
    expect(apolloToolCatalog.map(tool => tool.name)).not.toContain('webhook_result');
  });

  it('matches path templates segment by segment', () => {
    expect(pathFits('/api/v1/contacts/{contact_id}', `/api/v1/contacts/${ID}`)).toBe(true);
    expect(pathFits('/api/v1/contacts/{contact_id}', '/api/v1/contacts/')).toBe(false);
    expect(pathFits('/api/v1/contacts/{contact_id}', `/api/v1/contacts/${ID}/x`)).toBe(false);
    expect(pathFits('/api/v1/tasks/{id}/complete', `/api/v1/tasks/${ID}/complete`)).toBe(true);
  });
});

describe('credentials and policy', () => {
  it('requires an explicit key and never reads the environment', () => {
    vi.stubEnv('APOLLO_API_KEY', TOKEN);
    expect(() => createApolloGateway({} as never)).toThrow(/requires options.apiKey/);
    expect(() => createApolloGateway({ apiKey: 'short' })).toThrow(/credential was refused/);
  });

  it('refuses writes unless the host enables them', async () => {
    const { seen, fetchImpl } = recording();
    const result = await gateway(fetchImpl, false).callTool('update_contact', { contactId: ID, title: 'CEO' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Writes are disabled/);
    expect(seen).toEqual([]);
  });

  it('leaves out tools the host disables', async () => {
    const { fetchImpl } = recording();
    const gw = createApolloGateway({ apiKey: TOKEN, fetchImpl, policy: { disabledTools: ['people_bulk_enrich'] } });
    expect(gw.tools.map(tool => tool.name)).not.toContain('people_bulk_enrich');
    expect((await gw.callTool('people_bulk_enrich', { details: [{ id: ID }] })).isError).toBe(true);
  });

  it('refuses unknown fields', async () => {
    const { seen, fetchImpl } = recording();
    const result = await gateway(fetchImpl).callTool('get_contact', { contactId: ID, path: '/api/v1/users' });
    expect(result.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it('sends the key only as x-api-key to api.apollo.io', async () => {
    const { seen, fetchImpl } = recording(() => ({ id: 'u1', team_id: 't1' }));
    const result = await gateway(fetchImpl).callTool('check_connection', {});
    expect(result.structuredContent).toEqual({ connected: true, userId: 'u1', teamId: 't1' });
    expect(seen[0]!.path).toBe('/api/v1/users/api_profile');
    expect(seen[0]!.headers['x-api-key']).toBe(TOKEN);
  });
});

describe('requests', () => {
  it('searches contacts with a JSON body and projects the answer', async () => {
    const { seen, fetchImpl } = recording(() => ({
      pagination: { page: 1, per_page: 2, total_entries: 1, total_pages: 1 },
      contacts: [{ id: ID, name: 'Jane Doe', email: 'jane@example.com', crm_owner_id: 'x', secret_thing: 'y' }],
    }));
    const result = await gateway(fetchImpl).callTool('search_contacts', { qKeywords: 'Jane', perPage: 2 });
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/v1/contacts/search', body: { q_keywords: 'Jane', per_page: 2 } });
    expect(result.structuredContent).toEqual({
      pagination: { page: 1, per_page: 2, total_entries: 1, total_pages: 1 },
      contacts: [{ id: ID, name: 'Jane Doe', email: 'jane@example.com' }],
    });
  });

  it('updates a contact with a PATCH of the given fields only', async () => {
    const { seen, fetchImpl } = recording(() => ({ contact: { id: ID, title: 'CEO' } }));
    const result = await gateway(fetchImpl).callTool('update_contact', { contactId: ID, title: 'CEO', contactStageId: 's1' });
    expect(result.isError).toBeUndefined();
    expect(seen[0]).toMatchObject({ method: 'PATCH', path: `/api/v1/contacts/${ID}`, body: { title: 'CEO', contact_stage_id: 's1' } });
  });

  it('refuses an update that changes nothing, before anything is sent', async () => {
    const { seen, fetchImpl } = recording();
    expect((await gateway(fetchImpl).callTool('update_deal', { dealId: ID })).isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it('sets stages and owners with Apollo’s array query parameters', async () => {
    const { seen, fetchImpl } = recording(() => ({ contacts: [{ id: ID, contact_stage_id: 's1', email: 'x@example.com' }] }));
    const result = await gateway(fetchImpl).callTool('set_contact_stage', { contactIds: [ID, 'abc'], contactStageId: 's1' });
    expect(seen[0]!.path).toBe('/api/v1/contacts/update_stages');
    expect(seen[0]!.query.getAll('contact_ids[]')).toEqual([ID, 'abc']);
    expect(seen[0]!.query.get('contact_stage_id')).toBe('s1');
    expect(result.structuredContent).toEqual({ contacts: [{ id: ID, contact_stage_id: 's1' }] });
  });

  it('creates a deal with the amount as Apollo’s string', async () => {
    const { seen, fetchImpl } = recording(() => ({ opportunity: { id: ID, name: 'Big', amount: 1000 } }));
    await gateway(fetchImpl).callTool('create_deal', { name: 'Big', amount: 1000, closedDate: '2026-12-31' });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/opportunities',
      body: { name: 'Big', amount: '1000', closed_date: '2026-12-31' },
    });
  });

  it('creates a scheduled task', async () => {
    const { seen, fetchImpl } = recording(() => ({ task: { id: ID } }));
    await gateway(fetchImpl).callTool('create_task', { userId: 'u1', contactId: ID, type: 'call', dueAt: '2026-12-01T09:00:00+01:00' });
    expect(seen[0]!.body).toMatchObject({ user_id: 'u1', contact_id: ID, type: 'call', status: 'scheduled' });
  });

  it('adds contacts to a sequence from a mailbox, never with Apollo’s overrides', async () => {
    const { seen, fetchImpl } = recording(() => ({
      contacts: [{ id: ID, email: 'jane@example.com' }],
      skipped_contact_ids: { abc: 'contact_not_found' },
      emailer_campaign: { id: 'q1', name: 'Intro' },
    }));
    const result = await gateway(fetchImpl).callTool('add_contacts_to_sequence', {
      sequenceId: SEQ,
      contactIds: [ID, 'abc'],
      emailAccountId: 'm1',
    });
    expect(seen[0]!.path).toBe(`/api/v1/emailer_campaigns/${SEQ}/add_contact_ids`);
    expect(seen[0]!.query.get('emailer_campaign_id')).toBe(SEQ);
    expect(seen[0]!.query.get('send_email_from_email_account_id')).toBe('m1');
    expect([...seen[0]!.query.keys()].some(key => key.startsWith('sequence_') || key.startsWith('contacts_without'))).toBe(false);
    expect(result.structuredContent).toEqual({
      added: [{ id: ID }],
      skipped: [{ contactId: 'abc', reason: 'contact_not_found' }],
      sequence: { id: 'q1', name: 'Intro' },
    });
  });

  it('never passes on a mailbox’s sending credentials', async () => {
    const { fetchImpl } = recording(() => ({
      email_accounts: [{ id: 'm1', email: 'sales@example.com', active: true, sendgrid_api_key_v3: 'SG.xyz', signature_html: '<b>' }],
    }));
    const result = await gateway(fetchImpl).callTool('list_email_accounts', {});
    expect(result.structuredContent).toEqual({ email_accounts: [{ id: 'm1', email: 'sales@example.com', active: true }] });
  });

  it('sorts deals by the fields Apollo documents', async () => {
    for (const sortByField of ['opportunity_created_at', 'opportunity_updated_at', 'opportunity_close_date', 'amount', 'is_closed', 'is_won']) {
      const { seen, fetchImpl } = recording(() => ({ opportunities: [] }));
      const result = await gateway(fetchImpl).callTool('search_deals', { sortByField });
      expect(result.isError, sortByField).toBeUndefined();
      expect(seen[0]!.query.get('sort_by_field')).toBe(sortByField);
    }
    const { seen, fetchImpl } = recording();
    expect((await gateway(fetchImpl).callTool('search_deals', { sortByField: 'closed_date' })).isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it('says that a task Apollo has deleted was not completed', async () => {
    const { fetchImpl } = recording(() => ({ task: { id: ID, deleted: true } }));
    const result = await gateway(fetchImpl).callTool('complete_task', { taskId: ID });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/nothing was completed/);
  });

  it('never lets a word in an id reach a collection route', async () => {
    const { seen, fetchImpl } = recording(() => ({ opportunities: [] }));
    const gw = createApolloGateway({ apiKey: TOKEN, fetchImpl, policy: { disabledTools: ['search_deals'] } });
    for (const dealId of ['search', 'SEARCH', '../contacts', 'abc']) {
      expect((await gw.callTool('get_deal', { dealId })).isError, dealId).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  it('lists the stages of each kind', async () => {
    const { seen, fetchImpl } = recording(({ path }) =>
      path.endsWith('opportunity_stages') ? { opportunity_stages: [{ id: 'd1', name: 'Won', is_won: true, salesforce_id: 'x' }] } : {},
    );
    const result = await gateway(fetchImpl).callTool('list_stages', { kind: 'deal' });
    expect(seen[0]!.path).toBe('/api/v1/opportunity_stages');
    expect(result.structuredContent).toEqual({ stages: [{ id: 'd1', name: 'Won', is_won: true }] });
  });

  it('enriches a person without a phone reveal', async () => {
    const { seen, fetchImpl } = recording(() => ({ person: { id: ID } }));
    const result = await gateway(fetchImpl).callTool('person_enrich', { email: 'jane@example.com' });
    expect(result.isError).toBeUndefined();
    expect(seen[0]!.query.get('reveal_phone_number')).toBeNull();
    expect((await gateway(fetchImpl).callTool('person_enrich', { id: ID, revealPhoneNumber: true })).isError).toBe(true);
  });

  it('every tool makes only requests it declares', async () => {
    const samples: Record<string, Record<string, unknown>> = {
      search_capabilities: {},
      check_connection: {},
      companies_search: { qOrganizationName: 'Acme' },
      people_search: { personTitles: ['CEO'] },
      person_enrich: { id: ID },
      people_bulk_enrich: { details: [{ id: ID }] },
      org_enrich: { domain: 'example.com' },
      credit_usage: {},
      search_contacts: {},
      get_contact: { contactId: ID },
      search_accounts: {},
      get_account: { accountId: ID },
      search_deals: { isClosed: false },
      get_deal: { dealId: ID },
      search_tasks: {},
      search_sequences: {},
      list_users: {},
      list_email_accounts: {},
      list_stages: { kind: 'contact' },
      create_contact: { firstName: 'Jane' },
      update_contact: { contactId: ID, title: 'CEO' },
      set_contact_stage: { contactIds: [ID], contactStageId: 's1' },
      set_contact_owner: { contactIds: [ID], ownerId: 'u1' },
      create_account: { name: 'Acme' },
      update_account: { accountId: ID, phone: '+4512345678' },
      set_account_owner: { accountIds: [ID], ownerId: 'u1' },
      create_deal: { name: 'Big' },
      update_deal: { dealId: ID, amount: 5 },
      create_task: { userId: 'u1', contactId: ID, type: 'action_item', dueAt: '2026-12-01T09:00:00Z' },
      complete_task: { taskId: ID },
      add_contacts_to_sequence: { sequenceId: SEQ, contactIds: [ID], emailAccountId: 'm1' },
    };
    expect(Object.keys(samples).sort()).toEqual(apolloToolCatalog.map(tool => tool.name).sort());
    for (const tool of apolloToolCatalog) {
      const { seen, fetchImpl } = recording(() => ({ matches: [{ id: ID }] }));
      const result = await gateway(fetchImpl).callTool(tool.name, samples[tool.name] as never);
      expect(result.isError, `${tool.name}: ${result.content[0]!.text}`).toBeUndefined();
      for (const request of seen) {
        expect(
          tool.upstream.some(op => op.method === request.method && pathFits(op.path, request.path)),
          `${tool.name} ${request.method} ${request.path}`,
        ).toBe(true);
      }
      if (tool.upstream.length > 0) expect(seen.length, tool.name).toBeGreaterThan(0);
    }
  });
});
