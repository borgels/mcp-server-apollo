import { describe, expect, it, vi } from 'vitest';
import { ApolloClient } from '../src/apollo/client.js';
import { searchCompanies } from '../src/apollo/companies.js';

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

const organization = {
  id: 'org-1',
  name: 'Ballerup VVS ApS',
  primary_domain: 'ballerupvvs.dk',
  website_url: 'https://ballerupvvs.dk',
  linkedin_url: 'https://linkedin.com/company/ballerupvvs',
  founded_year: 1998,
  primary_phone: { number: '+45 44 44 44 44', source: 'Scraped' },
  logo_url: 'https://cdn.example/logo.png',
  alexa_ranking: 123456,
};

const account = {
  ...organization,
  id: 'acc-1',
  crm_record_url: 'https://mycrm.example/deal/1',
  domain: 'ballerupvvs.dk',
  organization_id: 'org-1',
};

describe('searchCompanies', () => {
  it('builds the documented query string and preserves the organizations/accounts split', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        pagination: { page: 1, per_page: 25, total_entries: 2, total_pages: 1 },
        partial_results_only: false,
        organizations: [organization],
        accounts: [account],
      }),
    );
    const client = makeClient(fetchMock);

    const result = await searchCompanies(client, {
      qOrganizationKeywordTags: ['plumbing'],
      organizationLocations: ['Ballerup, Denmark'],
      organizationNumEmployeesRanges: ['1,10', '11,50'],
      revenueRange: { min: 1000000 },
      page: 1,
      perPage: 25,
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/mixed_companies/search');
    expect(url.searchParams.getAll('q_organization_keyword_tags[]')).toEqual(['plumbing']);
    expect(url.searchParams.getAll('organization_locations[]')).toEqual(['Ballerup, Denmark']);
    expect(url.searchParams.getAll('organization_num_employees_ranges[]')).toEqual(['1,10', '11,50']);
    expect(url.searchParams.get('revenue_range[min]')).toBe('1000000');
    expect(url.searchParams.get('per_page')).toBe('25');

    // Pagination passes through unchanged.
    expect(result.pagination).toEqual({ page: 1, per_page: 25, total_entries: 2, total_pages: 1 });
    expect(result.organizations).toHaveLength(1);
    expect(result.accounts).toHaveLength(1);
  });

  it('applies the default projection and keeps CRM linkage on accounts', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ pagination: {}, organizations: [organization], accounts: [account] }),
    );
    const client = makeClient(fetchMock);

    const result = await searchCompanies(client, {});

    expect(result.organizations[0]).toEqual({
      id: 'org-1',
      name: 'Ballerup VVS ApS',
      primary_domain: 'ballerupvvs.dk',
      website_url: 'https://ballerupvvs.dk',
      linkedin_url: 'https://linkedin.com/company/ballerupvvs',
      founded_year: 1998,
      primary_phone: { number: '+45 44 44 44 44' },
    });
    // Not in the default projection:
    expect(result.organizations[0]).not.toHaveProperty('logo_url');
    expect(result.organizations[0]).not.toHaveProperty('alexa_ranking');
    // Accounts keep dedupe/CRM fields on top of the default projection.
    expect(result.accounts[0]).toMatchObject({
      id: 'acc-1',
      crm_record_url: 'https://mycrm.example/deal/1',
      organization_id: 'org-1',
    });
  });

  it('honours explicit fields and the ["*"] opt-out', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ pagination: {}, organizations: [organization], accounts: [] }),
    );
    const client = makeClient(fetchMock);

    const projected = await searchCompanies(client, { fields: ['name'] });
    expect(projected.organizations[0]).toEqual({ name: 'Ballerup VVS ApS' });

    const full = await searchCompanies(client, { fields: ['*'] });
    expect(full.organizations[0]).toEqual(organization);
  });

  it('rejects malformed employee ranges before calling Apollo', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = makeClient(fetchMock);

    await expect(
      searchCompanies(client, { organizationNumEmployeesRanges: ['1-10'] }),
    ).rejects.toThrow('min,max');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
