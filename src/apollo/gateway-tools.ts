import { z } from 'zod/v4';
import type { ApolloClient, QueryValue } from './client.js';
import { searchCompanies } from './companies.js';
import { callWithRateLimitRetry } from './batch.js';
import { enrichOrganization, enrichPerson } from './enrich.js';
import { ApolloAnswerError } from '../errors.js';
import type { ApolloGatewayClient, GatewayUpstream } from './gateway-client.js';
import { searchPeople } from './people.js';
import { encodePathParam } from '../path-params.js';

/**
 * The tools of the embedded gateway (src/gateway.ts): discovery and
 * enrichment, and the everyday sales work in the team's own Apollo data:
 * contacts, accounts, deals, tasks and sequences. Inputs are strict, every
 * request a tool may make is declared in `upstream` (and held against it by
 * the client), and the CRM answers are projected onto an allowlist of fields
 * before they leave, so nothing Apollo adds later (or a mailbox's sending
 * credentials) reaches the host.
 *
 * Left out on purpose: deleting anything, merging contacts, users, settings,
 * custom field definitions, mailbox settings, phone-number reveals (they
 * need a public webhook that receives personal data outside the host) and
 * bulk changes beyond 100 records. The MCP server's own tools
 * (src/tools/apollo.ts) are unchanged.
 */

export type { GatewayUpstream } from './gateway-client.js';

export interface GatewayTool {
  /** Without the `apollo_` prefix. */
  name: string;
  title: string;
  description: string;
  riskLevel: 'read' | 'write';
  /** The first line of a successful result's text. */
  summary: string;
  upstream: readonly GatewayUpstream[];
  broad?: boolean;
  input: z.ZodRawShape;
  run(client: ApolloGatewayClient, input: Record<string, unknown>, offered: readonly GatewayTool[]): Promise<unknown>;
}

const get = (path: string): GatewayUpstream => ({ method: 'GET', path });
const post = (path: string): GatewayUpstream => ({ method: 'POST', path });
const patch = (path: string): GatewayUpstream => ({ method: 'PATCH', path });

/** The MCP server's modules take an ApolloClient; the gateway client has the same get and post. */
const asServerClient = (client: ApolloGatewayClient): ApolloClient => client as unknown as ApolloClient;

// ---------------------------------------------------------------- inputs

/** An Apollo id: letters and digits (Apollo's ids are 24 hex characters). */
const apolloId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'an Apollo id');
const ids = (max: number) => z.array(apolloId).min(1).max(max);
/**
 * An id that becomes a path segment: Apollo's own form, 24 hex digits. A word such as "search" would otherwise reach a
 * collection route that shares the record's path template.
 */
const pathId = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, 'an Apollo id of 24 hex digits');
const shortText = (max = 200) => z.string().trim().min(1).max(max);
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');
const isoDateTime = z.iso.datetime({ offset: true });
const customFields = z
  .record(
    apolloId,
    z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(500)).max(50)]),
  )
  .refine(value => Object.keys(value).length <= 50, 'at most 50 custom fields')
  .optional()
  .describe('Custom field values keyed by the custom field id.');
const paging = {
  page: z.number().int().min(1).max(500).optional().describe('Page to return, starting at 1.'),
  perPage: z.number().int().min(1).max(100).optional().describe('Records per page, at most 100.'),
};
const employeeRanges = z
  .array(z.string().trim().regex(/^\d+,\d+$/, '"min,max" such as "11,50"'))
  .max(20)
  .optional();
const textList = (max = 20) => z.array(shortText()).max(max).optional();
const revenueRange = z
  .strictObject({ min: z.number().min(0).optional(), max: z.number().min(0).optional() })
  .optional();
const personIdentifiers = {
  id: apolloId.optional().describe('Apollo person id (from people search).'),
  firstName: shortText().optional(),
  lastName: shortText().optional(),
  name: shortText().optional(),
  email: z.email().optional(),
  organizationName: shortText().optional(),
  domain: shortText().optional(),
  linkedinUrl: shortText(500).optional(),
};

const contactFields = {
  firstName: shortText().optional(),
  lastName: shortText().optional(),
  title: shortText().optional(),
  organizationName: shortText().optional().describe('The employer, as text.'),
  accountId: apolloId.optional().describe('The account (company) in Apollo the contact belongs to.'),
  email: z.email().optional(),
  websiteUrl: shortText(500).optional(),
  labelNames: z.array(shortText()).max(50).optional().describe('Lists the contact is on. Replaces the current lists.'),
  contactStageId: apolloId.optional().describe('From apollo_list_stages with kind "contact".'),
  presentRawAddress: shortText(500).optional().describe('Location, such as city and country.'),
  directPhone: shortText(50).optional(),
  corporatePhone: shortText(50).optional(),
  mobilePhone: shortText(50).optional(),
  homePhone: shortText(50).optional(),
  otherPhone: shortText(50).optional(),
  typedCustomFields: customFields,
};

/**
 * No owner here: moving a contact or an account to another user is its own
 * tool (set_contact_owner, set_account_owner), so a host can allow everyday
 * edits without allowing a change of owner.
 */
