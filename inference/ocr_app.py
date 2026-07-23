"""
Modal app for the spec-00 OCR spike (docs/specs/00-modal-ocr-spike.md).

Standalone Modal app -- no FastAPI backend yet (out of scope for this spec). Exposes exactly one
`@modal.fastapi_endpoint(method="POST")` that:
  1. Checks the `X-Spike-Key` header against the `SPIKE_KEY` env var via `check_authorized(...)`
     from `ocr_pipeline.py`. Returns HTTP 403 if that fails, BEFORE any OCR work happens.
  2. Reads the POST body as raw image bytes and runs `process_image(...)`.
  3. Returns the resulting envelope JSON, or HTTP 400 with an error body if the bytes could not be
     decoded as an image (`InvalidImageError`).

Uses Modal's scale-to-zero (no `keep_warm`) per the spec -- this spike is explicitly measuring
cold-start cost, not hiding it.

This module is the ONLY place in `inference/` that imports Modal. `ocr_pipeline.py` (the actual OCR
orchestration) has zero Modal imports, by design, so it stays unit-testable without a Modal
environment.

The detector/OCR model are loaded once per container lifecycle (via Modal's `@modal.enter()` setup
hook), not per request -- model loading is the expensive part of cold start.

Not unit-tested (per the approved plan): endpoint-level behavior (actual HTTP 403/400/200 round
trips against a live deployment) is a manual `curl`/human smoke test, documented in the spec's
"Definition of done". `ocr_pipeline.check_authorized` and `ocr_pipeline.process_image`, which this
module calls, ARE unit-tested in `inference/tests/`.
"""
from __future__ import annotations

import os

import fastapi
import modal

import model_loader
import ocr_pipeline

app = modal.App("mangatl-ocr-spike")

# --------------------------------------------------------------------------------------------------
# comic-text-detector (dmMaze/comic-text-detector on GitHub) is GPL-3.0 licensed. The human has
# reviewed and accepted GPL-3.0 for this spike's use case as of this pass (2026-07-22) -- this is a
# record of that decision, not a legal judgement made by this code/agent. See
# inference/THIRD_PARTY_NOTICES.md for the full note.
# --------------------------------------------------------------------------------------------------

# VERIFIED 2026-07-22: `pip install git+https://github.com/dmMaze/comic-text-detector.git` FAILS --
# confirmed empirically (`pip install --no-deps git+...` against a scratch venv) with:
#   "ERROR: ... does not appear to be a Python project: neither 'setup.py' nor 'pyproject.toml' found."
# The repo has no packaging metadata at all (checked via the GitHub contents API: no setup.py,
# setup.cfg, or pyproject.toml at repo root). So this cannot be a `pip_install(...)` entry -- pip has
# nothing to build. Falling back to vendoring: clone the repo straight into the image and put its
# root on PYTHONPATH so `from inference import TextDetector` (the repo's own top-level `inference.py`,
# not to be confused with this project's `inference/` package -- see PYTHONPATH note below) resolves.
# The repo's own modules use plain top-level/relative imports (e.g. `from basemodel import ...`,
# `from utils.yolov5_utils import ...`) with no `__init__.py` at the repo root, so it must be run as
# "root of sys.path", not `pip install`ed as a package.
image = (
    modal.Image.debian_slim(python_version="3.11")
    # debian_slim has no git by default -- needed for the vendoring clone step below. libgl1 is
    # needed because opencv's native module (imported by comic-text-detector's yolo.py) fails to
    # load without it, even with the opencv-python-headless build, in this minimal base image.
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install(
        # Newer setuptools (>=81) dropped pkg_resources, which comic-text-detector's
        # utils/yolov5_utils.py imports unconditionally at module load. Pin below that.
        "setuptools<81",
        "pillow",
        # comic-text-detector's utils/io_utils.py references the deprecated `np.bool8` alias,
        # removed entirely in NumPy 2.0 -- this repo predates that release. Pin below it.
        "numpy<2",
        "torch",
        "torchvision",
        "torchsummary",
        "opencv-python-headless",
        "onnx",
        "manga-ocr",
        "fastapi",
        # The rest of these are comic-text-detector's own requirements.txt (github.com/dmMaze/
        # comic-text-detector) -- its modules import these unconditionally at module load (e.g.
        # utils/general.py does `import wandb` even though wandb is only used for training runs,
        # never for inference), so they must be present even though this spike never trains anything.
        "onnx-simplifier",
        "tqdm",
        "wandb",
        "trdg",
        # Found by manually tracing the full transitive import chain of `from inference import
        # TextDetector` across the vendored repo's basemodel.py -> models/yolov5/{yolo,common}.py
        # -> utils/{db_utils,textblock}.py -- these are NOT in requirements.txt but are imported
        # unconditionally at module load anyway.
        "pyclipper",
        "shapely",
        "requests",
    )
    # Vendor comic-text-detector's source (not its weights -- those come from the `weights` Volume
    # below) directly into the image at build time.
    .run_commands(
        "git clone --depth 1 https://github.com/dmMaze/comic-text-detector.git /opt/comic-text-detector"
    )
    .env({"PYTHONPATH": "/opt/comic-text-detector"})
    # Modal only auto-mounts the entrypoint file (ocr_app.py) itself -- the local sibling modules it
    # imports (model_loader.py, ocr_pipeline.py, schemas.py) are NOT included in the deployed
    # container by default and must be added explicitly, or the container crash-loops on import.
    .add_local_python_source("model_loader", "ocr_pipeline", "schemas")
)

