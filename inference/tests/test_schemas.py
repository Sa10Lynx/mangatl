"""
Unit tests for `inference/schemas.py` — the response-contract module.

These tests ARE the contract the coder implements against (schemas.py does not exist yet at
test-writing time). Expected public API:

    class SchemaValidationError(ValueError): ...

    def make_region(bbox, text, confidence) -> dict
        # Returns {"bbox": [x1, y1, x2, y2], "text": text, "confidence": confidence}.
        # Raises SchemaValidationError if bbox is not exactly 4 numbers, if x1 >= x2 or
        # y1 >= y2, or if confidence is not a number in [0, 1].

    def make_meta(downscaled, scale_factor, original_size, processed_size) -> dict
        # Returns {"downscaled": bool, "scale_factor": float, "original_size": [w, h],
        #          "processed_size": [w, h]}.
        # Raises SchemaValidationError on internally-inconsistent input:
        #   - downscaled is False but scale_factor != 1.0 or original_size != processed_size
        #   - downscaled is True but scale_factor >= 1.0, or processed_size is not
        #     elementwise <= original_size

    def make_envelope(regions, meta) -> dict
        # Returns {"regions": regions, "meta": meta}. `regions` may be an empty list (the
        # "blank page" case — this is a VALID envelope, not an error).
        # Raises SchemaValidationError if any region or meta is malformed.

    def validate_region(region: dict) -> None   # raises SchemaValidationError on bad shape
    def validate_meta(meta: dict) -> None        # raises SchemaValidationError on bad shape
    def validate_envelope(envelope: dict) -> None

This file covers locked decision #1 (envelope shape, not a bare array; meta reflects
downscaling truthfully) and the "bbox validity" / "confidence in [0,1]" edge cases from the
spec's edge-case list.
"""
from __future__ import annotations

import json

import pytest

import schemas


# ---------------------------------------------------------------------------
# make_region
# ---------------------------------------------------------------------------

def test_make_region_returns_expected_shape():
    region = schemas.make_region([10, 20, 100, 200], "うちはイタチ", 0.94)

    assert region["bbox"] == [10, 20, 100, 200]
    assert region["text"] == "うちはイタチ"
    assert region["confidence"] == 0.94
    assert set(region.keys()) == {"bbox", "text", "confidence"}


@pytest.mark.parametrize("confidence", [0.0, 1.0, 0.5])
def test_make_region_accepts_boundary_and_mid_confidence(confidence):
    region = schemas.make_region([0, 0, 1, 1], "x", confidence)
    assert region["confidence"] == confidence


@pytest.mark.parametrize("confidence", [-0.01, 1.01, -5, 2])
def test_make_region_rejects_confidence_out_of_range(confidence):
    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_region([0, 0, 1, 1], "x", confidence)


def test_make_region_rejects_none_confidence():
    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_region([0, 0, 1, 1], "x", None)


def test_make_region_rejects_non_numeric_confidence():
    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_region([0, 0, 1, 1], "x", "0.9")


@pytest.mark.parametrize(
    "bbox",
    [
        [0, 0, 1],           # only 3 numbers
        [0, 0, 1, 1, 1],     # 5 numbers
        [],                  # empty
    ],
)
def test_make_region_rejects_wrong_length_bbox(bbox):
    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_region(bbox, "x", 0.5)


@pytest.mark.parametrize(
    "bbox",
    [
        [10, 0, 10, 5],   # x1 == x2
        [10, 0, 5, 5],    # x1 > x2
        [0, 10, 5, 10],   # y1 == y2
        [0, 10, 5, 5],    # y1 > y2
    ],
)
def test_make_region_rejects_bad_bbox_ordering(bbox):
    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_region(bbox, "x", 0.5)


def test_make_region_accepts_valid_ordering():
    # x1 < x2 and y1 < y2, the only ordering the contract requires.
    region = schemas.make_region([1, 2, 3, 4], "x", 0.5)
    assert region["bbox"] == [1, 2, 3, 4]


# ---------------------------------------------------------------------------
# make_meta
# ---------------------------------------------------------------------------

def test_make_meta_no_downscale_case():
    meta = schemas.make_meta(
        downscaled=False,
        scale_factor=1.0,
        original_size=(1200, 800),
        processed_size=(1200, 800),
    )
    assert meta == {
        "downscaled": False,
        "scale_factor": 1.0,
        "original_size": [1200, 800],
        "processed_size": [1200, 800],
    }


