/**
 * Simple, pure, dependency-injected rate limiter/scheduler for async tasks.
 *
 * Built to keep `chrome.tabs.captureVisibleTab` calls (see background.ts) under Chrome's
 * per-second quota (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`, hit almost immediately during
 * manual testing on an image-heavy page), but this module has no `chrome.*` dependency of its
 * own -- it operates purely on injected `() => Promise<T>` tasks and an injected `sleep` function,
 * so it is fully unit-testable without real timers (see tests/rate-limiter.test.ts).
 *
 * Two responsibilities:
 *   1. Serialize scheduled tasks so only one ever runs at a time, with at least `minDelayMs`
 *      milliseconds between the START of consecutive tasks (no delay before the very first task).
 *   2. Retry-once-on-quota-error: if a task throws an error whose message matches
 *      `quotaErrorPattern`, wait `retryDelayMs` extra and retry that SAME task exactly once. Any
 *      other thrown error -- or a second quota error on the retry itself -- propagates to the
 *      caller immediately. This is deliberately not an unbounded retry loop.
 */

export type Task<T> = () => Promise<T>;
export type SleepFn = (ms: number) => Promise<void>;

/**
 * Matches Chrome's real captureVisibleTab quota-exceeded error message
 * (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`), plus a more general "exceeds ... quota" phrasing
 * as a fallback in case the exact wording differs across Chrome versions. This is NOT a verified
 * exhaustive list of every way Chrome might phrase a quota error -- just the one actually observed
 * during manual testing, plus a reasonable generalization.
 */
export const DEFAULT_QUOTA_ERROR_PATTERN = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|exceeds.*quota/i;

export interface RateLimiterOptions {
  /** Minimum delay (ms) enforced between the START of consecutive tasks. No delay is applied
   * before the very first scheduled task. */
  minDelayMs: number;
  /** Injected delay function -- production code passes a real setTimeout-based sleep; tests
   * inject a fake that resolves immediately while recording the requested duration/call count. */
  sleep: SleepFn;
  /** Extra backoff delay (ms) applied before the single retry attempt after a quota-exceeded
   * error. Defaults to 1000ms. */
  retryDelayMs?: number;
  /** Pattern used to recognize a thrown error's message as quota-exceeded (retry-worthy) rather
   * than any other failure (which is never retried). Defaults to DEFAULT_QUOTA_ERROR_PATTERN. */
  quotaErrorPattern?: RegExp;
}

export class RateLimiter {
  private readonly minDelayMs: number;
  private readonly sleep: SleepFn;
  private readonly retryDelayMs: number;
  private readonly quotaErrorPattern: RegExp;

  private tail: Promise<void> = Promise.resolve();
  private hasRunFirstTask = false;

  constructor(options: RateLimiterOptions) {
    this.minDelayMs = options.minDelayMs;
    this.sleep = options.sleep;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.quotaErrorPattern = options.quotaErrorPattern ?? DEFAULT_QUOTA_ERROR_PATTERN;
  }

  /**
   * Enqueues `task`, running it only once every previously-scheduled task has finished (so only
   * one task is ever in flight at a time) and, if this isn't the very first task run by this
   * limiter, only after `minDelayMs` has elapsed. Resolves/rejects with that task's own outcome
   * (after the retry-on-quota-error handling documented above). A rejection from one task never
   * blocks later-scheduled tasks from eventually running.
   */
  schedule<T>(task: Task<T>): Promise<T> {
    const runPromise = this.tail.then(() => this.runOne(task));
    // Detach the queue's internal tail from this call's own result: a rejection must not stop
    // LATER-scheduled tasks from ever running.
    this.tail = runPromise.then(
      () => undefined,
      () => undefined
    );
    return runPromise;
  }

  private async runOne<T>(task: Task<T>): Promise<T> {
    if (this.hasRunFirstTask) {
      await this.sleep(this.minDelayMs);
    }
    this.hasRunFirstTask = true;

    try {
      return await task();
    } catch (err) {
      if (!this.isQuotaError(err)) {
        throw err;
      }
      await this.sleep(this.retryDelayMs);
      // Exactly one retry: if this second attempt also throws, it propagates directly, uncaught.
      return await task();
    }
  }

  private isQuotaError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return this.quotaErrorPattern.test(message);
  }
}
