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

// Re-injection guard: background.ts's chrome.action.onClicked listener re-injects this file on
// every toolbar click, with no tracking of "is this tab already scanning" (see background.ts). If
// run() below executed a second time on the same page, it would create a brand-new emittedUrls Set
// (losing the first injection's dedup memory, above) and a brand-new IntersectionObserver watching
// the same <img> elements the first injection's still-live observer already watches (nothing here
// ever calls disconnect() on that first observer) -- producing duplicate CANDIDATE_FOUND messages
// and stacking observers. Both guard flag and observer reference live on `window` (rather than
// module scope) because each `chrome.scripting.executeScript` injection of this file is evaluated
// as a brand-new module instance -- a module-scope `let` would NOT persist across injections and
// so could neither detect a repeat injection nor reach the prior injection's observer to disconnect
// it. `window`, in contrast, is the same live object across re-injections into the same page, so
// state stashed there does persist. This also naturally resets to `undefined` on a full page
// navigation (a fresh `window` per page load), which is exactly the behavior we want: a new page's
// DOM/observers are gone, so a re-scan on next click should be allowed.
declare global {
  interface Window {
    __mangatlSpikeInjected?: boolean;
    __mangatlSpikeObserver?: IntersectionObserver | null;
  }
}

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
  if (window.__mangatlSpikeInjected) {
    console.warn(
      "[mangatl-spike] content script already injected on this page; skipping duplicate scan " +
        "(re-clicking the toolbar icon on the same page is a no-op until the page navigates)"
    );
    return;
  }
  window.__mangatlSpikeInjected = true;

  // Defensive safety net: disconnect any observer left over on `window` from a prior injection of
  // this page load. Should be unreachable given the guard above, but this is a one-line insurance
  // policy against ever stacking two live observers on the same page.
  window.__mangatlSpikeObserver?.disconnect();
  window.__mangatlSpikeObserver = null;

  const initialResults = scanImages(document);
  console.info(`[mangatl-spike] initial scan found ${initialResults.length} <img> element(s)`);

  for (const result of initialResults) {
    sendCandidate(result);
  }

  // See dom-scan.ts's watchForLazyLoadedImages docstring for the known limitation: this only
  // catches images that swap in a real src as they scroll into view, not brand-new <img> nodes
  // added to the DOM after this point (e.g. infinite-scroll pagination).
  window.__mangatlSpikeObserver = watchForLazyLoadedImages(
    initialResults.map((result) => result.element),
    sendCandidate,
    window
  );
}

run();
