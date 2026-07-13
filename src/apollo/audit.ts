import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError } from '../errors.js';

export interface ApolloAuditEvent {
  requestId?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied';
  target?: unknown;
  status?: string;
  retryAfter?: string;
  reason?: string;
  error?: unknown;
}

export async function writeAuditEvent(event: ApolloAuditEvent): Promise<void> {
  const auditPath = process.env.APOLLO_AUDIT_LOG;
  if (!auditPath) {
    return;
  }

  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? randomUUID(),
    tool: event.tool,
    action: event.action,
    targetHash: event.target === undefined ? undefined : hashValue(JSON.stringify(event.target)),
    status: event.status,
    retryAfter: event.retryAfter,
    reason: event.reason,
    error: event.error === undefined ? undefined : formatUnknownError(event.error),
  };

  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