const accountFields = {
  name: shortText().optional(),
  domain: shortText().optional().describe('Domain without www., such as example.com.'),
  accountStageId: apolloId.optional().describe('From apollo_list_stages with kind "account".'),
  phone: shortText(50).optional(),
  rawAddress: shortText(500).optional(),
  typedCustomFields: customFields,
};

const dealFields = {
  name: shortText().optional(),
  ownerId: apolloId.optional().describe('A user in the team (apollo_list_users).'),
  accountId: apolloId.optional(),
  amount: z.number().min(0).max(1e12).optional().describe('The deal value in the team currency.'),
  opportunityStageId: apolloId.optional().describe('From apollo_list_stages with kind "deal".'),
  closedDate: isoDate.optional().describe('Expected or actual close date.'),
  typedCustomFields: customFields,
};

/** A deal's account is set when it is created; Apollo's update takes no account. */
const { accountId: _account, ...dealUpdateFields } = dealFields;

// ----------------------------------------------------------- projections

type Json = Record<string, unknown>;
type Projection = Record<string, (value: unknown) => unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/** A string, number, boolean or null as it is; anything else is dropped. */
function plain(value: unknown): unknown {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
}

/** A list of plain values. */
function plainList(value: unknown): unknown {
  return Array.isArray(value) ? value.map(plain).filter(entry => entry !== undefined) : undefined;
}

/** An object of plain values (custom fields). */
function plainObject(value: unknown): unknown {
  const object = asObject(value);
  if (!object) return undefined;
  return Object.fromEntries(
    Object.entries(object)
      .map(([key, entry]) => [key, Array.isArray(entry) ? plainList(entry) : plain(entry)] as const)
      .filter(([, entry]) => entry !== undefined),
  );
}

/**
 * The custom fields Apollo did not save, from the custom_field_errors map it may send with a 200 answer (at the top
 * or on the record): their ids only, never Apollo's text. An empty list when every field was saved.
 */
function rejectedFields(answer: unknown, key: string): string[] {
  const top = asObject(asObject(answer)?.custom_field_errors) ?? {};
  const own = asObject(asObject(asObject(answer)?.[key])?.custom_field_errors) ?? {};
  const ids = [...Object.keys(top), ...Object.keys(own)].filter(name => /^[A-Za-z0-9_-]{1,64}$/.test(name));
  return [...new Set(ids)];
}

/** One saved record, with the ids of the custom fields Apollo refused when there are any. */
function saved(answer: unknown, key: string, projection: Projection): Json {
  const refused = rejectedFields(answer, key);
  return { ...one(answer, key, projection), ...(refused.length > 0 ? { customFieldsNotSaved: refused } : {}) };
}

