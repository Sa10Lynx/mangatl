/**
 * Unit tests for `extension/spike/src/types.ts`'s one small pure runtime helper: `isDegenerateBbox`
 * (plus its `MIN_VALID_BBOX_DIMENSION_PX` floor).
 *
 * Added in a content-script.ts bug-fix pass (see docs/decisions.md): real-world manual testing found
 * that some sites virtualize/collapse off-screen list items to zero size while still preloading
 * their `<img>`'s image data, so content-script.ts's initial DOM scan can report a real, valid image
 * URL alongside a degenerate `{width: 0, height: 0}`-ish bbox. `sendCandidate`'s dedup guard
 * (`emittedUrls`) used to add every reported URL to its dedup set unconditionally, including these
 * degenerate-bbox reports -- permanently blocking a later, corrected report for the same URL once
 * `watchForLazyLoadedImages`'s `IntersectionObserver` re-measured a fresh, valid bbox as the element
 * actually scrolled into view. `isDegenerateBbox` is the fix's pure predicate: `sendCandidate` only
 * adds a URL to `emittedUrls` when its bbox is NOT degenerate.
 *
 * Lives in tests/types.test.ts (rather than tests/content-script.test.ts) because the helper itself
 * lives in src/types.ts -- see that file's docstring for why: content-script.ts calls `run()`
 * unconditionally at module load (touching `window`/`document`/`chrome`), which would crash if
 * imported into this suite's Node, non-jsdom test environment (see vitest.config.ts).
 */
import { describe, expect, it } from "vitest";
import { isDegenerateBbox, MIN_VALID_BBOX_DIMENSION_PX, type Rect } from "../src/types";

describe("isDegenerateBbox", () => {
  it("is not degenerate for a normal real-world bbox (768x1206)", () => {
    const bbox: Rect = { x: 160.5, y: 40, width: 768, height: 1206 };

    expect(isDegenerateBbox(bbox)).toBe(false);
  });

  it("is degenerate for an exactly-zero bbox (the real bug repro: a virtualized list item collapsed to zero size)", () => {
    const bbox: Rect = { x: 0, y: 0, width: 0, height: 0 };

    expect(isDegenerateBbox(bbox)).toBe(true);
  });

  it("is degenerate when width is zero but height is non-zero", () => {
    const bbox: Rect = { x: 0, y: 0, width: 0, height: 500 };

    expect(isDegenerateBbox(bbox)).toBe(true);
  });

  it("is degenerate when height is zero but width is non-zero", () => {
    const bbox: Rect = { x: 0, y: 0, width: 500, height: 0 };

    expect(isDegenerateBbox(bbox)).toBe(true);
  });

  it("treats a bbox exactly AT the default minDimension threshold (10) as NOT degenerate (inclusive boundary)", () => {
    const bbox: Rect = { x: 0, y: 0, width: 10, height: 10 };

    // Boundary semantics deliberately match background.ts's MIN_CROP_DIMENSION_PX check
    // (`< minDimension`, not `<=`): exactly-at-the-floor counts as valid, not degenerate.
    expect(isDegenerateBbox(bbox)).toBe(false);
  });

  it("is degenerate for a bbox one pixel below the default threshold (9, with the other dimension large)", () => {
    const bbox: Rect = { x: 0, y: 0, width: 9, height: 500 };

    expect(isDegenerateBbox(bbox)).toBe(true);
  });

  it("is not degenerate for a bbox just above the default threshold (11x11)", () => {
    const bbox: Rect = { x: 0, y: 0, width: 11, height: 11 };

    expect(isDegenerateBbox(bbox)).toBe(false);
  });

  it("respects a custom minDimension argument instead of the default floor", () => {
    const bbox: Rect = { x: 0, y: 0, width: 15, height: 500 };

    // Below the default floor (10) this would be non-degenerate, but a custom, higher minDimension
    // makes the same bbox degenerate.
    expect(isDegenerateBbox(bbox)).toBe(false);
    expect(isDegenerateBbox(bbox, 20)).toBe(true);
  });

  it("exposes MIN_VALID_BBOX_DIMENSION_PX as 10, matching background.ts's MIN_CROP_DIMENSION_PX value", () => {
    expect(MIN_VALID_BBOX_DIMENSION_PX).toBe(10);
  });
});
