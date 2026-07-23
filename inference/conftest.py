# Root conftest for the `inference/` tree.
#
# Purpose: keep `inference/test_ocr.py` (the CLI script that calls the *deployed* Modal
# endpoint, per spec 00) from ever being collected/imported by pytest if pytest is invoked
# broadly (e.g. `pytest` from the repo root, or `pytest inference`) instead of narrowly
# (e.g. `pytest inference/tests`).
#
# test_ocr.py's filename happens to match pytest's default `test_*.py` discovery pattern even
# though the spec/plan explicitly says it is "not part of pytest suite" (locked decision).
# Without this, a broad `pytest` invocation could import test_ocr.py and — if its author ever
# lets any endpoint-calling code run at module import time instead of behind
# `if __name__ == "__main__":` — trigger a real network call / real GPU spend during what's
# supposed to be a zero-network unit test run. This file is the structural guardrail for that;
# it does not replace the requirement that test_ocr.py itself guard its main() properly.
collect_ignore = ["test_ocr.py"]
