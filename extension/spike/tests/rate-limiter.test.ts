/**
 * Unit tests for `extension/spike/src/rate-limiter.ts` -- a PURE, dependency-injected rate
 * limiter/scheduler used to serialize `chrome.tabs.captureVisibleTab` calls in background.ts and
 * respect Chrome's per-second quota (background.ts bug-fix pass, see README.md /
 * docs/decisions.md for the manual-testing repro: `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` was
 * hit almost immediately on an image-heavy page with zero throttling).
 *
 * No real timers, no chrome.* dependency here -- `sleep` is injected so this suite can assert on
 * call count/duration without ever actually waiting.
 *
 * Expected public API:
 *
 *   export type Task<T> = () => Promise<T>;
 *   export type SleepFn = (ms: number) => Promise<void>;
 *   export const DEFAULT_QUOTA_ERROR_PATTERN: RegExp;
 *
 *   export interface RateLimiterOptions {
 *     minDelayMs: number;
 *     sleep: SleepFn;
 *     retryDelayMs?: number; // default 1000
 *     quotaErrorPattern?: RegExp; // default DEFAULT_QUOTA_ERROR_PATTERN
 *   }
 *
 *   export class RateLimiter {
 *     constructor(options: RateLimiterOptions);
 *     schedule<T>(task: Task<T>): Promise<T>;
 *   }
 *
 * Semantics locked down by this suite:
 *   1. Tasks run strictly one at a time, in the order they were scheduled.
 *   2. `sleep(minDelayMs)` is called between each pair of consecutive tasks -- but NOT before the
 *      very first task (no reason to delay a lone/first call).
 *   3. If a task throws an error whose message matches the quota-error pattern, the limiter waits
 *      `retryDelayMs` and retries that same task exactly once; a second failure (quota or not)
 *      propagates as-is. A non-quota error never triggers a retry.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_QUOTA_ERROR_PATTERN, RateLimiter } from "../src/rate-limiter";

function makeFakeSleep() {
  return vi.fn(async (_ms: number) => undefined);
}

describe("RateLimiter -- serializes tasks with a minimum delay between starts", () => {
  it("runs a single scheduled task and resolves with its result, without ever calling sleep", async () => {
    const sleep = makeFakeSleep();
    const limiter = new RateLimiter({ minDelayMs: 600, sleep });

    const result = await limiter.schedule(async () => "ok");

    expect(result).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("calls sleep with minDelayMs between each pair of consecutive tasks, not before the first", async () => {
    const sleep = makeFakeSleep();
    const limiter = new RateLimiter({ minDelayMs: 600, sleep });
    const order: number[] = [];

    const results = await Promise.all([
      limiter.schedule(async () => {
        order.push(1);
        return 1;
      }),
      limiter.schedule(async () => {
        order.push(2);
        return 2;
      }),
      limiter.schedule(async () => {
        order.push(3);
        return 3;
      }),
    ]);

    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]); // strictly one at a time, in schedule order
    expect(sleep).toHaveBeenCalledTimes(2); // one gap before task 2, one before task 3
    expect(sleep).toHaveBeenNthCalledWith(1, 600);
    expect(sleep).toHaveBeenNthCalledWith(2, 600);
  });

  it("does not start a later task until an earlier one has fully resolved", async () => {
    const sleep = makeFakeSleep();
    const limiter = new RateLimiter({ minDelayMs: 600, sleep });

    let firstResolved = false;
    const first = limiter.schedule(async () => {
      await Promise.resolve();
      firstResolved = true;
      return "first";
    });
    const second = limiter.schedule(async () => {
      expect(firstResolved).toBe(true);
      return "second";
    });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });
});

describe("RateLimiter -- quota-error retry", () => {
  it("retries exactly once after a quota-exceeded error, then returns the success value", async () => {
    const sleep = makeFakeSleep();
    const limiter = new RateLimiter({ minDelayMs: 600, sleep, retryDelayMs: 1000 });

    let attempts = 0;
    const task = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded");
      }
      return "recovered";
    });

    const result = await limiter.schedule(task);

    expect(result).toBe("recovered");
    expect(task).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("gives up after exactly one retry (not an infinite loop) when the quota error keeps happening", async () => {
    const sleep = makeFakeSleep();
    const limiter = new RateLimiter({ minDelayMs: 600, sleep, retryDelayMs: 1000 });

    const quotaError = new Error("exceeds captureVisibleTab quota");
    const task = vi.fn(async () => {
      throw quotaError;
    });

    await expect(limiter.schedule(task)).rejects.toBe(quotaError);
    expect(task).toHaveBeenCalledTimes(2); // initial attempt + exactly one retry, then give up
  });

  it("does not retry a non-quota error -- it fails immediately", async () => {
    const sleep = makeFakeSleep();
    const limiter = new RateLimiter({ minDelayMs: 600, sleep, retryDelayMs: 1000 });

    const plainError = new Error("some unrelated failure");
    const task = vi.fn(async () => {
      throw plainError;
    });

    await expect(limiter.schedule(task)).rejects.toBe(plainError);
    expect(task).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("DEFAULT_QUOTA_ERROR_PATTERN matches Chrome's real quota message and a general 'exceeds quota' phrasing, but not unrelated errors", () => {
    expect(DEFAULT_QUOTA_ERROR_PATTERN.test("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")).toBe(true);
    expect(DEFAULT_QUOTA_ERROR_PATTERN.test("Error: exceeds quota")).toBe(true);
    expect(DEFAULT_QUOTA_ERROR_PATTERN.test("some unrelated failure")).toBe(false);
  });
});
