import { ApolloAnswerError, requestIdFrom } from '../errors.js';
import type { SecretRedactor } from '../secret-redactor.js';
import type { QueryValue } from './client.js';

/**
 * The client of the embedded gateway (src/gateway.ts). Unlike ApolloClient
 * (the MCP server's), it reads no APOLLO_* variable: the key and the time
 * limit come from the host only, the address is fixed (APOLLO_API_ORIGIN),
 * the key goes to the instance's redactor instead of the process-wide
 * registry, redirects are never followed, the body of an error answer is
 * never read, and an answer that is not JSON is refused.
 *
 * Every request is held against the tool's declared upstream requests
 * (forTool): a method and path the tool did not declare is refused before
 * anything is sent.
 */

/** The only address an embedded client talks to. */
export const APOLLO_API_ORIGIN = 'https://api.apollo.io';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export type GatewayMethod = 'GET' | 'POST' | 'PATCH';

export interface GatewayUpstream {
  readonly method: GatewayMethod;
  /** A path on https://api.apollo.io; a `{name}` segment stands for one id. */
  readonly path: string;
}

/** Our own guidance per HTTP status. */
const STATUS_HINTS: Record<number, string> = {
  400: 'Apollo refused the values. Check the ids and values.',
  401: 'Apollo rejected the API key (invalid or deleted). Retrying will not help.',
  403: 'The Apollo API key has no access to this endpoint (a master key reaches every endpoint), or the plan does not include it. Retrying will not help.',
  404: 'Apollo found nothing with this id. Check the ids.',
  422: 'Apollo refused the values. Check the ids and values.',
  429: 'Apollo is throttling requests for this key. Wait and retry later.',
};

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** An HTTP error from Apollo in our own words: the status, our hint and a retry-after; never Apollo's body. */
export class ApolloGatewayHttpError extends ApolloAnswerError {
  readonly method: string;
  readonly pathTemplate?: string;

  constructor(status: number, method: string, pathTemplate: string | undefined, retryAfter?: string, requestId?: string) {
    const hint = Object.hasOwn(STATUS_HINTS, status) ? ` ${STATUS_HINTS[status]}` : '';
    const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : '';
    super(`Apollo API request failed with HTTP ${status} (${method}).${hint}${wait}`, status, requestId);
    this.name = 'ApolloHttpError';
    this.method = method;
    this.pathTemplate = pathTemplate;
  }
}

export interface ApolloGatewayClientOptions {
  apiKey: string;
  redactor: SecretRedactor;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Whether a concrete path fits a template whose `{name}` segments stand for one non-empty segment. */
export function pathFits(template: string, path: string): boolean {
  const want = template.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return false;
  return want.every((segment, index) =>
    /^\{\w+\}$/.test(segment) ? (got[index] ?? '') !== '' : segment === got[index],
  );
}

export class ApolloGatewayClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  private readonly allowed?: readonly GatewayUpstream[];

  constructor(options: ApolloGatewayClientOptions, allowed?: readonly GatewayUpstream[]) {
    this.apiKey = options.apiKey;
    options.redactor.addSecret(this.apiKey);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowed = allowed;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }
  }

  /** A view of this client that may make only the given requests. */
  forTool(allowed: readonly GatewayUpstream[], redactor: SecretRedactor): ApolloGatewayClient {
    return new ApolloGatewayClient(
      { apiKey: this.apiKey, redactor, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs },
      allowed,
    );
  }

  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('POST', path, query, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, undefined, body);
  }

  /** The URL of a path under /api/v1/ on the fixed address. Arrays repeat under a `key[]` name. */
  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    if (!path.startsWith('/api/v1/')) {
      throw new Error('Refusing to call a path outside /api/v1/.');
    }
    const url = new URL(`${APOLLO_API_ORIGIN}${path}`);
    if (url.origin !== APOLLO_API_ORIGIN || url.pathname !== path) {
      throw new Error('Refusing to call a path outside /api/v1/.');
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        const arrayKey = key.endsWith('[]') ? key : `${key}[]`;
        for (const item of value) url.searchParams.append(arrayKey, String(item));
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** The declared request a call fits, or undefined when none is declared (an unscoped client). */
  private templateFor(method: GatewayMethod, path: string): string | undefined {
    if (this.allowed === undefined) return undefined;
    const match = this.allowed.find(entry => entry.method === method && pathFits(entry.path, path));
    if (!match) {
      throw new Error(`Refused: the tool did not declare a ${method} request to this Apollo path.`);
    }
    return match.path;
  }

  private async request<T>(
    method: GatewayMethod,
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
  ): Promise<T> {
    const template = this.templateFor(method, path);
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      'x-api-key': this.apiKey,
    };
    const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw this.transportError(method, error);
    }

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await discard(response);
      const error = new ApolloGatewayHttpError(response.status, method, template, undefined, requestIdFrom(response.headers));
      error.message = `Apollo API responded with a redirect (HTTP ${response.status}) for ${method}; redirects are not followed.`;
      throw error;
    }
    if (!response.ok) {
      // The body is never read: Apollo's text never becomes part of an error.
      await discard(response);
      throw new ApolloGatewayHttpError(
        response.status,
        method,
        template,
        wholeNumber(response.headers.get('retry-after')),
        requestIdFrom(response.headers),
      );
    }

    let read: { bytes: Uint8Array; exceeded: boolean };
    try {
      read = await readUpTo(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw this.transportError(method, error);
    }
    if (read.exceeded) {
      throw new Error(`The Apollo answer exceeds the ${MAX_RESPONSE_BYTES} byte limit (${method}).`);
    }
    const text = new TextDecoder().decode(read.bytes);
    if (!text.trim()) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Apollo answered with something that is not JSON (${method}); nothing of it is passed on.`);
    }
  }

  /** A network failure or timeout in our own words: no cause text, only a code from a fixed list. */
  private transportError(method: string, error: unknown): Error {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return Object.assign(new Error(`Apollo API request timed out after ${this.timeoutMs} ms (${method}).`), {
        name: 'TimeoutError',
      });
    }
    const shown = causeCodes(error).find(code => SHOWN_NETWORK_CODES.has(code));
    return new Error(`Network error calling the Apollo API (${method})${shown ? ` (${shown})` : ''}.`);
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/** A header value that is a whole number of at most 9 digits; anything else is dropped. */
function wholeNumber(value: string | null): string | undefined {
  return value !== null && /^\d{1,9}$/.test(value.trim()) ? value.trim() : undefined;
}

async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), exceeded: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}
