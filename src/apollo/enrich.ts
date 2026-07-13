import { callWithRateLimitRetry, runBatch, type RunBatchOptions } from './batch.js';
import type { ApolloClient, QueryValue } from './client.js';
import { selectFields } from './fields.js';

export const MAX_BULK_DETAILS_PER_CALL = 10;
export const MAX_BULK_ITEMS = 100;

export interface PersonIdentifiers {
  id?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  hashedEmail?: string;
  organizationName?: string;
  domain?: string;
  linkedinUrl?: string;
}

export interface RevealFlags {
  revealPersonalEmails?: boolean;
  revealPhoneNumber?: boolean;
  webhookUrl?: string;
}

export interface PersonEnrichInput extends PersonIdentifiers, RevealFlags {
  fields?: string[];
}

export interface PersonEnrichResult {
  person: unknown;
  request_id?: unknown;
  waterfall?: unknown;
  phoneRevealPending?: boolean;
  note?: string;
}

const PHONE_REVEAL_NOTE =
  'Phone numbers are delivered asynchronously: Apollo POSTs them to the webhook_url, which can take several minutes. Poll apollo_webhook_result with request_id if the callback is missed (results are kept 30 days).';

export function assertRevealFlags(input: RevealFlags): void {
  if (input.revealPhoneNumber && !input.webhookUrl) {
    throw new Error(
      'reveal_phone_number requires webhookUrl: Apollo delivers phone numbers asynchronously to a public HTTPS webhook.',
    );
  }
}

function hasAnyIdentifier(input: PersonIdentifiers): boolean {
  return Boolean(
    input.id ||
      input.email ||
      input.hashedEmail ||
      input.linkedinUrl ||
      input.name ||
      (input.firstName && input.lastName) ||
      input.domain ||
      input.organizationName,
  );
}

function identifierQuery(input: PersonIdentifiers): Record<string, QueryValue> {
  return {
    id: input.id,
    first_name: input.firstName,
    last_name: input.lastName,
    name: input.name,
    email: input.email,
    hashed_email: input.hashedEmail,
    organization_name: input.organizationName,
    domain: input.domain,
    linkedin_url: input.linkedinUrl,
  };
}

/**
 * Wraps POST /people/match. Consumes credits when a record is enriched
 * (email and phone reveals cost extra, per your Apollo plan). Phone reveals
 * come back via webhook, not in the synchronous response — the returned
 * request_id is the poll handle.
 */
export async function enrichPerson(
  client: ApolloClient,
  input: PersonEnrichInput,
): Promise<PersonEnrichResult> {
  if (!hasAnyIdentifier(input)) {
    throw new Error(
      'Provide at least one identifier: id, email, hashedEmail, linkedinUrl, name, firstName+lastName, domain, or organizationName.',
    );
  }
  assertRevealFlags(input);

  const query: Record<string, QueryValue> = {
    ...identifierQuery(input),
    reveal_personal_emails: input.revealPersonalEmails ? true : undefined,
    reveal_phone_number: input.revealPhoneNumber ? true : undefined,
    webhook_url: input.revealPhoneNumber ? input.webhookUrl : undefined,
  };

  const response = await client.post<Record<string, unknown>>('/api/v1/people/match', undefined, query);

  const person =
    input.fields && input.fields.length > 0 && !input.fields.includes('*')
      ? selectFields(response.person, input.fields)
      : response.person;

  return {
    person,
    request_id: response.request_id,
    waterfall: response.waterfall,
    ...(input.revealPhoneNumber ? { phoneRevealPending: true, note: PHONE_REVEAL_NOTE } : {}),
  };
}

export interface BulkEnrichInput extends RevealFlags {
  details: PersonIdentifiers[];
  concurrency?: number;
  fields?: string[];
}

export interface BulkEnrichItemResult {
  index: number;
  ok: boolean;
  person?: unknown;
  error?: string;
}

export interface BulkEnrichResult {
  total: number;
  succeeded: number;
  failed: number;
  creditsConsumed?: number;
  requestIds: unknown[];
  results: BulkEnrichItemResult[];
  phoneRevealPending?: boolean;
  note?: string;
}

export interface BulkEnrichProgress {
  completed: number;
  total: number;
  ok: boolean;
  error?: string;
}

export interface BulkEnrichOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BulkEnrichProgress) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

interface BulkMatchResponse {
  status?: unknown;
  total_requested_enrichments?: unknown;
  unique_enriched_records?: unknown;
  missing_records?: unknown;
  credits_consumed?: unknown;
  matches?: unknown[];
  request_id?: unknown;
}

/**
 * Wraps POST /people/bulk_match (max 10 people per Apollo call). Accepts up to
 * MAX_BULK_ITEMS items, chunks them into Apollo-sized calls, fans the chunks
 * out with bounded concurrency, retries HTTP 429, and isolates per-chunk
 * failures. Reveal flags apply to every item.
 */
