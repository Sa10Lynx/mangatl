/**
 * Unit tests for `extension/spike/src/image-fetch.ts` -- the background service worker's fetch
 * wrapper + result classifier (spec 01 "What to build" #1: "A background service worker that, for
 * each candidate image URL, fetches the bytes directly"; "Edge cases": blob: URLs, cross-origin
 * fetch failures).
 *
 * image-fetch.ts does NOT exist yet at test-writing time. These tests are the contract the coder
 * stage implements against.
 *
 * Expected public API:
 *
 *   export type FetchOutcomeReason = "cors" | "network" | "non-2xx" | "blob-url";
 *
 *   export type FetchOutcome =
 *     | { ok: true; bytes: Uint8Array }
 *     | { ok: false; reason: FetchOutcomeReason; status?: number };
 *
 *   // Minimal shape of the subset of the real Fetch API's Response this module relies on --
 *   // deliberately NOT the full lib.dom.d.ts Response type, so a fake can implement it trivially.
 *   export interface FetchLikeResponse {
 *     ok: boolean;
 *     status: number;
 *     arrayBuffer(): Promise<ArrayBuffer>;
 *   }
 *
 *   export type FetchLike = (url: string) => Promise<FetchLikeResponse>;
 *
 *   export function fetchImageBytes(url: string, fetchImpl: FetchLike): Promise<FetchOutcome>;
 *
 * DI-seam requirement (this IS the point of the "injectable fetch" design in the plan): the real
 * global `fetch()` must never be called in this suite -- `fetchImageBytes` accepts the fetch
 * implementation as a parameter rather than closing over `globalThis.fetch`, so it's testable with
 * zero real network access.
 *
 * CORS-vs-network note (per spec + locked decisions): the Fetch API surfaces both a cross-origin
 * CORS rejection and a genuine network failure (DNS, offline, connection reset, ...) as the exact
 * same kind of thrown error from the caller's point of view -- there is no reliable way to tell
 * them apart from outside the browser's network stack. So the "thrown error" tests below only
 * assert SOME non-ok classification (`ok: false`, with `reason` one of the two failure-shaped
 * values `"network"` / `"cors"`); they deliberately do NOT pin down which specific one
 * fetchImageBytes must choose for a given thrown error. Whichever the coder picks, it must be
 * applied consistently -- that consistency is what's tested, not the specific label.
 *
 * blob: URL note: a `blob:` URL created in the page's document realm is not resolvable from the
 * service worker's realm, so attempting to fetch it would be pointless (and could hang or throw
 * in confusing ways depending on the browser). fetchImageBytes must short-circuit before ever
 * calling the injected fetch implementation for such URLs.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchImageBytes, type FetchLikeResponse } from "../src/image-fetch";

function fakeResponse(status: number, bodyBytes: Uint8Array = new Uint8Array()): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bodyBytes.buffer as ArrayBuffer,
  };
}

describe("fetchImageBytes -- success", () => {
  it("classifies a 200 response with bytes as {ok: true, bytes}", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes, arbitrary content
    const fetchImpl = vi.fn(async () => fakeResponse(200, bytes));

    const result = await fetchImageBytes("https://reader.example/img.jpg", fetchImpl);

    expect(result).toEqual({ ok: true, bytes });
  });

  it("passes the given url through to the injected fetch implementation exactly once", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, new Uint8Array([1, 2, 3])));

    await fetchImageBytes("https://reader.example/img.jpg", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://reader.example/img.jpg");
  });
});

describe("fetchImageBytes -- thrown errors (network and CORS are indistinguishable at this layer)", () => {
  it("classifies a thrown network-style error as some non-ok failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await fetchImageBytes("https://reader.example/img.jpg", fetchImpl);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Deliberately not asserting which one -- see module docstring above.
      expect(["network", "cors"]).toContain(result.reason);
    }
  });

  it("classifies a thrown CORS-style error the same way as a network error (both are just a thrown TypeError to the caller)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    });

    const result = await fetchImageBytes("https://reader.example/img.jpg", fetchImpl);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["network", "cors"]).toContain(result.reason);
    }
  });
});

describe("fetchImageBytes -- non-2xx responses", () => {
  it("classifies a 404 response as {ok: false, reason: \"non-2xx\", status: 404}", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(404));

    const result = await fetchImageBytes("https://reader.example/missing.jpg", fetchImpl);

    expect(result).toEqual({ ok: false, reason: "non-2xx", status: 404 });
  });

  it("classifies a 403 response as {ok: false, reason: \"non-2xx\", status: 403}", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(403));

    const result = await fetchImageBytes("https://reader.example/forbidden.jpg", fetchImpl);

    expect(result).toEqual({ ok: false, reason: "non-2xx", status: 403 });
  });
});

describe("fetchImageBytes -- blob: URLs", () => {
  it("short-circuits a blob: URL to {ok: false, reason: \"blob-url\"} WITHOUT calling the injected fetch", async () => {
    const fetchImpl = vi.fn();

    const result = await fetchImageBytes("blob:https://reader.example/1234-5678-90ab", fetchImpl);

    expect(result).toEqual({ ok: false, reason: "blob-url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
