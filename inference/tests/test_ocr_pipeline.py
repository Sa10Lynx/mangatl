"""
Unit tests for `inference/ocr_pipeline.py` — pure orchestration, no GPU, no network.

These tests ARE the contract the coder implements against (ocr_pipeline.py does not exist yet at
test-writing time). Expected public API:

    class InvalidImageError(Exception): ...
        # Raised when input bytes cannot be decoded as an image.

    def downscale_if_needed(image: PIL.Image.Image, max_dim: int = 4000)
            -> tuple[PIL.Image.Image, dict]:
        # If max(image.width, image.height) > max_dim: resize preserving aspect ratio and return
        # (resized_image, meta) with meta["downscaled"] == True.
        # Otherwise: return (image, meta) unchanged, with meta["downscaled"] == False and
        # scale_factor == 1.0 and original_size == processed_size.
        # `meta` must be a dict compatible with schemas.make_meta(...)'s output shape.
        # Boundary: exactly max_dim on the longest side does NOT trigger downscaling (spec says
        # ">4000px", i.e. strictly greater than).

    def rescale_bbox(bbox, scale_factor) -> list:
        # Maps a bbox expressed in the *processed* (possibly-downscaled) image's coordinate
        # space back to the *original* image's pixel coordinate space, i.e. divides by
        # scale_factor. scale_factor == 1.0 is a no-op.

    def check_authorized(provided_key, expected_key) -> bool:
        # Pure, framework-agnostic version of the X-Spike-Key shared-secret check (locked
        # decision #2). Fails closed: any missing/empty/misconfigured value on either side is
        # NOT authorized. ocr_app.py's web_endpoint is expected to call this first, before doing
        # any OCR work, and return HTTP 403 if it returns False. (The HTTP wiring itself lives in
        # ocr_app.py and is not unit-tested here — see the "no live endpoint tests" note in the
        # module docstring below.)

    def process_image(image_bytes: bytes, detector, ocr_model, max_dim: int = 4000) -> dict:
        # detector: object with .detect(image: PIL.Image.Image) -> list of 4-number bboxes, in
        #           the coordinate space of the *processed* image it was given.
        # ocr_model: object with .recognize(crop: PIL.Image.Image) -> tuple[str, float]
        # Returns an envelope dict per schemas.make_envelope: {"regions": [...], "meta": {...}}.
        # Raises InvalidImageError if image_bytes cannot be decoded as an image (this is
        # distinct from the "valid image, zero regions detected" case, which returns a normal
        # 200-shaped envelope with regions == []).
        # Does NOT filter, drop, or threshold regions by confidence — that is L4/backend
        # territory later (architecture-v2.md Part C), out of scope for this OCR spike.
        # Never writes image bytes to disk or any persistent store (CLAUDE.md invariant 3).

Note on endpoint-level testing: per the approved plan, there is deliberately no pytest test that
calls the live Modal endpoint (`ocr_app.py`) — that costs real GPU spend and needs a live
deployment. Endpoint-level smoke testing (`X-Spike-Key` header end-to-end, actual HTTP 403/400/200
responses) is a manual `curl`/human step, documented as part of the spec's "Definition of done".
What IS unit-tested here is the pure `check_authorized` logic that the endpoint handler is
expected to call before doing any OCR work.
"""
from __future__ import annotations

import io

import pytest
from PIL import Image

import ocr_pipeline
import schemas


# ---------------------------------------------------------------------------
# downscale_if_needed
# ---------------------------------------------------------------------------

def test_downscale_not_triggered_under_threshold(small_image_bytes):
    image = Image.open(io.BytesIO(small_image_bytes))
    processed, meta = ocr_pipeline.downscale_if_needed(image, max_dim=4000)

    assert meta["downscaled"] is False
    assert meta["scale_factor"] == 1.0
    assert meta["original_size"] == [1200, 800]
    assert meta["processed_size"] == [1200, 800]
    assert processed.size == (1200, 800)


def test_downscale_not_triggered_exactly_at_threshold(just_under_threshold_image_bytes):
    # Boundary case: exactly 4000px on the long side must NOT downscale ("> 4000px" triggers it).
    image = Image.open(io.BytesIO(just_under_threshold_image_bytes))
    processed, meta = ocr_pipeline.downscale_if_needed(image, max_dim=4000)

    assert meta["downscaled"] is False
    assert meta["scale_factor"] == 1.0
    assert meta["original_size"] == [4000, 10]
    assert meta["processed_size"] == [4000, 10]


