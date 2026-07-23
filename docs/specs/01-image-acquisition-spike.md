# Spec 01 — Browser Image Acquisition Spike

## Goal
Prove that a Chrome extension can reliably get raw image bytes off a manga page from real reader
sites — this is the other half of the Week 1 go/no-go gate. Throwaway code is fine; this is a spike.

## Inputs
A manga page open in Chrome on one of the two target reader sites (pick two real sites you'll
actually test against — note them in `docs/decisions.md` once chosen).

## Outputs
For each detected manga image on the page: raw image bytes (as a Blob or base64 string), logged to
the console or written to a file for manual inspection — no UI, no overlay yet.

## What to build
1. A minimal Manifest V3 extension (`extension/spike/`) with:
   - `manifest.json` — `activeTab` permission only, no `<all_urls>`.
   - A content script that finds candidate manga images on the page (large `<img>` elements above
     a size threshold — start with width/height > 400px as a rough filter).
   - A background service worker that, for each candidate image URL, fetches the bytes directly
     (this avoids the canvas-tainting problem you'd hit reading a cross-origin `<img>` via canvas).
2. Test against both target sites and note for each:
   - Does the image URL fetch directly, or is it a `blob:` URL / lazy-loaded / behind auth?
   - If a `blob:` URL: does `chrome.tabs.captureVisibleTab` + manual crop work as a fallback?
   - Does scrolling/lazy-loading require an `IntersectionObserver` to catch images as they appear?

## Edge cases to handle
- Images that are ads/UI chrome, not manga pages — note what heuristic would filter these
  (size threshold alone probably isn't enough; note what else you observe, e.g. aspect ratio,
  container class names, position in DOM).
- Site uses `blob:` URLs instead of direct image URLs — document whether the fallback works.
- Site lazy-loads images on scroll — document what you'd need (`IntersectionObserver`) without
  necessarily building the full solution yet.

## Explicitly NOT in scope for this spec
- No overlay rendering. No calling the OCR endpoint. No UI at all beyond console.log output.
- No handling for every possible reader site — just the two you picked.

## Definition of done
- For each of the two sites: a clear yes/no on "can we reliably get image bytes," plus notes on
  which fallback (if any) was needed.
- A paragraph in `docs/decisions.md`: if either site fails outright, is that a blocker, or do you
  pick different target sites? This is a real go/no-go call, don't skip writing it down.
