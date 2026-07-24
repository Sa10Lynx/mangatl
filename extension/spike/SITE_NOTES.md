# Site Notes -- Spec 01 Image Acquisition Spike

Template only. Fill this in by hand while working through README.md's manual test checklist
against each site -- this file is explicitly a human-authored artifact, not something any subagent
should fill in on your behalf.

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

## Summary / go-no-go input

_(Not the final decisions.md paragraph itself -- just raw notes to draw on when writing it.)_
