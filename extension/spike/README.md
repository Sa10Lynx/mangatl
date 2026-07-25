# MangaTL Image Acquisition Spike (spec 01)

Throwaway Manifest V3 extension proving a Chrome extension can reliably get raw manga-image bytes
off a real reader page. No UI, no overlay -- console.log output only. See
`docs/specs/01-image-acquisition-spike.md` for the full spec.

## What's here

- `manifest.json` -- MV3 manifest. `activeTab` + `scripting` permissions only, no
  `host_permissions`, no static `content_scripts` entry. The content script is injected on demand
  from the background service worker, only after the user clicks the toolbar icon on the current
  tab.
- `src/candidate-filter.ts`, `src/capture-fallback.ts`, `src/image-fetch.ts`, `src/logging.ts`,
  `src/message-guard.ts`, `src/types.ts` -- pure-logic modules, unit-tested (`tests/*.test.ts`). Do
  not modify without also updating their approved tests.
- `src/dom-scan.ts` -- thin adapter over the real DOM (`document.querySelectorAll("img")`,
  `IntersectionObserver`). The "given an element, build an `ImageDescriptor`" core
  (`buildImageDescriptor`) is unit-tested with a fake element object
  (`tests/dom-scan.test.ts`); the live-DOM glue (`scanImages`, `watchForLazyLoadedImages`) is
  manual-verification-only.
- `src/content-script.ts` -- entry point, glue only. Scans the page, filters candidates, sends
  `CANDIDATE_FOUND` messages to the background worker. Manual-verification-only.
- `src/background.ts` -- entry point, glue only. Injects the content script on icon click; on each
  valid `CANDIDATE_FOUND` message, tries a direct fetch, falls back to
  `chrome.tabs.captureVisibleTab` + crop on failure, and logs metadata only. Manual-verification-only.

**Manual-verification-only** means: no browser tool is available to any subagent (including the one
that wrote this), so `dom-scan.ts`'s live-DOM glue, `content-script.ts`, and `background.ts` have
**not** been run in an actual Chrome browser. `npm run build`, `npx tsc --noEmit`, and `npx vitest
run` all pass, but that only proves the code compiles/bundles and that the pure-logic modules behave
as specified -- it is not end-to-end verification. A human must actually load this in Chrome and work
through the checklist below.

## Build steps

```
npm install
npm run build
```

This bundles `src/content-script.ts` and `src/background.ts` (each with all their local imports)
into single self-contained IIFE files: `dist/content-script.js` and `dist/background.js`. Plain IIFE
bundles were chosen over ES modules deliberately -- MV3 content-script injection via
`chrome.scripting.executeScript` has more restrictions/quirks around ES modules across Chrome
versions than a plain script, which is the safer choice for a spike meant to be loaded and tested
quickly.

Other useful scripts:
- `npm run typecheck` -- `tsc --noEmit` over `src/` and `tests/`.
- `npm test` -- runs the pure-logic unit test suite (`tests/*.test.ts`); does not touch `dom-scan.ts`'s
  live-DOM glue, `content-script.ts`, or `background.ts` beyond `dom-scan.ts`'s
  `buildImageDescriptor`/`toBoundingRect` seam.

## Load-unpacked steps

1. Run the build steps above first -- `dist/content-script.js` and `dist/background.js` must exist,
   since `manifest.json`'s `background.service_worker` and `content-script.ts`'s injection target
   both point at paths under `dist/`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this directory (`extension/spike/` -- the one containing
   `manifest.json`, *not* the repo root and *not* `dist/` itself). Paths in `manifest.json`
   (`dist/background.js`) and in `background.ts`'s `chrome.scripting.executeScript` call
   (`dist/content-script.js`) are both relative to this directory, so loading anything else as the
   extension root will break the paths.
5. If you edit any `src/*.ts` file, re-run `npm run build`, then click the refresh icon for this
   extension on `chrome://extensions`.

## How to use it

1. Navigate to a real chapter/reading page on one of the two target sites (see the manual test
   checklist below).
2. Click the MangaTL spike toolbar icon (puzzle-piece icon if you haven't pinned it -- pin it for
   convenience). This injects the content script into the current tab only (activeTab-gated).
3. On `chrome://extensions`, find this extension's card and click the **service worker** link (under
   "Inspect views") to open the background service worker's DevTools console. This is where all
   metadata logging happens (per CLAUDE.md invariant 3, raw image bytes are never logged -- only
   `byteLength`/`width`/`height`/`mimeType`/a non-cryptographic hash, plus which acquisition path
   (`direct-fetch` or `capture-fallback`) was used).
4. Scroll the page and watch for additional log lines from lazy-loaded images catching up (see the
   `IntersectionObserver` limitation below).

## Known limitations / judgment calls to specifically check for

These are implementation decisions made without a browser to verify them against -- the manual
checklist below exists specifically to validate (or invalidate) them:

1. **`ImageDescriptor.width`/`.height` use `naturalWidth`/`naturalHeight`** (the image's intrinsic
   bitmap resolution), not the element's CSS-rendered on-page size. Chosen because it's what the spec
   asked for and because it's more robust against a page that CSS-scales a small placeholder/logo up
   to look big, or a huge image down to look small -- but it means `candidate-filter.ts`'s size
   thresholds are being compared against the source image's real pixel dimensions, not how large it
   visually appears. Worth double-checking this doesn't misclassify anything on the two target sites.
