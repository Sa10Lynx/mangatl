# Site Notes -- Spec 01 Image Acquisition Spike

Template only. Fill this in by hand while working through README.md's manual test checklist
against each site -- this file is explicitly a human-authored artifact, not something any subagent
should fill in on your behalf.

Testing scope is open (2026-07-25) -- not limited to the two sites below. Copy the section template
at the bottom for any additional site you test (Google Photos, a news site, etc.).

---

## onisaga.com (hard-case finding, not a baseline site -- unclear licensing, tested opportunistically)

**Chapter/page tested:** Black Clover Vol. 17 Ch. 151

### Image URL / CORS behavior

- 100% of candidates: direct fetch failed with `reason=blob-url` (every image served via a `blob:`
  URL, which can't be fetched cross-realm from the background service worker).

### capture-fallback behavior -- did not work reliably

- All capture-fallback attempts returned a degenerate (0x0) crop rect, across four separate fix
  cycles targeting different theories: (1) viewport-containment (element scrolled above/below the
  visible area), (2) dedup blocking corrected re-measurements, (3) a reveal-timing race (site's own
  Alpine.js `x-show` reactivity revealing the element after our measurement). A confirmed real
  `getBoundingClientRect()` reading via DevTools showed the element DOES have a real, non-zero box
  at some points in time (768x1206, matching the image's real dimensions) -- so the underlying
  `<img>` elements are real and correctly sized when actually laid out. But our code's own
  measurements (both the initial scan and a post-retry re-measurement up to 600ms later) consistently
  saw 0x0 for these same elements.
- Root cause not fully resolved. Likely candidates: some form of layout virtualization/pooling that
  keeps most `<img>` elements hidden/uninitialized in layout until a very specific (and much later
  than our retry window) moment, possibly deliberately resistant to naive scraping given the site's
  blob-URL-only image delivery and unclear licensing status.
- **Practical conclusion for the go/no-go call**: on a site combining blob-URL image serving with
  this kind of layout behavior, BOTH the direct-fetch and captureVisibleTab-crop acquisition paths
  can fail completely, even after real fixes for viewport-containment, dedup, and reveal-timing
  races. This is a genuine limitation of the current spike's approach, not (as far as we could
  determine) a remaining simple bug -- worth noting as a real constraint on which sites this
  approach can reliably serve, separate from the baseline-site results below.

### Errors observed

- No console errors -- every failure was a clean, correctly-logged `degenerate crop rect` skip
  (the guards added during this testing session worked exactly as designed; they just couldn't turn
  a genuinely-degenerate measurement into a usable one on this particular site).

---

## MANGA Plus

**Chapter/page tested:** _(URL + chapter number)_

### Image URL / CORS behavior

- Direct fetch worked / fell back to `captureVisibleTab`?
- If fallback: reason logged (`cors` / `network` / `non-2xx` / `blob-url`)?
- Anything notable about how the site serves images (CDN, signed URLs, `blob:` URLs, etc.)?

### Lazy-load behavior

- Did scrolling reveal new pages via the `IntersectionObserver` catch-up path?
- Were any pages missed entirely (see README.md limitation #2 -- brand-new `<img>` nodes vs.
  `src`-swaps on existing ones)?

### candidate-filter accuracy

- Were real manga panels correctly included?
- Were ads/nav/icons/avatars correctly excluded?
- Anything that should have been filtered but wasn't, or vice versa?

### Errors observed

- _(paste verbatim console output, if any)_

---

## VIZ

**Chapter/page tested:** _(URL + chapter number)_

### Image URL / CORS behavior

- Direct fetch worked / fell back to `captureVisibleTab`?
- If fallback: reason logged (`cors` / `network` / `non-2xx` / `blob-url`)?
- Anything notable about how the site serves images (CDN, signed URLs, `blob:` URLs, etc.)?

### Lazy-load behavior

- Did scrolling reveal new pages via the `IntersectionObserver` catch-up path?
- Were any pages missed entirely (see README.md limitation #2 -- brand-new `<img>` nodes vs.
  `src`-swaps on existing ones)?

### candidate-filter accuracy

- Were real manga panels correctly included?
- Were ads/nav/icons/avatars correctly excluded?
- Anything that should have been filtered but wasn't, or vice versa?

### Errors observed

- _(paste verbatim console output, if any)_

---

## Google Photos

**Album/page tested:** _(URL)_

### Image URL / CORS behavior

- Direct fetch worked / fell back to `captureVisibleTab`?
- If fallback: reason logged (`cors` / `network` / `non-2xx` / `blob-url`)?
- Anything notable about how the site serves images (CDN, signed URLs, `blob:` URLs, etc.)?

### Lazy-load behavior

- Did scrolling reveal new photos via the `IntersectionObserver` catch-up path?
- Were any missed entirely (see README.md limitation #2)?

### candidate-filter accuracy

- Were real photos correctly included?
- Were thumbnails/icons/UI chrome correctly excluded?
- Anything that should have been filtered but wasn't, or vice versa? (Google Photos' grid thumbnails
  vs. full-size lightbox view may behave very differently -- note which view you tested.)

### Errors observed

- _(paste verbatim console output, if any)_

---

## (Additional site -- copy this section per extra site tested)

**Site + page tested:** _(URL)_

### Image URL / CORS behavior

-

### Lazy-load behavior

-

### candidate-filter accuracy

-

### Errors observed

-

---

## Summary / go-no-go input

_(Not the final decisions.md paragraph itself -- just raw notes to draw on when writing it.)_
