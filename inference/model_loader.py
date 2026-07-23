"""
Dependency-injection seam between `ocr_pipeline.py` (pure, testable, Modal-free) and the real
comic-text-detector + manga-ocr model libraries (heavy, GPU-bound, network-fetched weights).

`ocr_app.py` calls `load_detector()` / `load_ocr_model()` once per container lifecycle (not per
request — model loading is the expensive part of cold start) and passes the resulting objects into
`ocr_pipeline.process_image(...)`.

Imports of the real model libraries are deliberately deferred to inside these functions rather than
at module level, so that:
  - `inference/tests/` (which only ever uses the FakeDetector/FakeOCRModel test doubles from
    `inference/tests/conftest.py`) never needs comic-text-detector/manga-ocr/torch installed.
  - Any other module that imports `model_loader` for its symbols (e.g. type checking) doesn't pay
    the cost, or risk the import error, of pulling in the real ML stack until a loader is actually
    called.

Both returned objects match the interface `ocr_pipeline.py` expects:
    detector.detect(image: PIL.Image.Image) -> list of [x1, y1, x2, y2] bboxes
    ocr_model.recognize(crop: PIL.Image.Image) -> (text: str, confidence: float)

--------------------------------------------------------------------------------------------------
VERIFIED against the real libraries on 2026-07-22 (network access was available this pass; see the
coder's report for how this was checked) -- both adapters below were previously WRONG guesses.
--------------------------------------------------------------------------------------------------

manga-ocr (verified via `pip download manga-ocr` + reading the installed `manga_ocr/ocr.py`
source, manga-ocr 0.1.16):
  - Real usage is `MangaOcr()` once (loads weights, expensive), then `mocr(pil_image)` per crop.
  - `MangaOcr.__call__(img_or_path)` accepts either a path/str or a `PIL.Image.Image` directly (no
    manual numpy conversion needed) and returns a plain `str` -- there is NO confidence score
    anywhere in the public API. The previous code's assumption of a `(text, confidence)` tuple
    return was wrong.
  - Fix applied below: `MangaOCRModel.recognize()` calls the real model, gets back a bare `str`,
    and pairs it with a fixed placeholder confidence constant to satisfy the `(text, confidence)`
    interface `ocr_pipeline.py` expects. Per the locked pass-through decision (CLAUDE.md /
    `docs/decisions.md` -- never filter by confidence at this layer), this placeholder is never
    used to threshold or drop anything here; it exists purely so downstream code that expects a
    confidence field for every region gets *something* until this spike is followed up with a
    provider that has one, or a proper confidence estimate (e.g. token-level log-prob) is wired
    in. Do not treat this constant as a real signal.

comic-text-detector (dmMaze/comic-text-detector on GitHub) -- COULD NOT BE FULLY VERIFIED BY
INSTALLING IT AS A PACKAGE, because it is not actually distributed as an installable package:
  - `pip install comic-text-detector` FAILS -- confirmed both via `pip install` (no matching
    distribution) and directly against the PyPI JSON/simple APIs (404). There is no PyPI package
    under this name or any close variant.
  - `pip install git+https://github.com/dmMaze/comic-text-detector.git` ALSO FAILS -- confirmed
    empirically (2026-07-22) by running `pip install --no-deps git+https://github.com/dmMaze/
    comic-text-detector.git` in a scratch venv: pip clones the repo fine, then errors with
    "does not appear to be a Python project: neither 'setup.py' nor 'pyproject.toml' found." This
    was cross-checked against the GitHub contents API for the repo root: there is no `setup.py`,
    `setup.cfg`, or `pyproject.toml` there. The repo is a script collection, not a package, and
    pip has nothing to build from a git URL either.
  - Resolution (wired in `ocr_app.py`'s image definition): vendor the repo via
    `modal.Image.run_commands("git clone ... /opt/comic-text-detector")` and put that path on
    `PYTHONPATH` via `.env(...)`, matching how the repo's own modules import each other (plain
    top-level/relative imports like `from basemodel import ...`, `from utils.yolov5_utils import
    ...`, no `__init__.py` at repo root -- it expects to be run with its own root on `sys.path`,
    not installed as a package).
  - The real class lives in the repo's own top-level `inference.py` (confusingly same basename as
    this project's `inference/` directory, but it is not a Python package inside a container that
    imports `model_loader`/`ocr_pipeline` as top-level modules, so there is no import collision):
    `from inference import TextDetector` after `/opt/comic-text-detector` is on `sys.path`.
  - Verified (by reading `inference.py`, `basemodel.py`, and `README.md` straight from
    github.com/dmMaze/comic-text-detector) real shape:
        TextDetector(model_path, input_size=1024, device='cpu', ..., act='leaky')
        TextDetector.__call__(img: np.ndarray (BGR, HxWxC), refine_mode=..., keep_undetected_mask=False)
            -> (mask, mask_refined, blk_list)
    where `blk_list` is a list of `TextBlock` objects (see `utils/textblock.py` in that repo),
    each exposing an `.xyxy` attribute -- NOT a flat list of `[x1,y1,x2,y2]` boxes directly, and
    NOT a call that accepts a `PIL.Image.Image` (it wants a BGR numpy array, e.g. from
    `cv2.imread`). `model_path` is a required constructor arg (no zero-arg `TextDetector()`).
  - The adapter below reflects this *verified* call shape (numpy conversion, 3-tuple unpack,
    `.xyxy` extraction) -- unchanged from the previous pass, per the coder-stage instructions not
    to touch the adapter's internals, only construction.
  - Weights: `model_path` points at `/weights/comictextdetector.pt`, i.e. inside the
    `modal.Volume` mounted at `/weights` in `ocr_app.py` (see that module's comment block for the
    exact one-time `modal volume create` / `modal volume put` commands the human runs before
    `modal deploy`). Nothing in this codebase downloads or commits the weights file itself.
  - License: comic-text-detector is GPL-3.0. The human has reviewed and accepted this for this
    spike's use case as of this pass (2026-07-22) -- see `inference/THIRD_PARTY_NOTICES.md` and
    the note atop `ocr_app.py`'s image definition. This is a record of that decision, not a legal
    judgement made here.

# >>> VERIFY-BEFORE-DEPLOY <<<
# `load_detector()` below constructs a real `TextDetector` against `/weights/comictextdetector.pt`.
# That path only exists inside a deployed container if a human has already run the one-time setup
# in `ocr_app.py`'s comment block (`modal volume create` + `modal volume put`) for the
# `mangatl-ocr-weights` volume. If you rename the uploaded weights file, update `_WEIGHTS_PATH`
# below to match.
"""
from __future__ import annotations

