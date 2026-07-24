/**
 * Background service worker entry point -- glue only, manual-verification-only (see README.md).
 *
 * Responsibilities:
 *   1. `chrome.action.onClicked` -> inject the built content-script bundle into the active tab
 *      (activeTab-gated: no `host_permissions`, this only works because the user just clicked the
 *      toolbar icon on this specific tab).
 *   2. `chrome.runtime.onMessage` -> validate every incoming message via message-guard.ts's
 *      `validateMessage` (fail closed on anything malformed), then for a valid CANDIDATE_FOUND
 *      message: try a direct fetch of the image bytes, falling back to
 *      `chrome.tabs.captureVisibleTab` + capture-fallback.ts's `computeCaptureCropRect` when the
 *      direct fetch fails (classic case: a `blob:` URL, or a CORS-blocked cross-origin fetch).
 *   3. Log the outcome via logging.ts's metadata-only helpers -- never the raw bytes, per CLAUDE.md
 *      invariant 3. The opt-in raw-byte dump path exists but is off by default (see
 *      ENABLE_RAW_BYTE_DUMP below) and, even when flipped on, does not actually persist anything in
 *      this browser-extension build (see writeFileNotImplemented's docstring).
 */
import { computeCaptureCropRect } from "./capture-fallback";
import { fetchImageBytes } from "./image-fetch";
import {
  buildImageLogMetadata,
  dumpRawBytes,
  formatMetadataLogLine,
  LOCAL_ONLY_DUMP_DIR,
} from "./logging";
import { validateMessage } from "./message-guard";
import type { CandidateFoundMessage, Rect } from "./types";

// Opt-in ONLY, defaults to OFF. Flip to `true` locally (never commit as `true`) to also attempt a
// raw-byte dump via logging.ts's dumpRawBytes for manual spot-checking. Per CLAUDE.md invariant 3
// ("images are transient... never persist them"), this must stay off in anything that isn't a
// throwaway local debugging session -- and even when on, see writeFileNotImplemented below: this
// spike does not declare any permission (e.g. "downloads") that would let it actually write
// anywhere, so flipping this on only produces a console warning, not a real dump.
const ENABLE_RAW_BYTE_DUMP = false;

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) {
    console.warn("[mangatl-spike] onClicked fired without a tab id, ignoring");
    return;
  }
  chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      files: ["dist/content-script.js"],
    })
    .catch((err) => {
      console.error("[mangatl-spike] failed to inject content script:", err);
    });
});

chrome.runtime.onMessage.addListener((rawMessage, sender) => {
  const validated = validateMessage(rawMessage);
  if (!validated.ok) {
    // Fail closed, per message-guard.ts's documented contract: never act on a message that didn't
    // validate, no matter how plausible it looks.
    console.warn(`[mangatl-spike] rejected malformed message: ${validated.reason}`);
    return;
  }
  if (validated.message.type !== "CANDIDATE_FOUND") {
    return;
  }
  void handleCandidateFound(validated.message, sender.tab);
});

async function handleCandidateFound(
  message: CandidateFoundMessage,
  tab: chrome.tabs.Tab | undefined
): Promise<void> {
  const fetchOutcome = await fetchImageBytes(message.descriptor.url, fetch);

  let bytes: Uint8Array | undefined;
  let source: "direct-fetch" | "capture-fallback" = "direct-fetch";

  if (fetchOutcome.ok) {
    bytes = fetchOutcome.bytes;
  } else {
    console.info(
      `[mangatl-spike] direct fetch failed (reason=${fetchOutcome.reason}) for request ` +
        `${message.requestId}; trying captureVisibleTab fallback`
    );
    source = "capture-fallback";
    bytes = await runCaptureFallback(message, tab);
  }

  if (!bytes) {
    console.warn(`[mangatl-spike] no bytes obtained for request ${message.requestId}; giving up`);
    return;
  }

  const metadata = buildImageLogMetadata(
    { width: message.descriptor.width, height: message.descriptor.height, mimeType: "image/unknown" },
    bytes,
    fnv1aHex
  );
  console.info(
    `${formatMetadataLogLine(metadata)} source=${source} requestId=${message.requestId} ` +
      `url=${message.descriptor.url}`
  );

  if (ENABLE_RAW_BYTE_DUMP) {
    try {
      dumpRawBytes(LOCAL_ONLY_DUMP_DIR, `${message.requestId}.bin`, bytes, writeFileNotImplemented);
    } catch (err) {
      console.warn("[mangatl-spike] dumpRawBytes refused the write:", err);
    }
  }
}

interface FreshGeometry {
  bbox: Rect;
  devicePixelRatio: number;
}

