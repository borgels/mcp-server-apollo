// The host's audit sink and Apollo's rate limit, through the embedded gateway.
import { describe, expect, it } from 'vitest';
import { createApolloGateway } from '../src/gateway.js';

const TOKEN = 'qqqqwwwwzzzzxxxx1';
const ID = '64b2f0c1a1b2c3d4e5f60718';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('the audit sink', () => {
  it('refuses a call whose start record fails, with a fixed text and nothing sent', async () => {
    let sent = 0;
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => {
        sent += 1;
        return json({ contact: { id: ID } });
      },
      policy: {
        enableWrites: true,
        audit: () => {
          throw new Error('connection refused by AUDITSINK-XYZ-77');
        },
      },
    });
    const result = await gw.callTool('update_contact', { contactId: ID, title: 'CEO' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Refused: the audit record of this call could not be written, so nothing was sent to Apollo.');
    expect(JSON.stringify(result)).not.toContain('AUDITSINK');
    expect(sent).toBe(0);
  });

  it('keeps a completed change a success when only the finish record fails', async () => {
    let sent = 0;
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => {
        sent += 1;
        return json({ contact: { id: ID, title: 'CEO' } });
      },
      policy: {
        enableWrites: true,
        audit: record => {
          if (record.action === 'finish') throw new Error('sink down at AUDITSINK-XYZ-77');
        },
      },
    });
    const result = await gw.callTool('update_contact', { contactId: ID, title: 'CEO' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ contact: { id: ID, title: 'CEO' } });
    expect(JSON.stringify(result)).not.toContain('AUDITSINK');
    expect(sent).toBe(1);
  });

  it('passes on the call’s own error, not the sink’s, when the error record fails', async () => {
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => json({}, 404),
      policy: {
        audit: record => {
          if (record.action === 'error') throw new Error('sink down at AUDITSINK-XYZ-77');
        },
      },
    });
    const result = await gw.callTool('get_contact', { contactId: ID });
    expect(result.isError).toBe(true);
    expect(result.failure).toMatchObject({ httpStatus: 404 });
    expect(JSON.stringify(result)).not.toContain('AUDITSINK');
  });
});

describe('the audit sink on a refused call', () => {
  it('never passes the sink’s error on for an unknown tool or invalid input', async () => {
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => json({}),
      policy: {
        audit: () => {
          throw new Error('connection refused by AUDITSINK-XYZ-77');
        },
      },
    });
    const unknown = await gw.callTool('no_such_tool', {});
    const invalid = await gw.callTool('get_contact', { contactId: 'not an id!' });
    for (const result of [unknown, invalid]) {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('AUDITSINK');
    }
    expect(unknown.content[0]!.text).toBe('Unsupported Apollo gateway tool.');
    expect(invalid.content[0]!.text).toMatch(/^Invalid input for get_contact/);
  });
});

