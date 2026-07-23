# MangaTL

Context-aware in-place manga translation. Start here.

## What's in this repo already
- `docs/architecture-v2.md` — the target system design (read this once, fully, before writing code)
- `docs/gameplan.md` — the 10-week solo build order
- `docs/agent-pipeline.md` — how you'll actually use Cline/OpenRouter day to day
- `docs/decisions.md` — append-only log of real decisions made; add to it as you go
- `docs/specs/00-modal-ocr-spike.md` and `01-image-acquisition-spike.md` — your first two tasks
- `.clinerules` — Cline reads this automatically every task; don't delete it
- `extension/`, `api/`, `inference/` — empty, waiting for week 1

## Your literal first session, in order

1. **Install tools** (if not already):
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
   nvm install --lts
   pip install uv modal
   modal token new
   ```
2. **VS Code** → Extensions → install **Cline**.
3. **OpenRouter**: sign up at openrouter.ai, add ~$5-10 credit, copy the API key.
4. **Cline settings** → API Provider → OpenRouter → paste key.
5. **Open this folder in VS Code.** Cline will auto-read `.clinerules` on its first task.
6. **git init, first commit:**
   ```bash
   cd mangatl
   git init
   git add .
   git commit -m "scaffold: docs, rules, spec 00-01"
   ```
7. **First Cline task** — open Cline, select **Gemini** (large-context, cheap, fine for exploratory
   scaffolding — see the model routing table in `docs/agent-pipeline.md`), and give it this prompt:

   > Implement `docs/specs/00-modal-ocr-spike.md`. Read the spec fully first. Write the test script
   > described, then the Modal app. Show me the file structure you plan to create before writing code.

8. **Get 10-30 manga page images you have rights to** into `inference/test_pages/` before running
   the test script (per `decisions.md`: no scraped scanlation content, even for testing).
9. When Cline finishes: **review the diff yourself**, run the test script, spot-check 5-10 outputs
   against the source images with your own eyes. Then commit.
10. Repeat step 7 with `specs/01-image-acquisition-spike.md` in a fresh Cline task.
11. Write the go/no-go paragraph in `docs/decisions.md` for both. If both look workable, you're
    cleared for week 2 in `docs/gameplan.md`.

## Rules you already agreed to (enforced in `.clinerules`, not just written down)
- Every task ends in a commit you personally reviewed.
- No scraping/training on scanlation sites, ever, at any scale.
- Cache keys and validator logic get hand-reviewed line by line — no exceptions.
