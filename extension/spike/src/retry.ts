/**
 * Simple, pure, dependency-injected "retry while the result isn't usable yet" helper.
 *
 * Built for background.ts's `measureFreshGeometry` re-measurement (see its docstring and
 * docs/decisions.md for the confirmed root cause: a site can preload an `<img>` with a real,
 * valid `naturalWidth`/`naturalHeight` -- so it passes candidate-filter.ts's size checks and gets
 * sent as a `CANDIDATE_FOUND` message -- BEFORE the site's own reactive framework actually reveals
 * that element in layout. A `display:none` (or otherwise not-yet-laid-out) element always reports
 * `getBoundingClientRect()` as a degenerate, near-zero rect regardless of its real eventual size,
 * and our own `IntersectionObserver`-driven scan has no guarantee of firing in lockstep with
 * whenever the SITE's own logic decides to reveal the element), but this module has no
 * `chrome.*`/DOM dependency of its own -- it operates purely on an injected `measure` function, an
 * injected `isUsable` predicate, and an injected `sleep` function, so it is fully unit-testable
 * without real timers or a real measurement (see tests/retry.test.ts).
 *
 * Deliberately generic over both the measured type AND the usability predicate (rather than baking
 * in a degenerate-bbox check directly) so this helper stays reusable for any "retry until some
 * injected condition holds" need, not just this one background.ts call site.
 */

export type SleepFn = (ms: number) => Promise<void>;

export interface RetryWhileDegenerateOptions {
  /** Total number of attempts (including the first), NOT the number of retries. `maxAttempts: 1`
   * means "call `measure` exactly once and return its result immediately, regardless of whether
   * `isUsable` accepts it" -- no retry is possible. */
  maxAttempts: number;
  /** Delay (ms), via the injected `sleep`, between the END of one attempt and the START of the
   * next. Not applied after the final attempt (there is nothing left to wait for). */
  delayMs: number;
  /** Injected delay function -- production code passes a real setTimeout-based sleep; tests inject
   * a fake that resolves immediately while recording the requested duration/call count. */
  sleep: SleepFn;
}

/**
 * Calls `measure()` (a FRESH call every attempt -- never reusing an earlier attempt's result,
 * since the whole point is to let real time pass so a live, external DOM/state change can be
 * observed on the next call) up to `options.maxAttempts` times, stopping as soon as `isUsable`
 * accepts a result. If every attempt is exhausted without ever producing a usable result, returns
 * the LAST attempt's result as-is (never throws on exhaustion -- the caller is expected to have its
 * own existing fallback behavior for a still-unusable result, unchanged by this helper).
 */
export async function retryWhileDegenerate<T>(
  measure: () => Promise<T>,
  isUsable: (result: T) => boolean,
  options: RetryWhileDegenerateOptions
): Promise<T> {
  const { maxAttempts, delayMs, sleep } = options;

  let result = await measure();
  let attempts = 1;

  while (!isUsable(result) && attempts < maxAttempts) {
    await sleep(delayMs);
    result = await measure();
    attempts += 1;
  }

  return result;
}