describe('the rate limit', () => {
  it('retries bulk enrichment after a 429 from Apollo', async () => {
    let calls = 0;
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? json({}, 429, { 'retry-after': '0' }) : json({ matches: [{ id: ID }] });
      },
    });
    const result = await gw.callTool('people_bulk_enrich', { details: [{ id: ID }] });
    expect(result.isError).toBeUndefined();
    expect(calls).toBe(2);
    expect(result.structuredContent).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it('fails the whole call with its status when Apollo refuses the key, and audits it as an error', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => json({ error: 'bad key' }, 401),
      policy: { audit: record => void records.push({ ...record }) },
    });
    const result = await gw.callTool('people_bulk_enrich', { details: [{ id: ID }] });
    expect(result.isError).toBe(true);
    expect(result.failure).toMatchObject({ httpStatus: 401 });
    expect(records.map(record => record.action)).toEqual(['start', 'error']);
  });

  it('fails the whole call when the rate limit outlasts the retries', async () => {
    let calls = 0;
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => {
        calls += 1;
        return json({}, 429, { 'retry-after': '0' });
      },
    });
    const result = await gw.callTool('people_bulk_enrich', { details: [{ id: ID }] });
    expect(result.isError).toBe(true);
    expect(result.failure).toMatchObject({ httpStatus: 429 });
    expect(calls).toBeGreaterThan(1);
  });

  it('keeps the people already enriched when a later chunk fails, with the status only', async () => {
    let calls = 0;
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? json({ matches: Array.from({ length: 10 }, () => ({ id: ID })) }) : json({ error: 'Jane Doe' }, 500);
      },
    });
    const details = Array.from({ length: 12 }, () => ({ id: ID }));
    const result = await gw.callTool('people_bulk_enrich', { details });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ total: 12, succeeded: 10, failed: 2 });
    expect(JSON.stringify(result)).not.toContain('Jane Doe');
  });

  it('keeps the people already enriched and stops when a later chunk is refused or gets no answer', async () => {
    for (const later of [() => json({ error: 'out of credits' }, 402), () => Promise.reject(new TypeError('fetch failed'))]) {
      let calls = 0;
      const gw = createApolloGateway({
        apiKey: TOKEN,
        fetchImpl: (async () => {
          calls += 1;
          return calls === 1 ? json({ matches: Array.from({ length: 10 }, () => ({ id: ID })) }) : later();
        }) as typeof fetch,
      });
      const result = await gw.callTool('people_bulk_enrich', { details: Array.from({ length: 25 }, () => ({ id: ID })) });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ total: 25, succeeded: 10, failed: 15 });
      expect(calls).toBe(2);
    }
  });

  it('masks other credentials in an enrichment answer that is passed on whole', async () => {
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => json({ person: { id: ID, APOLLO_API_KEY: 'zzzzzzzzzzzzzzzz9', sendgrid_api_key_v3: 'mmmmmmmmmmmmmmmm8' } }),
    });
    const result = await gw.callTool('person_enrich', { id: ID });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/zzzzzzzz|mmmmmmmm/);
  });

  it('masks a quoted credential in free text whole', async () => {
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => json({ contact: { id: ID, title: `password="aaaa bbbb cccc" and api_key='dddd eeee'` } }),
    });
    const result = await gw.callTool('get_contact', { contactId: ID });
    expect(JSON.stringify(result)).not.toMatch(/aaaa|bbbb|cccc|dddd|eeee/);
  });
});

describe('two instances at once', () => {
  it('keep their keys, policies, callers and audit records apart, also when one calls the other from inside a call', async () => {
    const OTHER = 'yyyyyyyyyyyyyyyy7';
    const seen: Array<{ key: string | null; path: string }> = [];
    const recordsA: Array<Record<string, unknown>> = [];
    const recordsB: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push({ key: new Headers(init?.headers).get('x-api-key'), path: new URL(String(url)).pathname });
      await gate;
      return json({ contact: { id: ID } });
    };
    const b = createApolloGateway({ apiKey: OTHER, fetchImpl, policy: { enableWrites: false, audit: r => void recordsB.push({ ...r }) } });
    let nested: unknown;
    const a = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl,
      policy: {
        enableWrites: true,
        audit: async r => {
          recordsA.push({ ...r });
          // A call into the other instance from inside this one's sink runs under the other's policy only.
          if (r.action === 'start' && nested === undefined) nested = await b.callTool('update_contact', { contactId: ID, title: 'x' });
        },
      },
    });
    const both = Promise.all([
      a.callTool('update_contact', { contactId: ID, title: 'CEO' }, { caller: 'person-a' }),
      b.callTool('get_contact', { contactId: ID }, { caller: 'person-b' }),
    ]);
    for (let i = 0; i < 100 && seen.length < 2; i += 1) await new Promise(resolve => setImmediate(resolve));
    release();
    const [ra, rb] = await both;
    expect(ra.isError).toBeUndefined();
    expect(rb.isError).toBeUndefined();
    // The nested call into b is a write, and b's policy has writes off.
    expect((nested as { isError?: boolean }).isError).toBe(true);
    expect([...seen.map(s => s.key)].sort()).toEqual([OTHER, TOKEN].sort());
    expect(recordsA.every(r => r.tool !== undefined)).toBe(true);
    expect(recordsA.some(r => r.action === 'policy_denied')).toBe(false);
    expect(recordsB.some(r => r.action === 'policy_denied')).toBe(true);
    const callers = (records: Array<Record<string, unknown>>) => new Set(records.map(r => r.caller).filter(Boolean));
    for (const caller of callers(recordsA)) expect(callers(recordsB).has(caller)).toBe(false);
    expect(JSON.stringify(ra)).not.toContain(OTHER);
    expect(JSON.stringify(rb)).not.toContain(TOKEN);
  });
});

