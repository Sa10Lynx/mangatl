# MangaTL Architecture Review — v1 Critique & v2 Revision
*Role: lead architect, 10+ YoE, reviewing my own v1 proposal with no attachment to it. Format: what's wrong, then what replaces it.*

---

## Part A — Honest critique of v1

### A1. Stack was chosen for the founder, not the problem
v1 picked NestJS/Prisma "because team familiarity." Wrong basis for a production system. Consequence: two runtimes (Node API + Python ML workers) from day one — two build pipelines, two dependency trees, two on-call surfaces, for a team of one or two. **v2: one backend language until scale forces a split.** Python (FastAPI) wins because the ML pipeline is non-negotiably Python; the CRUD API is trivially expressible in it. Node earns its way back in later only if API throughput demands it (it won't for years).

### A2. Owning GPU workers at v0 is a classic premature-infrastructure mistake
v1 said "GPU worker pool behind a queue, autoscale on queue depth." That's a Series-A infra team's setup. At 100–10,000 users, GPU utilization will be spiky and low; owned GPUs idle at $1–3/hr while you sleep. **v2: serverless GPU inference (Modal / RunPod serverless / Replicate) with scale-to-zero.** Cold starts (2–8s) are hidden behind the cache and prefetch. Cross the ~30–40% sustained-utilization line before renting dedicated GPUs. This one change removes the queue, the autoscaler, and the worker fleet from the v0 build entirely.

### A3. The cache key design in v1 quietly destroys the business model
v1 keyed the page cache on `hash(image) + lang + engine + glossary_version`. Glossaries are **per-user-editable** — so every user edit forks the cache key, and the "80% global hit rate" collapses to per-user hit rates. This is the kind of bug that looks fine in design review and kills unit economics in production.

**v2 fix — three-layer cache with the right invariants:**
1. **OCR cache** — key: `hash(image)`. Glossary-independent, language-independent, engine-independent. The single most expensive step (GPU) cached at maximum generality. Immutable forever.
2. **Base translation cache** — key: `hash(image) + target_lang + engine + series_canonical_glossary_version`. Uses the *canonical* (community/AniList-derived) glossary only, shared by all readers of that series. This is the layer that gets 80%+ hits.
3. **User personalization** — user-custom glossary entries applied as a **post-pass**: deterministic term substitution on the cached base translation for exact-match terms; only bubbles containing a user-overridden term get an LLM re-touch, billed to that user. Personal deltas never pollute the shared cache.

Also: layers 1–2 are immutable and content-addressed → **serve them from a CDN edge**. At scale, the majority of all traffic never reaches origin at all. v1 completely missed that the cache is edge-cacheable.

### A4. No hallucination containment — v1 treated LLM output as trustworthy
v1 said "output = JSON array, validated, retried on schema failure." Schema validation catches malformed JSON, not a model that invents dialogue, drops honorifics, merges two bubbles, or "translates" a bubble into three sentences of fanfiction. For a translation product, hallucination is the core quality risk and v1 had one line about it. Full treatment in Part C.

### A5. Extension realities ignored
- **MV3 service workers are ephemeral** — killed after ~30s idle. v1's "service worker owns the local cache and API client" needs explicit design: all state in IndexedDB/`chrome.storage`, workers stateless and re-hydratable, long operations chunked or moved to an offscreen document. Otherwise translations silently die mid-chapter.
- **You cannot force-update an extension.** Store review takes days; users update whenever Chrome feels like it. Old clients live for **weeks**. v1 had no API versioning story. v2: versioned API (`/v1/`), additive-only changes within a version, server-driven config (feature flags fetched at startup) so behavior can change without shipping code, and a minimum-supported-version handshake with a graceful "please update" state — never a hard break.
- **Anonymous tier via device fingerprinting** (v1) contradicts the privacy posture in the same document. v2: anonymous trial = short-lived signed token with a small server-side quota, no fingerprinting. Cheap abuse is absorbed as CAC; real abuse is handled by requiring sign-in for anything beyond the trial.

### A6. Missing production table stakes
No idempotency keys (double-submit on flaky networks = double LLM spend). No dead-letter handling. No backpressure/load-shedding policy. No circuit breakers on external providers (a DeepL outage in v1 cascades as user-visible errors instead of tier-degradation). No content-safety scanning on uploaded images (a user-upload endpoint on the public internet **will** receive illegal content; you need automated scanning + reporting posture before launch, not after). No cost kill-switches. All addressed in Part D.

### A7. Latency was hand-waved
"p50 < 1.5s" with no load model and no perceived-latency design. Real numbers: uncached page = upload (0.3–1s) + OCR (1–3s serverless) + translation (0.5–2s DeepL / 2–6s LLM). Worst case ~10s. A user staring at raw manga for 10 seconds uninstalls. The fix is UX architecture, not just backend speed — Part E.

---

## Part B — v2 System architecture

```
Extension (MV3, TS)                       Edge (CDN)
┌──────────────────────┐         ┌─────────────────────────┐
│ Content script (UI)  │────────▶│ GET /page/{hash}/{lang}  │  immutable cache
│ SW (stateless, thin) │  hit?   │  → cached result JSON    │  hits: no origin
│ IndexedDB (L0 cache) │         └───────────┬──────────────┘
└──────────┬───────────┘                     │ miss
           │ POST (authed, idempotent)       ▼
┌──────────▼──────────────────────────────────────────────┐
│  Origin: ONE deployable — modular monolith (FastAPI)    │
│  modules: auth | quota | glossary | orchestrator | admin │
│  (module boundaries = future service boundaries;         │
│   split only when a module's load or team demands it)    │
└───────┬──────────────┬───────────────┬──────────────────┘
        │              │               │
        ▼              ▼               ▼
  Postgres        Redis           Serverless GPU inference
  (RDS-class,     (cache/locks/   (Modal/RunPod: detection+OCR)
   1 primary,      rate limits)          │
   replicas later)                        ▼
                                   Translation providers
                                   (DeepL │ LLM A │ LLM B)
                                   behind circuit breakers
```

**Scaling ladder (explicit, boring, correct):**

| Users | Action |
|---|---|
| 0–1k | Single monolith instance + managed Postgres + managed Redis + serverless GPU. Vertical scale only. Nothing else. |
| 1k–10k | Monolith → 2–4 stateless replicas behind an LB (it's stateless by construction; this is a slider, not a project). Postgres: vertical bump. CDN in front of the immutable cache endpoints. |
| 10k–100k | Postgres read replicas (glossary/series reads dominate). Redis → managed cluster. Extract the **orchestrator** module into its own deployment if translation traffic starves API traffic (first and probably only split). Dedicated GPU pool if sustained utilization justifies it. Multi-region CDN already handles read latency; origin stays single-region until data shows otherwise. |
| 100k+ | Now you have revenue and a team; re-architect with real usage data instead of guesses made today. |

The principle: **horizontal scaling is cheap only for stateless things** — so the monolith is stateless (all state in Postgres/Redis/object store), and everything cacheable is immutable + content-addressed so the CDN does the horizontal scaling for free.

---

## Part C — Model hierarchy & hallucination containment

The models form a **strict hierarchy where each layer can only refine, never replace, the layer below** — and the system always has a non-hallucinating answer to fall back to.

```
L0  Detection model (bubble/text regions)      — geometric, no language
L1  OCR model (per region, + confidence)       — deterministic-ish, no generation
L2  Baseline MT: DeepL + canonical glossary    — NMT: constrained, near-zero hallucination
L3  LLM refinement (premium): rewrites L2 with — generative: quality ↑, hallucination risk ↑
    glossary + rolling context + tone guidance
L4  Validators (deterministic, cheap)          — gatekeeper between L3 and the user
```

**Invariant: the user is never shown raw L3 output. They are shown L3 *if it passes L4*, else L2. L2 always exists.** This single rule converts hallucination from a correctness problem into a quality-ceiling problem.

**L4 validator battery (all deterministic, all < 5ms):**
1. **Cardinality** — bubbles in = bubbles out; no merging, splitting, or dropping. Hard fail per page.
2. **Length ratio bounds** — |EN| / |JA| chars per bubble within [0.5, 4.0] (tuned empirically). Catches both invented prose and swallowed content. Fail → that bubble reverts to L2.
3. **CJK echo check** — output must not contain untranslated source CJK (except glossary-permitted terms). Catches lazy copy-through.
4. **Named-entity anchoring** — capitalized/proper nouns in output must appear in {glossary ∪ transliterations of source tokens}. Catches invented character/place names — the most damaging manga hallucination. Fail → revert bubble to L2.
5. **Glossary compliance** — locked glossary terms present in source must appear in output as mapped. Fail → deterministic substitution repair, then re-check.
6. **Confidence propagation** — L1 OCR confidence < threshold ⇒ skip the bubble entirely and mark it "uncertain" in the UI (tap to view raw OCR). **Showing nothing beats showing garbage** — this was proven qualitatively in the InstaTL "Idachimi" incidents: bad OCR in → confident nonsense out.
7. **Sampled audit** — 1% of L3 outputs get async back-translation comparison, logged not blocking; feeds a per-model quality dashboard and the routing table (below).

**Model routing table (server-driven, hot-swappable):** per (tier, language pair, content flags) → ordered provider list with per-provider circuit breakers. Provider policy-refuses or times out → next in list → floor is always L2. New models are onboarded by shadowing: run candidate on 5% of traffic, compare validator pass-rates and audit scores against incumbent, promote on data. No model change ever requires a client release.

---

## Part D — Production hardening (the unglamorous list that separates demo from product)

- **Idempotency:** every mutating request carries a client-generated idempotency key (image hash + lang + tier works naturally); server dedupes for 24h. Flaky hotel wifi must not double-bill LLM calls.
- **Backpressure & load shedding:** priority classes — paid interactive > free interactive > prefetch. Under load, prefetch is shed first, free tier queued with honest UI ("high demand, ~15s"), paid protected. Explicit queue-depth limits; reject-with-retry-after beyond them.
- **Circuit breakers + budgets:** per-provider breakers (open on error-rate/latency); global and per-user daily spend caps with automatic tier degradation at 80% and hard stop + alert at 100%. A bug that loops LLM calls should cost hundreds, not tens of thousands.
- **Abuse & safety:** image endpoint enforces size/type/rate limits; every upload passes automated CSAM hash-matching (e.g., industry hash APIs) with mandated reporting workflow; ToS + enforcement path written before launch. This is non-optional for any public image-upload endpoint.
- **Observability from day one:** structured logs with request IDs end-to-end (extension → edge → origin → GPU → provider); RED metrics per module; **cost-per-page and cache-hit-rate as first-class dashboards** — for this product, cache hit rate *is* the P&L; SLOs: 99.5% availability, p95 uncached page < 6s, p95 cached < 400ms (edge).
- **Data lifecycle:** images: transient, 1h TTL, never logged, never trained on. Text+geometry: cached indefinitely (it's the asset). User deletion: full cascade within 30 days, documented.
- **Release safety:** server-side feature flags + remote config (extension fetches at startup); staged extension rollout (Chrome supports percentage rollout); API changes additive-only within a version; contract tests pinned to the oldest supported client version.

---

## Part E — UX architecture (latency is a design problem, not just an infra problem)

**Perceived-latency budget: first translated bubble on screen < 2.5s, full page < 6s uncached — achieved by streaming, not by making everything faster.**

1. **Progressive per-bubble rendering.** The pipeline streams: as each bubble clears L4, it renders (SSE/WebSocket per page job). Users read top-right → down; delivering bubbles in reading order means they're reading bubble 1 while bubble 5 computes. Never block a page on its slowest bubble.
2. **Skeleton states.** The instant detection returns (fastest stage), draw subtle placeholder outlines on every detected bubble — the product feels alive at ~1s even when translation takes 5.
3. **Prefetch pipeline.** Current page + next 2, lowest priority class, cancellable on tab close. Combined with the cache, most page turns feel instant.
4. **Zero-config activation.** Click icon → series auto-detected from page title/URL against AniList search → one-tap confirm (fallback: manual search). Glossary builds silently. **Time from install to first translated bubble < 60 seconds** — this number is the funnel; measure it.
5. **Honest degraded states, never blank:** low-confidence bubble → dashed outline, tap for raw OCR; L3 failed validation → L2 shown with a subtle "standard quality" glyph, tap to retry premium; provider down → banner "premium temporarily unavailable, using standard," not an error page.
6. **Overlay ergonomics (carrying InstaTL's validated learnings):** translucent light background/dark text, collision-avoided with measured labels, tap-to-toggle original, per-page hide toggle, opacity + font-size sliders, position preference (beside vs. over bubble). Add: `prefers-reduced-motion` respect, keyboard navigation between bubbles, and font-size floor for accessibility.
7. **Trust surfaces:** small per-page indicator of engine tier + cache status ("community-cached · premium") — power users (the early adopters and evangelists here) reward transparency; it also converts free→paid by making the tier difference visible.

---

## Part F — Revised v0 cutline (what to actually build first)

The smallest thing that is architecturally *on the path* to everything above:

1. FastAPI modular monolith: auth (magic link), quota, orchestrator, glossary (AniList only).
2. Serverless GPU endpoint: comic-text-detector + manga-ocr behind one HTTP call.
3. DeepL-only translation (L2) with canonical glossary. **No LLM tier in v0** — L2 + glossary already beats every generic tool on name consistency, and it ships weeks earlier. L3+L4 land in v1 on top of a stable base.
4. Three-layer cache exactly as specified in A3 (getting the keys right on day one is 10x cheaper than migrating them).
5. Extension: activation flow, series pinning, streaming per-bubble overlay, IndexedDB L0 cache, stateless SW.
6. Observability + idempotency + spend caps from commit one.

Everything in this doc that isn't in this list is deliberately deferred — but nothing in this list will need to be *rewritten* to add it. That's the definition of a v0 done right.