/**
 * Re-measures the candidate image's CURRENT bounding rect + devicePixelRatio, immediately before
 * calling captureVisibleTab, by matching on the resolved image URL rather than reusing the bbox
 * from the original CANDIDATE_FOUND message. Two reasons:
 *   1. `CandidateFoundMessage`'s schema is locked by message-guard.ts's approved test suite and
 *      does not carry a scroll-position/devicePixelRatio field, so there is no way to thread
 *      scan-time scroll position through the existing message contract.
 *   2. A service worker has no `window`, so it cannot read `window.devicePixelRatio` or
 *      `window.scrollX/Y` itself -- `chrome.scripting.executeScript` with an inline function is the
 *      only way to ask the live page for these values.
 *
 * Because this re-measurement happens right before the capture (rather than reusing a
 * possibly-much-earlier scan-time measurement), the page's scroll position has essentially not
 * changed between "measurement" and "capture" -- so `computeCaptureCropRect` is called below with a
 * `scrollOffset` of `{x: 0, y: 0}` as a deliberate consequence of this design, not a shortcut that
 * ignores scrolling. See README.md for the known residual gap (a scroll that happens in the single
 * message round-trip between this measurement and the capture call) and the reduced-accuracy
 * fallback path below when re-measurement fails entirely (e.g. the element was removed from the DOM
 * since the original scan).
 */
async function measureFreshGeometry(
  tabId: number,
  imageUrl: string
): Promise<FreshGeometry | undefined> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (url: string) => {
        const match = Array.from(document.querySelectorAll("img")).find(
          (img) => img.src === url || img.currentSrc === url
        );
        if (!match) {
          return null;
        }
        const rect = match.getBoundingClientRect();
        return {
          bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          devicePixelRatio: window.devicePixelRatio,
        };
      },
      args: [imageUrl],
    });
    return injection?.result ?? undefined;
  } catch (err) {
    console.warn("[mangatl-spike] failed to re-measure geometry before capture:", err);
    return undefined;
  }
}

async function runCaptureFallback(
  message: CandidateFoundMessage,
  tab: chrome.tabs.Tab | undefined
): Promise<Uint8Array | undefined> {
  if (!tab?.id || tab.windowId === undefined) {
    console.warn("[mangatl-spike] capture fallback needs a tab id + window id, none available");
    return undefined;
  }

  const fresh = await measureFreshGeometry(tab.id, message.descriptor.url);
  // Reduced-accuracy fallback: if re-measurement failed, fall back to the original (possibly stale)
  // bbox from the CANDIDATE_FOUND message and assume devicePixelRatio 1 -- better than giving up
  // entirely, but the crop may be off if the page scrolled or is on a hidpi display. Documented in
  // README.md's manual checklist.
  const bbox = fresh?.bbox ?? message.bbox;
  const devicePixelRatio = fresh?.devicePixelRatio ?? 1;
  const cropRect = computeCaptureCropRect(bbox, devicePixelRatio, { x: 0, y: 0 });

  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    console.warn("[mangatl-spike] captureVisibleTab failed:", err);
    return undefined;
  }

  try {
    return await cropScreenshot(dataUrl, cropRect);
  } catch (err) {
    console.warn("[mangatl-spike] failed to crop captured screenshot:", err);
    return undefined;
  }
}

/** Crops a captured-tab screenshot (a data: URL) down to `cropRect` (device pixels) using
 * OffscreenCanvas + createImageBitmap -- both available in an MV3 service worker context. */
async function cropScreenshot(dataUrl: string, cropRect: Rect): Promise<Uint8Array> {
  // Converting a data: URL to a Blob via fetch never touches the network (data: URLs resolve
  // locally) -- this is a different concern from image-fetch.ts's injectable-fetch candidate-image
  // fetch, so it deliberately uses the real global `fetch` directly rather than going through that
  // module's contract.
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const sx = Math.max(0, Math.round(cropRect.x));
  const sy = Math.max(0, Math.round(cropRect.y));
  const sw = Math.max(1, Math.round(cropRect.width));
  const sh = Math.max(1, Math.round(cropRect.height));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2d context unavailable on OffscreenCanvas");
  }
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const buffer = await outBlob.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Non-cryptographic FNV-1a hash, used ONLY as a short fingerprint for this spike's console log line
 * so a human can eyeball whether two logged entries refer to the same bytes. This is explicitly NOT
 * a cache key of any kind (see CLAUDE.md invariant 1) -- this spike has no cache, and this hash never
 * leaves the console.
 */
function fnv1aHex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Stub writeFile for logging.ts's opt-in dumpRawBytes path. This spike intentionally declares only
 * `activeTab` + `scripting` permissions (see manifest.json) -- it does NOT declare `downloads` or
 * any other permission that would let a service worker actually persist a file. So even with
 * ENABLE_RAW_BYTE_DUMP flipped on, this stub does not write anything; it only logs what it would
 * have written, so a human can see the flag is live without granting the extension any extra
 * capability.
 */
function writeFileNotImplemented(path: string, _data: Uint8Array): void {
  console.warn(
    `[mangatl-spike] ENABLE_RAW_BYTE_DUMP is on, but no dump backend is wired up (would need e.g. ` +
      `the "downloads" permission, intentionally not declared here). Resolved path would have ` +
      `been: ${path}`
  );
}
