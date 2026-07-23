"""
CLI script for the spec-00 Modal OCR spike (docs/specs/00-modal-ocr-spike.md, "What to build" #2).

Calls the *deployed* Modal endpoint for every image under `inference/test_pages/`, saves the JSON
response next to each source image, and prints a summary: average regions detected per page,
average confidence, and total latency.

This file is deliberately NOT part of the pytest suite (see `inference/conftest.py`'s
`collect_ignore` and the module docstring in `inference/tests/test_ocr_pipeline.py`) -- it makes
real network calls against a live, billed Modal deployment. All network/CLI logic therefore lives
behind `if __name__ == "__main__":`. The only thing imported and unit-tested elsewhere
(`inference/tests/test_ocr_summary_stats.py`) is the pure `summarize_results(...)` function below,
which has no I/O of its own.
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

TEST_PAGES_DIR = Path(__file__).resolve().parent / "test_pages"


def summarize_results(page_results: list[dict]) -> dict:
    """
    page_results: one entry per page that was run through the endpoint, each shaped like:
        {"regions": [{"bbox": [...], "text": "...", "confidence": 0.9}, ...],
         "latency_seconds": 1.23}

    Returns:
        {
            "pages": int,
            "avg_regions_per_page": float,   # 0.0 if pages == 0
            "avg_confidence": float,         # mean confidence over ALL regions across ALL pages;
                                              # 0.0 if there are zero regions total
            "total_latency_seconds": float,
        }

    A page result missing "latency_seconds" is a caller bug and raises KeyError -- it must never
    silently default to 0, since that would corrupt the reported total latency for a go/no-go
    spike decision.
    """
    pages = len(page_results)
    total_latency_seconds = 0.0
    total_regions = 0
    confidence_sum = 0.0
    confidence_count = 0

    for page_result in page_results:
        total_latency_seconds += page_result["latency_seconds"]
        regions = page_result.get("regions", [])
        total_regions += len(regions)
        for region in regions:
            confidence_sum += region["confidence"]
            confidence_count += 1

    avg_regions_per_page = (total_regions / pages) if pages else 0.0
    avg_confidence = (confidence_sum / confidence_count) if confidence_count else 0.0

    return {
        "pages": pages,
        "avg_regions_per_page": avg_regions_per_page,
        "avg_confidence": avg_confidence,
        "total_latency_seconds": total_latency_seconds,
    }


def _iter_test_page_paths(test_pages_dir: Path):
    for path in sorted(test_pages_dir.iterdir()):
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png"}:
            yield path


def _call_endpoint(endpoint_url: str, spike_key: str, image_bytes: bytes) -> tuple[dict, float]:
    headers = {"X-Spike-Key": spike_key, "Content-Type": "application/octet-stream"}
    request = urllib.request.Request(endpoint_url, data=image_bytes, headers=headers, method="POST")

    start = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        latency_seconds = time.monotonic() - start
        raise RuntimeError(
            f"endpoint returned HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')}"
        ) from exc
    latency_seconds = time.monotonic() - start

    return json.loads(body), latency_seconds


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Call the deployed spec-00 Modal OCR endpoint against inference/test_pages/."
    )
    parser.add_argument(
        "--endpoint-url",
        default=os.environ.get("OCR_ENDPOINT_URL"),
        help="Deployed Modal web endpoint URL (or set OCR_ENDPOINT_URL).",
    )
    parser.add_argument(
        "--spike-key",
        default=os.environ.get("SPIKE_KEY"),
        help="Shared secret sent as the X-Spike-Key header (or set SPIKE_KEY).",
    )
    parser.add_argument(
        "--test-pages-dir",
        default=str(TEST_PAGES_DIR),
        help="Directory of source page images to run through the endpoint.",
    )
    args = parser.parse_args()

    if not args.endpoint_url:
        raise SystemExit("--endpoint-url or OCR_ENDPOINT_URL is required")
    if not args.spike_key:
        raise SystemExit("--spike-key or SPIKE_KEY is required")

    test_pages_dir = Path(args.test_pages_dir)
    page_results = []

    for image_path in _iter_test_page_paths(test_pages_dir):
        image_bytes = image_path.read_bytes()
        envelope, latency_seconds = _call_endpoint(args.endpoint_url, args.spike_key, image_bytes)

        page_result = {"regions": envelope.get("regions", []), "latency_seconds": latency_seconds}
        page_results.append(page_result)

        output_path = image_path.with_suffix(image_path.suffix + ".json")
        output_path.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{image_path.name}: {len(page_result['regions'])} regions, {latency_seconds:.2f}s")

    summary = summarize_results(page_results)
    print("\n--- Summary ---")
    print(f"Pages processed:        {summary['pages']}")
    print(f"Avg regions per page:   {summary['avg_regions_per_page']:.2f}")
    print(f"Avg confidence:         {summary['avg_confidence']:.3f}")
    print(f"Total latency (s):      {summary['total_latency_seconds']:.2f}")


if __name__ == "__main__":
    main()
