import { searchCapabilities } from './apollo/capabilities.js';
import { ApolloClient, type ApolloClientOptions } from './apollo/client.js';
import { searchCompanies } from './apollo/companies.js';
import { bulkEnrichPeople, enrichOrganization, enrichPerson, getWebhookResult } from './apollo/enrich.js';
import { searchPeople } from './apollo/people.js';
import { getUsageStats } from './apollo/usage.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export interface ApolloGatewayOptions extends ApolloClientOptions {}

const fieldsProperty = { type: 'array', items: { type: 'string' } } satisfies GatewayJsonObject;

const personIdentifierProperties = {
  id: { type: 'string' },
  firstName: { type: 'string' },
  lastName: { type: 'string' },
  name: { type: 'string' },
  email: { type: 'string' },
  hashedEmail: { type: 'string' },
  organizationName: { type: 'string' },
  domain: { type: 'string' },
  linkedinUrl: { type: 'string' },
} satisfies GatewayJsonObject;

export const apolloGatewayTools: GatewayToolDefinition[] = [
  {
    name: 'search_capabilities',
    title: 'Search Apollo capabilities',
    description: 'Find supported Apollo discovery, people-search, and enrichment tools.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'companies_search',
    title: 'Search companies (Apollo)',
    description:
      'Discover companies by keywords, location, size, revenue, or technology. Costs 1 Apollo credit per page with results.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        qOrganizationName: { type: 'string' },
        qOrganizationKeywordTags: { type: 'array', items: { type: 'string' } },
        organizationLocations: { type: 'array', items: { type: 'string' } },
        organizationNotLocations: { type: 'array', items: { type: 'string' } },
        qOrganizationDomainsList: { type: 'array', items: { type: 'string' } },
        organizationIds: { type: 'array', items: { type: 'string' } },
        organizationNumEmployeesRanges: { type: 'array', items: { type: 'string' } },
        revenueRange: {
          type: 'object',
          properties: { min: { type: 'number' }, max: { type: 'number' } },
          additionalProperties: false,
        },
        currentlyUsingAnyOfTechnologyUids: { type: 'array', items: { type: 'string' } },
        page: { type: 'number', minimum: 1, maximum: 500 },
        perPage: { type: 'number', minimum: 1, maximum: 100 },
        fields: fieldsProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'people_search',
    title: 'Search people (Apollo)',
    description:
      'Find people by title, seniority, location, or employer. Free, but requires a master API key; returns no contact data.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        personTitles: { type: 'array', items: { type: 'string' } },
        includeSimilarTitles: { type: 'boolean' },
        qKeywords: { type: 'string' },
        personSeniorities: { type: 'array', items: { type: 'string' } },
        personLocations: { type: 'array', items: { type: 'string' } },
        organizationLocations: { type: 'array', items: { type: 'string' } },
        qOrganizationDomainsList: { type: 'array', items: { type: 'string' } },
        organizationIds: { type: 'array', items: { type: 'string' } },
        organizationNumEmployeesRanges: { type: 'array', items: { type: 'string' } },
        contactEmailStatus: { type: 'array', items: { type: 'string' } },
        revenueRange: {
          type: 'object',
          properties: { min: { type: 'number' }, max: { type: 'number' } },
          additionalProperties: false,
        },
        page: { type: 'number', minimum: 1, maximum: 500 },
        perPage: { type: 'number', minimum: 1, maximum: 100 },
        fields: fieldsProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'person_enrich',
    title: 'Enrich person (Apollo)',
    description:
      'Match one person and return their full profile. Consumes credits; email/phone reveals cost extra; phone reveals are asynchronous via webhook.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...personIdentifierProperties,
        revealPersonalEmails: { type: 'boolean' },
        revealPhoneNumber: { type: 'boolean' },
        webhookUrl: { type: 'string' },
        fields: fieldsProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'people_bulk_enrich',
    title: 'Bulk enrich people (Apollo)',
    description:
      'Enrich up to 100 people. Consumes credits per enriched record; reveal flags apply to every person.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['details'],
      properties: {
        details: {
          type: 'array',
          items: { type: 'object', properties: personIdentifierProperties, additionalProperties: false },
        },
        revealPersonalEmails: { type: 'boolean' },
        revealPhoneNumber: { type: 'boolean' },
        webhookUrl: { type: 'string' },
        concurrency: { type: 'number', minimum: 1, maximum: 4 },
        fields: fieldsProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'org_enrich',
    title: 'Enrich organization (Apollo)',
    description:
      'Fetch full firmographics (industry, revenue, funding, technology stack) for one company. Consumes 1 credit when enriched.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        name: { type: 'string' },
        website: { type: 'string' },
        linkedinUrl: { type: 'string' },
        fields: fieldsProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'webhook_result',
    title: 'Poll webhook result (Apollo)',
    description: 'Fetch an asynchronous enrichment result (phone reveal) by request_id. Free.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['requestId'],
      properties: {
        requestId: { type: ['string', 'number'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'credit_usage',
    title: 'Get API usage / rate limits (Apollo)',
    description: 'Report per-endpoint usage against minute/hour/day rate limits. Master key required; free.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

export function createApolloGateway(options: ApolloGatewayOptions = {}) {
  const client = new ApolloClient(options);

  return {
    tools: apolloGatewayTools,
    async callTool(toolName: string, input: GatewayJsonObject = {}): Promise<GatewayToolResult> {
      switch (toolName) {
        case 'search_capabilities':
          return jsonResult('Found Apollo capabilities.', searchCapabilities(
            stringValue(input.query) ?? '',
            numberValue(input.limit) ?? 20,
          ));

        case 'companies_search':
          return jsonResult('Found companies.', await searchCompanies(client, input as unknown as Parameters<typeof searchCompanies>[1]));

        case 'people_search':
          return jsonResult('Found people.', await searchPeople(client, input as unknown as Parameters<typeof searchPeople>[1]));

        case 'person_enrich':
          return jsonResult('Enriched person.', await enrichPerson(client, input as unknown as Parameters<typeof enrichPerson>[1]));

        case 'people_bulk_enrich':
          return jsonResult('Bulk enriched people.', await bulkEnrichPeople(client, input as unknown as Parameters<typeof bulkEnrichPeople>[1]));

        case 'org_enrich':
          return jsonResult('Enriched organization.', await enrichOrganization(client, input as unknown as Parameters<typeof enrichOrganization>[1]));

        case 'webhook_result':
          return jsonResult('Fetched webhook result.', await getWebhookResult(client, input.requestId as string | number));

        case 'credit_usage':
          return jsonResult('Fetched API usage stats.', await getUsageStats(client));

        default:
          return errorResult(`Unsupported Apollo gateway tool: ${toolName}`);
      }
    },
  };
}

function stringValue(value: GatewayJsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: GatewayJsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
