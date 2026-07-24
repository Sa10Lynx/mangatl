/**
 * Unit tests for the pure-ish seam in `extension/spike/src/dom-scan.ts`:
 * `buildImageDescriptor` / `toBoundingRect`. These use a minimal fake element object, NOT
 * jsdom/happy-dom -- per the approved plan, live-DOM behavior (`scanImages`,
 * `watchForLazyLoadedImages`, real `querySelectorAll`/`IntersectionObserver` wiring) is
 * manual-verification-only and out of scope for this suite.
 */
import { describe, expect, it } from "vitest";
import { buildImageDescriptor, toBoundingRect, type ImageElementLike } from "../src/dom-scan";

function fakeElement(overrides: Partial<ImageElementLike> = {}): ImageElementLike {
  const attributes: Record<string, string> = {};
  return {
    src: "https://reader.example/page-042.jpg",
    naturalWidth: 900,
    naturalHeight: 1350,
    getAttribute: (name: string) => attributes[name] ?? null,
    className: "",
    id: "",
    parentElement: null,
    ...overrides,
  };
}

describe("buildImageDescriptor", () => {
  it("uses the real src as-is when it doesn't look like a placeholder", () => {
    const el = fakeElement();

    const descriptor = buildImageDescriptor(el);

    expect(descriptor.url).toBe("https://reader.example/page-042.jpg");
    expect(descriptor.width).toBe(900);
    expect(descriptor.height).toBe(1350);
  });

  it("falls back to a data-src attribute when src is a tiny inline data: URI placeholder", () => {
    const el = fakeElement({
      src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      naturalWidth: 1,
      naturalHeight: 1,
      getAttribute: (name: string) =>
        name === "data-src" ? "https://reader.example/lazy-page-043.jpg" : null,
    });

    const descriptor = buildImageDescriptor(el);

    expect(descriptor.url).toBe("https://reader.example/lazy-page-043.jpg");
  });

  it("falls back to a lazy attribute when the reported natural size is suspiciously small", () => {
    const el = fakeElement({
      src: "https://reader.example/spinner.png",
      naturalWidth: 4,
      naturalHeight: 4,
      getAttribute: (name: string) =>
        name === "data-original" ? "https://reader.example/lazy-page-044.jpg" : null,
    });

    const descriptor = buildImageDescriptor(el);

    expect(descriptor.url).toBe("https://reader.example/lazy-page-044.jpg");
  });

  it("falls back to the raw src when it looks like a placeholder but no lazy attribute is set", () => {
    const el = fakeElement({
      src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      naturalWidth: 1,
      naturalHeight: 1,
    });

    const descriptor = buildImageDescriptor(el);

    expect(descriptor.url).toBe(
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
    );
  });

  it("collects className/id tokens from ancestor elements up to the default depth", () => {
    const grandparent = { className: "reader-page ad-slot", id: "", parentElement: null };
    const parent = { className: "panel-container", id: "panel-7", parentElement: grandparent };
    const el = fakeElement({ parentElement: parent });

    const descriptor = buildImageDescriptor(el);

    expect(descriptor.containerHints).toEqual([
      "panel-container",
      "panel-7",
      "reader-page ad-slot",
    ]);
  });

  it("stops walking ancestors once containerHintDepth is reached", () => {
    const tooFar = { className: "should-not-appear", id: "", parentElement: null };
    const grandparent = { className: "reader-page", id: "", parentElement: tooFar };
    const parent = { className: "panel-container", id: "", parentElement: grandparent };
    const el = fakeElement({ parentElement: parent });

    const descriptor = buildImageDescriptor(el, 2);

    expect(descriptor.containerHints).toEqual(["panel-container", "reader-page"]);
  });

  it("returns an empty containerHints array when there is no parentElement", () => {
    const el = fakeElement({ parentElement: null });

    const descriptor = buildImageDescriptor(el);

    expect(descriptor.containerHints).toEqual([]);
  });
});

describe("toBoundingRect", () => {
  it("extracts x/y/width/height from getBoundingClientRect()", () => {
    const el = {
      getBoundingClientRect: () => ({
        x: 12,
        y: 34,
        width: 300,
        height: 450,
        top: 34,
        left: 12,
        right: 312,
        bottom: 484,
      }),
    };

    expect(toBoundingRect(el)).toEqual({ x: 12, y: 34, width: 300, height: 450 });
  });
});
