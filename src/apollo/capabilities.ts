export type CapabilityRisk = 'read' | 'read+credits';

export interface ApolloCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

/** Every tool is read-only against Apollo data; none write anywhere. */
export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const APOLLO_CAPABILITIES: ApolloCapability[] = [
  {
    id: 'apollo_search_capabilities',
    title: 'Search Apollo Capabilities',
    description: 'Find the Apollo MCP tool to use for company discovery, people search, or contact enrichment.',
    risk: 'read',
    examples: [{ query: 'find companies' }],
    identifierFormats: ['Tool id such as apollo_companies_search or apollo_person_enrich.'],
    safetyNotes: ['Discovery only. Does not call Apollo.'],
    keywords: ['discover', 'search tools', 'help', 'capabilities'],
  },
  {
    id: 'apollo_companies_search',
    title: 'Search Companies (Apollo)',
    description:
      'Discover companies by keyword tags, name, location (include/exclude), employee-count ranges, revenue range, domains, or technology stack. Returns net-new `organizations` and already-saved `accounts` (with CRM linkage) separately — use the split to dedupe against your CRM.',
    risk: 'read+credits',
    examples: [
      { qOrganizationKeywordTags: ['plumbing'], organizationLocations: ['Ballerup, Denmark'] },
      {
        qOrganizationKeywordTags: ['pharmaceuticals', 'biotechnology'],
        organizationLocations: ['Denmark'],
        organizationNumEmployeesRanges: ['101,200', '201,500', '501,10000'],
      },
    ],
    identifierFormats: ['Employee ranges as "min,max" strings', 'Locations as "City, Country" or country names'],
    safetyNotes: [
      'Costs 1 credit per request (page) that returns results. Confirm total credit cost with the user before running multi-page batches.',
      'Search records are slim (no revenue/industry details) — use apollo_org_enrich for full firmographics.',
      'Display limit: 100 per page, 500 pages (50,000 records).',
    ],
    keywords: ['company', 'search', 'discovery', 'prospecting', 'segment', 'firmographic', 'accounts', 'organizations'],
  },
  {
    id: 'apollo_people_search',
    title: 'Search People (Apollo)',
    description:
      'Find people by title, seniority, location, employer domain/id, or employer size. Free (no credits) but requires a MASTER Apollo API key. Results are intentionally slim: obfuscated last names, no emails or phone numbers — pass the returned person `id` to apollo_person_enrich for full contact data.',
    risk: 'read',
    examples: [
      { personTitles: ['head of talent acquisition', 'hr director'], qOrganizationDomainsList: ['nne.com'] },
      { personSeniorities: ['c_suite', 'vp'], organizationLocations: ['Denmark'] },
    ],
    identifierFormats: [
      'Seniorities: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern',
      'Email statuses: verified, unverified, likely to engage, unavailable',
    ],
    safetyNotes: [
      'No credits consumed. Requires a master API key (Apollo returns 403 API_INACCESSIBLE otherwise).',
      'Search results never include verified emails/phones — do not loop searching for contact data; enrich instead.',
    ],
    keywords: ['people', 'person', 'search', 'titles', 'seniority', 'contacts', 'prospecting'],
  },
  {
    id: 'apollo_person_enrich',
    title: 'Enrich Person (Apollo)',
    description:
      'Match one person and return their full Apollo profile. Set revealPersonalEmails / revealPhoneNumber to fetch contact data. Phone numbers arrive asynchronously via webhook — the response includes request_id for apollo_webhook_result polling.',
    risk: 'read+credits',
    examples: [
      { name: 'Tim Zheng', domain: 'apollo.io' },
      { id: '66f4b9d84c7e1c0001ab349e', revealPersonalEmails: true },
    ],
    identifierFormats: ['Apollo person id', 'email or MD5/SHA-256 hashed email', 'LinkedIn URL', 'name + domain/organization'],
    safetyNotes: [
      'Consumes credits when a record is enriched; email and phone reveals cost extra per your Apollo plan (typically ~1 credit per email, ~8 per mobile number). Confirm with the user before bulk reveals.',
      'revealPhoneNumber requires webhookUrl (public HTTPS); numbers are delivered asynchronously and can take minutes.',
      'Personal emails are not revealed for people in GDPR regions. You (not Apollo) are the data controller for retrieved personal data — handle it per GDPR.',
    ],
    keywords: ['enrich', 'match', 'email', 'phone', 'contact data', 'person', 'reveal'],
  },
  {
    id: 'apollo_people_bulk_enrich',
    title: 'Bulk Enrich People (Apollo)',
    description:
      'Enrich up to 100 people in one call. Chunks into Apollo-sized bulk_match calls (10 per call), fans out with bounded concurrency, retries HTTP 429, and isolates per-item failures. Returns { total, succeeded, failed, results[] } plus creditsConsumed as reported by Apollo.',
    risk: 'read+credits',
    examples: [
      {
        details: [
          { name: 'Tim Zheng', domain: 'apollo.io' },
          { email: 'example@example.com' },
        ],
      },
    ],
    identifierFormats: ['Array of person identifier objects (same formats as apollo_person_enrich).'],
    safetyNotes: [
      'Consumes credits per enriched record; reveal flags apply to EVERY person in the batch. Confirm total credit cost with the user first.',
      'Apollo rate-limits bulk_match hard (documented 20/min) — concurrency is capped low by design.',
      'revealPhoneNumber requires webhookUrl; phone numbers arrive asynchronously per chunk (requestIds[] are the poll handles).',
    ],
    keywords: ['bulk', 'batch', 'enrich', 'many', 'emails', 'phones', 'list'],
  },
  {
    id: 'apollo_org_enrich',
    title: 'Enrich Organization (Apollo)',
    description:
      'Fetch full firmographics for one company by domain, name, website, or LinkedIn URL: industry, keywords, employee count, revenue, funding events, technology stack (current_technologies), department headcounts, and growth rates.',
    risk: 'read+credits',
    examples: [{ domain: 'apollo.io' }, { name: 'Novo Nordisk', fields: ['organization.name', 'organization.current_technologies'] }],
    identifierFormats: ['Bare domain (no www./@)', 'company name', 'website URL', 'LinkedIn company URL'],
    safetyNotes: [
      'Consumes 1 credit when a record is enriched.',
      'For Danish companies prefer the Lassox MCP (authoritative CVR registry data); use this for non-DK companies or Apollo-specific fields like technology stack and funding.',
    ],
    keywords: ['organization', 'company', 'enrich', 'firmographics', 'technology stack', 'funding', 'revenue'],
  },
  {
    id: 'apollo_webhook_result',
    title: 'Poll Webhook Result (Apollo)',
    description:
      'Fetch the result of an asynchronous enrichment (phone-number reveal or waterfall) by request_id, in case the webhook callback was missed. Free; results are kept for 30 days.',
    risk: 'read',
    examples: [{ requestId: 12345 }],
    identifierFormats: ['Integer request_id returned by apollo_person_enrich / apollo_people_bulk_enrich (may be negative).'],
    safetyNotes: ['No credits consumed. A 404 with retry_after_seconds means the result is not ready yet — wait before retrying.'],
    keywords: ['webhook', 'poll', 'async', 'phone', 'request_id', 'pending'],
  },
  {
    id: 'apollo_credit_usage',
    title: 'Get API Usage / Rate Limits (Apollo)',
    description:
      'Report per-endpoint API usage against the minute/hour/day rate limits, plus the latest rate-limit headers seen. Use before large batches to check headroom. Note: Apollo has no API for the remaining credit balance — that lives in the Apollo UI.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: ['No credits consumed. Requires a master API key.'],
    keywords: ['credits', 'usage', 'rate limit', 'quota', 'remaining', 'budget'],
  },
];

export function searchCapabilities(query: string, limit = 20): ApolloCapability[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return APOLLO_CAPABILITIES.slice(0, limit);
  }

  return APOLLO_CAPABILITIES.map(capability => ({
    capability,
    score: scoreCapability(capability, normalized),
  }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: ApolloCapability, query: string): number {
  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    ...capability.identifierFormats,
    ...capability.keywords,
  ]
    .join(' ')
    .toLowerCase();

  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