def test_downscale_triggered_one_pixel_over_threshold(just_over_threshold_image_bytes):
    image = Image.open(io.BytesIO(just_over_threshold_image_bytes))
    processed, meta = ocr_pipeline.downscale_if_needed(image, max_dim=4000)

    assert meta["downscaled"] is True
    assert meta["original_size"] == [4001, 10]
    assert meta["processed_size"][0] <= 4000
    assert meta["scale_factor"] < 1.0


def test_downscale_triggered_preserves_aspect_ratio_exact_scale(oversized_image_bytes):
    # 8000x10 with max_dim=4000 -> scale_factor exactly 0.5, processed_size exactly (4000, 5).
    image = Image.open(io.BytesIO(oversized_image_bytes))
    processed, meta = ocr_pipeline.downscale_if_needed(image, max_dim=4000)

    assert meta["downscaled"] is True
    assert meta["scale_factor"] == pytest.approx(0.5)
    assert meta["original_size"] == [8000, 10]
    assert meta["processed_size"] == [4000, 5]
    assert processed.size == (4000, 5)


def test_downscale_result_is_schema_valid_meta(oversized_image_bytes):
    image = Image.open(io.BytesIO(oversized_image_bytes))
    _, meta = ocr_pipeline.downscale_if_needed(image, max_dim=4000)
    # Should not raise: downscale_if_needed's meta must satisfy schemas' own invariants.
    schemas.validate_meta(meta)


# ---------------------------------------------------------------------------
# rescale_bbox
# ---------------------------------------------------------------------------

def test_rescale_bbox_noop_at_scale_factor_one():
    bbox = [10, 20, 30, 40]
    assert list(ocr_pipeline.rescale_bbox(bbox, 1.0)) == [10, 20, 30, 40]


def test_rescale_bbox_maps_processed_coords_back_to_original():
    # scale_factor 0.5 means processed image is half the size of original, so rescaling divides
    # by 0.5 (i.e. multiplies coordinates by 2) to recover original-image pixel coordinates.
    bbox = [1000, 0, 3000, 5]
    result = list(ocr_pipeline.rescale_bbox(bbox, 0.5))
    assert result == [2000, 0, 6000, 10]


# ---------------------------------------------------------------------------
# check_authorized (locked decision #2 — pure logic only; HTTP wiring is manual/curl-tested)
# ---------------------------------------------------------------------------

def test_check_authorized_true_when_keys_match():
    assert ocr_pipeline.check_authorized("s3cr3t", "s3cr3t") is True


@pytest.mark.parametrize(
    "provided,expected",
    [
        (None, "s3cr3t"),        # missing header
        ("wrong", "s3cr3t"),     # wrong header value
        ("s3cr3t", None),       # server misconfigured (no expected key set) -> fail closed
        (None, None),           # nothing configured on either side -> fail closed
        ("", ""),               # both empty -> must not silently "match"
        ("s3cr3t", ""),          # expected key is empty -> fail closed
    ],
)
def test_check_authorized_false_for_missing_or_mismatched_or_misconfigured(provided, expected):
    assert ocr_pipeline.check_authorized(provided, expected) is False


# ---------------------------------------------------------------------------
# process_image — happy paths
# ---------------------------------------------------------------------------

def test_process_image_normal_size_no_downscale(
    small_image_bytes, make_fake_detector, make_fake_ocr_model
):
    detector = make_fake_detector(bboxes=[[10, 10, 100, 100]])
    ocr_model = make_fake_ocr_model(results=[("hello", 0.9)])

    result = ocr_pipeline.process_image(small_image_bytes, detector, ocr_model)

    assert result["meta"]["downscaled"] is False
    assert result["meta"]["scale_factor"] == 1.0
    assert result["meta"]["original_size"] == result["meta"]["processed_size"] == [1200, 800]
    # No downscaling happened, so bbox passes through unchanged.
    assert result["regions"] == [{"bbox": [10, 10, 100, 100], "text": "hello", "confidence": 0.9}]


def test_process_image_rescales_bboxes_to_original_coordinates_when_downscaled(
    oversized_image_bytes, make_fake_detector, make_fake_ocr_model
):
    # This is the case explicitly flagged as easy to get wrong: bboxes must come back in
    # ORIGINAL image pixel coordinates, not the downscaled working coordinates the detector saw.
    detector = make_fake_detector(bboxes=[[1000, 0, 3000, 5]])  # coords in the 4000x5 working image
    ocr_model = make_fake_ocr_model(results=[("SFX", 0.7)])

    result = ocr_pipeline.process_image(oversized_image_bytes, detector, ocr_model)

    assert result["meta"]["downscaled"] is True
    assert result["meta"]["scale_factor"] == pytest.approx(0.5)
    assert result["meta"]["original_size"] == [8000, 10]
    assert result["meta"]["processed_size"] == [4000, 5]

    assert len(result["regions"]) == 1
    region = result["regions"][0]
    # Rescaled back to the 8000x10 ORIGINAL image's coordinate space, not the 4000x5 working one.
    assert region["bbox"] == [2000, 0, 6000, 10]
    assert region["text"] == "SFX"
    assert region["confidence"] == 0.7


