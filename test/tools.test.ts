import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchCapabilities } from '../src/apollo/capabilities.js';
import { ApolloClient } from '../src/apollo/client.js';
import { checkToolPolicy } from '../src/apollo/policy.js';
import { registerApolloTools } from '../src/tools/apollo.js';

const originalAuditLog = process.env.APOLLO_AUDIT_LOG;
let tempDir: string | undefined;

describe('Apollo tool hardening', () => {
  afterEach(async () => {
    if (originalAuditLog === undefined) {
      delete process.env.APOLLO_AUDIT_LOG;
    } else {
      process.env.APOLLO_AUDIT_LOG = originalAuditLog;
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('registers discovery and read-only annotations for every tool', () => {
    const registered = captureRegisteredTools();

    expect(Object.keys(registered)).toEqual([
      'apollo_search_capabilities',
      'apollo_companies_search',
      'apollo_people_search',
      'apollo_person_enrich',
      'apollo_people_bulk_enrich',
      'apollo_org_enrich',
      'apollo_webhook_result',
      'apollo_credit_usage',
    ]);

    for (const tool of Object.values(registered)) {
      expect(tool.config.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it('searches capability metadata for MCP clients', () => {
    const results = searchCapabilities('enrich phone');

    expect(results.map(result => result.id)).toContain('apollo_person_enrich');
    expect(results[0]?.examples.length).toBeGreaterThan(0);
  });

  it('states credit costs in the descriptions of credit-consuming tools', () => {
    const registered = captureRegisteredTools();

    expect(registered.apollo_companies_search?.config.description).toContain('1 CREDIT');
    expect(registered.apollo_person_enrich?.config.description).toContain('CONSUMES CREDITS');
    expect(registered.apollo_people_bulk_enrich?.config.description).toContain('CONSUMES CREDITS');
    expect(registered.apollo_people_search?.config.description).toContain('no credits');
  });

  it('keeps the policy allowlist explicit about free reads and credit-consuming reads', () => {
    expect(checkToolPolicy('apollo_search_capabilities')).toMatchObject({
      allowed: true,
      reason: 'read-only Apollo tool (no credits)',
    });
    expect(checkToolPolicy('apollo_people_search')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('apollo_webhook_result')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('apollo_credit_usage')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('apollo_companies_search')).toMatchObject({
      allowed: true,
      reason: 'read-only Apollo tool (consumes shared credits)',
    });
    expect(checkToolPolicy('apollo_person_enrich')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('apollo_people_bulk_enrich')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('apollo_org_enrich')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('apollo_create_sequence')).toMatchObject({ allowed: false });
    expect(checkToolPolicy('apollo_update_account')).toMatchObject({ allowed: false });
  });

  it('audits tool calls without writing raw targets or secrets', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'apollo-audit-'));
    const auditPath = join(tempDir, 'audit.jsonl');
    process.env.APOLLO_AUDIT_LOG = auditPath;
    const registered = captureRegisteredTools();

    const discoveryTool = registered.apollo_search_capabilities;
    if (!discoveryTool) {
      throw new Error('apollo_search_capabilities was not registered');
    }

    await discoveryTool.handler({ query: 'company', limit: 5 });

    const auditText = await readFile(auditPath, 'utf8');
    const records = auditText
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      tool: 'apollo_search_capabilities',
      action: 'start',
    });
    expect(records[1]).toMatchObject({
      tool: 'apollo_search_capabilities',
      action: 'finish',
      status: 'ok',
    });
    expect(auditText).not.toContain('company');
    expect(auditText).not.toContain('test-key');
  });
});

function captureRegisteredTools(): Record<
  string,
  {
    config: { annotations?: unknown; description?: string };
    handler: (input: Record<string, unknown>) => Promise<unknown>;
  }
> {
  const registered: Record<
    string,
    {
      config: { annotations?: unknown; description?: string };
      handler: (input: Record<string, unknown>) => Promise<unknown>;
    }
  > = {};
  const server = {
    registerTool: vi.fn((name: string, config: { annotations?: unknown; description?: string }, handler) => {
      registered[name] = { config, handler };
    }),
  };
  const client = new ApolloClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    fetchImpl: vi.fn() as unknown as typeof fetch,
  });

  registerApolloTools(server as never, client);

  return registered;
}
