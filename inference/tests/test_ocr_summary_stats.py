"""
Unit tests for the stats-aggregation helper used by `inference/test_ocr.py` (the CLI script
described in the spec, item 2 of "What to build": "Prints a summary: average regions detected per
page, average confidence, total latency.").

`test_ocr.py` itself is a CLI script that calls the deployed Modal endpoint for real pages under
`inference/test_pages/` — it is explicitly NOT part of the pytest suite (see the module docstring
in `inference/tests/test_ocr_pipeline.py` and `inference/conftest.py`'s collect_ignore). What IS
unit-testable, and zero-network/zero-GPU, is the pure aggregation function it uses to build its
printed summary. Per the approved file layout there is no separate stats module, so this helper is
expected to be defined directly in `inference/test_ocr.py` and imported here.

Expected public API (in inference/test_ocr.py):

    def summarize_results(page_results: list[dict]) -> dict:
        '''
        page_results: one entry per page that was run through the endpoint, each shaped like:
            {"regions": [{"bbox": [...], "text": "...", "confidence": 0.9}, ...],
             "latency_seconds": 1.23}

        Returns:
            {
                "pages": int,                     # number of pages processed
                "avg_regions_per_page": float,     # total regions / pages; 0.0 if pages == 0
                "avg_confidence": float,           # mean confidence over ALL regions across ALL
                                                    # pages; 0.0 if there are zero regions total
                "total_latency_seconds": float,    # sum of every page's latency_seconds
            }
        '''

Each `page_results` entry must include "latency_seconds" — a page result missing it is a caller
bug and should raise (KeyError), not silently default to 0, since that would corrupt the reported
total latency for a go/no-go spike decision.

Note: importing `test_ocr` here does not execute its CLI/network logic — that logic must live
behind `if __name__ == "__main__":` per the "not part of pytest suite" requirement, and this test
file only ever calls the pure `summarize_results` function.
"""
from __future__ import annotations

import pytest

from test_ocr import summarize_results


def test_summarize_results_empty_input_does_not_crash():
    summary = summarize_results([])

    assert summary["pages"] == 0
    assert summary["avg_regions_per_page"] == 0.0
    assert summary["avg_confidence"] == 0.0
    assert summary["total_latency_seconds"] == 0.0


def test_summarize_results_single_page():
    page_results = [
        {
            "regions": [
                {"bbox": [0, 0, 10, 10], "text": "a", "confidence": 0.8},
                {"bbox": [10, 10, 20, 20], "text": "b", "confidence": 0.6},
            ],
            "latency_seconds": 2.0,
        }
    ]

    summary = summarize_results(page_results)

    assert summary["pages"] == 1
    assert summary["avg_regions_per_page"] == pytest.approx(2.0)
    assert summary["avg_confidence"] == pytest.approx(0.7)
    assert summary["total_latency_seconds"] == pytest.approx(2.0)


def test_summarize_results_multiple_pages_mixed_empty_and_nonempty():
    page_results = [
        {
            "regions": [{"bbox": [0, 0, 1, 1], "text": "a", "confidence": 1.0}],
            "latency_seconds": 1.0,
        },
        {
            "regions": [],  # blank page — contributes 0 regions, no confidence samples
            "latency_seconds": 0.5,
        },
        {
            "regions": [
                {"bbox": [0, 0, 1, 1], "text": "b", "confidence": 0.5},
                {"bbox": [0, 0, 1, 1], "text": "c", "confidence": 0.5},
            ],
            "latency_seconds": 1.5,
        },
    ]

    summary = summarize_results(page_results)

    assert summary["pages"] == 3
    # total regions = 1 + 0 + 2 = 3, over 3 pages
    assert summary["avg_regions_per_page"] == pytest.approx(1.0)
    # confidences seen: 1.0, 0.5, 0.5 -> mean 0.6667 (blank page contributes no samples, doesn't
    # get averaged in as if it were a zero-confidence region)
    assert summary["avg_confidence"] == pytest.approx(2.0 / 3.0)
    assert summary["total_latency_seconds"] == pytest.approx(3.0)


def test_summarize_results_all_pages_blank_avg_confidence_is_zero_not_nan():
    page_results = [
        {"regions": [], "latency_seconds": 0.3},
        {"regions": [], "latency_seconds": 0.4},
    ]

    summary = summarize_results(page_results)

    assert summary["pages"] == 2
    assert summary["avg_regions_per_page"] == 0.0
    assert summary["avg_confidence"] == 0.0
    assert summary["total_latency_seconds"] == pytest.approx(0.7)


def test_summarize_results_missing_latency_key_raises():
    page_results = [{"regions": []}]  # no "latency_seconds"

    with pytest.raises(KeyError):
        summarize_results(page_results)
