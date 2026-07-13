import { describe, expect, it, vi } from 'vitest';
import { ApolloClient } from '../src/apollo/client.js';
import {
  bulkEnrichPeople,
  enrichOrganization,
  enrichPerson,
  getWebhookResult,
} from '../src/apollo/enrich.js';
import { ApolloHttpError } from '../src/errors.js';

function makeClient(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): ApolloClient {
  return new ApolloClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('enrichPerson', () => {
  it('sends identifiers and reveal flags as query params', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ person: { id: 'p-1', email: 'tim@apollo.io' }, request_id: 123 }),
    );
    const client = makeClient(fetchMock);

    const result = await enrichPerson(client, {
      name: 'Tim Zheng',
      domain: 'apollo.io',
      revealPersonalEmails: true,
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/people/match');
    expect(url.searchParams.get('name')).toBe('Tim Zheng');
    expect(url.searchParams.get('domain')).toBe('apollo.io');
    expect(url.searchParams.get('reveal_personal_emails')).toBe('true');
    expect(url.searchParams.has('reveal_phone_number')).toBe(false);
    expect(url.searchParams.has('webhook_url')).toBe(false);

    expect(result.person).toEqual({ id: 'p-1', email: 'tim@apollo.io' });
    expect(result.request_id).toBe(123);
    expect(result.phoneRevealPending).toBeUndefined();
  });

  it('requires an identifier and a webhook for phone reveals', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = makeClient(fetchMock);

    await expect(enrichPerson(client, {})).rejects.toThrow('identifier');
    await expect(
      enrichPerson(client, { email: 'a@b.dk', revealPhoneNumber: true }),
    ).rejects.toThrow('webhookUrl');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flags pending phone reveals and passes the webhook through', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ person: { id: 'p-1' }, request_id: -42 }),
    );
    const client = makeClient(fetchMock);

    const result = await enrichPerson(client, {
      id: 'p-1',
      revealPhoneNumber: true,
      webhookUrl: 'https://hooks.example/apollo',
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('reveal_phone_number')).toBe('true');
    expect(url.searchParams.get('webhook_url')).toBe('https://hooks.example/apollo');
    expect(result.phoneRevealPending).toBe(true);
    expect(result.note).toContain('asynchronously');
    expect(result.request_id).toBe(-42);
  });

  it('projects the person via fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ person: { id: 'p-1', email: 'x@y.dk', headline: 'noise' }, request_id: 1 }),
    );
    const client = makeClient(fetchMock);

    const result = await enrichPerson(client, { id: 'p-1', fields: ['id', 'email'] });
    expect(result.person).toEqual({ id: 'p-1', email: 'x@y.dk' });
  });
});

describe('bulkEnrichPeople', () => {
  it('chunks into bulk_match calls of 10 and maps matches back positionally', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { details: unknown[] };
      bodies.push(body);
      return jsonResponse({
        status: 'success',
        credits_consumed: body.details.length,
        request_id: bodies.length,
        matches: body.details.map((_, index) => (index === 0 ? null : { id: `m-${index}` })),
      });
    });
    const client = makeClient(fetchMock);

    const details = Array.from({ length: 12 }, (_, i) => ({ email: `user${i}@example.dk` }));
    const result = await bulkEnrichPeople(client, { details });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((bodies[0] as { details: unknown[] }).details).toHaveLength(10);
    expect((bodies[1] as { details: unknown[] }).details).toHaveLength(2);

    expect(result.total).toBe(12);
    // First item of each chunk was a null match.
    expect(result.failed).toBe(2);
    expect(result.succeeded).toBe(10);
    expect(result.results[0]).toEqual({ index: 0, ok: false, error: 'No match found.' });
    expect(result.results[1]).toMatchObject({ index: 1, ok: true, person: { id: 'm-1' } });
    expect(result.results[10]).toEqual({ index: 10, ok: false, error: 'No match found.' });
    expect(result.creditsConsumed).toBe(12);
    expect(result.requestIds).toEqual([1, 2]);
  });

  it('isolates chunk failures and retries 429s', async () => {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ message: 'rate limited' }, 429);
      }
      return jsonResponse({ status: 'success', matches: [{ id: 'm-0' }] });
    });
    const client = makeClient(fetchMock);

    const result = await bulkEnrichPeople(
      client,
      { details: [{ email: 'a@b.dk' }] },
      { sleep: async () => {} },
    );

    expect(calls).toBe(2);
    expect(result.succeeded).toBe(1);
  });

  it('validates inputs before calling Apollo', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = makeClient(fetchMock);

    await expect(bulkEnrichPeople(client, { details: [] })).rejects.toThrow('1-100');
    await expect(bulkEnrichPeople(client, { details: [{}] })).rejects.toThrow('identifier');
    await expect(
      bulkEnrichPeople(client, { details: [{ email: 'a@b.dk' }], revealPhoneNumber: true }),
    ).rejects.toThrow('webhookUrl');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports item-level progress per completed chunk', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { details: unknown[] };
      return jsonResponse({ status: 'success', matches: body.details.map((_, i) => ({ id: i })) });
    });
    const client = makeClient(fetchMock);
    const progress: Array<{ completed: number; total: number }> = [];

    await bulkEnrichPeople(
      client,
      { details: Array.from({ length: 12 }, (_, i) => ({ email: `u${i}@x.dk` })), concurrency: 1 },
      { onProgress: p => void progress.push({ completed: p.completed, total: p.total }) },
    );

    expect(progress).toEqual([
      { completed: 10, total: 12 },
      { completed: 12, total: 12 },
    ]);
  });
});

describe('enrichOrganization', () => {
  it('requires at least one identifier and builds the query', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ organization: { id: 'o-1', name: 'Apollo', current_technologies: [] } }),
    );
    const client = makeClient(fetchMock);

    await expect(enrichOrganization(client, {})).rejects.toThrow('at least one');

    const result = await enrichOrganization(client, { domain: 'apollo.io' });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/organizations/enrich');
    expect(url.searchParams.get('domain')).toBe('apollo.io');
    expect(result.organization).toMatchObject({ id: 'o-1' });
  });
});

describe('getWebhookResult', () => {
  it('polls by integer request id, including negative ids', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ request_id: -42, webhook_status: 'success' }),
    );
    const client = makeClient(fetchMock);

    await getWebhookResult(client, -42);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://example.test/api/v1/webhook_result/-42');

    await expect(getWebhookResult(client, 'abc')).rejects.toThrow('integer');
  });

  it('propagates the not-ready 404 payload as an error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ retry_after_seconds: 60, message: 'not ready' }, 404),
    );
    const client = makeClient(fetchMock);

    await expect(getWebhookResult(client, 42)).rejects.toBeInstanceOf(ApolloHttpError);
  });
});
