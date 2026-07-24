/**
 * Thin adapter over the real DOM for the spec 01 image-acquisition spike. This is the ONLY module
 * allowed to touch `document`/`window`/`IntersectionObserver` directly on the "finding images" side
 * -- candidate-filter.ts stays a pure function over an already-resolved ImageDescriptor.
 *
 * Known gap, out of scope for this spike: this only looks at real `<img>` elements
 * (`document.querySelectorAll("img")`). Manga readers that render pages as CSS `background-image`
 * on a `<div>` (rather than an `<img>` element) will not be picked up at all. Noting this rather than
 * building a background-image walker, per spec 01's explicit "no handling for every possible reader
 * site" scope cut.
 *
 * DI seam: `buildImageDescriptor` (and its small helpers) take a plain, minimally-shaped
 * `ImageElementLike` rather than a real `HTMLImageElement`, specifically so the "given an element,
 * build a descriptor" logic can be unit tested with a fake object (tests/dom-scan.test.ts) without
 * jsdom/happy-dom. `scanImages`/`watchForLazyLoadedImages` are the thin, untested glue that supplies
 * real DOM elements (which satisfy `ImageElementLike` structurally) to that logic.
 */
import type { ImageDescriptor, Rect } from "./types";

export type { ImageDescriptor, Rect };

/** Minimal shape of an ancestor element this module needs -- just enough to collect hint tokens. */
export interface ElementLike {
  className?: string | null;
  id?: string | null;
  parentElement?: ElementLike | null;
}

/** Minimal shape of an `<img>`-like element this module needs. A real `HTMLImageElement` satisfies
 * this structurally, so no adapter/wrapper object is needed at the real `scanImages` call site. */
export interface ImageElementLike extends ElementLike {
  src: string;
  currentSrc?: string;
  naturalWidth: number;
  naturalHeight: number;
  getAttribute(name: string): string | null;
}

/** Minimal shape of anything `getBoundingClientRect()`-able. */
export interface BoundingRectLike {
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

export interface ScanResult {
  descriptor: ImageDescriptor;
  bbox: Rect;
  element: HTMLImageElement;
}

// Common attributes sites stash the "real" URL in while a lazy-loader hasn't swapped it into `src`
// yet. Checked in this order; first one present wins.
const LAZY_LOAD_ATTRS = ["data-src", "data-original", "data-lazy-src"] as const;

// A reported natural size at or below this (in either dimension) is treated as "this is almost
// certainly a placeholder/spinner/tracking-pixel, not the real image" -- e.g. classic 1x1 GIFs.
const PLACEHOLDER_MAX_DIMENSION = 8;

// How many `parentElement` levels to walk up collecting className/id tokens for candidate-filter.ts
// to check against its blockedContainerHints list (e.g. "ad", "nav", "sponsor").
const DEFAULT_CONTAINER_HINT_DEPTH = 4;

/** True if `src` looks like it's very likely a placeholder rather than the real manga-page image:
 * a tiny inline data: URI, or one the browser reports as having a suspiciously small natural size
 * (a strong signal for a "load real image on scroll" lazy-loader that hasn't fired yet). */
function looksLikePlaceholder(src: string, naturalWidth: number, naturalHeight: number): boolean {
  if (!src) {
    return true;
  }
  if (src.startsWith("data:")) {
    return true;
  }
  if (
    naturalWidth > 0 &&
    naturalHeight > 0 &&
    naturalWidth <= PLACEHOLDER_MAX_DIMENSION &&
    naturalHeight <= PLACEHOLDER_MAX_DIMENSION
  ) {
    return true;
  }
  return false;
}

/** Resolves the real image URL: `src` as-is, unless it looks like a placeholder, in which case the
 * first present lazy-load attribute wins. Falls back to the raw `src` if no lazy attribute is set
 * either (nothing better to offer). */
function resolveRealSrc(el: ImageElementLike): string {
  const rawSrc = el.src ?? "";
  if (!looksLikePlaceholder(rawSrc, el.naturalWidth, el.naturalHeight)) {
    return rawSrc;
  }
  for (const attr of LAZY_LOAD_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) {
      return value;
    }
  }
  return rawSrc;
}

