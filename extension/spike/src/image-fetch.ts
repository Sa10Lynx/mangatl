/**
 * Background service worker's fetch wrapper + result classifier. Takes an injectable fetch
 * implementation so this module (and its tests) never touch the real network.
 *
 * CORS-vs-network: the Fetch API surfaces both a cross-origin CORS rejection and a genuine network
 * failure as the exact same kind of thrown error -- there's no reliable way to tell them apart from
 * outside the browser's network stack. This implementation maps any thrown error to reason
 * "network"; that choice is consistently applied (see module docstring in the test file).
 *
 * blob: URLs are short-circuited before ever calling the injected fetch implementation, since a
 * blob: URL created in the page's document realm is not resolvable from the service worker's realm.
 */

export type FetchOutcomeReason = "cors" | "network" | "non-2xx" | "blob-url";

export type FetchOutcome =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: FetchOutcomeReason; status?: number };

// Minimal shape of the subset of the real Fetch API's Response this module relies on --
// deliberately NOT the full lib.dom.d.ts Response type, so a fake can implement it trivially.
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string) => Promise<FetchLikeResponse>;

export async function fetchImageBytes(url: string, fetchImpl: FetchLike): Promise<FetchOutcome> {
  if (url.startsWith("blob:")) {
    return { ok: false, reason: "blob-url" };
  }

  let response: FetchLikeResponse;
  try {
    response = await fetchImpl(url);
  } catch {
    // Network and CORS failures are indistinguishable at this layer -- see docstring above.
    return { ok: false, reason: "network" };
  }

  if (!response.ok) {
    return { ok: false, reason: "non-2xx", status: response.status };
  }

  try {
    const buffer = await response.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(buffer) };
  } catch {
    // A body-read failure (e.g. a connection reset mid-download) is realistic for large images and
    // must be classified the same way as a thrown fetchImpl error, per this function's documented
    // contract of always resolving to a FetchOutcome, never rejecting.
    return { ok: false, reason: "network" };
  }
}
