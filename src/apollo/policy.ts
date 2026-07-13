export interface ApolloPolicyDecision {
  allowed: boolean;
  reason: string;
}

const ALLOWED_READ_TOOLS = new Set([
  'apollo_search_capabilities',
  'apollo_people_search',
  'apollo_webhook_result',
  'apollo_credit_usage',
]);

// Reads that draw on the shared Apollo credit pool. Still read-only against
// Apollo data — this server has no write tools at all (no sequences, no CRM
// pushes, no account management).
const ALLOWED_CREDIT_TOOLS = new Set([
  'apollo_companies_search',
  'apollo_person_enrich',
  'apollo_people_bulk_enrich',
  'apollo_org_enrich',
]);

export function checkToolPolicy(toolName: string): ApolloPolicyDecision {
  if (ALLOWED_READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Apollo tool (no credits)' };
  }

  if (ALLOWED_CREDIT_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Apollo tool (consumes shared credits)' };
  }

  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}
