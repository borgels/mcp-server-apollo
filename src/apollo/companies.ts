import type { ApolloClient, QueryValue } from './client.js';
import { selectFields } from './fields.js';

export const MAX_PAGE = 500;
export const MAX_PER_PAGE = 100;

/**
 * Default projection for company search results. Apollo organization records
 * carry many fields the discovery workflow never needs; unknown paths are
 * skipped silently, so paths Apollo stopped returning simply disappear.
 */
export const DEFAULT_COMPANY_FIELDS = [
  'id',
  'name',
  'primary_domain',
  'website_url',
  'linkedin_url',
  'organization_revenue_printed',
  'naics_codes',
  'sic_codes',
  'founded_year',
  'primary_phone.number',
] as const;

/** Extra paths kept on `accounts` so the agent can dedupe against the CRM. */
const ACCOUNT_EXTRA_FIELDS = ['crm_record_url', 'domain', 'organization_id'] as const;

export interface RevenueRange {
  min?: number;
  max?: number;
}

export interface CompaniesSearchInput {
  qOrganizationName?: string;
  qOrganizationKeywordTags?: string[];
  organizationLocations?: string[];
  organizationNotLocations?: string[];
  qOrganizationDomainsList?: string[];
  organizationIds?: string[];
  organizationNumEmployeesRanges?: string[];
  revenueRange?: RevenueRange;
  currentlyUsingAnyOfTechnologyUids?: string[];
  page?: number;
  perPage?: number;
  fields?: string[];
}

export interface CompaniesSearchResult {
  pagination?: unknown;
  organizations: unknown[];
  accounts: unknown[];
  partial_results_only?: unknown;
  partial_results_limit?: unknown;
  breadcrumbs?: unknown;
}

const EMPLOYEE_RANGE_PATTERN = /^\d+,\d+$/;

export function assertEmployeeRanges(ranges: readonly string[] | undefined): void {
  for (const range of ranges ?? []) {
    if (!EMPLOYEE_RANGE_PATTERN.test(range)) {
      throw new Error(
        `Invalid employee range "${range}". Use "min,max" strings such as "1,10" or "101,200".`,
      );
    }
  }
}

/**
 * Wraps POST /mixed_companies/search. Consumes 1 credit per page that returns
 * results. The response keeps Apollo's `organizations` (net-new) vs `accounts`
 * (already saved to the team, incl. CRM linkage) split and passes `pagination`
 * through unchanged.
 */
export async function searchCompanies(
  client: ApolloClient,
  input: CompaniesSearchInput,
): Promise<CompaniesSearchResult> {
  assertEmployeeRanges(input.organizationNumEmployeesRanges);

  const query: Record<string, QueryValue> = {
    q_organization_name: input.qOrganizationName,
    'q_organization_keyword_tags[]': input.qOrganizationKeywordTags,
    'organization_locations[]': input.organizationLocations,
    'organization_not_locations[]': input.organizationNotLocations,
    'q_organization_domains_list[]': input.qOrganizationDomainsList,
    'organization_ids[]': input.organizationIds,
    'organization_num_employees_ranges[]': input.organizationNumEmployeesRanges,
    'revenue_range[min]': input.revenueRange?.min,
    'revenue_range[max]': input.revenueRange?.max,
    'currently_using_any_of_technology_uids[]': input.currentlyUsingAnyOfTechnologyUids,
    page: input.page,
    per_page: input.perPage,
  };

  const response = await client.post<Record<string, unknown>>('/api/v1/mixed_companies/search', undefined, query);

  const fields = resolveProjection(input.fields, DEFAULT_COMPANY_FIELDS);
  const organizations = asArray(response.organizations);
  const accounts = asArray(response.accounts);

  return {
    pagination: response.pagination,
    partial_results_only: response.partial_results_only,
    partial_results_limit: response.partial_results_limit,
    breadcrumbs: response.breadcrumbs,
    organizations: fields ? (selectFields(organizations, fields) as unknown[]) : organizations,
    accounts: fields
      ? (selectFields(accounts, [...fields, ...ACCOUNT_EXTRA_FIELDS]) as unknown[])
      : accounts,
  };
}

/** `["*"]` opts out of projection; omitted falls back to the default set. */
export function resolveProjection(
  fields: readonly string[] | undefined,
  defaults: readonly string[],
): readonly string[] | undefined {
  if (!fields || fields.length === 0) {
    return defaults;
  }

  if (fields.includes('*')) {
    return undefined;
  }

  return fields;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
