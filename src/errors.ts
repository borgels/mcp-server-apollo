import { redactRegisteredSecrets, truncate } from './upstream-http.js';

export interface ApolloErrorPayload {
  error?: string;
  message?: string;
  error_code?: string | number;
}

const SECRET_PATTERNS = [
  /x-api-key:\s*[^,\s}]+/gi,
  /(apiKey|APOLLO_API_KEY|api_key)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class ApolloHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: ApolloErrorPayload | unknown;
  readonly retryAfter?: string;

  constructor(input: {
    status: number;
    url: string;
    payload?: ApolloErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
  }) {
    super(formatApolloHttpError(input));
    this.name = 'ApolloHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    redactRegisteredSecrets(value),
  );
}

function formatApolloHttpError(input: {
  status: number;
  url: string;
  payload?: ApolloErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}): string {
  const payload = isApolloErrorPayload(input.payload) ? input.payload : undefined;
  const parts = [
    `Apollo API request failed with HTTP ${input.status}`,
    payload?.error_code === undefined ? undefined : `error_code=${payload.error_code}`,
    textField(payload?.error),
    textField(payload?.message),
    input.retryAfter ? `retry-after=${truncate(input.retryAfter, 64)}s` : undefined,
    // Redact before truncating, so a secret is never cut in half and left partly visible.
    input.fallbackMessage === undefined ? undefined : truncate(redactSecrets(input.fallbackMessage.trim())),
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function textField(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  return truncate(redactSecrets(String(value)));
}

function isApolloErrorPayload(value: unknown): value is ApolloErrorPayload {
  return typeof value === 'object' && value !== null;
}

/**
 * An answer from Apollo that failed, as the embedded gateway's client throws it: an HTTP error or a redirect, which is
 * never followed. Our own text, the status and Apollo's request id from a response header (only in the form such ids
 * have); nothing of the body or the Location.
 */
export class ApolloAnswerError extends Error {
  readonly status: number;
  /** Apollo's id for the request, when a response header gives one as a UUID or hex id (never in the message). */
  readonly requestId?: string;

  constructor(message: string, status: number, requestId?: string) {
    super(message);
    this.name = 'ApolloAnswerError';
    this.status = status;
    this.requestId = vendorRequestId(requestId);
  }
}

/** Response headers that carry the vendor's own id for a request, most specific first. */
export const REQUEST_ID_HEADERS: readonly string[] = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'correlation-id',
  'x-amzn-requestid',
  'cf-ray',
];

/**
 * A hex id: one run of hex digits, or groups of at least four hex digits joined by single hyphens (a UUID is one),
 * 8 to 64 characters in all. A name, a sentence or an e-mail address never fits.
 */
const REQUEST_ID_FORM = /^[0-9A-Fa-f]{4,}(?:-[0-9A-Fa-f]{4,})*$/;
/** Six digits and four more: the shape of a personal number. An id that holds it is dropped. */
const PERSONAL_NUMBER_SHAPE = /\d{6}-?\d{4}/;

/** The vendor's request id, only as a UUID or a hex id of 8 to 64 characters, or undefined. */
export function vendorRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length >= 8 && id.length <= 64 && REQUEST_ID_FORM.test(id) && !PERSONAL_NUMBER_SHAPE.test(id) ? id : undefined;
}

/** The vendor's request id from the first of REQUEST_ID_HEADERS a response has in the right form, or undefined. */
export function requestIdFrom(headers: Headers, names: readonly string[] = REQUEST_ID_HEADERS): string | undefined {
  for (const name of names) {
    const id = vendorRequestId(headers.get(name));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Metadata about a failed call, for a host that counts failures: the HTTP status Apollo answered with, its request
 * id, the method and the path template of the request. Never the response body, Apollo's error text, or the input.
 */
export interface FailureMetadata {
  httpStatus: number;
  requestId?: string;
  method?: string;
  pathTemplate?: string;
}

/** The failure metadata of an error: an answer from Apollo that failed (see ApolloAnswerError). */
export function failureMetadata(error: unknown): FailureMetadata | undefined {
  if (!(error instanceof ApolloAnswerError)) return undefined;
  const status = error.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const requestId = vendorRequestId(error.requestId);
  const extra = error as ApolloAnswerError & { method?: string; pathTemplate?: string };
  return {
    httpStatus: status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(typeof extra.method === 'string' ? { method: extra.method } : {}),
    ...(typeof extra.pathTemplate === 'string' ? { pathTemplate: extra.pathTemplate } : {}),
  };
}
