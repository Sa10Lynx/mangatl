# Decisions Log
*Append-only, newest at top. One line per real decision, with a reason and a pointer to more detail.*

---

- **2026-07-25** — Spec 01's manual-verification site scope widened from a fixed MANGA Plus + VIZ
  pair to an open list (still including those two, plus e.g. Google Photos, news sites). Reason:
  matches the same on-screen-translator direction as the invariant-4 removal below — useful to learn
  now whether `candidate-filter.ts`'s heuristics generalize beyond manga-reader DOM patterns.
  `extension/spike/README.md` and `SITE_NOTES.md` updated accordingly.

- **2026-07-25** — Removed CLAUDE.md/`.clinerules` invariant 4 ("no scraping, no unlicensed manga
  hosting"), reversing the 2026-07-17 entry below. Reason: product direction is widening from a
  manga-only translator to a general on-screen translator (manga, comics, news articles). Decided by
  Tanush directly editing CLAUDE.md; the numbering references in both files were updated to match
  (now 4 invariants, not 5). Scope of the wider pivot (renaming, architecture-v2.md, gameplan.md)
  is intentionally NOT addressed yet — specs 00/01 are being finished under the original manga-spike
  scope first, per an explicit decision to not fold in the bigger rework mid-spike.

- **2026-07-23** — Spec 00 go/no-go: **go**. Manually spot-checked `inference/spot_check_report.html`
  against all 30 source pages — detection accuracy is high, almost every Japanese text block is boxed
  correctly. Text detection/OCR quality is good enough to proceed to week 2 (backend skeleton).

- **2026-07-22** — Adopted a formalized 4-role pipeline per feature spec: Planner (plans, no code) →
  Test writer → Coder → Reviewer, with a human approval gate after every single stage, not just at
  final commit. Reason: wanted distinct planning/testing/coding/reviewing roles without giving up the
  existing "no autonomous swarm" safety property — approval still happens before each stage proceeds.
  Piloting on spec 00 (Modal OCR spike) before applying to cache/auth/quota specs. See
  `agent-pipeline.md` §2, §5.

- **2026-07-22** — Implemented the 4-role pipeline as native Claude Code subagents (`.claude/agents/`,
  see `CLAUDE.md`), all Claude, rather than Cline + OpenRouter multi-model. Reason: Claude Code usage
  under a Claude Pro subscription is included in that subscription's allowance, so running 4 agent
  passes per spec costs nothing extra; routing through OpenRouter instead would meter every call as
  separate spend on top of Pro. Tradeoff accepted: no genuine model-family diversity on the reviewer
  stage for now (Pro's usage caps are shared with normal usage and reset every ~5h, so heavy multi-agent
  use burns quota faster than casual chat). Revisit multi-model-family review once the project scales
  enough that the OpenRouter spend (or a Claude Max upgrade) is clearly worth it.

- **2026-07-17** — Cache keys: OCR cache = `hash(image)` only. Base translation cache =
  `hash(image)+lang+engine+canonical_glossary_version` (canonical = shared AniList glossary, NEVER
  per-user). User glossary overrides are a post-pass on the cached result, never part of a shared key.
  Reason: per-user glossary edits would otherwise fork the cache and destroy the >80% hit rate the
  whole cost model depends on. See `architecture-v2.md` §A3.

- **2026-07-17** — v0 ships with L2 (DeepL + glossary) only. No LLM premium tier at launch.
  Reason: DeepL + auto-glossary already beats generic tools on name consistency (the thing users
  notice most), and it ships weeks earlier with near-zero hallucination risk. LLM tier is a v1
  pricing feature, not a launch requirement. See `gameplan.md` §3.

- **2026-07-17** — No scraping or training on scanlation aggregator sites (weebcentral, asurascans,
  etc.), at any scale, "educational" framing included. Reason: legal exposure — these sites host
  unauthorized derivative works of copyrighted manga; using that content doesn't become safe by
  being small-scale or temporary.

- **2026-07-17** — OCR runs server-side (Modal serverless GPU), not in-browser. Reason: browser OCR
  (Tesseract.js) can't handle vertical Japanese or stylized fonts; server-side also enables the
  content-addressed cache, which is the core unit-economics lever.

---
*Add new entries above this line, most recent first. Keep each entry to 2-3 lines: what, why, where
to read more.*
