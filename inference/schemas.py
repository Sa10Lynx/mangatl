"""
Response-contract module for the spec-00 Modal OCR spike.

Defines the shape of the JSON envelope returned by the OCR endpoint:

    {"regions": [{"bbox": [x1, y1, x2, y2], "text": str, "confidence": float}, ...],
     "meta": {"downscaled": bool, "scale_factor": float,
              "original_size": [w, h], "processed_size": [w, h]}}

The envelope is always an object (dict), never a bare list — this is a locked design decision so
future fields (e.g. request id, model version) can be added without breaking clients.

Every `make_*` constructor validates its own output before returning it, and the corresponding
`validate_*` function can be called independently against any dict of the right shape (e.g. to
re-check a dict assembled by `ocr_pipeline.py` without going through the constructor).
"""
from __future__ import annotations

import numbers


class SchemaValidationError(ValueError):
    """Raised when a region/meta/envelope dict does not match the response contract."""


def _is_number(value) -> bool:
    # bool is a subclass of int in Python; explicitly reject it so True/False never pass as
    # numeric confidence/scale_factor/bbox values.
    return isinstance(value, numbers.Real) and not isinstance(value, bool)


def validate_region(region: dict) -> None:
    if not isinstance(region, dict):
        raise SchemaValidationError(f"region must be a dict, got {type(region)!r}")

    if set(region.keys()) != {"bbox", "text", "confidence"}:
        raise SchemaValidationError(
            f"region must have exactly keys 'bbox', 'text', 'confidence', got {set(region.keys())!r}"
        )

    bbox = region["bbox"]
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        raise SchemaValidationError(f"bbox must be exactly 4 numbers, got {bbox!r}")
    if not all(_is_number(coord) for coord in bbox):
        raise SchemaValidationError(f"bbox coordinates must all be numeric, got {bbox!r}")

    x1, y1, x2, y2 = bbox
    if x1 >= x2:
        raise SchemaValidationError(f"bbox x1 must be < x2, got x1={x1!r} x2={x2!r}")
    if y1 >= y2:
        raise SchemaValidationError(f"bbox y1 must be < y2, got y1={y1!r} y2={y2!r}")

    if not isinstance(region["text"], str):
        raise SchemaValidationError(f"text must be a str, got {type(region['text'])!r}")

    confidence = region["confidence"]
    if not _is_number(confidence):
        raise SchemaValidationError(f"confidence must be a number, got {confidence!r}")
    if not (0.0 <= confidence <= 1.0):
        raise SchemaValidationError(f"confidence must be in [0, 1], got {confidence!r}")


def validate_meta(meta: dict) -> None:
    if not isinstance(meta, dict):
        raise SchemaValidationError(f"meta must be a dict, got {type(meta)!r}")

    expected_keys = {"downscaled", "scale_factor", "original_size", "processed_size"}
    if set(meta.keys()) != expected_keys:
        raise SchemaValidationError(f"meta must have exactly keys {expected_keys}, got {set(meta.keys())!r}")

    downscaled = meta["downscaled"]
    if not isinstance(downscaled, bool):
        raise SchemaValidationError(f"downscaled must be a bool, got {type(downscaled)!r}")

    scale_factor = meta["scale_factor"]
    if not _is_number(scale_factor):
        raise SchemaValidationError(f"scale_factor must be a number, got {scale_factor!r}")

    original_size = meta["original_size"]
    processed_size = meta["processed_size"]
    for name, size in (("original_size", original_size), ("processed_size", processed_size)):
        if not isinstance(size, (list, tuple)) or len(size) != 2:
            raise SchemaValidationError(f"{name} must be exactly [w, h], got {size!r}")
        if not all(_is_number(v) for v in size):
            raise SchemaValidationError(f"{name} values must be numeric, got {size!r}")

    if downscaled:
        if not (scale_factor < 1.0):
            raise SchemaValidationError(
                f"downscaled=True requires scale_factor < 1.0, got {scale_factor!r}"
            )
        if not (processed_size[0] <= original_size[0] and processed_size[1] <= original_size[1]):
            raise SchemaValidationError(
                "downscaled=True requires processed_size to be elementwise <= original_size, "
                f"got original_size={original_size!r} processed_size={processed_size!r}"
            )
    else:
        if scale_factor != 1.0:
            raise SchemaValidationError(
                f"downscaled=False requires scale_factor == 1.0, got {scale_factor!r}"
            )
        if list(original_size) != list(processed_size):
            raise SchemaValidationError(
                "downscaled=False requires original_size == processed_size, "
                f"got original_size={original_size!r} processed_size={processed_size!r}"
            )


def validate_envelope(envelope: dict) -> None:
    if not isinstance(envelope, dict):
        raise SchemaValidationError(f"envelope must be a dict, got {type(envelope)!r}")

    if set(envelope.keys()) != {"regions", "meta"}:
        raise SchemaValidationError(
            f"envelope must have exactly keys 'regions', 'meta', got {set(envelope.keys())!r}"
        )

    regions = envelope["regions"]
    if not isinstance(regions, list):
        raise SchemaValidationError(f"regions must be a list, got {type(regions)!r}")
    for region in regions:
        validate_region(region)

    validate_meta(envelope["meta"])


def make_region(bbox, text, confidence) -> dict:
    region = {"bbox": list(bbox) if isinstance(bbox, (list, tuple)) else bbox, "text": text, "confidence": confidence}
    validate_region(region)
    return region


def make_meta(downscaled, scale_factor, original_size, processed_size) -> dict:
    meta = {
        "downscaled": downscaled,
        "scale_factor": scale_factor,
        "original_size": list(original_size),
        "processed_size": list(processed_size),
    }
    validate_meta(meta)
    return meta


def make_envelope(regions, meta) -> dict:
    envelope = {"regions": list(regions), "meta": meta}
    validate_envelope(envelope)
    return envelope
