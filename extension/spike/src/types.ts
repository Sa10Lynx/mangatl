/**
 * Shared types for the spec 01 image-acquisition spike.
 *
 * These are re-exported (type-only) from the individual modules whose test files declare them
 * (candidate-filter.ts, message-guard.ts, capture-fallback.ts), so each module's public API still
 * exposes exactly the type names its own test file imports, while the actual shape is defined once
 * here to avoid drift between candidate-filter's ImageDescriptor and message-guard's ImageDescriptor,
 * and between capture-fallback's Rect and message-guard's Rect.
 *
 * This file also carries one small pure RUNTIME helper, `isDegenerateBbox` (plus its
 * `MIN_VALID_BBOX_DIMENSION_PX` floor) -- added in a content-script.ts bug-fix pass, see
 * docs/decisions.md. It's deliberately placed here rather than in content-script.ts itself, its only
 * consumer, for one reason: content-script.ts calls `run()` unconditionally at module load (touching
 * `window`/`document`/`chrome`), which would crash if imported into this suite's Node,
 * non-jsdom test environment (see vitest.config.ts) -- a pure helper defined there could never
 * actually be unit tested. Living here keeps it a plain, DOM-free function content-script.ts can
 * still import and use like any other type from this module.
 */

/** A candidate image already resolved to a real URL + intrinsic bitmap dimensions
 * (naturalWidth/naturalHeight), not CSS-rendered display size -- see dom-scan.ts's
 * buildImageDescriptor, which is what actually populates width/height. */
export interface ImageDescriptor {
  url: string;
  width: number;
  height: number;
  // Flattened class-name/id tokens gathered from the <img> and its ancestor containers.
  containerHints?: string[];
}

/** A rectangle in CSS pixels (or device pixels, depending on context -- see capture-fallback.ts). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Conservative minimum-dimension floor (CSS px) below which a bbox is treated as "degenerate" --
 * see `isDegenerateBbox` below. Numerically matches background.ts's own `MIN_CROP_DIMENSION_PX`
 * floor (10), chosen for consistency between the two conservative floors -- but that constant is
 * kept deliberately INDEPENDENT (not imported from here; see its own comment in background.ts for
 * why): it guards a different measurement (a device-pixel crop rect, taken post-DPR-scaling)
 * from this one (a CSS-pixel `getBoundingClientRect()` reading, taken pre-DPR-scaling), and forcing
 * them to share one binding would silently couple two conceptually distinct floors that only
 * happen to currently agree on 10. If either value ever needs to change, update the other's
 * cross-reference comment too so they don't silently drift apart unnoticed. */
export const MIN_VALID_BBOX_DIMENSION_PX = 10;

/**
 * True if `bbox` is "degenerate" -- essentially zero-size in at least one dimension -- rather than
 * a genuinely laid-out element. Real-world cause (confirmed via manual testing): some sites
 * virtualize/collapse off-screen list items to zero size while still preloading their `<img>`'s
 * image data, so a scan performed before the element is actually laid out reports a bbox like
 * `{width: 0, height: 0}` even though its resolved URL is completely valid.
 *
 * Used by content-script.ts's `sendCandidate` dedup guard: a candidate reported with a degenerate
 * bbox must NOT permanently "claim" its URL in the `emittedUrls` dedup set, so that a later,
 * corrected report for the same URL (once `watchForLazyLoadedImages`'s `IntersectionObserver`
 * re-measures a fresh bbox as the element actually scrolls into view) is not silently dropped.
 *
 * Boundary semantics deliberately match background.ts's own `MIN_CROP_DIMENSION_PX` check
 * (`< minDimension`, not `<=`): a bbox with a dimension EXACTLY equal to `minDimension` is still
 * considered valid/non-degenerate. Only a dimension strictly SMALLER than the floor counts as
 * degenerate.
 */
export function isDegenerateBbox(
  bbox: Rect,
  minDimension: number = MIN_VALID_BBOX_DIMENSION_PX
): boolean {
  return bbox.width < minDimension || bbox.height < minDimension;
}

/** A CSS-pixel scroll delta between two points in time. */
export interface ScrollOffset {
  x: number;
  y: number;
}

// content-script -> background: "I found a candidate image at this DOM position."
export interface CandidateFoundMessage {
  type: "CANDIDATE_FOUND";
  requestId: string;
  descriptor: ImageDescriptor;
  bbox: Rect;
}

// background -> content-script: fetch/capture outcome for a given requestId.
export interface FetchResultMessage {
  type: "FETCH_RESULT";
  requestId: string;
  ok: boolean;
  reason?: string;
}

export type ExtensionMessage = CandidateFoundMessage | FetchResultMessage;
