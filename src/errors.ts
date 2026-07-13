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
    value,
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
    payload?.error,
    payload?.message,
    input.retryAfter ? `retry-after=${input.retryAfter}s` : undefined,
    input.fallbackMessage,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function isApolloErrorPayload(value: unknown): value is ApolloErrorPayload {
  return typeof value === 'object' && value !== null;
}
