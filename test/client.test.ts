import { describe, expect, it, vi } from 'vitest';
import { ApolloClient } from '../src/apollo/client.js';
import { ApolloHttpError, redactSecrets } from '../src/errors.js';

function makeClient(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): ApolloClient {
  return new ApolloClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('ApolloClient', () => {
  it('sends the API key in the x-api-key header, never in the URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);

    await client.post('/api/v1/mixed_companies/search', undefined, { page: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://example.test/api/v1/mixed_companies/search?page=1');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('test-key');
    expect(String(url)).not.toContain('test-key');
  });

  it('encodes array query params under a [] key, repeated per value', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);

    await client.post('/api/v1/mixed_companies/search', undefined, {
      'organization_locations[]': ['Ballerup, Denmark', 'Copenhagen, Denmark'],
      'revenue_range[min]': 1000000,
      page: 2,
      skipped: undefined,
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.getAll('organization_locations[]')).toEqual([
      'Ballerup, Denmark',
      'Copenhagen, Denmark',
    ]);
    expect(url.searchParams.get('revenue_range[min]')).toBe('1000000');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.has('skipped')).toBe(false);
  });

  it('appends [] to array keys that lack the suffix', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);

    await client.get('/api/v1/thing', { tags: ['a', 'b'] });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.getAll('tags[]')).toEqual(['a', 'b']);
  });

  it('serializes POST bodies as JSON when given', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);

    await client.post('/api/v1/people/bulk_match', { details: [{ name: 'Tim' }] });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ details: [{ name: 'Tim' }] });
  });

  it('throws ApolloHttpError with JSON error payloads', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: 'not accessible with this api_key', error_code: 'API_INACCESSIBLE' }, 403),
    );
    const client = makeClient(fetchMock);

    const error = await client.get('/api/v1/usage_stats').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApolloHttpError);
    expect((error as ApolloHttpError).status).toBe(403);
    expect((error as ApolloHttpError).message).toContain('API_INACCESSIBLE');
  });

  it('handles text/plain error bodies (Apollo 401s are not JSON)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('Invalid access credentials.', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const client = makeClient(fetchMock);

    const error = await client.get('/api/v1/anything').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApolloHttpError);
    expect((error as ApolloHttpError).message).toContain('Invalid access credentials.');
  });

  it('surfaces retry-after on 429 responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ message: 'The maximum number of api calls...' }, 429, { 'retry-after': '30' }),
    );
    const client = makeClient(fetchMock);

    const error = await client.get('/api/v1/anything').catch((e: unknown) => e);
    expect((error as ApolloHttpError).retryAfter).toBe('30');
  });

  it('captures rate-limit response headers into the snapshot', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ok: true }, 200, {
        'x-rate-limit-minute': '200',
        'x-minute-usage': '5',
        'x-hourly-requests-left': '595',
        'content-length': '11',
      }),
    );
    const client = makeClient(fetchMock);

    await client.get('/api/v1/anything');

    expect(client.rateLimitSnapshot()).toEqual({
      'x-rate-limit-minute': '200',
      'x-minute-usage': '5',
      'x-hourly-requests-left': '595',
    });
  });

  it('refuses non-https base URLs except loopback', () => {
    expect(
      () => new ApolloClient({ apiKey: 'k', baseUrl: 'http://api.apollo.io' }),
    ).toThrow(/https/);
    expect(
      () => new ApolloClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:8080' }),
    ).not.toThrow();
  });

  it('fails fast without an API key', async () => {
    const original = process.env.APOLLO_API_KEY;
    delete process.env.APOLLO_API_KEY;
    try {
      const client = new ApolloClient({ baseUrl: 'https://example.test' });
      await expect(client.get('/api/v1/anything')).rejects.toThrow('APOLLO_API_KEY');
    } finally {
      if (original !== undefined) {
        process.env.APOLLO_API_KEY = original;
      }
    }
  });
});

describe('redactSecrets', () => {
  it('redacts api key material from error text', () => {
    expect(redactSecrets('x-api-key: super-secret')).not.toContain('super-secret');
    expect(redactSecrets('APOLLO_API_KEY=super-secret')).not.toContain('super-secret');
    expect(redactSecrets('{"api_key":"super-secret"}')).not.toContain('super-secret');
  });
});

describe('ApolloClient upstream hardening', () => {
  it('never follows redirects and does not leak the redirect query string', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x?sig=abc' } }),
    );
    const client = makeClient(fetchMock);

    const error = await client.get('/api/v1/thing', { q_keywords: 'private' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/redirect \(HTTP 302\) to https:\/\/elsewhere\.example\/x/);
    expect((error as Error).message).not.toContain('sig=abc');
    expect((error as Error).message).not.toContain('private');
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('manual');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads at most 64 KB of an error body and truncates the message', async () => {
    const huge = 'x'.repeat(1_000_000);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(huge, { status: 500 }));
    const client = makeClient(fetchMock);

    const error = await client.get('/api/v1/thing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApolloHttpError);
    expect((error as Error).message.length).toBeLessThan(1_000);
  });

  it('redacts the configured key by value before truncating', async () => {
    const key = 'configured-apollo-key-0123456789';
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(`${'y'.repeat(490)}${key}`, { status: 400 }),
    );
    const client = new ApolloClient({ apiKey: key, baseUrl: 'https://example.test', fetchImpl: fetchMock });

    const error = await client.get('/api/v1/thing').catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(key.slice(0, 10));
    expect((error as ApolloHttpError).url).toBe('https://example.test/api/v1/thing');
  });

  it('rejects an invalid APOLLO_TIMEOUT_MS instead of producing NaN', () => {
    const original = process.env.APOLLO_TIMEOUT_MS;
    process.env.APOLLO_TIMEOUT_MS = 'abc';
    try {
      expect(() => new ApolloClient({ apiKey: 'k' })).toThrow(/APOLLO_TIMEOUT_MS/);
    } finally {
      if (original === undefined) {
        delete process.env.APOLLO_TIMEOUT_MS;
      } else {
        process.env.APOLLO_TIMEOUT_MS = original;
      }
    }
  });
});
