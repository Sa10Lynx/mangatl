/**
 * Shared types for the spec 01 image-acquisition spike.
 *
 * These are re-exported (type-only) from the individual modules whose test files declare them
 * (candidate-filter.ts, message-guard.ts, capture-fallback.ts), so each module's public API still
 * exposes exactly the type names its own test file imports, while the actual shape is defined once
 * here to avoid drift between candidate-filter's ImageDescriptor and message-guard's ImageDescriptor,
 * and between capture-fallback's Rect and message-guard's Rect.
 */

/** A candidate image already resolved to a real URL + final rendered CSS-pixel dimensions. */
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
