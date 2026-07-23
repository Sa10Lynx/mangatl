"""
Pure orchestration for the spec-00 Modal OCR spike.

This module has ZERO Modal-specific imports on purpose (see docs/specs/00-modal-ocr-spike.md and
CLAUDE.md): `ocr_app.py` is the only place that talks to Modal, and it calls into
`process_image(...)` here with a real detector/OCR model loaded via `model_loader.py`'s
dependency-injection seam. Keeping this module Modal-free means it can be unit tested with plain
Pillow-built images and test-double detector/OCR objects, with no GPU and no network access.

CLAUDE.md invariant 3 (images are transient, never persisted): nothing in this module ever writes
image bytes, crops, or derived pixel data to disk or any persistent store. Everything here is
in-memory only.
"""
from __future__ import annotations

import io

from PIL import Image, UnidentifiedImageError

import schemas

# Pillow's default `Image.MAX_IMAGE_PIXELS` (~179 megapixels) is tuned as a generic
# decompression-bomb guard, but it's well below what a legitimate large manga scan needs: a
# 20000x12000 page (240MP) is a real, valid input per this spec's Edge Cases section ("large
# images should be downscaled and processed successfully, not rejected"), yet it trips Pillow's
# bomb guard *before* `downscale_if_needed` (which only checks per-side dimensions) ever runs,
# raising `PIL.Image.DecompressionBombError` — which is NOT caught by the
# (UnidentifiedImageError, OSError, ValueError) tuple below, since it inherits directly from
# `Exception`. Raise the bound to comfortably cover large-but-real manga scans (enough for at
# least a 20000x20000 page) while still keeping a finite ceiling as a genuine DoS guard against
# pathological inputs (e.g. a crafted 1,000,000x1,000,000 "image"). Do NOT set this to None —
# that disables the guard entirely.
Image.MAX_IMAGE_PIXELS = 20000 * 20000  # 400 megapixels


class InvalidImageError(Exception):
    """Raised when input bytes cannot be decoded as an image."""


def downscale_if_needed(image: "Image.Image", max_dim: int = 4000):
    """
    If the longest side of `image` exceeds `max_dim`, resize it down (preserving aspect ratio) and
    return (resized_image, meta). Otherwise return (image, meta) unchanged.

    `meta` is always shaped compatibly with schemas.make_meta(...)'s output.

    Boundary: exactly `max_dim` on the longest side does NOT trigger downscaling (spec says
    ">4000px", i.e. strictly greater than).
    """
    original_size = (image.width, image.height)
    longest_side = max(original_size)

    if longest_side <= max_dim:
        meta = schemas.make_meta(
            downscaled=False,
            scale_factor=1.0,
            original_size=original_size,
            processed_size=original_size,
        )
        return image, meta

    scale_factor = max_dim / longest_side
    processed_size = (
        max(1, round(original_size[0] * scale_factor)),
        max(1, round(original_size[1] * scale_factor)),
    )
    resized = image.resize(processed_size)

    meta = schemas.make_meta(
        downscaled=True,
        scale_factor=scale_factor,
        original_size=original_size,
        processed_size=processed_size,
    )
    return resized, meta


def rescale_bbox(bbox, scale_factor) -> list:
    """
    Map a bbox expressed in the *processed* (possibly-downscaled) image's coordinate space back to
    the *original* image's pixel coordinate space, i.e. divide by scale_factor.
    """
    return [coord / scale_factor for coord in bbox]


def check_authorized(provided_key, expected_key) -> bool:
    """
    Pure, framework-agnostic shared-secret check for the X-Spike-Key header (locked decision #2).
    Fails closed: any missing/empty/None value on either side is NOT authorized.
    """
    if not provided_key or not expected_key:
        return False
    return provided_key == expected_key


def _decode_image(image_bytes: bytes) -> "Image.Image":
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
    ) as exc:
        # DecompressionBombError inherits directly from Exception (not OSError/ValueError), so it
        # must be listed explicitly. This is a backstop for inputs that exceed even the raised
        # `Image.MAX_IMAGE_PIXELS` bound above -- pathological/adversarial inputs, not real manga
        # scans, get a 400 here rather than crashing the process.
        raise InvalidImageError(f"could not decode image bytes: {exc}") from exc
    return image.convert("RGB")


def process_image(image_bytes: bytes, detector, ocr_model, max_dim: int = 4000) -> dict:
    """
    Decode `image_bytes`, downscale if needed, run detection + OCR, and return a validated
    envelope with bboxes rescaled back to ORIGINAL image pixel coordinates.

    Never filters/drops regions by confidence (pass-through only — L4/backend territory later).
    Never writes anything to disk.
    """
    image = _decode_image(image_bytes)

    processed_image, meta = downscale_if_needed(image, max_dim=max_dim)
    scale_factor = meta["scale_factor"]

    boxes = detector.detect(processed_image)

    regions = []
    for box in boxes:
        crop = processed_image.crop(tuple(box))
        text, confidence = ocr_model.recognize(crop)
        original_bbox = rescale_bbox(box, scale_factor)
        regions.append(schemas.make_region(original_bbox, text, confidence))

    return schemas.make_envelope(regions, meta)
