import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { failureMetadata, vendorRequestId, type FailureMetadata } from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, KEY_REFUSED, leaksSecret, maskedText, sealedError } from './key-admission.js';
import { redactDeep, redactText } from './redaction.js';
import { writeGatewayAuditEvent } from './apollo/gateway-audit.js';
import { ApolloGatewayClient } from './apollo/gateway-client.js';
import { GATEWAY_TOOLS, type GatewayTool } from './apollo/gateway-tools.js';
import {
  canonicalToolName,
  currentInstancePolicy,
  GatewayConfigError,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type CallContext,
  type InstancePolicy,
  type ResolvedInstancePolicy,
} from './apollo/scope.js';
import { SecretRedactor } from './secret-redactor.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. The tools, their inputs and their answer
 * allowlists live in src/apollo/gateway-tools.ts.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the API key passed to
 * createApolloGateway and reads no APOLLO_* variable at all: not the key
 * (APOLLO_API_KEY), not the address (APOLLO_BASE_URL: the gateway talks to
 * https://api.apollo.io only), not APOLLO_TIMEOUT_MS (30 seconds unless
 * `timeoutMs` is given) and not APOLLO_AUDIT_LOG. Redirects are never
 * followed, and every request is held against the requests its tool
 * declares.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`; without it the instance uses the default policy (no
 * writes, no disabled tools, no audit records).
 *
 * Every call runs in a call scope of its own (AsyncLocalStorage), so a call
 * made from inside another instance's call (from its audit sink or its fetch)
 * never inherits that instance's policy, sink, redactor or caller.
 */

export type { AuditSink, InstancePolicy } from './apollo/scope.js';
export { GatewayConfigError } from './apollo/scope.js';
export { KEY_REFUSED } from './key-admission.js';
export { APOLLO_API_ORIGIN } from './apollo/gateway-client.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status Apollo answered with, its
 * and request id when a response header gives one as a UUID or hex id, and the method and path template of the request. For a host that counts failures without
 * reading their text. Never the response body, Apollo's error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from the upstream API only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
}

/** Who and which request a call belongs to; written to the audit records of the call. */
export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One Apollo API request a tool may make: the method and the path template on https://api.apollo.io. */
export interface GatewayUpstreamOperation {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
}

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /** Every Apollo request the tool may make. Empty for a tool that does not call Apollo. */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). No Apollo gateway tool is broad.
   */
  readonly broad: boolean;
}

export interface ApolloGatewayOptions {
  /** The team's Apollo API key, sent as `x-api-key`. Required; never read from the environment. */
  apiKey: string;
  /** The fetch to use (tests, or a host's own). Redirects are never followed either way. */
  fetchImpl?: typeof fetch;
  /** Time limit per Apollo request in milliseconds. Default 30 seconds; never read from the environment. */
  timeoutMs?: number;
  /**
   * Instance policy from the host. Without it the instance uses the default
   * policy (no writes, no disabled tools, no audit records); it never reads
   * a policy or audit variable from the environment.
   */
  policy?: InstancePolicy;
}

/**
 * JSON Schema for a gateway tool, derived from the same zod schema the call
 * is validated with. `format` and `pattern` are dropped: validators such as
 * Ajv reject unknown formats in strict mode, and zod checks the values when
 * the call runs.
 */
function toJsonSchema(schema: z.ZodType): GatewayJsonObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
      delete (ctx.jsonSchema as Record<string, unknown>).pattern;
    },
  }) as Record<string, unknown>;
  return json as GatewayJsonObject;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/** Strict input schemas: an unknown field is refused, not dropped. */
const SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map(
  GATEWAY_TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, z.strictObject(tool.input)]),
);
const BY_NAME: ReadonlyMap<string, GatewayTool> = new Map(GATEWAY_TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, tool]));
const GATEWAY_TOOL_NAMES: readonly string[] = [...BY_NAME.keys()];

function definition(tool: GatewayTool): GatewayToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabledByDefault: tool.riskLevel === 'read',
    inputSchema: toJsonSchema(SCHEMAS.get(`${TOOL_PREFIX}${tool.name}`)!),
  };
}

/** Every path template a tool declares: the only ones failure metadata may name. */
const KNOWN_PATHS: ReadonlySet<string> = new Set(GATEWAY_TOOLS.flatMap(tool => tool.upstream.map(entry => entry.path)));

/** All gateway tools, as definitions (names without the prefix). */
export const apolloGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(definition);

/**
 * The tool catalog: every gateway tool with its definition, the upstream
 * requests it may make and the broad mark. Generated from the same table as
 * `apolloGatewayTools` and deeply frozen. Hosts can use it to build their own
 * permission model without creating a gateway instance.
 */
export const apolloToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...definition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
  })),
);

/** KEY_REFUSED with every run that shares a piece with any of the secrets masked, so it holds no piece of one. */
function refusedText(field: string, secrets: readonly unknown[]): string {
  return secrets.reduce<string>((text, secret) => maskedText(text, secret), `${field}: ${KEY_REFUSED}`);
}

function requiredKey(options: ApolloGatewayOptions | undefined, given: readonly unknown[]): string {
  const apiKey: unknown = options?.apiKey;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new GatewayConfigError(
      'createApolloGateway requires options.apiKey. Embedded instances do not read credentials from the environment.',
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from it; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(apiKey.trim())) throw new GatewayConfigError(refusedText('options.apiKey', given));
  return apiKey.trim();
}

/** A caller id from the host: redacted before it is cut short, so no part of a secret survives. */
function contextValue(value: unknown, redactor: SecretRedactor): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? redactor.redact(value.trim()).slice(0, 200) : undefined;
}

/**
 * Create one gateway instance. `apiKey` is required and is the only
 * credential the instance uses; a missing or refused key fails here, before
 * anything is built or sent.
 */
export function createApolloGateway(options: ApolloGatewayOptions) {
  let key: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const raw = options as Partial<ApolloGatewayOptions> | undefined;
  const secrets = typeof raw?.apiKey === 'string' ? [raw.apiKey, raw.apiKey.trim()] : [];
  try {
    key = requiredKey(options, secrets);
    guard = new SecretRedactor().addSecret(key);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new GatewayConfigError(refusedText('options', secrets));
    }
    const gateway = buildApolloGateway(options, key, guard);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new GatewayConfigError(refusedText('options', secrets));
    }
    return gateway;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (guard && key !== undefined) {
      message = guard.redact(message);
      if (leaksSecret(message, guard)) message = refusedText('options', secrets);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError), then the sink check on the finished object.
    const final = sealedError(new GatewayConfigError(message), ...secrets);
    if (guard && key !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new GatewayConfigError(refusedText('options', secrets)), ...secrets);
    }
    throw final;
  }
}

function buildApolloGateway(options: ApolloGatewayOptions, apiKey: string, redactor: SecretRedactor) {
  // Only these options are read; anything else a host passes (a base URL, a budget, ...) is dropped.
  const { policy: hostPolicy, fetchImpl, timeoutMs } = options;
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new GatewayConfigError('options.fetchImpl must be a function.');
  }
  // Always a policy: the host's, or the default one. A gateway call never reads policy or audit variables.
  const policy: ResolvedInstancePolicy = resolveInstancePolicy(hostPolicy ?? {}, GATEWAY_TOOL_NAMES);
  let client: ApolloGatewayClient;
  try {
    client = new ApolloGatewayClient({ apiKey, redactor, ...(fetchImpl ? { fetchImpl } : {}), timeoutMs });
  } catch (error) {
    throw new GatewayConfigError(error instanceof Error ? error.message : 'Invalid options.');
  }
  const offeredNames: ReadonlySet<string> = new Set(GATEWAY_TOOL_NAMES.filter(name => !policy.disabledTools.has(name)));
  const offered: readonly GatewayTool[] = GATEWAY_TOOLS.filter(tool => offeredNames.has(`${TOOL_PREFIX}${tool.name}`));

  return {
    /** Tools enabled on this instance (tools the host's policy disables are left out). */
    tools: apolloGatewayTools.filter(tool => !policy.disabledTools.has(canonicalToolName(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      return runInCallScope(
        {
          policy,
          redactor,
          caller: contextValue(context?.caller, redactor),
          // Our own id for the call: the host's request id is its text, and is not written to the audit.
          requestId: randomUUID(),
          offeredTools: offeredNames,
        },
        () =>
          runCall(toolName, input).then(result => {
            // An error result is redacted as a whole, its failure metadata checked again after that.
            const final = result.isError ? withFailureInForm(redactDeep(result, redactor) as GatewayToolResult) : result;
            // The sink check, as the very last step: a result that holds a piece of the key anywhere is withheld whole.
            return leaksSecret(final, redactor) ? withheldResult() : final;
          }),
      );
    },
  };

  async function runCall(toolName: string, input: GatewayJsonObject): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? canonicalToolName(toolName) : '';
      const tool = BY_NAME.get(name);
      const schema = SCHEMAS.get(name);
      if (!tool || !schema) {
        // Neither the audit record nor the answer repeats the name: it is the caller's text, not ours.
        await bestEffortAudit({ tool: UNKNOWN_TOOL, action: 'rejected', reason: 'unsupported tool' });
        return errorResult('Unsupported Apollo gateway tool.');
      }

      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) {
        await bestEffortAudit({ tool: name, action: 'rejected', reason: 'invalid input' });
        return errorResult(redactText(`Invalid input for ${tool.name}: ${z.prettifyError(parsed.error)}`, redactor));
      }
      const values = parsed.data as Record<string, unknown>;

      const denied = policyDenial(name, tool);
      const target = auditTarget(values);
      if (denied) {
        // The refusal stands whether or not the sink takes the record.
        await bestEffortAudit({ tool: name, action: 'policy_denied', target, reason: denied });
        return errorResult(denied);
      }
      // A tool runs only when its start record was accepted. A sink that throws refuses the call with our own fixed
      // text: the sink's error is the host's and is never passed on (it may name the host's own systems).
      try {
        await writeGatewayAuditEvent({ tool: name, action: 'start', target });
      } catch {
        return errorResult(AUDIT_REFUSED);
      }
      let data: unknown;
      try {
        // The tool may make only the requests it declares (src/apollo/gateway-client.ts).
        data = await tool.run(client.forTool(tool.upstream, redactor), values, offered);
      } catch (error) {
        await bestEffortAudit({ tool: name, action: 'error', target, status: 'error', error });
        throw error;
      }
      // The call has happened at Apollo: a sink that fails on the finish record does not turn a completed change into
      // an error, which a caller might retry and so make twice.
      await bestEffortAudit({ tool: name, action: 'finish', target, status: 'ok' });
      // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
      return jsonResult(tool.summary, redactDeep(redactDeep(data, redactor), redactor));
    } catch (error) {
      return errorResult(redactText(error instanceof Error ? error.message : String(error), redactor), failureMetadata(error));
    }
  }
}

/** The text of a call refused because the host's audit sink did not take its start record. */
const AUDIT_REFUSED = 'Refused: the audit record of this call could not be written, so nothing was sent to Apollo.';

/** An audit record after the outcome is decided: a sink that throws changes nothing about the result. */
async function bestEffortAudit(event: Parameters<typeof writeGatewayAuditEvent>[0]): Promise<void> {
  try {
    await writeGatewayAuditEvent(event);
  } catch {
    // The host's sink failed; the outcome stands, and the sink's error is not passed on.
  }
}

/** Why the host's policy refuses a tool, or undefined when it may run. */
function policyDenial(name: string, tool: GatewayTool): string | undefined {
  const policy = currentInstancePolicy()!;
  if (policy.disabledTools.has(name)) return 'This tool is disabled on this instance by the embedding host.';
  if (tool.riskLevel !== 'read' && !policy.enableWrites) {
    return 'Writes are disabled. The embedding host has not enabled writes for this instance.';
  }
  return undefined;
}

/** The ids a call is about (hashed in the audit record). */
function auditTarget(input: Record<string, unknown>): unknown {
  return {
    contactId: input.contactId,
    contactIds: input.contactIds,
    accountId: input.accountId,
    accountIds: input.accountIds,
    dealId: input.dealId,
    taskId: input.taskId,
    sequenceId: input.sequenceId,
  };
}

/** The audit's tool for a call to a tool this gateway does not have. */
const UNKNOWN_TOOL = 'unknown_tool';

/** One gateway instance, as returned by createApolloGateway. */
export type ApolloGateway = ReturnType<typeof createApolloGateway>;

/**
 * The summary, then the same (already redacted) data as compact JSON in the text block, as the MCP spec asks of a
 * tool that returns structured content: many clients read only the text. The text holds exactly
 * `structuredContent`, and the sink check in callTool covers it.
 */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue;
  return {
    content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return { isError: true, content: [{ type: 'text', text }], ...(failure ? { failure } : {}) };
}

/**
 * The failure metadata as it must be after redaction: on an error result only, a status of 100-599 and a request id
 * still in the form of one (redaction can have changed it). Anything else is dropped, never passed on.
 */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, ...rest } = result;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const status = failure.httpStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return rest;
  const requestId = vendorRequestId(failure.requestId);
  const method = ['GET', 'POST', 'PATCH'].includes(String(failure.method)) ? failure.method : undefined;
  const pathTemplate = typeof failure.pathTemplate === 'string' && KNOWN_PATHS.has(failure.pathTemplate) ? failure.pathTemplate : undefined;
  return {
    ...rest,
    failure: {
      httpStatus: status,
      ...(requestId === undefined ? {} : { requestId }),
      ...(method === undefined ? {} : { method }),
      ...(pathTemplate === undefined ? {} : { pathTemplate }),
    },
  };
}
