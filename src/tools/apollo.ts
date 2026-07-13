import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../apollo/audit.js';
import { searchCapabilities, TOOL_ANNOTATIONS } from '../apollo/capabilities.js';
import type { ApolloClient } from '../apollo/client.js';
import { searchCompanies, MAX_PAGE, MAX_PER_PAGE } from '../apollo/companies.js';
import {
  bulkEnrichPeople,
  enrichOrganization,
  enrichPerson,
  getWebhookResult,
  MAX_BULK_ITEMS,
  type BulkEnrichProgress,
} from '../apollo/enrich.js';
import { CONTACT_EMAIL_STATUSES, PERSON_SENIORITIES, searchPeople } from '../apollo/people.js';
import { checkToolPolicy } from '../apollo/policy.js';
import { getUsageStats } from '../apollo/usage.js';

const fieldsSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(100)
  .optional()
  .describe(
    'Optional dot-path field projection to shrink the response — only these fields are returned per record. Descends nested objects and maps over arrays, e.g. ["id","name","primary_domain","primary_phone.number"]. Pass ["*"] for the full record.',
  );

const employeeRangesSchema = z
  .array(z.string().trim().regex(/^\d+,\d+$/, 'Each range is a "min,max" string, e.g. "101,200".'))
  .max(20)
  .optional()
  .describe('Employee-count ranges as "min,max" strings, e.g. ["1,10","101,200"].');

const revenueRangeSchema = z
  .object({
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
  })
  .optional()
  .describe('Annual revenue range in plain integers (no symbols/commas).');

const pageSchema = z.number().int().min(1).max(MAX_PAGE).optional();
const perPageSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_PER_PAGE)
  .optional()
  .describe(`Results per page, 1-${MAX_PER_PAGE}. Defaults to Apollo's default (10).`);

const personIdentifierShape = {
  id: z.string().trim().min(1).optional().describe('Apollo person id, e.g. from apollo_people_search.'),
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  email: z.string().trim().min(3).optional(),
  hashedEmail: z.string().trim().min(32).optional().describe('MD5 or SHA-256 hashed email.'),
  organizationName: z.string().trim().min(1).optional(),
  domain: z.string().trim().min(1).optional().describe('Employer domain without www. or @.'),
  linkedinUrl: z.string().trim().url().optional(),
};

const webhookUrlSchema = z
  .string()
  .trim()
  .url()
  .startsWith('https://', 'webhookUrl must be a public HTTPS URL.')
  .optional()
  .describe('Public HTTPS endpoint Apollo POSTs phone numbers to. Required when revealPhoneNumber=true.');