2. **Lazy-load catch-up uses `IntersectionObserver`, not a `MutationObserver`.** It only observes
   `<img>` elements that existed in the DOM at the moment the content script ran its initial scan. If
   a site appends brand-new `<img>` nodes as you scroll (e.g. an infinite-scroll reader, rather than
   one that pre-renders empty `<img>` placeholders and swaps their `src`), those new nodes will
   **not** be caught by this spike. Check specifically: does scrolling on each target site reveal new
   manga pages that never get logged at all?
3. **`captureVisibleTab` crop fallback assumes negligible scroll movement between measurement and
   capture, and now explicitly refuses to capture anything not fully within the viewport.** Rather
   than trying to track scan-time scroll position (which the locked `CandidateFoundMessage` schema
   has no field for) and threading a scroll delta through `capture-fallback.ts`'s
   `computeCaptureCropRect`, `background.ts` re-measures the candidate element's current bounding
   rect + `devicePixelRatio` + viewport size immediately before calling `captureVisibleTab` (matching
   by resolved image URL). Real testing (2026-07-25) found that elements only partially scrolled into
   view produce a garbage, misleadingly-"successful" tiny capture (`captureVisibleTab` can't see
   pixels outside the visible viewport, and Canvas silently blanks the missing region instead of
   erroring) -- fixed with `isRectFullyInViewport()`: if the freshly-measured bbox isn't **fully**
   contained in the viewport, the capture is skipped outright with a clear log line, rather than
   producing bad data. Practical effect: on a long scrollable page, only images that happen to be
   fully on-screen at the moment you click are capturable via this fallback path -- worth explicitly
   checking how often that's actually the case during your manual pass, since it may mean most
   off-screen images on a real page never get captured at all via this path (direct-fetch, when it
   works, has no such limitation). If the element can no longer be found at all (e.g. its `src`
   changed again, or it left the DOM), it falls back to the original, possibly-stale `bbox` from the
   `CANDIDATE_FOUND` message with `devicePixelRatio` assumed to be 1 and skips the viewport check
   entirely (no fresh viewport data exists in that path) -- a reduced-accuracy path worth specifically
   checking (does a captured/cropped fallback image on a hidpi display actually look right, or is it
   visibly off?).
4. **CSS `background-image` panels are not scanned at all** -- only real `<img>` elements. If either
   target site renders pages that way, that's a hard miss for this spike, not a fallback case.
5. **The opt-in raw-byte dump path (`ENABLE_RAW_BYTE_DUMP` in `background.ts`) is off by default**,
   and even if flipped on locally, does not actually persist a file anywhere in this browser-extension
   build -- it only logs what it *would* have written. This spike deliberately does not declare a
   `downloads` (or any other) permission beyond `activeTab` + `scripting` that would let it actually
   write a file, to keep the permission footprint minimal. If you need real byte-level manual
   inspection, add temporary instrumentation locally and remove it again -- do not commit an
   enabled dump path or an added permission.

## Manual test checklist (open site scope)

Testing scope is intentionally open, not limited to two fixed sites (updated 2026-07-25, see
`docs/decisions.md`) -- the product direction is widening from manga-only to a general on-screen
translator, so it's useful to know how this behaves broadly, not just on manga readers. At minimum,
still run this against MANGA Plus and VIZ (real manga-reader DOM patterns, lazy-loading, CORS-y CDN
image hosting -- good coverage for the reader-specific judgment calls in the limitations above), but
add any other sites you want signal on -- e.g. Google Photos (generic photo grid, very different DOM
shape/lazy-load pattern than a manga reader, good test of whether `candidate-filter.ts`'s heuristics
generalize at all), a news article page (mixed text + inline images), or anything else. For each site
tested, note the answers (in `SITE_NOTES.md`, see below) to:

- [ ] Open a real chapter/reading page on the site.
- [ ] Click the extension icon. Open the background service worker's console
      (`chrome://extensions` -> this extension's card -> "service worker" inspect link).
- [ ] Direct fetch vs. fallback: for each logged candidate, did the log line say
      `source=direct-fetch` or `source=capture-fallback`? For any `capture-fallback` entries, check
      the console for the preceding `direct fetch failed (reason=...)` line -- was the reason `cors`,
      `network`, `non-2xx`, or `blob-url`? Note which, and why you think that reason applies to this
      site's image-hosting setup.
- [ ] Candidate accuracy: did `candidate-filter.ts` correctly include the real manga panels and
      exclude ads/nav/icons/avatars? Check both the browser DOM (via DevTools "Elements" panel) and
      the log line count against what you'd expect for that chapter's actual page count.
- [ ] Lazy-loading: scroll through the whole chapter. Did new manga pages produce new log lines as
      they scrolled into view? If some pages were missed, was it because of limitation #2 above (a
      brand-new `<img>` node rather than a `src`-swap on an existing one)?
- [ ] Any errors in the console (content script or background)? Note them verbatim.
- [ ] If a `capture-fallback` path fired, visually sanity-check the crop: does it look correctly
      positioned/sized, or does it look shifted/scaled wrong (see limitation #3 above, especially on
      a hidpi/scaled display)?

**After running the checklist on however many sites you choose, filling in `SITE_NOTES.md` and
writing the final go/no-go paragraph in `docs/decisions.md` are explicitly human-only steps** (per
the spec and the pipeline's working style) -- not something any subagent should draft the content of.
This README and the code stop at "here's what to check and how"; the actual findings and the go/no-go
call are yours.
