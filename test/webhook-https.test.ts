import { describe, expect, it, vi } from 'vitest';
import { apolloGatewayTools, createApolloGateway } from '../src/gateway.js';
import { assertHttpsWebhookUrl } from '../src/apollo/enrich.js';

describe('webhookUrl must be https in every entry point', () => {
  it('declares https in the gateway input schemas', () => {
    for (const name of ['person_enrich', 'people_bulk_enrich']) {
      const tool = apolloGatewayTools.find(t => t.name === name)!;
      const props = (tool.inputSchema as { properties: Record<string, { pattern?: string }> }).properties;
      expect(props.webhookUrl?.pattern).toBe('^https://');
    }
  });

  it.each(['http://example.com/hook', 'ftp://example.com/x', 'not a url', 'javascript:alert(1)'])(
    'rejects %j',
    value => {
      expect(() => assertHttpsWebhookUrl(value)).toThrow(/HTTPS/);
    },
  );

  it('accepts https', () => {
    expect(() => assertHttpsWebhookUrl('https://hooks.example.com/apollo')).not.toThrow();
  });

  it('gateway refuses a non-https webhook before calling Apollo', async () => {
    const fetchImpl = vi.fn();
    const gateway = createApolloGateway({ apiKey: 'test', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      gateway.callTool('person_enrich', { email: 'a@example.com', revealPhoneNumber: true, webhookUrl: 'http://example.com/hook' }),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      gateway.callTool('people_bulk_enrich', { details: [{ email: 'a@example.com' }], revealPhoneNumber: true, webhookUrl: 'http://example.com/hook' }),
    ).rejects.toThrow(/HTTPS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