export function registerApolloTools(server: McpServer, client: ApolloClient): void {
  server.registerTool(
    'apollo_search_capabilities',
    {
      title: 'Search Apollo Capabilities',
      description:
        'Search the Apollo MCP server capabilities and examples. Use this first when deciding which Apollo tool to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('apollo_search_capabilities', input, async () =>
        jsonToolResult(searchCapabilities(input.query, input.limit)),
      ),
  );

  server.registerTool(
    'apollo_companies_search',
    {
      title: 'Search Companies (Apollo)',
      description:
        'Discover companies via Apollo by keyword tags, name, location (include/exclude), employee-count ranges, revenue range, domains, or technology stack. The response preserves Apollo\'s split between `organizations` (net-new) and `accounts` (already saved to your Apollo team, incl. CRM linkage) — use it to dedupe against your CRM — and passes `pagination` (page/per_page/total_entries/total_pages) through unchanged. COSTS 1 CREDIT per request (page) that returns results — confirm total credit cost with the user before running multi-page batches. Search records are slim; use apollo_org_enrich for revenue/industry/technology details.',
      inputSchema: {
        qOrganizationName: z.string().trim().min(1).optional().describe('Partial company-name match.'),
        qOrganizationKeywordTags: z
          .array(z.string().trim().min(1))
          .max(50)
          .optional()
          .describe('Keyword tags, e.g. ["plumbing"] or ["pharmaceuticals","biotechnology"].'),
        organizationLocations: z
          .array(z.string().trim().min(1))
          .max(50)
          .optional()
          .describe('HQ locations to include, e.g. ["Ballerup, Denmark"] or ["Denmark"].'),
        organizationNotLocations: z.array(z.string().trim().min(1)).max(50).optional(),
        qOrganizationDomainsList: z
          .array(z.string().trim().min(1))
          .max(1000)
          .optional()
          .describe('Company domains without www. or @.'),
        organizationIds: z.array(z.string().trim().min(1)).max(100).optional(),
        organizationNumEmployeesRanges: employeeRangesSchema,
        revenueRange: revenueRangeSchema,
        currentlyUsingAnyOfTechnologyUids: z
          .array(z.string().trim().min(1))
          .max(50)
          .optional()
          .describe('Technology uids with underscores, e.g. ["wordpress_org"].'),
        page: pageSchema,
        perPage: perPageSchema,
        fields: fieldsSchema,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('apollo_companies_search', input, async () =>
        jsonToolResult(await searchCompanies(client, input)),
      ),
  );

  server.registerTool(
    'apollo_people_search',
    {
      title: 'Search People (Apollo)',
      description:
        'Find people via Apollo by title, seniority, location, employer domain/id, or employer size. FREE (no credits) but requires a MASTER Apollo API key. Results are intentionally slim: last names are obfuscated ("Hu***n") and NO email addresses or phone numbers are included — do not loop searching for contact data; pass the returned person id to apollo_person_enrich instead.',
      inputSchema: {
        personTitles: z
          .array(z.string().trim().min(1))
          .max(100)
          .optional()
          .describe('Job titles, OR-matched. Similar titles are included unless includeSimilarTitles=false.'),
        includeSimilarTitles: z.boolean().optional(),
        qKeywords: z.string().trim().min(1).optional(),
        personSeniorities: z.array(z.enum(PERSON_SENIORITIES)).max(11).optional(),
        personLocations: z.array(z.string().trim().min(1)).max(50).optional(),
        organizationLocations: z.array(z.string().trim().min(1)).max(50).optional(),
        qOrganizationDomainsList: z.array(z.string().trim().min(1)).max(1000).optional(),
        organizationIds: z.array(z.string().trim().min(1)).max(100).optional(),
        organizationNumEmployeesRanges: employeeRangesSchema,
        contactEmailStatus: z.array(z.enum(CONTACT_EMAIL_STATUSES)).max(4).optional(),
        revenueRange: revenueRangeSchema,
        page: pageSchema,
        perPage: perPageSchema,
        fields: fieldsSchema,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('apollo_people_search', input, async () =>
        jsonToolResult(await searchPeople(client, input)),
      ),
  );

  server.registerTool(
    'apollo_person_enrich',
    {
      title: 'Enrich Person (Apollo)',
      description:
        'Match one person via Apollo and return their full profile (employment history, employer, departments, seniority). CONSUMES CREDITS when a record is enriched; setting revealPersonalEmails or revealPhoneNumber costs extra per your Apollo plan (typically ~1 credit per email, ~8 per mobile) — confirm with the user first. Phone numbers are NOT in the synchronous response: Apollo delivers them asynchronously to webhookUrl (required for phone reveals); poll apollo_webhook_result with the returned request_id if the callback is missed. Personal emails are not revealed for people in GDPR regions; you are the data controller for retrieved personal data.',
      inputSchema: {
        ...personIdentifierShape,
        revealPersonalEmails: z.boolean().default(false),
        revealPhoneNumber: z.boolean().default(false),
        webhookUrl: webhookUrlSchema,
        fields: fieldsSchema,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('apollo_person_enrich', input, async () =>
        jsonToolResult(await enrichPerson(client, input)),
      ),
  );

  server.registerTool(
    'apollo_people_bulk_enrich',
    {
      title: 'Bulk Enrich People (Apollo)',
      description:
        `Enrich up to ${MAX_BULK_ITEMS} people via Apollo in one call. Chunks into bulk_match calls of 10, fans out with bounded concurrency, retries HTTP 429, and isolates per-item failures. Returns { total, succeeded, failed, creditsConsumed, requestIds, results[] } with results in input order. CONSUMES CREDITS per enriched record and reveal flags apply to EVERY person — confirm total credit cost with the user first. Apollo rate-limits bulk_match hard (documented 20/min). revealPhoneNumber requires webhookUrl. Emits MCP progress notifications when the client sends a progressToken.`,
      inputSchema: {
        details: z
          .array(z.object(personIdentifierShape))
          .min(1)
          .max(MAX_BULK_ITEMS)
          .describe('People to enrich. Each item needs at least one identifier.'),
        revealPersonalEmails: z.boolean().default(false),
        revealPhoneNumber: z.boolean().default(false),
        webhookUrl: webhookUrlSchema,
        concurrency: z.number().int().min(1).max(4).optional().describe('Parallel bulk_match calls, 1-4. Defaults to 2.'),
        fields: fieldsSchema,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async (input, extra) =>
      runAuditedTool('apollo_people_bulk_enrich', input, async () =>
        jsonToolResult(
          await bulkEnrichPeople(client, input, {
            signal: extra?.signal,
            onProgress: makeBulkProgressReporter(extra),
          }),
        ),
      ),
  );

  server.registerTool(
    'apollo_org_enrich',
    {
      title: 'Enrich Organization (Apollo)',
      description:
        'Fetch full firmographics for one company via Apollo: industry, keywords, employee count, revenue, funding events, technology stack (current_technologies / technology_names), department headcounts, and headcount growth rates. Provide at least one of domain, name, website, or linkedinUrl. Consumes 1 credit when a record is enriched. For Danish companies prefer the Lassox MCP (authoritative CVR registry data); use this for non-DK companies or Apollo-specific fields like technology stack.',
      inputSchema: {
        domain: z.string().trim().min(1).optional().describe('Bare domain without www. or @, e.g. "apollo.io".'),
        name: z.string().trim().min(1).optional(),
        website: z.string().trim().min(1).optional(),
        linkedinUrl: z.string().trim().url().optional(),
        fields: fieldsSchema,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('apollo_org_enrich', input, async () =>
        jsonToolResult(await enrichOrganization(client, input)),
      ),
  );

  server.registerTool(
    'apollo_webhook_result',
    {
      title: 'Poll Webhook Result (Apollo)',
      description:
        'Fetch the result of an asynchronous Apollo enrichment (phone-number reveal or waterfall) by request_id, in case the webhook callback was missed. Free (no credits); results are kept for 30 days. A 404 with retry_after_seconds means the result is not ready yet — wait before retrying.',
      inputSchema: {
        requestId: z
          .union([z.number().int(), z.string().trim().regex(/^-?\d+$/)])
          .describe('Integer request_id from apollo_person_enrich / apollo_people_bulk_enrich (may be negative).'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('apollo_webhook_result', input, async () =>
        jsonToolResult(await getWebhookResult(client, input.requestId)),
      ),
  );

  server.registerTool(
    'apollo_credit_usage',
    {
      title: 'Get API Usage / Rate Limits (Apollo)',
      description:
        'Report per-endpoint Apollo API usage against the minute/hour/day rate limits, plus the most recent rate-limit headers observed. Use before large batches to check headroom, and to answer "how much have we used?". Requires a master API key; consumes no credits. Note: Apollo exposes no API for the remaining credit balance — that is only visible in the Apollo UI (Settings > Billing and credits).',
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('apollo_credit_usage', input, async () => jsonToolResult(await getUsageStats(client))),
  );
}

async function runAuditedTool<T>(tool: string, input: unknown, call: () => Promise<T>): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);

  if (!policy.allowed) {
    await writeAuditEvent({
      tool,
      action: 'policy_denied',
      target,
      reason: policy.reason,
    });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ tool, action: 'start', target, reason: policy.reason });

  try {
    const result = await call();
    await writeAuditEvent({ tool, action: 'finish', target, status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({
      tool,
      action: 'error',
      target,
      status: 'error',
      error: formatUnknownError(error),
    });
    throw error;
  }
}

interface ProgressCapableExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

/**
 * Builds an onProgress callback that streams MCP progress notifications, but
 * only when the client opted in by sending a progressToken.
 */
function makeBulkProgressReporter(
  extra: ProgressCapableExtra | undefined,
): ((progress: BulkEnrichProgress) => Promise<void>) | undefined {
  const progressToken = extra?._meta?.progressToken;
  const sendNotification = extra?.sendNotification;
  if (progressToken === undefined || !sendNotification) {
    return undefined;
  }

  return async progress => {
    const status = progress.ok ? 'ok' : `error: ${progress.error ?? 'failed'}`;
    await sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: progress.completed,
        total: progress.total,
        message: `${progress.completed}/${progress.total} enriched — last chunk ${status}`,
      },
    });
  };
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const value = input as Record<string, unknown>;
  return {
    query: value.query,
    qOrganizationName: value.qOrganizationName,
    qOrganizationKeywordTags: value.qOrganizationKeywordTags,
    organizationLocations: value.organizationLocations,
    organizationNotLocations: value.organizationNotLocations,
    domainCount: Array.isArray(value.qOrganizationDomainsList)
      ? value.qOrganizationDomainsList.length
      : undefined,
    organizationNumEmployeesRanges: value.organizationNumEmployeesRanges,
    revenueRange: value.revenueRange,
    personTitles: value.personTitles,
    personSeniorities: value.personSeniorities,
    personLocations: value.personLocations,
    contactEmailStatus: value.contactEmailStatus,
    page: value.page,
    perPage: value.perPage,
    fields: value.fields,
    detailCount: Array.isArray(value.details) ? value.details.length : undefined,
    concurrency: value.concurrency,
    revealPersonalEmails: value.revealPersonalEmails,
    revealPhoneNumber: value.revealPhoneNumber,
    domain: value.domain,
    name: value.name,
    website: value.website,
    linkedinUrl: value.linkedinUrl,
    requestId: value.requestId,
  };
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
