/**
 * Unit tests for `extension/spike/src/candidate-filter.ts` -- the "is this a manga panel vs.
 * ad/logo/avatar" heuristic (spec 01 "What to build" #1, and "Edge cases to handle": images that
 * are ads/UI chrome, not manga pages -- size threshold alone probably isn't enough; aspect ratio
 * and container class names are the other signals to check).
 *
 * candidate-filter.ts does NOT exist yet at test-writing time. These tests are the contract the
 * coder stage implements against.
 *
 * Expected public API:
 *
 *   export interface ImageDescriptor {
 *     url: string;
 *     width: number;              // final, already-resolved rendered width in CSS px
 *     height: number;             // final, already-resolved rendered height in CSS px
 *     // Flattened class-name/id tokens gathered from the <img> and its ancestor containers
 *     // (e.g. ["ad-slot", "manga-reader", "page-1"]). Optional.
 *     containerHints?: string[];
 *   }
 *
 *   export interface CandidateFilterOptions {
 *     minWidth?: number;                 // default 400 (spec: "width/height > 400px")
 *     minHeight?: number;                // default 400
 *     minAspectRatio?: number;           // width / height lower bound, default 0.3
 *     maxAspectRatio?: number;           // width / height upper bound, default 3.0
 *     blockedContainerHints?: string[];  // default ["ad", "ads", "sponsor", "sponsored", "nav"]
 *   }
 *
 *   export function isCandidateImage(
 *     descriptor: ImageDescriptor,
 *     options?: CandidateFilterOptions
 *   ): boolean;
 *
 *   export function filterCandidates(
 *     descriptors: ImageDescriptor[],
 *     options?: CandidateFilterOptions
 *   ): ImageDescriptor[];
 *
 * Design decisions this suite locks down (spec didn't specify them; picked reasonable defaults
 * per CLAUDE.md working style and noted here rather than guessed silently):
 *
 * 1. Size threshold is STRICT and per-dimension: width AND height must EACH be > the configured
 *    threshold (matching the spec's literal "> 400px" wording), not just one of them and not >=.
 * 2. Aspect ratio bounds exist specifically to catch wide banner ads that already clear the size
 *    threshold. Defaults are chosen so a typical portrait manga page passes and a landscape
 *    banner fails.
 * 3. `blockedContainerHints` matching is TOKEN-based, not substring-based: each hint string is
 *    split on non-alphanumeric characters and compared case-insensitively against the blocklist.
 *    This avoids false positives like "header" (contains the substring "ad" but is not an ad
 *    container). This is asserted explicitly below, not just assumed.
 * 4. candidate-filter.ts operates ONLY on an already-resolved descriptor (real URL + final
 *    dimensions). It is explicitly NOT responsible for reading `data-src`/lazy-load attributes --
 *    that normalization is dom-scan.ts's job (manual-verification-only, out of scope here). A
 *    tiny lazy-load placeholder descriptor is simply rejected by the ordinary size check.
 */
import { describe, expect, it } from "vitest";
import {
  filterCandidates,
  isCandidateImage,
  type ImageDescriptor,
} from "../src/candidate-filter";

function descriptor(overrides: Partial<ImageDescriptor>): ImageDescriptor {
  return {
    url: "https://reader.example/img.jpg",
    width: 900,
    height: 1350,
    ...overrides,
  };
}

