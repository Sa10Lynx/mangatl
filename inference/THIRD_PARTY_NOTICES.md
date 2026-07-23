# Third-party notices

## comic-text-detector

- Source: https://github.com/dmMaze/comic-text-detector
- License: GPL-3.0
- Usage: vendored (git-cloned) into the `mangatl-ocr-spike` Modal image at build time, per
  `inference/ocr_app.py`'s image definition and `inference/model_loader.py`'s
  `load_detector()`. Not installed via PyPI (there is no PyPI package for it) and not
  installable via `pip install git+...` either, since the repo has no `setup.py`/`pyproject.toml`
  at its root -- confirmed empirically 2026-07-22, see the comments in `model_loader.py` for how.
- License decision: the human (project owner) has reviewed and accepted the GPL-3.0 terms for
  this spike's use case, as recorded in this pass's task instructions (2026-07-22). This note
  records that decision; it is not a legal judgement made by any agent, and should not be
  treated as legal advice for downstream/production use of this spike's output.
