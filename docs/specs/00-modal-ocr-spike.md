# Spec 00 — Modal OCR Spike

## Goal
Prove that comic-text-detector + manga-ocr, deployed on Modal, can detect and read text on real
manga pages, before any product code is written. This is a go/no-go gate, not production code.

## Inputs
- A single manga page image (JPEG/PNG bytes), passed via HTTP POST.

## Outputs
A JSON list, one entry per detected text region:
```json
[
  {"bbox": [x1, y1, x2, y2], "text": "うちはイタチ", "confidence": 0.94}
]
```
- `bbox` in source-image pixel coordinates (top-left origin).
- `text` is the raw OCR output, no translation, no cleanup.
- `confidence` from the OCR model's own score (0-1).

## What to build
1. A Modal app (`inference/ocr_app.py`) that:
   - Loads comic-text-detector for region detection (bubble/text-block bounding boxes).
   - Loads manga-ocr for per-region text recognition.
   - Exposes one `@modal.web_endpoint` that accepts image bytes and returns the JSON above.
   - Uses Modal's scale-to-zero — no `keep_warm`, we're testing cold-start cost, not hiding it.
2. A small test script (`inference/test_ocr.py`) that:
   - Loads 30 sample manga page images from `inference/test_pages/` (you'll supply these — use
     pages you own/have rights to, not scraped scanlations, per decisions.md).
   - Calls the deployed endpoint for each, saves the JSON output next to each image.
   - Prints a summary: average regions detected per page, average confidence, total latency.

## Edge cases to handle
- Empty/blank page (no text regions) → return `[]`, not an error.
- Very large image (>4000px on a side) → downscale before inference, note this in the response
  metadata, don't crash.
- Model cold start on first call → acceptable to be slow (a few seconds); just don't time out.

## Explicitly NOT in scope for this spec
- No translation. No reading-order sorting. No glossary. No caching. This spec is OCR only.
- Don't build the FastAPI backend yet — this is a standalone Modal app, called directly for testing.

## Definition of done
- Endpoint deployed and callable via `curl` or the test script.
- Run against 30 real manga pages, results look sane on manual spot-check (open 5-10 of the JSON
  outputs next to their source images yourself — this is the one thing you must eyeball personally,
  not delegate).
- A one-paragraph note added to `docs/decisions.md`: did detection/OCR quality look good enough to
  proceed? If not, what specifically failed (vertical text? SFX? stylized fonts?) — this determines
  whether week 2 happens at all.
