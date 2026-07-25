/**
 * Unit tests for `extension/spike/src/capture-fallback.ts` -- PURE crop-rect math for the
 * `chrome.tabs.captureVisibleTab` + manual-crop fallback path (spec 01 "What to build" #2 /
 * "Edge cases": "If a blob: URL: does captureVisibleTab + manual crop work as a fallback?").
 *
 * capture-fallback.ts does NOT exist yet at test-writing time. These tests are the contract the
 * coder stage implements against.
 *
 * Expected public API:
 *
 *   export interface Rect { x: number; y: number; width: number; height: number; }
 *   export interface ScrollOffset { x: number; y: number; }
 *
 *   export function computeCaptureCropRect(
 *     elementRect: Rect,
 *     devicePixelRatio: number,
 *     scrollOffset: ScrollOffset
 *   ): Rect;
 *
 * Semantics locked down by this suite (the spec only says "element rect + devicePixelRatio +
 * scroll offsets -> pixel rect", not the exact formula -- this is a genuine design decision, noted
 * here rather than guessed silently per CLAUDE.md working style):
 *
 *   1. `elementRect` is in CSS pixels, as measured by the content script (e.g. via
 *      `getBoundingClientRect()`). `scrollOffset` represents the CSS-pixel scroll delta between
 *      when that rect was measured in the content script and when `captureVisibleTab` actually ran
 *      in the background -- these happen at slightly different times because a message has to
 *      cross the content-script/background boundary in between, and the page could have scrolled
 *      in the meantime.
 *   2. `scrollOffset` is SUBTRACTED from `elementRect`'s x/y position BEFORE any devicePixelRatio
 *      scaling, to re-align the rect with the viewport as it existed at capture time.
 *   3. Only position (x/y) is affected by scrollOffset -- width/height are not, since scrolling
 *      never changes an element's rendered size.
 *   4. `devicePixelRatio` scaling is applied to the WHOLE already-scroll-corrected rect (position
 *      AND size), last, because `captureVisibleTab`'s screenshot bitmap is produced at native
 *      device-pixel resolution, not CSS-pixel resolution.
 *   5. Order matters: subtract scrollOffset, THEN multiply by devicePixelRatio. Doing it in the
 *      other order (scaling elementRect by DPR first, then subtracting an un-scaled CSS-pixel
 *      scrollOffset) silently produces a wrong crop rect whenever DPR != 1 and scrollOffset != 0
 *      at the same time -- this is exactly the bug the combined DPR+scroll test below exists to
 *      catch.
 *
 * Also covers `isRectFullyInViewport(bbox: Rect, viewport: Viewport): boolean` -- added in the
 * background.ts bug-fix pass (see docs/decisions.md) after real-world manual testing surfaced a
 * `captureVisibleTab` crop producing tiny, mostly-blank "successful" captures whenever the target
 * element was scrolled (partially or fully) out of the visible viewport at capture time. Returns
 * true only if bbox's full extent (x >= 0, y >= 0, x+width <= viewport.width,
 * y+height <= viewport.height) is contained within the viewport; boundary-touching rects count as
 * contained (inclusive).
 */
import { describe, expect, it } from "vitest";
import { computeCaptureCropRect, isRectFullyInViewport, type Rect } from "../src/capture-fallback";