def test_process_image_detector_receives_the_processed_working_image(
    oversized_image_bytes, make_fake_detector, make_fake_ocr_model
):
    detector = make_fake_detector(bboxes=[])
    ocr_model = make_fake_ocr_model(results=[])

    ocr_pipeline.process_image(oversized_image_bytes, detector, ocr_model)

    assert len(detector.calls) == 1
    seen_image = detector.calls[0]
    # The detector must see the downscaled *working* image, not the original 8000x10 one.
    assert seen_image.size == (4000, 5)


# ---------------------------------------------------------------------------
# process_image — empty / blank page (valid input, zero regions -> success, not an error)
# ---------------------------------------------------------------------------

def test_process_image_blank_page_returns_empty_regions_not_an_error(
    blank_page_image_bytes, make_fake_detector, make_fake_ocr_model
):
    detector = make_fake_detector(bboxes=[])
    ocr_model = make_fake_ocr_model(results=[])

    result = ocr_pipeline.process_image(blank_page_image_bytes, detector, ocr_model)

    assert result["regions"] == []
    # Must still be a well-formed envelope with meta, not a bare error / bare list.
    schemas.validate_envelope(result)


# ---------------------------------------------------------------------------
# process_image — corrupt / non-image input (distinct from the blank-page case)
# ---------------------------------------------------------------------------

def test_process_image_corrupt_bytes_raises_invalid_image_error(
    corrupt_image_bytes, make_fake_detector, make_fake_ocr_model
):
    detector = make_fake_detector(bboxes=[])
    ocr_model = make_fake_ocr_model(results=[])

    with pytest.raises(ocr_pipeline.InvalidImageError):
        ocr_pipeline.process_image(corrupt_image_bytes, detector, ocr_model)

    # Corrupt input must never reach the detector/OCR model at all.
    assert detector.calls == []
    assert ocr_model.calls == []


# ---------------------------------------------------------------------------
# Confidence pass-through: low-confidence regions are NOT dropped/filtered here (locked decision #3)
# ---------------------------------------------------------------------------

def test_process_image_does_not_drop_low_confidence_regions(
    small_image_bytes, make_fake_detector, make_fake_ocr_model
):
    detector = make_fake_detector(bboxes=[[0, 0, 10, 10], [20, 20, 40, 40]])
    ocr_model = make_fake_ocr_model(results=[("clear text", 0.95), ("garbled ???", 0.02)])

    result = ocr_pipeline.process_image(small_image_bytes, detector, ocr_model)

    # Both regions present, including the very-low-confidence one. Filtering low-confidence
    # regions is explicitly L4/backend territory later (architecture-v2.md), not this spike.
    assert len(result["regions"]) == 2
    confidences = [r["confidence"] for r in result["regions"]]
    assert 0.02 in confidences
    assert 0.95 in confidences


def test_process_image_region_bboxes_and_confidences_are_schema_valid(
    small_image_bytes, make_fake_detector, make_fake_ocr_model
):
    detector = make_fake_detector(bboxes=[[0, 0, 10, 10]])
    ocr_model = make_fake_ocr_model(results=[("x", 0.5)])

    result = ocr_pipeline.process_image(small_image_bytes, detector, ocr_model)

    schemas.validate_envelope(result)
    for region in result["regions"]:
        x1, y1, x2, y2 = region["bbox"]
        assert len(region["bbox"]) == 4
        assert x1 < x2
        assert y1 < y2
        assert 0.0 <= region["confidence"] <= 1.0


# ---------------------------------------------------------------------------
# CLAUDE.md invariant 3 — images are transient, never persisted
# ---------------------------------------------------------------------------

def test_process_image_never_writes_any_file_to_disk(
    small_image_bytes, make_fake_detector, make_fake_ocr_model, tmp_path, monkeypatch
):
    detector = make_fake_detector(bboxes=[[0, 0, 10, 10]])
    ocr_model = make_fake_ocr_model(results=[("x", 0.5)])

    monkeypatch.chdir(tmp_path)
    ocr_pipeline.process_image(small_image_bytes, detector, ocr_model)

    # No incidental files (e.g. caching the uploaded image, writing crops, logging bytes to
    # disk) should appear anywhere under the working directory as a side effect of OCR.
    assert list(tmp_path.rglob("*")) == []