# Path inside the container where the `mangatl-ocr-weights` Modal Volume (mounted at `/weights` in
# `ocr_app.py`) is expected to expose the pretrained comic-text-detector weights file. Must match
# the filename the human uploads via `modal volume put` (see the comment block in `ocr_app.py`).
_WEIGHTS_PATH = "/weights/comictextdetector.pt"

# Repo root vendored into the Modal image by `ocr_app.py` (`git clone` + `PYTHONPATH`). Only
# meaningful inside a deployed container -- not required to exist for `inference/tests/`, since
# those tests never call `load_detector()` (they use the FakeDetector test double instead).
_VENDORED_REPO_PATH = "/opt/comic-text-detector"

# Fixed placeholder confidence paired with every manga-ocr result, since manga-ocr's public API
# (verified: `manga_ocr/ocr.py`, `MangaOcr.__call__` returns a bare `str`) exposes no confidence
# score at all. This is pass-through filler, never used to threshold/drop regions (see module
# docstring above) -- it exists only so every region has *a* confidence field.
_MANGA_OCR_PLACEHOLDER_CONFIDENCE = 1.0


class ComicTextDetector:
    """Thin adapter around comic-text-detector's real `TextDetector`, exposing the
    `.detect(image) -> list[[x1, y1, x2, y2]]` interface `ocr_pipeline.py` expects.

    Constructed by `load_detector()` once the vendored repo (see `_VENDORED_REPO_PATH`) and the
    weights file (see `_WEIGHTS_PATH`, sourced from the `mangatl-ocr-weights` Modal Volume) are
    both present in the container -- see the VERIFY-BEFORE-DEPLOY block in this module's
    docstring for the human setup steps required before that's true.
    """

    def __init__(self, model):
        self._model = model

    def detect(self, image):
        import numpy as np

        # comic-text-detector's TextDetector wants a BGR numpy array (e.g. cv2.imread output), not
        # a PIL.Image -- convert here so callers of this adapter can keep passing PIL images.
        rgb_array = np.array(image.convert("RGB"))
        bgr_array = rgb_array[:, :, ::-1]

        # Real return shape (verified from inference.py): (mask, mask_refined, blk_list), where
        # blk_list is a list of TextBlock objects exposing `.xyxy`, NOT a flat bbox list.
        _mask, _mask_refined, blk_list = self._model(bgr_array)
        return [list(block.xyxy) for block in blk_list]