def test_make_meta_downscaled_case():
    meta = schemas.make_meta(
        downscaled=True,
        scale_factor=0.5,
        original_size=(8000, 6000),
        processed_size=(4000, 3000),
    )
    assert meta["downscaled"] is True
    assert meta["scale_factor"] == 0.5
    assert meta["original_size"] == [8000, 6000]
    assert meta["processed_size"] == [4000, 3000]


def test_make_meta_rejects_downscaled_false_with_scale_factor_not_one():
    # Locked decision #1: when no downscaling happened, scale_factor must reflect "no change".
    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_meta(
            downscaled=False,
            scale_factor=0.5,
            original_size=(1200, 800),
            processed_size=(1200, 800),
        )


def test_make_meta_rejects_downscaled_false_with_mismatched_sizes():
    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_meta(
            downscaled=False,
            scale_factor=1.0,
            original_size=(1200, 800),
            processed_size=(600, 400),
        )


def test_make_meta_rejects_downscaled_true_with_scale_factor_not_less_than_one():
    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_meta(
            downscaled=True,
            scale_factor=1.0,
            original_size=(8000, 6000),
            processed_size=(8000, 6000),
        )


def test_make_meta_rejects_downscaled_true_with_upscaled_processed_size():
    # processed_size must never exceed original_size — downscaling only ever shrinks.
    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_meta(
            downscaled=True,
            scale_factor=0.5,
            original_size=(1000, 1000),
            processed_size=(2000, 2000),
        )


# ---------------------------------------------------------------------------
# make_envelope / validate_envelope
# ---------------------------------------------------------------------------

def test_make_envelope_with_empty_regions_is_valid():
    # This is the "blank page" contract: regions == [] is success, not an error.
    meta = schemas.make_meta(
        downscaled=False,
        scale_factor=1.0,
        original_size=(400, 600),
        processed_size=(400, 600),
    )
    envelope = schemas.make_envelope([], meta)

    assert envelope["regions"] == []
    assert envelope["meta"] == meta
    assert set(envelope.keys()) == {"regions", "meta"}


def test_make_envelope_is_not_a_bare_list():
    # Locked decision #1: response is an envelope object, never a bare array.
    meta = schemas.make_meta(
        downscaled=False,
        scale_factor=1.0,
        original_size=(10, 10),
        processed_size=(10, 10),
    )
    envelope = schemas.make_envelope([], meta)

    assert isinstance(envelope, dict)
    assert not isinstance(envelope, list)


def test_make_envelope_with_regions():
    region = schemas.make_region([0, 0, 10, 10], "hi", 0.8)
    meta = schemas.make_meta(
        downscaled=False,
        scale_factor=1.0,
        original_size=(10, 10),
        processed_size=(10, 10),
    )
    envelope = schemas.make_envelope([region], meta)

    assert envelope["regions"] == [region]


def test_make_envelope_rejects_malformed_region():
    meta = schemas.make_meta(
        downscaled=False,
        scale_factor=1.0,
        original_size=(10, 10),
        processed_size=(10, 10),
    )
    bad_region = {"bbox": [0, 0, 10], "text": "x", "confidence": 0.5}  # bad bbox length

    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_envelope([bad_region], meta)


def test_make_envelope_rejects_malformed_meta():
    region = schemas.make_region([0, 0, 10, 10], "x", 0.5)
    bad_meta = {"downscaled": False, "scale_factor": 0.5,
                "original_size": [10, 10], "processed_size": [10, 10]}

    with pytest.raises(schemas.SchemaValidationError):
        schemas.make_envelope([region], bad_meta)


def test_envelope_is_json_serializable():
    # The endpoint returns this as an HTTP JSON body; it must round-trip cleanly and must never
    # contain raw bytes (images are transient / never persisted or leaked, per CLAUDE.md).
    region = schemas.make_region([0, 0, 10, 10], "hi", 0.8)
    meta = schemas.make_meta(
        downscaled=True,
        scale_factor=0.5,
        original_size=(20, 20),
        processed_size=(10, 10),
    )
    envelope = schemas.make_envelope([region], meta)

    serialized = json.dumps(envelope)
    round_tripped = json.loads(serialized)
    assert round_tripped == envelope
