/**
 * Pure crop-rect math for the `chrome.tabs.captureVisibleTab` + manual-crop fallback path. No
 * chrome.* calls here -- just arithmetic, so it's trivially unit-testable.
 *
 * Order of operations (see tests/capture-fallback.test.ts docstring for why this order matters):
 *   1. Subtract scrollOffset from elementRect's x/y (both in CSS px) to re-align the rect with the
 *      viewport as it existed when captureVisibleTab actually ran.
 *   2. THEN scale the whole rect (position AND size) by devicePixelRatio, since the screenshot
 *      bitmap is produced at native device-pixel resolution.
 */
import type { Rect, ScrollOffset } from "./types";

export type { Rect, ScrollOffset };

export function computeCaptureCropRect(
  elementRect: Rect,
  devicePixelRatio: number,
  scrollOffset: ScrollOffset
): Rect {
  const scrollCorrectedX = elementRect.x - scrollOffset.x;
  const scrollCorrectedY = elementRect.y - scrollOffset.y;

  return {
    x: scrollCorrectedX * devicePixelRatio,
    y: scrollCorrectedY * devicePixelRatio,
    width: elementRect.width * devicePixelRatio,
    height: elementRect.height * devicePixelRatio,
  };
}

/** Viewport dimensions in CSS px, as read from `window.innerWidth`/`window.innerHeight`. */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * Returns true only if `bbox`'s full extent is contained within `viewport` (x >= 0, y >= 0,
 * x + width <= viewport.width, y + height <= viewport.height). Boundary-inclusive: a bbox that
 * exactly touches the viewport edge counts as fully contained.
 *
 * Exists because `chrome.tabs.captureVisibleTab` can only ever capture the CURRENTLY visible
 * viewport -- it has no access to content scrolled out of view. Attempting a crop against a bbox
 * that isn't fully in the viewport doesn't error: Canvas silently clips/blanks the missing part,
 * producing a small, mostly-blank, misleadingly-"successful" PNG. This check lets callers refuse
 * the capture attempt up front instead of ever reaching that silent-failure path.
 *
 * Real bug repro that motivated this check: a `getBoundingClientRect()` reading of
 * `{x: 160.5, y: -356.5, width: 768, height: 1206.3}` during manual testing -- the negative `y`
 * meant ~356px of the element was scrolled above the top of the viewport at measurement time.
 */
export function isRectFullyInViewport(bbox: Rect, viewport: Viewport): boolean {
  return (
    bbox.x >= 0 &&
    bbox.y >= 0 &&
    bbox.x + bbox.width <= viewport.width &&
    bbox.y + bbox.height <= viewport.height
  );
}