export async function bulkEnrichPeople(
  client: ApolloClient,
  input: BulkEnrichInput,
  options: BulkEnrichOptions = {},
): Promise<BulkEnrichResult> {
  if (!input.details.length || input.details.length > MAX_BULK_ITEMS) {
    throw new Error(`details must contain 1-${MAX_BULK_ITEMS} people.`);
  }
  for (const [index, detail] of input.details.entries()) {
    if (!hasAnyIdentifier(detail)) {
      throw new Error(`details[${index}] has no usable identifier.`);
    }
  }
  assertRevealFlags(input);

  const chunks: PersonIdentifiers[][] = [];
  for (let start = 0; start < input.details.length; start += MAX_BULK_DETAILS_PER_CALL) {
    chunks.push(input.details.slice(start, start + MAX_BULK_DETAILS_PER_CALL));
  }

  const query: Record<string, QueryValue> = {
    reveal_personal_emails: input.revealPersonalEmails ? true : undefined,
    reveal_phone_number: input.revealPhoneNumber ? true : undefined,
    webhook_url: input.revealPhoneNumber ? input.webhookUrl : undefined,
  };

  const itemTotal = input.details.length;
  let itemsCompleted = 0;

  const batchOptions: RunBatchOptions<BulkMatchResponse> = {
    // Apollo's documented bulk_match rate limit is low (20/min) — stay gentle.
    concurrency: Math.max(1, Math.min(input.concurrency ?? 2, 4)),
    signal: options.signal,
    onProgress: async (_completed, _total, last) => {
      const chunkSize = chunks[last.index]?.length ?? 0;
      itemsCompleted += chunkSize;
      await options.onProgress?.({
        completed: itemsCompleted,
        total: itemTotal,
        ok: last.ok,
        error: last.ok ? undefined : last.error,
      });
    },
  };

  const chunkResults = await runBatch(
    chunks,
    chunk =>
      callWithRateLimitRetry(
        () =>
          client.post<BulkMatchResponse>('/api/v1/people/bulk_match', { details: chunk.map(identifierQuery) }, query),
        { signal: options.signal, sleep: options.sleep },
      ),
    batchOptions,
  );

  const results: BulkEnrichItemResult[] = [];
  const requestIds: unknown[] = [];
  let creditsConsumed = 0;
  let creditsReported = false;

  for (const [chunkIndex, chunkResult] of chunkResults.entries()) {
    const chunk = chunks[chunkIndex] ?? [];
    const baseIndex = chunkIndex * MAX_BULK_DETAILS_PER_CALL;

    if (!chunkResult.ok) {
      for (let offset = 0; offset < chunk.length; offset += 1) {
        results.push({ index: baseIndex + offset, ok: false, error: chunkResult.error });
      }
      continue;
    }

    const payload = chunkResult.value;
    if (typeof payload.credits_consumed === 'number') {
      creditsConsumed += payload.credits_consumed;
      creditsReported = true;
    }
    if (payload.request_id !== undefined && payload.request_id !== null) {
      requestIds.push(payload.request_id);
    }

    // Apollo returns matches positionally; unmatched inputs may be null.
    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const match = matches[offset] ?? null;
      if (match === null) {
        results.push({ index: baseIndex + offset, ok: false, error: 'No match found.' });
        continue;
      }
      results.push({
        index: baseIndex + offset,
        ok: true,
        person:
          input.fields && input.fields.length > 0 && !input.fields.includes('*')
            ? selectFields(match, input.fields)
            : match,
      });
    }
  }

  const succeeded = results.filter(result => result.ok).length;

  return {
    total: itemTotal,
    succeeded,
    failed: itemTotal - succeeded,
    creditsConsumed: creditsReported ? creditsConsumed : undefined,
    requestIds,
    results,
    ...(input.revealPhoneNumber ? { phoneRevealPending: true, note: PHONE_REVEAL_NOTE } : {}),
  };
}

export interface OrgEnrichInput {
  domain?: string;
  name?: string;
  website?: string;
  linkedinUrl?: string;
  fields?: string[];
}

/**
 * Wraps GET /organizations/enrich. Consumes 1 credit when a record is
 * enriched. At least one of domain / name / website / linkedinUrl is required.
 */
export async function enrichOrganization(
  client: ApolloClient,
  input: OrgEnrichInput,
): Promise<{ organization: unknown }> {
  if (!input.domain && !input.name && !input.website && !input.linkedinUrl) {
    throw new Error('Provide at least one of: domain, name, website, linkedinUrl.');
  }

  const response = await client.get<Record<string, unknown>>('/api/v1/organizations/enrich', {
    domain: input.domain,
    name: input.name,
    website: input.website,
    linkedin_url: input.linkedinUrl,
  });

  return {
    organization:
      input.fields && input.fields.length > 0 && !input.fields.includes('*')
        ? selectFields(response.organization, input.fields)
        : response.organization,
  };
}

/**
 * Wraps GET /webhook_result/{request_id} — the poll endpoint for asynchronous
 * phone-number reveals. Free (no credits); results are kept for 30 days.
 */
export async function getWebhookResult(client: ApolloClient, requestId: string | number): Promise<unknown> {
  const id = String(requestId).trim();
  if (!/^-?\d+$/.test(id)) {
    throw new Error('requestId must be the integer request_id returned by an enrichment call.');
  }

  return client.get<unknown>(`/api/v1/webhook_result/${encodeURIComponent(id)}`);
}
