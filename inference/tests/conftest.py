"""
Shared fixtures for the spec-00 (Modal OCR spike) unit test suite.

Design constraints these fixtures exist to satisfy (see docs/specs/00-modal-ocr-spike.md and the
approved plan):

- Zero GPU access, zero network access. Every fixture here builds tiny synthetic images in-memory
  with Pillow; nothing reads from `inference/test_pages/` (that corpus is real, rights-sensitive
  manga scans and is explicitly out of bounds for the automated test suite).
- The detector and OCR model are always test doubles (FakeDetector / FakeOCRModel below), injected
  directly into `ocr_pipeline.process_image(...)` via its DI seam. Nothing here touches
  `model_loader.py`'s real `load_detector()` / `load_ocr_model()`, which is expected to load real
  (heavy, network-fetched) model weights in production and is intentionally untested at this layer.

sys.path handling: `inference/` has no package `__init__.py` (by design, per the approved plan's
file layout), so this conftest inserts the `inference/` directory onto `sys.path` at import time.
This lets every test module do plain top-level imports (`import schemas`, `from ocr_pipeline import
...`, `from test_ocr import summarize_results`) regardless of which directory pytest is invoked
from.
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest
from PIL import Image

INFERENCE_DIR = Path(__file__).resolve().parent.parent
if str(INFERENCE_DIR) not in sys.path:
    sys.path.insert(0, str(INFERENCE_DIR))


def _make_png_bytes(width: int, height: int, color=(255, 255, 255)) -> bytes:
    """Build a tiny solid-color PNG in memory. No disk I/O, no network."""
    image = Image.new("RGB", (width, height), color=color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def png_bytes_factory():
    """Factory fixture: png_bytes_factory(width, height, color=(255,255,255)) -> bytes."""
    return _make_png_bytes


@pytest.fixture
def small_image_bytes() -> bytes:
    """A normal-size page, well under the 4000px downscale threshold on both sides."""
    return _make_png_bytes(1200, 800)


@pytest.fixture
def blank_page_image_bytes() -> bytes:
    """A valid, decodable, blank/textless page. Distinct fixture name from small_image_bytes so
    intent is obvious at call sites, even though the bytes-generation is the same shape — the
    "blank page" behavior in this suite comes from pairing this with a FakeDetector that reports
    zero regions, not from anything about the pixels themselves."""
    return _make_png_bytes(400, 600)


@pytest.fixture
def oversized_image_bytes() -> bytes:
    """
    A page that exceeds the 4000px-on-a-side downscale trigger, sized so the downscale math is
    exact (no rounding ambiguity in tests): 8000 wide (>4000) x 10 tall.

    With the spec's default max_dim=4000: scale_factor = 4000/8000 = 0.5 exactly,
    processed_size = (4000, 5) exactly. Kept extremely thin (height=10) so the fixture is cheap to
    generate and resize despite the large width.
    """
    return _make_png_bytes(8000, 10)


@pytest.fixture
def just_under_threshold_image_bytes() -> bytes:
    """Exactly at the 4000px boundary on the wide side. Spec says '>4000px' triggers downscaling,
    so exactly 4000 must NOT trigger it. Thin on the other side to stay cheap."""
    return _make_png_bytes(4000, 10)


@pytest.fixture
def just_over_threshold_image_bytes() -> bytes:
    """One pixel over the 4000px boundary — must trigger downscaling."""
    return _make_png_bytes(4001, 10)


@pytest.fixture
def corrupt_image_bytes() -> bytes:
    """Bytes that are not a decodable image at all (not merely a truncated/malformed PNG,
    to avoid relying on Pillow's tolerance for partially-valid files)."""
    return b"this-is-definitely-not-an-image-file-\x00\x01\x02\xff\xfe"


class FakeDetector:
    """Test double for the comic-text-detector DI seam.

    Records the image it was called with (for assertions) and returns a pre-programmed list of
    bboxes, expressed in the coordinate space of whatever image `detect()` receives (i.e. the
    *processed*/possibly-downscaled working image, per ocr_pipeline's contract).
    """

    def __init__(self, bboxes):
        self._bboxes = list(bboxes)
        self.calls = []

    def detect(self, image):
        self.calls.append(image)
        return list(self._bboxes)


class FakeOCRModel:
    """Test double for the manga-ocr DI seam.

    Returns one (text, confidence) pair per call to `recognize()`, taken in order from a
    pre-programmed list. Records every crop it was given for assertions.
    """

    def __init__(self, results):
        self._results = list(results)
        self.calls = []

    def recognize(self, crop):
        self.calls.append(crop)
        return self._results.pop(0)


@pytest.fixture
def make_fake_detector():
    return FakeDetector


@pytest.fixture
def make_fake_ocr_model():
    return FakeOCRModel
