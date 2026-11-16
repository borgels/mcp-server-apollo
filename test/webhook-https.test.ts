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

describe('advertised webhookUrl schema', () => {
  it('lists webhookUrl as format "uri" with an https pattern', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { ApolloClient } = await import('../src/apollo/client.js');
    const { createServer } = await import('../src/server.js');

    const server = createServer({ client: new ApolloClient({ apiKey: 'k', baseUrl: 'https://example.test' }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

    const { tools } = await mcp.listTools();
    for (const name of ['apollo_person_enrich', 'apollo_people_bulk_enrich']) {
      const tool = tools.find(entry => entry.name === name);
      const webhookUrl = (tool?.inputSchema.properties as Record<string, { format?: string; pattern?: string }>)
        .webhookUrl;
      expect(webhookUrl?.format, name).toBe('uri');
      expect(webhookUrl?.pattern, name).toMatch(/^\^https/);
    }
    await mcp.close();
  });
});
