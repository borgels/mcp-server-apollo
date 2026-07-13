import { ApolloHttpError } from '../errors.js';

export interface ApolloClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<string | number | boolean>;

/**
 * Rate-limit telemetry captured from the most recent Apollo response.
 * Apollo reports per-minute/hourly/daily quotas in x-* response headers.
 */
export type RateLimitSnapshot = Record<string, string>;

const RATE_LIMIT_HEADER_PATTERN = /^x-(rate-limit|minute|hourly|daily|24-hour)/i;

export class ApolloClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private lastRateLimit: RateLimitSnapshot = {};

  constructor(options: ApolloClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.APOLLO_API_KEY;
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ?? process.env.APOLLO_BASE_URL ?? 'https://api.apollo.io',
    );
    assertSafeBaseUrl(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.APOLLO_TIMEOUT_MS ?? 30_000);
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  async post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('POST', path, query, body);
  }

  /** Headers captured from the most recent Apollo response (x-rate-limit-* etc.). */
  rateLimitSnapshot(): RateLimitSnapshot {
    return { ...this.lastRateLimit };
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);

    // Apollo documents all search/match parameters as query strings, even on
    // POST. Array parameters repeat under a `key[]` name.
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }

      if (Array.isArray(value)) {
        const arrayKey = key.endsWith('[]') ? key : `${key}[]`;
        for (const item of value) {
          url.searchParams.append(arrayKey, String(item));
        }
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
  ): Promise<T> {
    if (!this.apiKey) {
      throw new Error('Missing APOLLO_API_KEY. Set it in the MCP server environment.');
    }

    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      'x-api-key': this.apiKey,
    };

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    this.captureRateLimitHeaders(response);

    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw new ApolloHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof responseBody === 'string' ? responseBody : undefined,
      });
    }

    return responseBody as T;
  }

  private captureRateLimitHeaders(response: Response): void {
    const snapshot: RateLimitSnapshot = {};
    response.headers.forEach((value, key) => {
      if (RATE_LIMIT_HEADER_PATTERN.test(key)) {
        snapshot[key.toLowerCase()] = value;
      }
    });

    if (Object.keys(snapshot).length > 0) {
      this.lastRateLimit = snapshot;
    }
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`APOLLO_BASE_URL is not a valid URL: ${baseUrl}`);
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    `Refusing to send the Apollo API key over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
