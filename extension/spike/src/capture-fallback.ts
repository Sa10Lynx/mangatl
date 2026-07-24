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
