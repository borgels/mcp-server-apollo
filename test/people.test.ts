import { describe, expect, it, vi } from 'vitest';
import { ApolloClient } from '../src/apollo/client.js';
import { searchPeople } from '../src/apollo/people.js';

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

describe('searchPeople', () => {
  it('calls the current api_search endpoint with documented params', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ total_entries: 1, people: [{ id: 'p-1', first_name: 'Andrew' }] }),
    );
    const client = makeClient(fetchMock);

    const result = await searchPeople(client, {
      personTitles: ['hr director', 'qa director'],
      personSeniorities: ['director'],
      qOrganizationDomainsList: ['nne.com'],
      includeSimilarTitles: false,
      perPage: 10,
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/mixed_people/api_search');
    expect(url.searchParams.getAll('person_titles[]')).toEqual(['hr director', 'qa director']);
    expect(url.searchParams.getAll('person_seniorities[]')).toEqual(['director']);
    expect(url.searchParams.getAll('q_organization_domains_list[]')).toEqual(['nne.com']);
    expect(url.searchParams.get('include_similar_titles')).toBe('false');
    expect(url.searchParams.get('per_page')).toBe('10');

    expect(result.total_entries).toBe(1);
    expect(result.people).toEqual([{ id: 'p-1', first_name: 'Andrew' }]);
  });

  it('tolerates a missing people array and applies field projection', async () => {
    const empty = makeClient(vi.fn<typeof fetch>(async () => jsonResponse({ total_entries: 0 })));
    expect((await searchPeople(empty, {})).people).toEqual([]);

    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        total_entries: 1,
        people: [{ id: 'p-1', first_name: 'Andrew', last_name_obfuscated: 'Hu***n', has_email: true }],
      }),
    );
    const projected = await searchPeople(makeClient(fetchMock), { fields: ['id', 'first_name'] });
    expect(projected.people).toEqual([{ id: 'p-1', first_name: 'Andrew' }]);
  });

  it('rejects malformed employee ranges before calling Apollo', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      searchPeople(makeClient(fetchMock), { organizationNumEmployeesRanges: ['lots'] }),
    ).rejects.toThrow('min,max');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
