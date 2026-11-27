// The host's audit sink and Apollo's rate limit, through the embedded gateway.
import { describe, expect, it } from 'vitest';
import { createApolloGateway } from '../src/gateway.js';

const TOKEN = 'qqqqwwwwzzzzxxxx1';
const ID = '64b2f0c1a1b2c3d4e5f60718';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('the audit sink', () => {
  it('refuses a call whose start record fails, with a fixed text and nothing sent', async () => {
    let sent = 0;
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => {
        sent += 1;
        return json({ contact: { id: ID } });
      },
      policy: {
        enableWrites: true,
        audit: () => {
          throw new Error('postgres://audit_user:p4ssw0rd987@audit.internal/events unreachable');
        },
      },
    });
    const result = await gw.callTool('update_contact', { contactId: ID, title: 'CEO' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Refused: the audit record of this call could not be written, so nothing was sent to Apollo.');
    expect(JSON.stringify(result)).not.toMatch(/p4ssw0rd|audit\.internal|postgres/);
    expect(sent).toBe(0);
  });

  it('keeps a completed change a success when only the finish record fails', async () => {
    let sent = 0;
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => {
        sent += 1;
        return json({ contact: { id: ID, title: 'CEO' } });
      },
      policy: {
        enableWrites: true,
        audit: record => {
          if (record.action === 'finish') throw new Error('sink down at audit.internal');
        },
      },
    });
    const result = await gw.callTool('update_contact', { contactId: ID, title: 'CEO' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ contact: { id: ID, title: 'CEO' } });
    expect(JSON.stringify(result)).not.toContain('audit.internal');
    expect(sent).toBe(1);
  });

  it('passes on the call’s own error, not the sink’s, when the error record fails', async () => {
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => json({}, 404),
      policy: {
        audit: record => {
          if (record.action === 'error') throw new Error('sink down at audit.internal');
        },
      },
    });
    const result = await gw.callTool('get_contact', { contactId: ID });
    expect(result.isError).toBe(true);
    expect(result.failure).toMatchObject({ httpStatus: 404 });
    expect(JSON.stringify(result)).not.toContain('audit.internal');
  });
});

describe('the rate limit', () => {
  it('retries bulk enrichment after a 429 from Apollo', async () => {
    let calls = 0;
    const gw = createApolloGateway({
      apiKey: TOKEN,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? json({}, 429, { 'retry-after': '0' }) : json({ matches: [{ id: ID }] });
      },
    });
    const result = await gw.callTool('people_bulk_enrich', { details: [{ id: ID }] });
    expect(result.isError).toBeUndefined();
    expect(calls).toBe(2);
    expect(result.structuredContent).toMatchObject({ succeeded: 1, failed: 0 });
  });
});