/** Only the named fields of `source`, each through its projection; fields that come out undefined are left out. */
function pick(source: unknown, projection: Projection): Json {
  const object = asObject(source) ?? {};
  const out: Json = {};
  for (const [field, project] of Object.entries(projection)) {
    if (!Object.hasOwn(object, field)) continue;
    const value = project(object[field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

const listOf =
  (projection: Projection) =>
  (value: unknown): unknown =>
    Array.isArray(value) ? value.map(entry => pick(entry, projection)) : undefined;

const objectOf =
  (projection: Projection) =>
  (value: unknown): unknown =>
    value === null ? null : asObject(value) ? pick(value, projection) : undefined;

const PAGINATION: Projection = { page: plain, per_page: plain, total_entries: plain, total_pages: plain };

const PHONE: Projection = { raw_number: plain, sanitized_number: plain, type: plain, status: plain, position: plain };

const CONTACT: Projection = {
  id: plain,
  first_name: plain,
  last_name: plain,
  name: plain,
  title: plain,
  organization_name: plain,
  organization_id: plain,
  account_id: plain,
  email: plain,
  email_status: plain,
  contact_stage_id: plain,
  owner_id: plain,
  label_ids: plainList,
  linkedin_url: plain,
  present_raw_address: plain,
  phone_numbers: listOf(PHONE),
  emailer_campaign_ids: plainList,
  last_activity_date: plain,
  created_at: plain,
  updated_at: plain,
  typed_custom_fields: plainObject,
};

const ACCOUNT: Projection = {
  id: plain,
  name: plain,
  domain: plain,
  website_url: plain,
  linkedin_url: plain,
  phone: plain,
  raw_address: plain,
  account_stage_id: plain,
  owner_id: plain,
  organization_id: plain,
  label_ids: plainList,
  last_activity_date: plain,
  created_at: plain,
  updated_at: plain,
  typed_custom_fields: plainObject,
};

const DEAL: Projection = {
  id: plain,
  name: plain,
  amount: plain,
  opportunity_stage_id: plain,
  opportunity_pipeline_id: plain,
  owner_id: plain,
  account_id: plain,
  closed_date: plain,
  is_closed: plain,
  is_won: plain,
  probability: plain,
  forecast_category: plain,
  description: plain,
  source: plain,
  last_activity_date: plain,
  created_at: plain,
  updated_at: plain,
  typed_custom_fields: plainObject,
};

const TASK: Projection = {
  id: plain,
  user_id: plain,
  contact_id: plain,
  account_id: plain,
  opportunity_id: plain,
  type: plain,
  priority: plain,
  status: plain,
  title: plain,
  note: plain,
  due_at: plain,
  completed_at: plain,
  skipped_at: plain,
  created_at: plain,
};

const SEQUENCE: Projection = {
  id: plain,
  name: plain,
  active: plain,
  archived: plain,
  user_id: plain,
  num_steps: plain,
  created_at: plain,
  last_used_at: plain,
  unique_scheduled: plain,
  unique_delivered: plain,
  unique_opened: plain,
  unique_replied: plain,
  unique_bounced: plain,
};

const USER: Projection = { id: plain, first_name: plain, last_name: plain, name: plain, title: plain, email: plain, deleted: plain };

const EMAIL_ACCOUNT: Projection = {
  id: plain,
  user_id: plain,
  email: plain,
  type: plain,
  provider_display_name: plain,
  active: plain,
  default: plain,
};

const CONTACT_STAGE: Projection = { id: plain, name: plain, display_name: plain, display_order: plain, category: plain };
const ACCOUNT_STAGE: Projection = CONTACT_STAGE;
const DEAL_STAGE: Projection = {
  id: plain,
  name: plain,
  display_order: plain,
  opportunity_pipeline_id: plain,
  is_won: plain,
  is_closed: plain,
  probability: plain,
  forecast_category_cd: plain,
};

/** A page of a search: the pagination and the named list, projected. */
function page(source: unknown, list: string, projection: Projection): Json {
  const object = asObject(source) ?? {};
  return {
    pagination: objectOf(PAGINATION)(object.pagination) ?? null,
    [list]: listOf(projection)(object[list]) ?? [],
  };
}

/** One record under `key`, projected. */
function one(source: unknown, key: string, projection: Projection): Json {
  return { [key]: objectOf(projection)(asObject(source)?.[key]) ?? null };
}

// ----------------------------------------------------------- bodies

/** camelCase input fields to Apollo's snake_case body, leaving out what is not given. */
function body(input: Record<string, unknown>, fields: Record<string, string>): Json {
  const out: Json = {};
  for (const [from, to] of Object.entries(fields)) {
    const value = input[from];
    if (value === undefined) continue;
    out[to] = from === 'amount' && typeof value === 'number' ? String(value) : value;
  }
  return out;
}

const CONTACT_BODY: Record<string, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  title: 'title',
  organizationName: 'organization_name',
  accountId: 'account_id',
  email: 'email',
  websiteUrl: 'website_url',
  labelNames: 'label_names',
  contactStageId: 'contact_stage_id',
  presentRawAddress: 'present_raw_address',
  directPhone: 'direct_phone',
  corporatePhone: 'corporate_phone',
  mobilePhone: 'mobile_phone',
  homePhone: 'home_phone',
  otherPhone: 'other_phone',
  typedCustomFields: 'typed_custom_fields',
};

const ACCOUNT_BODY: Record<string, string> = {
  name: 'name',
  domain: 'domain',
  accountStageId: 'account_stage_id',
  phone: 'phone',
  rawAddress: 'raw_address',
  typedCustomFields: 'typed_custom_fields',
};

const DEAL_BODY: Record<string, string> = {
  name: 'name',
  ownerId: 'owner_id',
  accountId: 'account_id',
  amount: 'amount',
  opportunityStageId: 'opportunity_stage_id',
  closedDate: 'closed_date',
  typedCustomFields: 'typed_custom_fields',
};

/** An update must change something. */
function requireChange(input: Record<string, unknown>, fields: Record<string, string>): void {
  if (!Object.keys(fields).some(field => input[field] !== undefined)) {
    throw new Error('Give at least one field to change.');
  }
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length >= 2);
}

const id = (input: Record<string, unknown>, field: string): string => encodePathParam(String(input[field]), field);

// ----------------------------------------------------------------- tools

export const GATEWAY_TOOLS: readonly GatewayTool[] = [
  {
    name: 'search_capabilities',
    title: 'Search Apollo capabilities',
    description: 'Find the Apollo tools this connection offers. Does not call Apollo.',
    riskLevel: 'read',
    summary: 'Apollo capabilities.',
    upstream: [],
    input: {
      query: z.string().trim().max(500).default(''),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async run(_client, input, offered) {
      const asked = words(String(input.query ?? ''));
      const scored = offered.map((tool, order) => {
        const own = words(`${tool.name} ${tool.title} ${tool.description}`);
        const score = asked.filter(word => own.some(o => o === word || (o.length >= 4 && word.startsWith(o)))).length;
        return { tool, order, score };
      });
      const hits =
        asked.length === 0 ? scored : scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
      return {
        query: input.query,
        tools: hits.slice(0, Number(input.limit)).map(({ tool }) => ({
          name: `apollo_${tool.name}`,
          title: tool.title,
          description: tool.description,
          riskLevel: tool.riskLevel,
        })),
      };
    },
  },
  {
    name: 'check_connection',
    title: 'Check Apollo connection',
    description: 'Verify that Apollo accepts the API key, and show the ids of the key’s user and team.',
    riskLevel: 'read',
    summary: 'Apollo connection checked.',
    upstream: [get('/api/v1/users/api_profile')],
    input: {},
    async run(client) {
      const profile = asObject(await client.get('/api/v1/users/api_profile'));
      return { connected: true, userId: plain(profile?.id) ?? null, teamId: plain(profile?.team_id) ?? null };
    },
  },
  {
    name: 'companies_search',
    title: 'Search companies in Apollo’s database',
    description:
      'Discover companies by name, keywords, location, size, revenue or technology. Costs 1 Apollo credit per page with results.',
    riskLevel: 'read',
    summary: 'Companies found.',
    upstream: [post('/api/v1/mixed_companies/search')],
    input: {
      qOrganizationName: shortText().optional(),
      qOrganizationKeywordTags: textList(),
      organizationLocations: textList(),
      organizationNotLocations: textList(),
      qOrganizationDomainsList: textList(100),
      organizationIds: z.array(apolloId).max(100).optional(),
      organizationNumEmployeesRanges: employeeRanges,
      revenueRange,
      currentlyUsingAnyOfTechnologyUids: textList(),
      ...paging,
    },
    async run(client, input) {
      return searchCompanies(asServerClient(client), input as unknown as Parameters<typeof searchCompanies>[1]);
    },
  },
  {
    name: 'people_search',
    title: 'Search people in Apollo’s database',
    description:
      'Find people by title, seniority, location or employer. Free, but needs a master API key; returns no email or phone (enrich a person for that).',
    riskLevel: 'read',
    summary: 'People found.',
    upstream: [post('/api/v1/mixed_people/api_search')],
    input: {
      personTitles: textList(),
      includeSimilarTitles: z.boolean().optional(),
      qKeywords: shortText().optional(),
      personSeniorities: z
        .array(z.enum(['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern']))
        .max(11)
        .optional(),
      personLocations: textList(),
      organizationLocations: textList(),
      qOrganizationDomainsList: textList(100),
      organizationIds: z.array(apolloId).max(100).optional(),
      organizationNumEmployeesRanges: employeeRanges,
      contactEmailStatus: z.array(z.enum(['verified', 'unverified', 'likely to engage', 'unavailable'])).max(4).optional(),
      revenueRange,
      ...paging,
    },
    async run(client, input) {
      return searchPeople(asServerClient(client), input as unknown as Parameters<typeof searchPeople>[1]);
    },
  },
  {
    name: 'person_enrich',
    title: 'Enrich a person',
    description:
      'Match one person and return the full profile, including work email. Consumes Apollo credits; revealing personal emails costs extra.',
    riskLevel: 'read',
    summary: 'Person enriched.',
    upstream: [post('/api/v1/people/match')],
    input: { ...personIdentifiers, revealPersonalEmails: z.boolean().optional() },
    async run(client, input) {
      return enrichPerson(asServerClient(client), input as unknown as Parameters<typeof enrichPerson>[1]);
    },
  },
  {
    name: 'people_bulk_enrich',
    title: 'Enrich several people',
    description: 'Enrich up to 100 people in one call. Consumes Apollo credits per enriched person.',
    riskLevel: 'read',
    summary: 'People enriched.',
    upstream: [post('/api/v1/people/bulk_match')],
    input: {
      details: z.array(z.strictObject(personIdentifiers)).min(1).max(100),
      revealPersonalEmails: z.boolean().optional(),
    },
    async run(client, input) {
      // One chunk of ten at a time, each retried on Apollo's 429. A failure before anything was enriched fails the whole
      // call with its status, so a host sees it. Once people are enriched (their credits are spent), a failing chunk
      // stops the run: the people enriched so far are kept, and the rest are failed items with Apollo's status only.
      const details = input.details as Array<Record<string, unknown>>;
      // Every entry is checked before anything is sent, so no credits are spent on a batch that fails later.
      for (const [index, detail] of details.entries()) {
        const usable =
          ['id', 'email', 'linkedinUrl', 'name', 'domain', 'organizationName'].some(field => typeof detail[field] === 'string') ||
          (typeof detail.firstName === 'string' && typeof detail.lastName === 'string');
        if (!usable) throw new Error(`details[${index}] has no usable identifier.`);
      }
      const fields: Record<string, string> = {
        id: 'id', firstName: 'first_name', lastName: 'last_name', name: 'name', email: 'email',
        organizationName: 'organization_name', domain: 'domain', linkedinUrl: 'linkedin_url',
      };
      const results: Array<{ index: number; ok: boolean; person?: unknown; error?: string }> = [];
      for (let start = 0; start < details.length; start += 10) {
        const chunk = details.slice(start, start + 10);
        let answer: Record<string, unknown> | undefined;
        try {
          answer = asObject(
            await callWithRateLimitRetry(() =>
              client.post('/api/v1/people/bulk_match', { details: chunk.map(detail => body(detail, fields)) }, {
                reveal_personal_emails: input.revealPersonalEmails === true ? true : undefined,
              }),
            ),
          );
        } catch (error) {
          if (results.length === 0) throw error;
          const status = error instanceof ApolloAnswerError ? error.status : undefined;
          const why = status === undefined ? 'Apollo did not answer; not tried further.' : `Apollo answered with HTTP ${status}; not tried further.`;
          for (let index = start; index < details.length; index += 1) results.push({ index, ok: false, error: why });
          break;
        }
        const matches = Array.isArray(answer?.matches) ? answer.matches : [];
        chunk.forEach((_, offset) => {
          const match = matches[offset];
          results.push(
            match === null || match === undefined
              ? { index: start + offset, ok: false, error: 'No match found.' }
              : { index: start + offset, ok: true, person: match },
          );
        });
      }
      const succeeded = results.filter(result => result.ok).length;
      return { total: details.length, succeeded, failed: details.length - succeeded, results };
    },
  },
  {
    name: 'org_enrich',
    title: 'Enrich a company',
    description:
      'Firmographics for one company (industry, size, revenue, funding, technologies). Consumes 1 Apollo credit when enriched.',
    riskLevel: 'read',
    summary: 'Company enriched.',
    upstream: [get('/api/v1/organizations/enrich')],
    input: {
      domain: shortText().optional(),
      name: shortText().optional(),
      website: shortText(500).optional(),
      linkedinUrl: shortText(500).optional(),
    },
    async run(client, input) {
      return enrichOrganization(asServerClient(client), input as unknown as Parameters<typeof enrichOrganization>[1]);
    },
  },
  {
    name: 'credit_usage',
    title: 'Show Apollo credits and API usage',
    description: 'Remaining credits of the key’s user and how much of each rate limit is used. Free; the usage needs a master key.',
    riskLevel: 'read',
    summary: 'Apollo credits and usage.',
    upstream: [get('/api/v1/users/api_profile'), post('/api/v1/usage_stats/api_usage_stats')],
    input: {},
    async run(client) {
      const profile = asObject(await client.get('/api/v1/users/api_profile', { include_credit_usage: true })) ?? {};
      const credits = Object.fromEntries(
        Object.entries(profile).filter(([key, value]) => /credit/i.test(key) && typeof value === 'number'),
      );
      const usage = asObject(await client.post('/api/v1/usage_stats/api_usage_stats')) ?? {};
      const endpoints = Object.entries(usage).map(([key, value]) => {
        let endpoint = key;
        let action = '';
        try {
          const parsed = JSON.parse(key) as unknown;
          if (Array.isArray(parsed)) [endpoint, action] = [String(parsed[0] ?? key), String(parsed[1] ?? '')];
        } catch {
          // not the documented form
        }
        const windows = asObject(value) ?? {};
        const window = (name: string) => objectOf({ limit: plain, consumed: plain, left_over: plain })(windows[name]);
        return { endpoint, action, minute: window('minute'), hour: window('hour'), day: window('day') };
      });
      return { credits, endpoints };
    },
  },
  {
    name: 'search_contacts',
    title: 'Search contacts',
    description: 'Search the team’s saved contacts by name, title, employer or email, stage or list.',
    riskLevel: 'read',
    summary: 'Contacts found.',
    upstream: [post('/api/v1/contacts/search')],
    input: {
      qKeywords: shortText().optional().describe('Words in the name, title, employer or email.'),
      contactStageIds: z.array(apolloId).max(50).optional(),
      contactLabelIds: z.array(apolloId).max(50).optional(),
      sortByField: z
        .enum(['contact_last_activity_date', 'contact_email_last_opened_at', 'contact_email_last_clicked_at', 'contact_created_at', 'contact_updated_at'])
        .optional(),
      sortAscending: z.boolean().optional(),
      ...paging,
    },
    async run(client, input) {
      const answer = await client.post('/api/v1/contacts/search', {
        ...body(input, { qKeywords: 'q_keywords', contactStageIds: 'contact_stage_ids', contactLabelIds: 'contact_label_ids' }),
        ...body(input, { sortByField: 'sort_by_field', sortAscending: 'sort_ascending', page: 'page', perPage: 'per_page' }),
      });
      return page(answer, 'contacts', CONTACT);
    },
  },
  {
    name: 'get_contact',
    title: 'Get a contact',
    description: 'One saved contact with email, phones, stage, owner and lists.',
    riskLevel: 'read',
    summary: 'Contact.',
    upstream: [get('/api/v1/contacts/{contact_id}')],
    input: { contactId: pathId },
    async run(client, input) {
      return one(await client.get(`/api/v1/contacts/${id(input, 'contactId')}`), 'contact', CONTACT);
    },
  },
  {
    name: 'search_accounts',
    title: 'Search accounts',
    description: 'Search the team’s saved accounts (companies) by name, stage or list.',
    riskLevel: 'read',
    summary: 'Accounts found.',
    upstream: [post('/api/v1/accounts/search')],
    input: {
      qOrganizationName: shortText().optional(),
      accountStageIds: z.array(apolloId).max(50).optional(),
      accountLabelIds: z.array(apolloId).max(50).optional(),
      sortByField: z.enum(['account_last_activity_date', 'account_created_at', 'account_updated_at']).optional(),
      sortAscending: z.boolean().optional(),
      ...paging,
    },
    async run(client, input) {
      const answer = await client.post('/api/v1/accounts/search', {
        ...body(input, { qOrganizationName: 'q_organization_name', accountStageIds: 'account_stage_ids', accountLabelIds: 'account_label_ids' }),
        ...body(input, { sortByField: 'sort_by_field', sortAscending: 'sort_ascending', page: 'page', perPage: 'per_page' }),
      });
      return page(answer, 'accounts', ACCOUNT);
    },
  },
  {
    name: 'get_account',
    title: 'Get an account',
    description: 'One saved account (company) with stage, owner and address.',
    riskLevel: 'read',
    summary: 'Account.',
    upstream: [get('/api/v1/accounts/{id}')],
    input: { accountId: pathId },
    async run(client, input) {
      return one(await client.get(`/api/v1/accounts/${id(input, 'accountId')}`), 'account', ACCOUNT);
    },
  },
  {
    name: 'search_deals',
    title: 'Search deals',
    description: 'Search the team’s deals by name, account, owner, stage, open or closed, amount and dates.',
    riskLevel: 'read',
    summary: 'Deals found.',
    upstream: [get('/api/v1/opportunities/search')],
    input: {
      qOpportunityName: shortText().optional(),
      accountIds: z.array(apolloId).max(50).optional(),
      ownerIds: z.array(apolloId).max(50).optional(),
      stageIds: z.array(apolloId).max(50).optional(),
      isClosed: z.boolean().optional(),
      amountMin: z.number().min(0).optional(),
      amountMax: z.number().min(0).optional(),
      closeDateFrom: isoDate.optional(),
      closeDateTo: isoDate.optional(),
      sortByField: z
        .enum(['opportunity_created_at', 'opportunity_updated_at', 'opportunity_close_date', 'amount', 'is_closed', 'is_won'])
        .optional(),
      sortAscending: z.boolean().optional(),
      ...paging,
    },
    async run(client, input) {
      const query: Record<string, QueryValue> = {
        q_opportunity_name: input.qOpportunityName as string | undefined,
        'account_ids[]': input.accountIds as string[] | undefined,
        'opportunity_owner_ids[]': input.ownerIds as string[] | undefined,
        'opportunity_stage_ids[]': input.stageIds as string[] | undefined,
        opportunity_is_closed: input.isClosed as boolean | undefined,
        'opportunity_amount_range[min]': input.amountMin as number | undefined,
        'opportunity_amount_range[max]': input.amountMax as number | undefined,
        'opportunity_close_date_range[min]': input.closeDateFrom as string | undefined,
        'opportunity_close_date_range[max]': input.closeDateTo as string | undefined,
        sort_by_field: input.sortByField as string | undefined,
        sort_ascending: input.sortAscending as boolean | undefined,
        page: input.page as number | undefined,
        per_page: input.perPage as number | undefined,
      };
      return page(await client.get('/api/v1/opportunities/search', query), 'opportunities', DEAL);
    },
  },
  {
    name: 'get_deal',
    title: 'Get a deal',
    description: 'One deal with amount, stage, owner, account and close date.',
    riskLevel: 'read',
    summary: 'Deal.',
    upstream: [get('/api/v1/opportunities/{opportunity_id}')],
    input: { dealId: pathId },
    async run(client, input) {
      return one(await client.get(`/api/v1/opportunities/${id(input, 'dealId')}`), 'opportunity', DEAL);
    },
  },
  {
    name: 'search_tasks',
    title: 'Search tasks',
    description: 'The team’s tasks (calls, emails, to-dos), soonest due or highest priority first.',
    riskLevel: 'read',
    summary: 'Tasks found.',
    upstream: [post('/api/v1/tasks/search')],
    input: {
      sortByField: z.enum(['task_due_at', 'task_priority']).optional(),
      ...paging,
    },
    async run(client, input) {
      const answer = await client.post('/api/v1/tasks/search', undefined, {
        sort_by_field: input.sortByField as string | undefined,
        page: input.page as number | undefined,
        per_page: input.perPage as number | undefined,
      });
      return page(answer, 'tasks', TASK);
    },
  },
  {
    name: 'search_sequences',
    title: 'Search sequences',
    description: 'Find the team’s sequences (automated email cadences) by name, with their counts.',
    riskLevel: 'read',
    summary: 'Sequences found.',
    upstream: [post('/api/v1/emailer_campaigns/search')],
    input: { qName: shortText().optional(), ...paging },
    async run(client, input) {
      const answer = await client.post('/api/v1/emailer_campaigns/search', undefined, {
        q_name: input.qName as string | undefined,
        page: input.page as number | undefined,
        per_page: input.perPage as number | undefined,
      });
      return page(answer, 'emailer_campaigns', SEQUENCE);
    },
  },
  {
    name: 'list_users',
    title: 'List Apollo users',
    description: 'The users in the team, with their ids, for owners and tasks. Needs a master key.',
    riskLevel: 'read',
    summary: 'Apollo users.',
    upstream: [get('/api/v1/users/search')],
    input: { ...paging },
    async run(client, input) {
      const answer = await client.get('/api/v1/users/search', {
        page: input.page as number | undefined,
        per_page: input.perPage as number | undefined,
      });
      return page(answer, 'users', USER);
    },
  },
  {
    name: 'list_email_accounts',
    title: 'List mailboxes',
    description: 'The team’s linked mailboxes that sequences can send from: id, owner, address and whether active.',
    riskLevel: 'read',
    summary: 'Mailboxes.',
    upstream: [get('/api/v1/email_accounts')],
    input: {},
    async run(client) {
      const answer = asObject(await client.get('/api/v1/email_accounts')) ?? {};
      return { email_accounts: listOf(EMAIL_ACCOUNT)(answer.email_accounts) ?? [] };
    },
  },
  {
    name: 'list_stages',
    title: 'List stages',
    description: 'The stages for contacts, accounts or deals, with their ids.',
    riskLevel: 'read',
    summary: 'Stages.',
    upstream: [get('/api/v1/contact_stages'), get('/api/v1/account_stages'), get('/api/v1/opportunity_stages')],
    input: { kind: z.enum(['contact', 'account', 'deal']) },
    async run(client, input) {
      if (input.kind === 'contact') {
        const answer = asObject(await client.get('/api/v1/contact_stages')) ?? {};
        return { stages: listOf(CONTACT_STAGE)(answer.contact_stages) ?? [] };
      }
      if (input.kind === 'account') {
        const answer = asObject(await client.get('/api/v1/account_stages')) ?? {};
        return { stages: listOf(ACCOUNT_STAGE)(answer.account_stages) ?? [] };
      }
      const answer = asObject(await client.get('/api/v1/opportunity_stages')) ?? {};
      return { stages: listOf(DEAL_STAGE)(answer.opportunity_stages) ?? [] };
    },
  },

  // ------------------------------------------------------------- changes

  {
    name: 'create_contact',
    title: 'Create a contact',
    description: 'Save a person as a contact in the team’s Apollo. With runDedupe, an existing match is updated instead.',
    riskLevel: 'write',
    summary: 'Contact created.',
    upstream: [post('/api/v1/contacts')],
    input: { ...contactFields, runDedupe: z.boolean().optional().describe('Update a matching contact instead of creating a new one.') },
    async run(client, input) {
      if (!input.firstName && !input.lastName && !input.email) throw new Error('Give a name or an email.');
      const answer = asObject(
        await client.post('/api/v1/contacts', { ...body(input, CONTACT_BODY), ...body(input, { runDedupe: 'run_dedupe' }) }),
      );
      return {
        ...saved(answer, 'contact', CONTACT),
        ...(answer?.dedupe_result ? { dedupe: objectOf({ found_existing: plain, existing_contact_id: plain })(answer.dedupe_result) } : {}),
      };
    },
  },
  {
    name: 'update_contact',
    title: 'Update a contact',
    description: 'Change a saved contact’s name, title, employer, email, phones, stage, lists or custom fields.',
    riskLevel: 'write',
    summary: 'Contact updated.',
    upstream: [patch('/api/v1/contacts/{contact_id}')],
    input: { contactId: pathId, ...contactFields },
    async run(client, input) {
      requireChange(input, CONTACT_BODY);
      return saved(await client.patch(`/api/v1/contacts/${id(input, 'contactId')}`, body(input, CONTACT_BODY)), 'contact', CONTACT);
    },
  },
  {
    name: 'set_contact_stage',
    title: 'Move contacts to a stage',
    description: 'Set the stage of up to 100 contacts.',
    riskLevel: 'write',
    summary: 'Contact stage set.',
    upstream: [post('/api/v1/contacts/update_stages')],
    input: { contactIds: ids(100), contactStageId: apolloId },
    async run(client, input) {
      const answer = asObject(
        await client.post('/api/v1/contacts/update_stages', undefined, {
          'contact_ids[]': input.contactIds as string[],
          contact_stage_id: input.contactStageId as string,
        }),
      );
      return { contacts: listOf({ id: plain, contact_stage_id: plain })(answer?.contacts) ?? [] };
    },
  },
  {
    name: 'set_contact_owner',
    title: 'Give contacts a new owner',
    description: 'Make a user in the team the owner of up to 100 contacts.',
    riskLevel: 'write',
    summary: 'Contact owner set.',
    upstream: [post('/api/v1/contacts/update_owners')],
    input: { contactIds: ids(100), ownerId: apolloId },
    async run(client, input) {
      const answer = asObject(
        await client.post('/api/v1/contacts/update_owners', undefined, {
          'contact_ids[]': input.contactIds as string[],
          owner_id: input.ownerId as string,
        }),
      );
      return { contacts: listOf({ id: plain, owner_id: plain })(answer?.contacts) ?? [] };
    },
  },
  {
    name: 'create_account',
    title: 'Create an account',
    description: 'Save a company as an account in the team’s Apollo.',
    riskLevel: 'write',
    summary: 'Account created.',
    upstream: [post('/api/v1/accounts')],
    input: { ...accountFields, name: shortText() },
    async run(client, input) {
      return saved(await client.post('/api/v1/accounts', body(input, ACCOUNT_BODY)), 'account', ACCOUNT);
    },
  },
  {
    name: 'update_account',
    title: 'Update an account',
    description: 'Change a saved account’s name, domain, stage, phone, address or custom fields. The owner changes only with apollo_set_account_owner.',
    riskLevel: 'write',
    summary: 'Account updated.',
    upstream: [patch('/api/v1/accounts/{account_id}')],
    input: { accountId: pathId, ...accountFields },
    async run(client, input) {
      requireChange(input, ACCOUNT_BODY);
      return saved(await client.patch(`/api/v1/accounts/${id(input, 'accountId')}`, body(input, ACCOUNT_BODY)), 'account', ACCOUNT);
    },
  },
  {
    name: 'set_account_owner',
    title: 'Give accounts a new owner',
    description: 'Make a user in the team the owner of up to 100 accounts.',
    riskLevel: 'write',
    summary: 'Account owner set.',
    upstream: [post('/api/v1/accounts/update_owners')],
    input: { accountIds: ids(100), ownerId: apolloId },
    async run(client, input) {
      const answer = asObject(
        await client.post('/api/v1/accounts/update_owners', undefined, {
          'account_ids[]': input.accountIds as string[],
          owner_id: input.ownerId as string,
        }),
      );
      return { accounts: listOf({ id: plain, owner_id: plain })(answer?.accounts) ?? [] };
    },
  },
  {
    name: 'create_deal',
    title: 'Create a deal',
    description: 'Create a deal with amount, stage, owner, account and close date.',
    riskLevel: 'write',
    summary: 'Deal created.',
    upstream: [post('/api/v1/opportunities')],
    input: { ...dealFields, name: shortText() },
    async run(client, input) {
      return saved(await client.post('/api/v1/opportunities', body(input, DEAL_BODY)), 'opportunity', DEAL);
    },
  },
  {
    name: 'update_deal',
    title: 'Update a deal',
    description: 'Change a deal’s name, amount, stage, owner, close date or custom fields.',
    riskLevel: 'write',
    summary: 'Deal updated.',
    upstream: [patch('/api/v1/opportunities/{opportunity_id}')],
    input: { dealId: pathId, ...dealUpdateFields },
    async run(client, input) {
      requireChange(input, DEAL_BODY);
      return saved(await client.patch(`/api/v1/opportunities/${id(input, 'dealId')}`, body(input, DEAL_BODY)), 'opportunity', DEAL);
    },
  },
  {
    name: 'create_task',
    title: 'Create a task',
    description: 'Create a task for a user about a contact: a call, an email, a LinkedIn step or a to-do, due at a time.',
    riskLevel: 'write',
    summary: 'Task created.',
    upstream: [post('/api/v1/tasks')],
    input: {
      userId: apolloId.describe('The user who owns the task (apollo_list_users).'),
      contactId: apolloId,
      type: z.enum([
        'call',
        'outreach_manual_email',
        'linkedin_step_connect',
        'linkedin_step_message',
        'linkedin_step_view_profile',
        'linkedin_step_interact_post',
        'action_item',
      ]),
      dueAt: isoDateTime.describe('When it is due, ISO 8601 with offset.'),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      title: shortText().optional(),
      note: z.string().trim().max(5000).optional(),
    },
    async run(client, input) {
      const answer = await client.post('/api/v1/tasks', {
        ...body(input, { userId: 'user_id', contactId: 'contact_id', type: 'type', dueAt: 'due_at', priority: 'priority' }),
        ...body(input, { title: 'title', note: 'note' }),
        status: 'scheduled',
      });
      return one(answer, 'task', TASK);
    },
  },
  {
    name: 'complete_task',
    title: 'Complete a task',
    description: 'Mark a task as done, with an optional note.',
    riskLevel: 'write',
    summary: 'Task completed.',
    upstream: [post('/api/v1/tasks/{id}/complete')],
    input: { taskId: pathId, note: z.string().trim().max(5000).optional() },
    async run(client, input) {
      const answer = await client.post(
        `/api/v1/tasks/${id(input, 'taskId')}/complete`,
        input.note === undefined ? {} : { note: input.note },
      );
      // Apollo answers 200 with the task marked deleted when it no longer exists: nothing was completed.
      if (asObject(asObject(answer)?.task)?.deleted === true) {
        throw new Error('Apollo has no such task any more (it was deleted); nothing was completed.');
      }
      return one(answer, 'task', TASK);
    },
  },
  {
    name: 'add_contacts_to_sequence',
    title: 'Add contacts to a sequence',
    description:
      'Enroll up to 100 saved contacts in a sequence, sending from one of the team’s mailboxes. The sequence then emails them on its schedule. Apollo’s enrollment rules apply: contacts without a verified email, in another sequence or owned by others are skipped.',
    riskLevel: 'write',
    summary: 'Contacts added to the sequence.',
    upstream: [post('/api/v1/emailer_campaigns/{sequence_id}/add_contact_ids')],
    input: {
      sequenceId: pathId,
      contactIds: ids(100),
      emailAccountId: apolloId.describe('The mailbox to send from (apollo_list_email_accounts).'),
      status: z.enum(['active', 'paused']).optional(),
      autoUnpauseAt: isoDateTime.optional().describe('With status "paused": when the contacts start.'),
    },
    async run(client, input) {
      if (input.autoUnpauseAt !== undefined && input.status !== 'paused') {
        throw new Error('autoUnpauseAt needs status "paused".');
      }
      const sequence = String(input.sequenceId);
      const answer = asObject(
        await client.post(`/api/v1/emailer_campaigns/${id(input, 'sequenceId')}/add_contact_ids`, undefined, {
          emailer_campaign_id: sequence,
          'contact_ids[]': input.contactIds as string[],
          send_email_from_email_account_id: input.emailAccountId as string,
          status: input.status as string | undefined,
          auto_unpause_at: input.autoUnpauseAt as string | undefined,
        }),
      );
      const skipped = asObject(answer?.skipped_contact_ids) ?? {};
      return {
        added: listOf({ id: plain })(answer?.contacts) ?? [],
        skipped: Object.entries(skipped).map(([contactId, reason]) => ({ contactId, reason: plain(reason) ?? null })),
        sequence: objectOf(SEQUENCE)(answer?.emailer_campaign) ?? null,
      };
    },
  },
];