describe('bulk enrichment input', () => {
  it('sends nothing when any entry has no usable identifier', async () => {
    for (const bad of [{}, { firstName: 'Jane' }] as Array<Record<string, string>>) {
      let calls = 0;
      const gw = createApolloGateway({
        apiKey: TOKEN,
        fetchImpl: async () => {
          calls += 1;
          return json({ matches: [] });
        },
      });
      const details = [...Array.from({ length: 10 }, () => ({ id: ID })), bad];
      const result = await gw.callTool('people_bulk_enrich', { details });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/details\[10\] has no usable identifier/);
      expect(calls).toBe(0);
    }
  });
});

describe('custom fields', () => {
  it('keeps list values both ways, and names the fields Apollo did not save', async () => {
    let sent: unknown;
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return json({
          account: { id: ID, typed_custom_fields: { f1: ['Byg', 'Anlæg'], f2: 'x' } },
          custom_field_errors: { f2: 'Value is not allowed for field Kunde of Jane Doe' },
        });
      },
      policy: { enableWrites: true },
    });
    const result = await gw.callTool('update_account', { accountId: ID, typedCustomFields: { f1: ['Byg', 'Anlæg'], f2: 'x' } });
    expect(result.isError).toBeUndefined();
    expect(sent).toEqual({ typed_custom_fields: { f1: ['Byg', 'Anlæg'], f2: 'x' } });
    expect(result.structuredContent).toEqual({
      account: { id: ID, typed_custom_fields: { f1: ['Byg', 'Anlæg'], f2: 'x' } },
      customFieldsNotSaved: ['f2'],
    });
    expect(JSON.stringify(result)).not.toContain('Jane Doe');
  });
});

describe('the owner changes only through its own tools', () => {
  it('refuses an owner on create_account, update_account and update_contact, and sends nothing', async () => {
    let calls = 0;
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => {
        calls += 1;
        return json({ account: { id: ID } });
      },
      policy: { enableWrites: true },
    });
    for (const [tool, input] of [
      ['create_account', { name: 'Acme', ownerId: ID }],
      ['update_account', { accountId: ID, ownerId: ID }],
      ['update_account', { accountId: ID, phone: '+4512345678', ownerId: ID }],
      ['update_contact', { contactId: ID, ownerId: ID }],
      ['create_contact', { firstName: 'Ada', ownerId: ID }],
    ] as const) {
      const result = await gw.callTool(tool, input);
      expect(result.isError, tool).toBe(true);
    }
    expect(calls).toBe(0);
    const schemas = Object.fromEntries(gw.tools.map(tool => [tool.name.replace(/^apollo_/, ''), JSON.stringify(tool.inputSchema)]));
    for (const name of ['create_account', 'update_account', 'create_contact', 'update_contact']) {
      expect(schemas[name], name).toBeDefined();
      expect(schemas[name], name).not.toMatch(/owner/i);
    }
    expect(schemas['set_account_owner']).toMatch(/ownerId/);
  });
});