describe("isCandidateImage", () => {
  it("accepts a large portrait hero image (typical manga page)", () => {
    const heroImage = descriptor({ width: 900, height: 1350 }); // aspect ratio ~0.667
    expect(isCandidateImage(heroImage)).toBe(true);
  });

  it("rejects a small icon/avatar below the size threshold", () => {
    const avatar = descriptor({ width: 64, height: 64 });
    expect(isCandidateImage(avatar)).toBe(false);
  });

  it("rejects a wide banner ad that clears the size threshold but fails the aspect-ratio check", () => {
    // Both dimensions clear the default 400px size threshold, but width/height ~3.56 is well
    // outside the default [0.3, 3.0] aspect-ratio band that a manga page would fall inside.
    const banner = descriptor({ width: 1600, height: 450 });
    expect(banner.width).toBeGreaterThan(400);
    expect(banner.height).toBeGreaterThan(400);
    expect(isCandidateImage(banner)).toBe(false);
  });

  it.each([
    ["ad container", ["ad-slot", "right-rail"]],
    ["sponsor container", ["sponsored-content"]],
    ["nav container", ["site-nav", "header"]],
  ])("rejects an otherwise-valid image inside a %s", (_label, containerHints) => {
    // Otherwise passes size (900x1350) and aspect ratio (~0.667) -- only the container hint
    // should cause rejection here.
    const img = descriptor({ containerHints });
    expect(isCandidateImage(img)).toBe(false);
  });

  it("rejects a 1x1 lazy-load placeholder purely on size, regardless of any real data-src elsewhere", () => {
    // dom-scan.ts (out of scope) is responsible for resolving data-src/lazy-load attributes to a
    // real final size before a descriptor ever reaches this module. This module only ever sees
    // the resolved 1x1 placeholder and rejects it the same way it would any undersized image.
    const placeholder = descriptor({ width: 1, height: 1 });
    expect(isCandidateImage(placeholder)).toBe(false);
  });

  it("does not false-positive on container hints that merely CONTAIN the substring \"ad\" (token-based matching)", () => {
    // "header" contains the substring "ad" (he-AD-er) but is not an ad container. Matching must
    // be token-based (split on non-alphanumeric chars) not substring-based, or this would
    // wrongly reject a huge number of legitimate containers.
    const img = descriptor({ containerHints: ["header", "gradient-overlay"] });
    expect(isCandidateImage(img)).toBe(true);
  });

  it("respects custom size options overriding the defaults", () => {
    const small = descriptor({ width: 150, height: 150 }); // rejected under defaults
    expect(isCandidateImage(small)).toBe(false);
    expect(isCandidateImage(small, { minWidth: 100, minHeight: 100 })).toBe(true);
  });

  it("respects a custom blockedContainerHints list", () => {
    const img = descriptor({ containerHints: ["carousel-widget"] });
    expect(isCandidateImage(img)).toBe(true);
    expect(isCandidateImage(img, { blockedContainerHints: ["carousel"] })).toBe(false);
  });

  // Regression: Infinity / Infinity === NaN, and `NaN < min || NaN > max` is false for any
  // threshold, so without an explicit finiteness guard the aspect-ratio check silently no-ops
  // instead of rejecting an Infinity-dimension descriptor.
  it("rejects a descriptor with Infinity width and height (NaN aspect ratio must not slip through)", () => {
    const infinite = descriptor({ width: Infinity, height: Infinity });
    expect(isCandidateImage(infinite)).toBe(false);
  });

  it("rejects a descriptor with NaN width", () => {
    const nanWidth = descriptor({ width: NaN });
    expect(isCandidateImage(nanWidth)).toBe(false);
  });

  it("rejects a descriptor with NaN height", () => {
    const nanHeight = descriptor({ height: NaN });
    expect(isCandidateImage(nanHeight)).toBe(false);
  });

  // Regression: hasBlockedHint tokenized the input containerHints but NOT the blockedList side, so
  // a multi-word custom blocklist entry like "google-ad" never matched a tokenized input hint like
  // "google-ad-slot" (tokens: ["google","ad","slot"]) -- contradicting the module's own
  // token-based-matching docstring. Both sides must go through the same tokenize() call.
  it("matches a multi-word custom blockedContainerHints entry against its tokenized form", () => {
    const img = descriptor({ containerHints: ["google-ad-slot"] });
    expect(
      isCandidateImage(img, { blockedContainerHints: ["google-ad"] })
    ).toBe(false);
  });
});

describe("filterCandidates", () => {
  it("filters a mixed list down to only true candidates, preserving order", () => {
    const hero = descriptor({ url: "hero.jpg", width: 900, height: 1350 });
    const avatar = descriptor({ url: "avatar.jpg", width: 64, height: 64 });
    const banner = descriptor({ url: "banner.jpg", width: 1600, height: 450 });
    const adImage = descriptor({
      url: "ad.jpg",
      width: 900,
      height: 1350,
      containerHints: ["ad-slot"],
    });
    const secondHero = descriptor({ url: "hero2.jpg", width: 850, height: 1300 });

    const result = filterCandidates([hero, avatar, banner, adImage, secondHero]);

    expect(result).toEqual([hero, secondHero]);
  });

  it("returns an empty array when given no descriptors", () => {
    expect(filterCandidates([])).toEqual([]);
  });

  it("returns an empty array when none of the descriptors qualify", () => {
    const avatar = descriptor({ width: 64, height: 64 });
    const banner = descriptor({ width: 1600, height: 450 });
    expect(filterCandidates([avatar, banner])).toEqual([]);
  });
});
