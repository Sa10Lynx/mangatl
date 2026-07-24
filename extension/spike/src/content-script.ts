/**
 * Content script entry point -- glue only, manual-verification-only (see README.md).
 *
 * Injected on demand via `chrome.scripting.executeScript` from background.ts's
 * `chrome.action.onClicked` listener. This file is NOT declared as a static `content_scripts` entry
 * in manifest.json -- it only ever runs after the user explicitly clicks the toolbar icon on the
 * current tab, which is what makes activeTab-only permissions (no `host_permissions`) sufficient.
 *
 * Flow: dom-scan (find real <img> elements) -> candidate-filter (drop ads/nav/icons/wrong-shaped
 * images) -> send one CANDIDATE_FOUND message per surviving candidate to the background service
 * worker.
 */
import { filterCandidates } from "./candidate-filter";
import { scanImages, watchForLazyLoadedImages, type ScanResult } from "./dom-scan";
import type { CandidateFoundMessage } from "./types";

// Dedup guard: the initial scan and the IntersectionObserver lazy-load callback can both report the
// same URL (e.g. an image already in view at scan time also fires an intersection entry). Keyed on
// resolved URL rather than DOM element so a genuinely re-resolved lazy URL for the same <img> is
// still treated as "new" and reported.
const emittedUrls = new Set<string>();

function passesCandidateFilter(result: ScanResult): boolean {
  return filterCandidates([result.descriptor]).length > 0;
}

function sendCandidate(result: ScanResult): void {
  const url = result.descriptor.url;
  if (!url || emittedUrls.has(url)) {
    return;
  }
  if (!passesCandidateFilter(result)) {
    return;
  }
  emittedUrls.add(url);

  const message: CandidateFoundMessage = {
    type: "CANDIDATE_FOUND",
    requestId: crypto.randomUUID(),
    descriptor: result.descriptor,
    bbox: result.bbox,
  };

  chrome.runtime.sendMessage(message).catch((err) => {
    // Most common cause during manual testing: the background service worker hadn't finished
    // waking up yet, or the extension was reloaded mid-session. Not fatal -- just log it.
    console.warn("[mangatl-spike] failed to send CANDIDATE_FOUND message:", err);
  });
}

function run(): void {
  const initialResults = scanImages(document);
  console.info(`[mangatl-spike] initial scan found ${initialResults.length} <img> element(s)`);

  for (const result of initialResults) {
    sendCandidate(result);
  }

  // See dom-scan.ts's watchForLazyLoadedImages docstring for the known limitation: this only
  // catches images that swap in a real src as they scroll into view, not brand-new <img> nodes
  // added to the DOM after this point (e.g. infinite-scroll pagination).
  watchForLazyLoadedImages(
    initialResults.map((result) => result.element),
    sendCandidate,
    window
  );
}

run();
