# Production Giant — instructions for coding sessions

Personal, local, single-user EVE Online industry planner (EVE Guru replacement). Owner: Nick — not a programmer; he reviews behaviour, not code. Talk to him in Russian, casually and concisely.

Read `docs/plan.md` (roadmap, formulas) and `docs/decisions.md` (what was decided and why) before changing anything non-trivial. Add a dated entry to `docs/decisions.md` for every new decision.

## Hard rules

- **Cloud sessions have NO access** to esi.evetech.net, developers.eveonline.com, login.eveonline.com or any EVE data site. Never try. Anything needing them is a script under `scripts/` that Nick runs locally. Work from `fixtures/` instead.
- **Never invent SDE numbers** (base material quantities, times, probabilities). Use `fixtures/sde/subset.json` (real data). Hand-made test data must be labelled `SYNTHETIC`.
- **`src/engine` stays pure** — no fs, node:*, fetch, db, esi, sde imports (ESLint enforces it). Data comes in as arguments.
- **No magic numbers in formulas**: game constants go to `src/engine/bonuses.ts`, marked `// verify` until confirmed in game.
- `data/` is never committed; `fixtures/` always is.

## Before you finish

`npm run typecheck && npm run lint && npm test` must be clean. Work on a branch, small meaningful commits, open a PR with a Russian summary Nick can read: what changed, how to check it locally.
