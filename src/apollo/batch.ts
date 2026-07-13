import { formatUnknownError, ApolloHttpError } from '../errors.js';

export const DEFAULT_BATCH_CONCURRENCY = 4;
export const MAX_BATCH_CONCURRENCY = 8;

export interface BatchItemSuccess<T> {
  index: number;
  ok: true;
  value: T;
}

export interface BatchItemFailure {
  index: number;
  ok: false;
  error: string;
}

export type BatchItemResult<T> = BatchItemSuccess<T> | BatchItemFailure;

export interface RunBatchOptions<T> {
  /** Maximum number of workers run in parallel. Clamped to [1, MAX_BATCH_CONCURRENCY]. */
  concurrency?: number;
  /** Aborts the run; items not yet started resolve to a failure result. */
  signal?: AbortSignal;
  /** Invoked after every item settles, in completion order. */
  onProgress?: (completed: number, total: number, last: BatchItemResult<T>) => void | Promise<void>;
}

/**
 * Runs `worker` over `items` with bounded concurrency. Each item is isolated:
 * a rejected worker becomes a failure result instead of aborting the whole batch.
 * Results are returned in input order regardless of completion order.
 */
export async function runBatch<I, T>(
  items: readonly I[],
  worker: (item: I, index: number) => Promise<T>,
  options: RunBatchOptions<T> = {},
): Promise<BatchItemResult<T>[]> {
  const total = items.length;
  const results = new Array<BatchItemResult<T>>(total);

  if (total === 0) {
    return results;
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_BATCH_CONCURRENCY, total, MAX_BATCH_CONCURRENCY));
  let next = 0;
  let completed = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= total) {
        return;
      }

      if (options.signal?.aborted) {
        results[index] = { index, ok: false, error: 'Batch aborted before this item started.' };
      } else {
        try {
          const value = await worker(items[index] as I, index);
          results[index] = { index, ok: true, value };
        } catch (error) {
          results[index] = { index, ok: false, error: formatUnknownError(error) };
        }
      }

      completed += 1;
      if (options.onProgress) {
        await options.onProgress(completed, total, results[index]);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
}

export interface RateLimitRetryOptions {
  /** Total attempts including the first try. Defaults to 3. */
  maxAttempts?: number;
  /** Upper bound for any single backoff wait, in milliseconds. Defaults to 60s. */
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Math.random-based jitter. */
  jitter?: () => number;
}

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_MAX_DELAY_MS = 60_000;
const FALLBACK_RETRY_DELAY_MS = 2_000;

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wraps an Apollo call so that HTTP 429 responses are retried with jittered
 * backoff, honouring the `retry-after` header (capped) when Apollo sends one.
 * Non-429 errors propagate immediately.
 */
export async function callWithRateLimitRetry<T>(
  thunk: () => Promise<T>,
  options: RateLimitRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS);
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await thunk();
    } catch (error) {
      if (!(error instanceof ApolloHttpError) || error.status !== 429 || attempt >= maxAttempts) {
        throw error;
      }

      if (options.signal?.aborted) {
        throw error;
      }

      const baseDelay = retryAfterMs(error.retryAfter) * attempt;
      const jitteredDelay = baseDelay * (1 + jitter() * 0.25);
      await sleep(Math.min(jitteredDelay, maxDelayMs));
    }
  }
}

function retryAfterMs(retryAfter: string | undefined): number {
  if (!retryAfter) {
    return FALLBACK_RETRY_DELAY_MS;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return FALLBACK_RETRY_DELAY_MS;
}
