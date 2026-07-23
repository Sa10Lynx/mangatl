# MangaTL — Claude Code instructions

This mirrors `.clinerules` (which Cline reads automatically; Claude Code reads this file instead).
Keep the two in sync if either changes.

## Non-negotiable invariants — never violate these regardless of what a spec seems to ask for

1. **Cache keys are sacred.**
   - OCR cache key = `hash(image_bytes)` ONLY. Never include language, engine, or glossary in this key.
   - Base translation cache key = `hash(image_bytes) + target_lang + engine + canonical_glossary_version`.
     `canonical_glossary_version` means the SHARED series glossary (from AniList), NEVER a per-user glossary.
   - User-specific glossary overrides are applied as a post-pass AFTER the cache lookup, on the cached
     result. They must never be baked into a cache key that other users' requests could hit.
   - If a spec or your own judgement suggests putting user data in a shared cache key, STOP and flag it
     instead of implementing it.

2. **The user never sees unvalidated LLM output.**
   - Any premium (LLM) translation must pass the L4 validator battery (bubble-count match, length-ratio
     bounds, no untranslated CJK leakage, named-entity anchoring against the glossary) before display.
   - If validation fails for a bubble, that bubble falls back to the L2 (DeepL) result — never show a
     failed-validation LLM output, and never show nothing when an L2 result exists.
   - Low-confidence OCR bubbles are not translated or shown — better to omit than to confidently mistranslate
     garbage. Mark them as "uncertain, tap to see raw OCR" instead.

3. **Images are transient. Never persist them.**
   - Uploaded manga images live only long enough to run OCR (target: under 1 hour, object store TTL).
   - Never log image bytes. Never write them to a database. Never use them for model training/fine-tuning.
   - Only OCR'd text + bounding-box geometry may be cached/stored long-term.

4. **No scraping, no training on scanlation sites, no unlicensed manga hosting.**
   - Do not write code that fetches from, mirrors, or trains on weebcentral/asurascans/similar sites.
   - Glossary sources: AniList GraphQL API, MAL API, user-entered terms only.

5. **Idempotency and spend caps are not optional, even in a "quick" spec.**
   - Any endpoint that calls a paid provider (Modal, DeepL, LLM) needs an idempotency key and must check
     per-user/global spend limits before calling out.

## The spec pipeline (per docs/decisions.md, 2026-07-22)

Every feature spec (`docs/specs/NN-*.md`) goes through four gated stages, each a separate subagent
under `.claude/agents/`, with a human approval checkpoint between every stage — never chain them
automatically:

1. `mangatl-planner` — reads the spec, proposes file structure + task breakdown, no code.
2. `mangatl-test-writer` — writes the test suite for that spec only, no implementation.
3. `mangatl-coder` — implements against the approved tests.
4. `mangatl-reviewer` — adversarial pass over the diff before the human's final review + commit.

Currently all four run as Claude subagents (same model family) — this was a deliberate choice to
stay inside a Claude Pro subscription's usage allowance rather than pay per-token via OpenRouter.
Revisit multi-model-family review (see `docs/agent-pipeline.md` §5) once the project scales enough
that the extra spend is worth it.

## Working style

- Write tests before implementation. Show the test file before writing the implementation.
- Keep diffs scoped to the current spec file only. Do not refactor unrelated code in the same task.
- If a spec is ambiguous or missing an edge case, ask rather than guessing on anything touching
  invariants 1–5 above. For everything else, pick the reasonable default and note the assumption.
- Reference `docs/architecture-v2.md` and `docs/decisions.md` for context before asking to
  re-explain something that's probably already answered there.
- Run `make test` (or the relevant test command) before declaring a stage done.