describe("computeCaptureCropRect", () => {
  it("returns the element rect unchanged at DPR=1 with no scroll offset", () => {
    const elementRect: Rect = { x: 100, y: 50, width: 300, height: 400 };

    const result = computeCaptureCropRect(elementRect, 1, { x: 0, y: 0 });

    expect(result).toEqual({ x: 100, y: 50, width: 300, height: 400 });
  });

  it("scales all rect fields by devicePixelRatio=2 with no scroll offset", () => {
    const elementRect: Rect = { x: 100, y: 50, width: 300, height: 400 };

    const result = computeCaptureCropRect(elementRect, 2, { x: 0, y: 0 });

    expect(result).toEqual({ x: 200, y: 100, width: 600, height: 800 });
  });

  it("adjusts only position (not size) for a non-zero scroll offset at DPR=1", () => {
    const elementRect: Rect = { x: 100, y: 200, width: 300, height: 400 };

    const result = computeCaptureCropRect(elementRect, 1, { x: 10, y: 20 });

    // Position shifts by exactly the scroll offset; size is untouched by scrolling.
    expect(result).toEqual({ x: 90, y: 180, width: 300, height: 400 });
  });

  it("combines DPR=2 with a non-zero scroll offset in the correct order (subtract-then-scale)", () => {
    const elementRect: Rect = { x: 100, y: 200, width: 300, height: 400 };
    const scrollOffset = { x: 10, y: 20 };
    const devicePixelRatio = 2;

    const result = computeCaptureCropRect(elementRect, devicePixelRatio, scrollOffset);

    // Correct order: subtract scroll offset in CSS px first, THEN scale by DPR.
    //   x: (100 - 10) * 2 = 180, y: (200 - 20) * 2 = 360
    //   width: 300 * 2 = 600, height: 400 * 2 = 800
    const correct: Rect = { x: 180, y: 360, width: 600, height: 800 };

    // The order-of-operations bug this test exists to catch: scaling elementRect by DPR first,
    // then subtracting the CSS-pixel scroll offset WITHOUT also scaling it.
    //   x: 100 * 2 - 10 = 190 (wrong), y: 200 * 2 - 20 = 380 (wrong)
    const wrongOrder: Rect = { x: 190, y: 380, width: 600, height: 800 };

    expect(result).toEqual(correct);
    expect(result).not.toEqual(wrongOrder);
  });

  it("handles a fractional devicePixelRatio (e.g. 1.5, common with Windows display scaling)", () => {
    const elementRect: Rect = { x: 100, y: 200, width: 300, height: 400 };

    const result = computeCaptureCropRect(elementRect, 1.5, { x: 0, y: 0 });

    expect(result.x).toBeCloseTo(150);
    expect(result.y).toBeCloseTo(300);
    expect(result.width).toBeCloseTo(450);
    expect(result.height).toBeCloseTo(600);
  });

  it("handles a negative scroll offset (page scrolled back up since measurement)", () => {
    const elementRect: Rect = { x: 100, y: 200, width: 300, height: 400 };

    const result = computeCaptureCropRect(elementRect, 1, { x: -5, y: -15 });

    expect(result).toEqual({ x: 105, y: 215, width: 300, height: 400 });
  });
});

describe("isRectFullyInViewport", () => {
  it("returns true for a rect fully contained within the viewport", () => {
    const bbox: Rect = { x: 50, y: 50, width: 300, height: 400 };
    const viewport = { width: 1024, height: 768 };

    expect(isRectFullyInViewport(bbox, viewport)).toBe(true);
  });

  it("returns false for a negative-y rect scrolled above the viewport (real bug repro)", () => {
    // Matches the real getBoundingClientRect() reading that exposed the underlying bug:
    // {x: 160.5, y: -356.5, width: 768, height: 1206.3} -- ~356px of the element was scrolled
    // above the top of the viewport at measurement/capture time.
    const bbox: Rect = { x: 160.5, y: -356.5, width: 768, height: 1206.3 };
    const viewport = { width: 1024, height: 768 };

    expect(isRectFullyInViewport(bbox, viewport)).toBe(false);
  });

  it("returns false for a rect extending past the right edge of the viewport", () => {
    const bbox: Rect = { x: 900, y: 50, width: 300, height: 400 };
    const viewport = { width: 1024, height: 768 };

    expect(isRectFullyInViewport(bbox, viewport)).toBe(false);
  });

  it("returns false for a rect extending past the bottom edge of the viewport", () => {
    const bbox: Rect = { x: 50, y: 600, width: 300, height: 400 };
    const viewport = { width: 1024, height: 768 };

    expect(isRectFullyInViewport(bbox, viewport)).toBe(false);
  });

  it("returns true for a rect exactly touching the viewport boundary (inclusive)", () => {
    const bbox: Rect = { x: 724, y: 368, width: 300, height: 400 };
    const viewport = { width: 1024, height: 768 };

    // x + width === viewport.width (1024) and y + height === viewport.height (768) exactly.
    expect(isRectFullyInViewport(bbox, viewport)).toBe(true);
  });
});
