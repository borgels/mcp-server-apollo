import { describe, expect, it, vi } from 'vitest';
import {
  callWithRateLimitRetry,
  runBatch,
  type BatchItemResult,
} from '../src/apollo/batch.js';
import { ApolloHttpError } from '../src/errors.js';

describe('runBatch', () => {
  it('returns results in input order and isolates per-item failures', async () => {
    const results = await runBatch([1, 2, 3, 4], async value => {
      if (value === 3) {
        throw new Error('boom');
      }
      return value * 10;
    });

    expect(results).toEqual([
      { index: 0, ok: true, value: 10 },
      { index: 1, ok: true, value: 20 },
      { index: 2, ok: false, error: 'boom' },
      { index: 3, ok: true, value: 40 },
    ]);
  });

  it('never exceeds the requested concurrency', async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    const items = Array.from({ length: 6 }, (_, i) => i);
    const pending = runBatch(
      items,
      () => {
        active += 1;
        peak = Math.max(peak, active);
        return new Promise<number>(resolve => {
          release.push(() => {
            active -= 1;
            resolve(1);
          });
        });
      },
      { concurrency: 2 },
    );

    // Drain the queued workers until the batch settles.
    while (release.length > 0 || active > 0) {
      const next = release.shift();
      if (next) {
        next();
      }
      await Promise.resolve();
    }

    await pending;
    expect(peak).toBe(2);
  });

  it('reports progress in completion order', async () => {
    const seen: Array<{ completed: number; total: number; ok: boolean }> = [];

    await runBatch([1, 2], async value => value, {
      concurrency: 1,
      onProgress: (completed, total, last) => {
        seen.push({ completed, total, ok: last.ok });
      },
    });

    expect(seen).toEqual([
      { completed: 1, total: 2, ok: true },
      { completed: 2, total: 2, ok: true },
    ]);
  });

  it('marks items as failed when the signal is already aborted', async () => {
    const worker = vi.fn(async (value: number) => value);
    const controller = new AbortController();
    controller.abort();

    const results = (await runBatch([1, 2], worker, {
      signal: controller.signal,
    })) as BatchItemResult<number>[];

    expect(worker).not.toHaveBeenCalled();
    expect(results.every(result => !result.ok)).toBe(true);
  });
});

describe('callWithRateLimitRetry', () => {
  it('retries HTTP 429 honouring retry-after, then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;

    const value = await callWithRateLimitRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new ApolloHttpError({ status: 429, url: 'https://example.test', retryAfter: '2' });
        }
        return 'ok';
      },
      { sleep, jitter: () => 0 },
    );

    expect(value).toBe('ok');
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('applies jitter and escalates the delay per attempt', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;

    await callWithRateLimitRetry(
      async () => {
        calls += 1;
        if (calls <= 2) {
          throw new ApolloHttpError({ status: 429, url: 'https://example.test', retryAfter: '2' });
        }
        return 'ok';
      },
      { sleep, jitter: () => 1, maxAttempts: 3 },
    );

    // attempt 1: 2000 * 1 * 1.25 = 2500; attempt 2: 2000 * 2 * 1.25 = 5000
    expect(sleep).toHaveBeenNthCalledWith(1, 2_500);
    expect(sleep).toHaveBeenNthCalledWith(2, 5_000);
  });

  it('caps the backoff delay at maxDelayMs', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;

    await callWithRateLimitRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new ApolloHttpError({ status: 429, url: 'https://example.test', retryAfter: '999' });
        }
        return 'ok';
      },
      { sleep, jitter: () => 0, maxDelayMs: 5_000 },
    );

    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('gives up after maxAttempts and rethrows the 429', async () => {
    const sleep = vi.fn(async () => {});
    const thunk = vi.fn(async () => {
      throw new ApolloHttpError({ status: 429, url: 'https://example.test', retryAfter: '1' });
    });

    await expect(
      callWithRateLimitRetry(thunk, { sleep, jitter: () => 0, maxAttempts: 2 }),
    ).rejects.toBeInstanceOf(ApolloHttpError);
    expect(thunk).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-429 errors', async () => {
    const sleep = vi.fn(async () => {});
    const thunk = vi.fn(async () => {
      throw new ApolloHttpError({ status: 404, url: 'https://example.test' });
    });

    await expect(callWithRateLimitRetry(thunk, { sleep })).rejects.toBeInstanceOf(ApolloHttpError);
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
