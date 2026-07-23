# MangaTL — Solo Developer Game Plan (AI-Accelerated)
*Lens: lead GenAI engineer. Premise: one developer, the v2 architecture doc as the target, and modern AI tooling as your force multiplier. The goal is not "use AI everywhere" — it's knowing which 20% of the work you must do with your own hands and which 80% you can safely delegate to coding agents.*

---

## 0. The mental model

As a solo dev with AI agents, your job changes from "writer of code" to three roles:

1. **Architect** — you own the specs, the interfaces, and the cache-key invariants. Agents are dangerously agreeable; if your spec is wrong, they will build the wrong thing beautifully.
2. **Reviewer** — you read every diff that touches money (LLM/OCR spend), auth, or the cache keys. Everything else gets skimmed + tested.
3. **Evaluator** — for the GenAI parts (translation quality, hallucination validators), you own the eval set. Agents can't tell you whether a translation *feels* right; your eval harness can.

The three highest-risk areas where agents commonly produce subtly wrong code for this specific project: cache-key construction (A3 in the review doc), MV3 service-worker lifecycle, and quota/billing math. Hand-review those. Everything else — CRUD, UI components, glue, tests, adapters — delegate aggressively.

---

## 1. Toolchain (what to actually install, week 0)

| Purpose | Tool | Notes |
|---|---|---|
| Primary coding agent | **Claude Code** (terminal/desktop) | Your main builder. Docs: docs.claude.com/en/docs/claude-code/overview |
| Repo memory for agents | `CLAUDE.md` per package | The single highest-leverage artifact you'll write (§2) |
| Serverless GPU | **Modal** | Deploy manga-ocr + comic-text-detector as one endpoint; scale-to-zero; Python-native |
| OCR models | **comic-text-detector** + **manga-ocr** (open source) | Both established, both designed for exactly this domain |
| Baseline MT | **DeepL API Free → Pro** | Your proven pipeline from InstaTL, incl. `context` param + glossary |
| Premium tier (v1, not v0) | Claude API (or provider-abstracted) | Behind the L2/L3/L4 hierarchy from the review doc |
| Backend | FastAPI + Postgres (Neon/Supabase) + Redis (Upstash) | All serverless/managed, all free-tier-friendly |
| Extension | TypeScript + Vite + CRXJS + React | CRXJS makes MV3 dev-reload tolerable |
| Payments (v1) | Stripe | Later |
| Errors/analytics | Sentry + PostHog | Free tiers fine |
| CI | GitHub Actions | Tests must pass before you merge agent output — non-negotiable |

Monorepo layout (one repo, agents navigate it better than multi-repo):

```
mangatl/
├── CLAUDE.md               ← global agent instructions
├── docs/
│   ├── architecture-v2.md  ← the review doc, verbatim
│   └── specs/              ← one spec per feature (§2)
├── extension/    (TS)      ← + its own CLAUDE.md
├── api/          (FastAPI) ← + its own CLAUDE.md
├── inference/    (Modal)   ← + its own CLAUDE.md
└── evals/                  ← translation eval harness (§4)
```

---

## 2. The agent workflow that actually works (spec → test → build → review)

This is the discipline that separates "AI helped me ship" from "AI helped me create a haunted codebase."

**2.1 Write CLAUDE.md files first.** These are standing instructions every Claude Code session reads. Global one contains: the architecture invariants ("cache keys are sacred: OCR cache = hash(image) only; base translation cache = hash+lang+engine+canonical_glossary_version; user glossary NEVER enters a shared cache key"), the L2/L3/L4 hierarchy rule ("user never sees unvalidated LLM output"), code conventions, and "run `make test` before declaring done." Package-level ones add local context (MV3 lifecycle rules in `extension/`, "images are transient, never persist" in `api/`).

**2.2 One feature = one spec file = one agent session.** Before opening Claude Code for a feature, write (or dictate to Claude and edit) a half-page spec into `docs/specs/`: inputs, outputs, edge cases, what NOT to do. Then the session prompt is essentially: "Implement docs/specs/07-page-cache.md. Write tests first. Don't touch modules X, Y."

