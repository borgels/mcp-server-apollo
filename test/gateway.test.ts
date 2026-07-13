import { describe, expect, it } from 'vitest';
import { createApolloGateway, apolloGatewayTools } from '../src/gateway.js';

describe('Apollo gateway export', () => {
  it('exposes a read-only discovery and enrichment surface', () => {
    expect(apolloGatewayTools.map(tool => tool.name)).toEqual([
      'search_capabilities',
      'companies_search',
      'people_search',
      'person_enrich',
      'people_bulk_enrich',
      'org_enrich',
      'webhook_result',
      'credit_usage',
    ]);

    // This server has no write tools at all.
    expect(apolloGatewayTools.every(tool => tool.riskLevel === 'read')).toBe(true);
  });

  it('supports local capability search without upstream calls', async () => {
    const gateway = createApolloGateway({ apiKey: 'test' });
    const result = await gateway.callTool('search_capabilities', { query: 'enrich phone' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeTruthy();
  });
});
