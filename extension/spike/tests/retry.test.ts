/**
 * Unit tests for `extension/spike/src/retry.ts` -- a PURE, dependency-injected "retry while the
 * result isn't usable yet" helper, added in a background.ts bug-fix pass (see README.md /
 * docs/decisions.md for the manual-testing repro this exists to fix: `measureFreshGeometry` can
 * catch a candidate `<img>` mid-transition -- still reporting a degenerate bbox -- moments before
 * the exact same element measures correctly, because the site's own reactive framework reveals it
 * asynchronously).
 *
 * No real timers, no chrome.* / DOM dependency here -- `measure`, `isUsable`, and `sleep` are all
 * injected so this suite can assert on call count/order/duration without ever actually waiting or
 * touching a real element.
 *
 * Expected public API:
 *
 *   export type SleepFn = (ms: number) => Promise<void>;
 *
 *   export interface RetryWhileDegenerateOptions {
 *     maxAttempts: number;
 *     delayMs: number;
 *     sleep: SleepFn;
 *   }
 *
 *   export function retryWhileDegenerate<T>(
 *     measure: () => Promise<T>,
 *     isUsable: (result: T) => boolean,
 *     options: RetryWhileDegenerateOptions
 *   ): Promise<T>;
 *
 * Semantics locked down by this suite:
 *   1. Succeeds on the first attempt: `measure` is called once, `sleep` is never called.
 *   2. Succeeds on a later attempt after some degenerate ones: `measure` is called once per
 *      attempt (a FRESH call each time, not a cached reuse), `sleep` is called once per gap
 *      (attempts - 1 times) with `delayMs`.
 *   3. Never succeeds within `maxAttempts`: returns the LAST attempt's result without throwing;
 *      `measure` is called exactly `maxAttempts` times; `sleep` is called `maxAttempts - 1` times
 *      (never after the final attempt).
 *   4. `maxAttempts: 1` edge case: no retries are possible -- the first result is returned
 *      immediately regardless of what `isUsable` says, and `sleep` is never called.
 */
import { describe, expect, it, vi } from "vitest";
import { retryWhileDegenerate } from "../src/retry";

function makeFakeSleep() {
  return vi.fn(async (_ms: number) => undefined);
}

describe("retryWhileDegenerate", () => {
  it("succeeds on the first attempt: measure is called once, sleep is never called", async () => {
    const sleep = makeFakeSleep();
    const measure = vi.fn(async () => "usable");

    const result = await retryWhileDegenerate(measure, (r) => r === "usable", {
      maxAttempts: 3,
      delayMs: 200,
      sleep,
    });

    expect(result).toBe("usable");
    expect(measure).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("succeeds on a later attempt after some degenerate ones: retries with the right delay", async () => {
    const sleep = makeFakeSleep();
    let calls = 0;
    const measure = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? "degenerate" : "usable";
    });

    const result = await retryWhileDegenerate(measure, (r) => r === "usable", {
      maxAttempts: 5,
      delayMs: 200,
      sleep,
    });

    expect(result).toBe("usable");
    expect(measure).toHaveBeenCalledTimes(3); // 2 degenerate + 1 usable, each a fresh call
    expect(sleep).toHaveBeenCalledTimes(2); // one gap before attempt 2, one before attempt 3
    expect(sleep).toHaveBeenNthCalledWith(1, 200);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it("never succeeds within maxAttempts: returns the LAST result without throwing, sleep called maxAttempts-1 times", async () => {
    const sleep = makeFakeSleep();
    const measure = vi.fn(async () => "always-degenerate");

    const result = await retryWhileDegenerate(measure, () => false, {
      maxAttempts: 3,
      delayMs: 200,
      sleep,
    });

    expect(result).toBe("always-degenerate");
    expect(measure).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // NOT 3 -- no sleep after the final, exhausted attempt
  });

  it("maxAttempts=1 edge case: no retries possible, first result returned immediately regardless of usability", async () => {
    const sleep = makeFakeSleep();
    const measure = vi.fn(async () => "degenerate");

    const result = await retryWhileDegenerate(measure, () => false, {
      maxAttempts: 1,
      delayMs: 200,
      sleep,
    });

    expect(result).toBe("degenerate");
    expect(measure).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("calls measure fresh each attempt rather than reusing a cached first result", async () => {
    const sleep = makeFakeSleep();
    const results = ["first", "second", "third"];
    let index = 0;
    const measure = vi.fn(async () => results[index++]);

    const result = await retryWhileDegenerate(measure, (r) => r === "third", {
      maxAttempts: 3,
      delayMs: 200,
      sleep,
    });

    expect(result).toBe("third");
    expect(measure).toHaveBeenCalledTimes(3);
  });
});