/** Walks up `parentElement` up to `maxDepth` levels, collecting non-empty className/id strings. */
function collectContainerHints(el: ElementLike, maxDepth: number): string[] {
  const hints: string[] = [];
  let current = el.parentElement ?? null;
  let depth = 0;
  while (current && depth < maxDepth) {
    if (current.className) {
      hints.push(current.className);
    }
    if (current.id) {
      hints.push(current.id);
    }
    current = current.parentElement ?? null;
    depth += 1;
  }
  return hints;
}

/**
 * Pure(-ish) core: given an element-like object, builds the `ImageDescriptor` candidate-filter.ts
 * and image-fetch.ts expect. No `document`/`window` access -- this is the unit-tested seam.
 */
export function buildImageDescriptor(
  el: ImageElementLike,
  containerHintDepth: number = DEFAULT_CONTAINER_HINT_DEPTH
): ImageDescriptor {
  return {
    url: resolveRealSrc(el),
    width: el.naturalWidth,
    height: el.naturalHeight,
    containerHints: collectContainerHints(el, containerHintDepth),
  };
}

/** Reads a real element's current bounding rect into a plain `Rect`. Kept separate from
 * `buildImageDescriptor` since it's a different concern (viewport position for the captureVisibleTab
 * crop fallback) from the descriptor (URL + intrinsic size + container hints). */
export function toBoundingRect(el: BoundingRectLike): Rect {
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Live-DOM entry point: finds every real `<img>` on the page and builds a `ScanResult` for each. */
export function scanImages(doc: Document = document): ScanResult[] {
  const images = Array.from(doc.querySelectorAll("img"));
  return images.map((img) => ({
    descriptor: buildImageDescriptor(img),
    bbox: toBoundingRect(img),
    element: img,
  }));
}

/**
 * Lazy-load catch-up strategy: an `IntersectionObserver` on every `<img>` found at initial-scan
 * time. When one scrolls into view, we re-run `buildImageDescriptor`/`toBoundingRect` on it (picking
 * up whatever a site's own lazy-loader may have just swapped into `src`) and report it again via
 * `onUpdate`.
 *
 * Why IntersectionObserver over a scroll-debounce rescan: it's the browser telling us exactly when
 * an element enters the viewport, for free, without us re-walking/re-filtering the entire DOM on
 * every scroll tick.
 *
 * Known limitation (see README.md's manual checklist): this only observes `<img>` elements that
 * already existed in the DOM at initial-scan time. Brand-new `<img>` nodes inserted later (e.g. an
 * infinite-scroll reader appending additional page elements as you scroll) are NOT picked up -- that
 * would need a `MutationObserver` watching for added nodes, which is intentionally out of scope for
 * this spike (kept small per the approved plan).
 */
export function watchForLazyLoadedImages(
  images: HTMLImageElement[],
  onUpdate: (result: ScanResult) => void,
  // `Window & typeof globalThis` (rather than plain `Window`) because `IntersectionObserver` is a
  // global `var` in lib.dom.d.ts, not a member of the `Window` interface -- this typing lets
  // `win.IntersectionObserver` resolve at all while still keeping `win` as an injectable seam.
  win: Window & typeof globalThis = window
): IntersectionObserver | null {
  if (typeof win.IntersectionObserver !== "function") {
    // No IntersectionObserver in this environment -- caller just keeps whatever the initial scan
    // found. Realistically this never happens in a real Chrome tab, but keeps this function total.
    return null;
  }

  const observer = new win.IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        const element = entry.target as HTMLImageElement;
        onUpdate({
          descriptor: buildImageDescriptor(element),
          bbox: toBoundingRect(element),
          element,
        });
      }
    },
    { rootMargin: "200px" }
  );

  for (const image of images) {
    observer.observe(image);
  }
  return observer;
}