class MangaOCRModel:
    """Thin adapter around manga-ocr's real `MangaOcr`, exposing the
    `.recognize(crop) -> (text, confidence)` interface `ocr_pipeline.py` expects.

    Verified (manga-ocr 0.1.16, `manga_ocr/ocr.py`): `MangaOcr.__call__` accepts a `PIL.Image`
    directly and returns a plain `str`, with no confidence score anywhere in the public API. A
    fixed placeholder confidence is paired with the real text below (pass-through only, per the
    locked decision -- never used to filter here).
    """

    def __init__(self, model):
        self._model = model

    def recognize(self, crop):
        text = self._model(crop)
        return text, _MANGA_OCR_PLACEHOLDER_CONFIDENCE


def load_detector() -> ComicTextDetector:
    """Load the real comic-text-detector model. Expensive — call once per container lifecycle.

    Requires (both provided by `ocr_app.py`'s image/volume wiring, not by this function):
      - the vendored repo at `_VENDORED_REPO_PATH` on `sys.path` (via the container's `PYTHONPATH`
        env var, set in `ocr_app.py`'s image definition), and
      - the pretrained weights file at `_WEIGHTS_PATH`, from the `mangatl-ocr-weights` Modal
        Volume mounted at `/weights` -- see the one-time `modal volume create` / `modal volume
        put` commands documented in `ocr_app.py`.

    If either is missing (e.g. running this outside a properly-provisioned container, or before
    the human has completed the one-time weights upload), this raises naturally (ImportError /
    FileNotFoundError) rather than silently constructing something broken.
    """
    import os

    if not os.path.isdir(_VENDORED_REPO_PATH):
        raise RuntimeError(
            f"load_detector(): vendored comic-text-detector repo not found at "
            f"{_VENDORED_REPO_PATH!r}. This function only works inside a container built from "
            f"ocr_app.py's `image` (which git-clones the repo and sets PYTHONPATH) -- see the "
            f"VERIFY-BEFORE-DEPLOY block at the top of this module."
        )

    if not os.path.isfile(_WEIGHTS_PATH):
        raise RuntimeError(
            f"load_detector(): weights file not found at {_WEIGHTS_PATH!r}. Before first deploy, "
            f"a human must run the one-time `modal volume create mangatl-ocr-weights` + "
            f"`modal volume put mangatl-ocr-weights <local .pt/.onnx file> comictextdetector.pt` "
            f"setup documented in ocr_app.py's comment block. Do not guess a path or ship a "
            f"detector without real weights."
        )

    from inference import TextDetector  # type: ignore  # vendored repo's own top-level module

    device = "cuda" if _cuda_available() else "cpu"
    model = TextDetector(model_path=_WEIGHTS_PATH, device=device)
    return ComicTextDetector(model)


def _cuda_available() -> bool:
    import torch  # deferred import, see module docstring

    return torch.cuda.is_available()


def load_ocr_model() -> MangaOCRModel:
    """Load the real manga-ocr model. Expensive — call once per container lifecycle."""
    from manga_ocr import MangaOcr  # type: ignore

    return MangaOCRModel(MangaOcr())
