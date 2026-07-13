import { describe, expect, it, vi } from 'vitest';
import { ApolloClient } from '../src/apollo/client.js';
import { getUsageStats } from '../src/apollo/usage.js';

describe('getUsageStats', () => {
  it('POSTs to the usage endpoint and decodes stringified-array keys', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          '["api/v1/people", "match"]': {
            day: { limit: 6000, consumed: 5, left_over: 5995 },
            hour: { limit: 600, consumed: 5, left_over: 595 },
            minute: { limit: 200, consumed: 5, left_over: 195 },
          },
          'not-json-key': { day: { limit: 1, consumed: 0, left_over: 1 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-rate-limit-minute': '200' } },
      ),
    );
    const client = new ApolloClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await getUsageStats(client);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://example.test/api/v1/usage_stats/api_usage_stats');
    expect(init?.method).toBe('POST');

    expect(result.endpoints).toEqual([
      {
        endpoint: 'api/v1/people',
        action: 'match',
        minute: { limit: 200, consumed: 5, left_over: 195 },
        hour: { limit: 600, consumed: 5, left_over: 595 },
        day: { limit: 6000, consumed: 5, left_over: 5995 },
      },
      {
        endpoint: 'not-json-key',
        action: '',
        minute: undefined,
        hour: undefined,
        day: { limit: 1, consumed: 0, left_over: 1 },
      },
    ]);
    expect(result.rateLimitHeaders).toEqual({ 'x-rate-limit-minute': '200' });
    expect(result.note).toContain('credit balance');
  });
});