# --------------------------------------------------------------------------------------------------
# Model weights: comic-text-detector's `TextDetector` needs a `model_path` pointing at a `.pt`/`.onnx`
# weights file that is several-hundred-MB -- NOT something to fetch at image-build time or commit to
# this git repo. Wired here via a `modal.Volume` mounted at `/weights`, populated by the human
# out-of-band, once, before first deploy (and again any time the weights are updated). This volume is
# read-only from the app's perspective; nothing in this codebase writes to it.
#
# ONE-TIME HUMAN SETUP (run locally, before `modal deploy`):
#   1. modal volume create mangatl-ocr-weights
#   2. Download the pretrained weights from the comic-text-detector README/releases (a `.pt` or
#      `.onnx` file, e.g. `comictextdetector.pt`) to your local machine -- do NOT commit this file
#      to the mangatl repo.
#   3. modal volume put mangatl-ocr-weights /path/to/local/comictextdetector.pt comictextdetector.pt
#
# `model_loader.load_detector()` reads the file from `/weights/comictextdetector.pt` (see
# `_WEIGHTS_PATH` in model_loader.py) -- update that constant if you upload under a different name.
# --------------------------------------------------------------------------------------------------
weights_volume = modal.Volume.from_name("mangatl-ocr-weights", create_if_missing=True)


# Before deploying: `modal secret create mangatl-ocr-spike-key SPIKE_KEY=<value>` (or create it via
# the Modal dashboard). Modal containers do NOT inherit the local deploying machine's shell
# environment -- without this `secrets=` binding, `os.environ.get("SPIKE_KEY")` is None inside the
# remote container, and since `check_authorized` fails closed, every legitimate request 403s too.
@app.cls(
    image=image,
    gpu="T4",
    secrets=[modal.Secret.from_name("mangatl-ocr-spike-key")],
    volumes={"/weights": weights_volume},
)
class OCRApp:
    @modal.enter()
    def load_models(self):
        # Loaded once per container lifecycle (cold start), not per request.
        self.detector = model_loader.load_detector()
        self.ocr_model = model_loader.load_ocr_model()

    @modal.fastapi_endpoint(method="POST")
    async def ocr(self, request: fastapi.Request):
        from fastapi.responses import JSONResponse

        expected_key = os.environ.get("SPIKE_KEY")
        provided_key = request.headers.get("X-Spike-Key")

        if not ocr_pipeline.check_authorized(provided_key, expected_key):
            return JSONResponse({"error": "unauthorized"}, status_code=403)

        image_bytes = await request.body()

        try:
            envelope = ocr_pipeline.process_image(image_bytes, self.detector, self.ocr_model)
        except ocr_pipeline.InvalidImageError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

        return JSONResponse(envelope, status_code=200)
