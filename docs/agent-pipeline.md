# MangaTL — Agent-Based Dev Pipeline (Zero-to-Working Setup)
*Principal AI engineer framing: you already have the right primitives (Cline/Kilo Code, OpenRouter, Obsidian). This is how they snap together into one pipeline for building this specific product, starting from knowing nothing about agents.*

---

## 0. The one rule that makes everything below safe

**Every agent task ends in a git commit you personally reviewed. No exceptions, no "let it run overnight."** This is the human-checkpoint pattern you already correctly identified as the thing that actually works. Everything in this doc is built around that rule, not around it being autonomous.

---

## 1. Tool choice: start with Cline, not Kilo Code

You have zero agent experience — start with the tool that forces you to build trust before it builds momentum.

- **Cline** asks approval before every file edit and terminal command by default. Slower per-task, but you *see* every decision it makes while you're still calibrating what these things get wrong. This matters more than speed in week one.
- **Kilo Code** is genuinely good (Architect/Code/Debug modes map nicely onto spec→build→fix) but its extra autonomy is a feature you earn after you've watched Cline work for a week and know its failure modes.

**Switch to Kilo Code once** you've noticed Cline's approval prompts feel repetitive rather than reassuring — that's the signal you've internalized what to watch for.

Install: VS Code / Antigravity → Extensions → search "Cline" → install → it'll prompt for an API key on first use.

---

## 2. One key, all models: OpenRouter setup

1. Sign up at openrouter.ai, add a small credit balance ($5–10 to start — you'll burn cents per task, not dollars).
2. Copy the API key.
3. Cline settings → API Provider → **OpenRouter** → paste key.
4. Cline's model dropdown now lists every model OpenRouter proxies: Claude Sonnet/Opus, Gemini Pro/Flash, GPT, Kimi (Moonshot), dozens more — switchable per task, no separate accounts.

**Model routing table for this project** — pick deliberately, not by habit:

| Task type | Model | Why |
|---|---|---|
| Cache-key logic, quota/billing math, auth, L4 validators | **Claude Sonnet** | You need to read every line; Claude's code tends to be the most "obviously correct or obviously wrong" to review, less plausible-but-subtly-off |
| Reading/refactoring across the whole repo, large context tasks | **Gemini Pro** (huge context window) | Cheapest way to hand an agent "understand this entire codebase" tasks |
| Boilerplate: CRUD endpoints, test scaffolding, simple UI components | **Kimi K2** or **GPT-mini tier** | Cheap, fast, the ceiling of quality needed here is low |
| One-time second opinion on a security/logic-sensitive diff | **A different model family than who wrote it** | See §5 — this is the one place "multiple models" earns its keep |

---

## 3. Obsidian vault = the project's long-term memory

Structure, inside your existing vault or a new one:

```
MangaTL/
├── .clinerules                  ← Cline reads this automatically, every task
├── architecture-v2.md           ← paste the review doc verbatim
├── gameplan.md                  ← the solo-dev build-order doc
├── decisions.md                 ← append-only log, newest at top
├── glossary-of-terms.md         ← project vocabulary (cache layers, L0-L4, etc.)
└── specs/
    ├── 00-modal-ocr-spike.md
    ├── 01-image-acquisition-spike.md
    ├── 02-fastapi-skeleton.md
    ├── 03-three-layer-cache.md
    └── ... one file per feature, numbered in build order
```

**Why this specific structure works with Cline:** Cline auto-loads a `.clinerules` file from your project root at the start of every single task — this is the real mechanism, not a vague "point it at a folder." Put your non-negotiable invariants there (see the starter file below) and Cline reads them before touching anything, every time, without you re-explaining.

`decisions.md` is your six-months-from-now insurance — one line per real decision: *"2026-07-20: OCR cache key is hash(image) only, no glossary version — glossary changes must never fork this cache. See architecture-v2.md §A3."* When a future agent session (or future you) asks "why is this cache keyed this way," this file answers it instead of you re-deriving it.

---

## 4. The actual pipeline (spec → task → commit → review, on repeat)

This is the loop, every single feature, no shortcuts:

1. **Write the spec** in `specs/NN-feature-name.md` — half a page: inputs, outputs, edge cases, explicit "don't touch these files." If you're not sure what to write, ask Cline (using whichever model) to draft it from a one-paragraph description, then you edit it — you're the reviewer of the spec too, not just the code.
2. **Open a Cline task**, pointed at that one spec file: *"Implement specs/03-three-layer-cache.md. Write tests first, show me the test file before implementing."*
3. **Review the tests it proposes** before letting it implement — this is 10x faster than reviewing implementation, because you're checking "does this test encode my invariant" not "is this code correct."
4. **Let it implement until tests pass.**
5. **You review the diff.** For anything from the "hand-review" row of the model table above, read every line. For boilerplate, skim + run it.
6. **Commit.** This commit is your rollback point — if the *next* task goes sideways, `git checkout .` costs you nothing.
7. **Update `decisions.md`** if anything non-obvious got decided along the way.
8. Move to the next spec file.

That's the entire pipeline. No orchestration framework, no swarm, no agents-catching-agents — just a disciplined loop with a human checkpoint every cycle, which is the pattern that actually survives contact with a real codebase.

---

## 5. Where "multiple models checking each other" genuinely earns its keep

You already correctly identified that autonomous reviewer-agent setups don't reliably work — a reviewer LLM shares the writer LLM's blind spots often enough that it's not real insurance. Full agreement.

**The one place it's worth the extra step, and only this:** before *you* review a diff touching cache keys, auth, quota math, or the L4 hallucination validators — paste that diff into a **different model family** than the one that wrote it (wrote with Claude → get a second pass from Gemini or GPT; wrote with Gemini → second pass from Claude) with the prompt: *"Find bugs, security issues, or logic errors in this diff. Be adversarial, assume it's wrong until proven otherwise."*

This is not autonomous, not a loop, not "forever" — it's one extra manual step, on the ~10% of code where the cost of a subtle bug is high, before your own review. Cheap (one API call), fast (seconds), and it does catch a meaningfully different set of mistakes than the model that wrote the code would catch in itself, because different model families genuinely have different blind spots. That's the real, non-hype version of "multi-model checking" — a second opinion you request, not a system you trust unsupervised.

---

## 6. Week 1, concretely, using this exact pipeline

Per the gameplan's build order, your very first spec files should be:

- `specs/00-modal-ocr-spike.md` — "Deploy comic-text-detector + manga-ocr on Modal as one HTTP endpoint. Input: image bytes. Output: list of {bbox, text, confidence}. No product code, just prove it works on 30 test pages." Route to Gemini or Kimi — this is exploratory scaffolding, not sensitive logic.
- `specs/01-image-acquisition-spike.md` — "Chrome extension content script that extracts image bytes from [your two target reader sites], handling blob URLs and canvas-taint cases. Throwaway code, just prove the acquisition path." Same, cheap model is fine.

These two specs *are* your Week 1 go/no-go gate from the gameplan. Run them through this exact pipeline — spec, task, test, review, commit — and by the end of the week you'll know whether the product is buildable, and you'll have already internalized the loop you'll repeat for the next nine weeks.