**2.3 Tests are the leash.** For every spec, have the agent write the test suite first, review the *tests* yourself (much faster than reviewing implementation — you're checking "does this test encode my invariant?"), then let it implement until green. For this project three test suites are your safety net: cache-key property tests, validator (L4) unit tests with known-hallucination fixtures, and quota-math tests.

**2.4 Small sessions, frequent commits.** Agents degrade over long sessions with huge diffs. Cut work so each session lands one reviewable commit. If a session goes sideways, `git checkout .` and restart with a sharper spec — cheaper than untangling.

**2.5 Parallelize where safe.** The three packages have clean boundaries — you can genuinely run one Claude Code session building an extension component while another builds an API module, because the contract between them is a spec'd OpenAPI schema. Generate the API's OpenAPI spec early and hand it to the extension sessions as ground truth; agents building both sides against one schema don't drift.

---

## 3. Build order (10 weeks to public beta, honest solo pace)

**Week 1 — Prove the scary parts (no product code).**
- Modal endpoint: comic-text-detector + manga-ocr wrapped in one HTTP call. Test on 30 real manga pages. *This is the go/no-go gate* — if OCR quality on real pages disappoints, you want to know in week 1, not week 8.
- Extension spike: acquire image bytes from your 2 target reader sites (the blob-URL / canvas-taint problem). Ugly throwaway code is fine.
- Deliverable: a script that takes a manga page URL → prints bubbles + text + boxes.

**Weeks 2–3 — Backend skeleton.**
- FastAPI monolith: auth (magic link), quota module, orchestrator that chains Modal OCR → DeepL, the three-layer cache **with property tests on the keys**, AniList glossary module (GraphQL fetch → canonical glossary).
- Idempotency keys + per-user spend caps from the first commit (they're 10x harder to retrofit).
- Most of this is agent-buildable from specs; you hand-review cache and quota.

**Weeks 4–5 — Extension core.**
- Activation flow, series pinning (AniList search), stateless service worker + IndexedDB, streaming per-bubble overlay (SSE), collision-avoided labels — port the InstaTL overlay logic conceptually (measure → place → nudge-down cascade; it's the same algorithm in DOM instead of WindowManager).
- Skeleton states the moment detection returns.

**Week 6 — Wire it end-to-end + eat your own dogfood.**
- You reading a full chapter through it daily. Every friction point becomes a spec file. This week finds the twenty small things no plan predicts.

**Weeks 7–8 — Hardening.**
- L4 validators (even with DeepL-only, the confidence-gating and CJK-echo checks matter), circuit breaker on DeepL, content-safety scanning on the upload path, Sentry + PostHog, rate limiting, the update-handshake for old extension versions.

**Weeks 9–10 — Private beta.**
- 20–50 users (manga communities are easy to recruit from — your friend is user #1). Chrome Web Store draft listing + privacy policy in parallel (review takes days-to-weeks; start early).
- Your only jobs: watch cache hit rate, cost-per-page, and time-to-first-bubble dashboards; fix the top 3 complaints weekly.

**Deferred to post-beta on purpose:** LLM premium tier (L3), Stripe, Firefox, KO/ZH. The v0 with DeepL + auto-glossary already beats generic tools on the thing users notice most — name consistency.

---

## 4. The GenAI engineering core (where *you* add value no agent can)

**4.1 Build the eval set before the premium tier.** Collect ~100 manga panels where you know the right translation (use officially licensed pages you own for personal reference — never scraped scanlations). For each: source text, gold translation, glossary. Your eval harness scores any engine config on: glossary compliance %, validator pass rate, and an LLM-as-judge quality score (Claude grading candidate vs. gold on meaning/tone — imperfect but directionally reliable when you spot-check 10%). Every prompt tweak, model swap, or provider change runs the evals first. This 1–2 days of work is what lets you iterate on quality *scientifically* instead of vibes.

**4.2 Prompting the L3 tier (when you get there):** structured JSON in/out with strict schema; system prompt = translation directives + full canonical glossary + AniList synopsis (tone) + rolling page context; temperature low; explicit rule "output exactly N items for N inputs; if a bubble is untranslatable, echo its romaji — never invent." The L4 validators from the review doc then enforce what the prompt requests. Prompt asks, validator verifies — never trust the ask alone.

**4.3 Hallucination fixtures:** deliberately feed the pipeline garbage OCR (your "Idachimi" cases are literally the seed corpus) and assert the system shows L2-or-nothing. Regression-test your failure modes like features, because for a translation product they are features.

---

## 5. Solo-dev survival rules

1. **You are the bottleneck, protect the bottleneck.** Agent time is cheap; your review attention isn't. Spend it on cache keys, money paths, auth, and evals. Skim the rest.
2. **Never merge red.** CI green or it doesn't land, no matter how confident the agent sounded.
3. **One deploy target per layer** (Modal, one Fly/Railway app, one extension zip). Solo devs die by a thousand environments.
4. **Weekly cost review** — a cron that emails you yesterday's OCR + MT spend. The day that number surprises you is the day the kill-switch earns its keep.
5. **Ship the boring version.** Every week the LLM tier isn't built is a week DeepL + glossary is already delighting beta users. The premium tier is a pricing feature, not a launch feature.
6. **Keep a decision log** (`docs/decisions/`). Six months in, "why did I key the cache this way?" gets answered by a file, not archaeology — and it doubles as context you paste into agent sessions.

---

## 6. Where each AI tool earns its keep (summary)

| Task | Delegate? | How |
|---|---|---|
| CRUD endpoints, DB models, adapters | Fully | Spec → Claude Code → skim |
| Extension UI components | Fully | Spec + screenshot references |
| Test suites | Mostly | Agent writes, **you review the tests** |
| Cache keys, quota, auth, billing | No | Agent drafts, you line-review |
| OCR/inference deployment | Mostly | Modal examples are agent-friendly |
| Translation prompts + evals | You | Agents assist, you own judgment |
| Legal/privacy policy | Draft only | Agent drafts, real lawyer reviews |
| Store listing, docs, marketing site | Fully | Cheap wins |

The uncomfortable truth a lead GenAI engineer owes you: the agents will make you feel 5x faster on weeks 2–5 and roughly 1x on the parts that decide whether this product is good — the eval set, the validator thresholds, the overlay feel, and the judgment calls about quality. Budget your energy accordingly, and this is very buildable by one person in a quarter.
