import { assertEmployeeRanges, MAX_PAGE, MAX_PER_PAGE, type RevenueRange } from './companies.js';
import type { ApolloClient, QueryValue } from './client.js';
import { selectFields } from './fields.js';

export { MAX_PAGE, MAX_PER_PAGE };

export const PERSON_SENIORITIES = [
  'owner',
  'founder',
  'c_suite',
  'partner',
  'vp',
  'head',
  'director',
  'manager',
  'senior',
  'entry',
  'intern',
] as const;

export const CONTACT_EMAIL_STATUSES = [
  'verified',
  'unverified',
  'likely to engage',
  'unavailable',
] as const;

export interface PeopleSearchInput {
  personTitles?: string[];
  includeSimilarTitles?: boolean;
  qKeywords?: string;
  personSeniorities?: string[];
  personLocations?: string[];
  organizationLocations?: string[];
  qOrganizationDomainsList?: string[];
  organizationIds?: string[];
  organizationNumEmployeesRanges?: string[];
  contactEmailStatus?: string[];
  revenueRange?: RevenueRange;
  page?: number;
  perPage?: number;
  fields?: string[];
}

export interface PeopleSearchResult {
  total_entries?: unknown;
  people: unknown[];
}

/**
 * Wraps POST /mixed_people/api_search (the current documented people-search
 * endpoint; it replaced /mixed_people/search). Requires a MASTER API key and
 * consumes no credits. Results are intentionally slim: last names are
 * obfuscated ("Hu***n") and no emails/phones are included — feed the returned
 * `id` into person enrichment for full data.
 */
export async function searchPeople(
  client: ApolloClient,
  input: PeopleSearchInput,
): Promise<PeopleSearchResult> {
  assertEmployeeRanges(input.organizationNumEmployeesRanges);

  const query: Record<string, QueryValue> = {
    'person_titles[]': input.personTitles,
    include_similar_titles: input.includeSimilarTitles,
    q_keywords: input.qKeywords,
    'person_seniorities[]': input.personSeniorities,
    'person_locations[]': input.personLocations,
    'organization_locations[]': input.organizationLocations,
    'q_organization_domains_list[]': input.qOrganizationDomainsList,
    'organization_ids[]': input.organizationIds,
    'organization_num_employees_ranges[]': input.organizationNumEmployeesRanges,
    'contact_email_status[]': input.contactEmailStatus,
    'revenue_range[min]': input.revenueRange?.min,
    'revenue_range[max]': input.revenueRange?.max,
    page: input.page,
    per_page: input.perPage,
  };

  const response = await client.post<Record<string, unknown>>(
    '/api/v1/mixed_people/api_search',
    undefined,
    query,
  );

  const people = Array.isArray(response.people) ? response.people : [];

  return {
    total_entries: response.total_entries,
    people:
      input.fields && input.fields.length > 0 && !input.fields.includes('*')
        ? (selectFields(people, input.fields) as unknown[])
        : people,
  };
}
