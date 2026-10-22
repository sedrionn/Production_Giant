# Production Giant: briefing for an outside reviewer (another AI or a person)

Read this first, then `docs/plan.md` (roadmap, formulas) and `docs/decisions.md` (what was decided and why, newest first).

## What it is

A personal, local, single-user EVE Online industry planner, a replacement for EVE Guru. It is a Next.js app that Nick runs on his own PC. It talks to EVE's ESI API with his characters' tokens, and the static game data (SDE) is imported into SQLite.

- **Owner:** Nick. He is not a programmer and reviews behaviour, not code. Code is written by Claude Code.
- **Language:** the UI and the conversation are in Russian.

## How Nick plays (the requirements come from this)

- He builds mostly **Caldari ships** at a Sotiyo in Auner, with reactions at a Tatara.
- Favourites:
  - **Flycatcher:** invented with an Augmentation decryptor (+9 runs), one ~5-day job.
  - **Buzzard, Raptor, Kitsune, Jackdaw:** regular builds.
  - **Golem and Nighthawk:** good for keeping slots busy, but lower margin.
  - **Fillers:** T2 rigs and cheap reactions.
  - **Also builds:** Obelisk and Anshar (Gallente).
- He has **3 active characters**, plus 2 inactive accounts with 3 characters each that may be added later.
- He **logs in about every 2 days**. A job that ends between logins means an idle slot. The main goal is to fill a week with as few separate actions as possible.
- **Budget:** about 10B ISK per week.
- **Freight:** he sells in Jita. Products go there by courier contract at 60M per 180k m³ (≈333 ISK/m³). Capitals are not couriered.
- **Blueprints:** he can buy BPCs from contracts, so missing blueprints are not critical.

## What exists (pages)

| Page | What it does |
|---|---|
| Калькулятор | Full build tree for one item: build or buy per node, ME/TE, job cost, invention with decryptor comparison, freight, profit. |
| Что выгодно | Profitability overview by category (Caldari T1/T2, T3, rigs by size, reactions, components, «Прочие», own blueprints), with market depth and "hard to sell" flags. |
| План недели | Picks batches sized to end at a login, ranks them by profit per occupied slot-day and spreads them over the real free slots. Tiers: Caldari hulls, then rigs and reactions, then the rest. One item may take at most 20% of the budget. Shows stages and a purchase list minus stock (multibuy copy). |
| Этапы | The saved plan by stage (fuel → reactions → components → hulls), with progress from ESI industry jobs. |
| Учёт | Wallet ledger across all characters (internal transfers excluded), built and sold per item, undercut orders, losing jobs. |
| Персонажи / Настройки | SSO login, sync (skills, blueprints, jobs, wallet, orders, contracts, assets), structure presets with rigs, blacklist, freight, decryptor defaults. |

## Verified against EVE Guru

- **Job cost** matches to the ISK: Jackdaw, Flycatcher, Golem and a T2 rig.
- **Job times** match within ±1 s.
- **Purchase list** for the same weekly plan: overlapping items agree within rounding. Differences:
  - EVE Guru buys some components and reactions that we build.
  - It counts invention attempts as a total expectation; we round attempts per BPC.

## Hard rules for anyone changing code (from `CLAUDE.md`)

- **`src/engine` stays pure:** no fs, db, network or SDE imports. Data comes in as arguments.
- **Game constants** live in `src/engine/bonuses.ts`, marked `// verify` until confirmed in game.
- **No invented SDE numbers.** Test data that isn't from the SDE is labelled `SYNTHETIC`.
- **`data/` and `.env*` are never shared or committed.** They hold tokens and the local database.

## Known gaps / open questions (good places for ideas)

1. **Build vs buy for intermediates.** Today it is "build if cheaper per unit". Should it consider slot time and logins? EVE Guru buys some components that we build.
2. **Invention on lab slots** is scheduled (attempts pooled per item); T1 copying for invention is not. Spare lab slots could make BPCs to sell.
3. **Missing blueprints for intermediates** (T1 hulls, T1 rig BPCs for invention) are not flagged or added to the purchase list.
4. **Planner:**
   - **Greedy algorithm:** greedy by tier and profit per slot-day; would an ILP or knapsack be meaningfully better?
   - **Steady-state assumption:** this week's hulls are built from components made last week.
   - **Reaction slot use:** reaction slots are often under-used.
5. **Market risk:**
   - **Depth:** only Jita, by order count, freshness and price trend.
   - **Other hubs:** not compared.
   - **Sale speed:** not fed back from real sales (the ledger has the data).
6. **Stock snapshot:** the saved plan freezes stock at save time; jobs started later consume it. Stock already lowers the cash a batch needs and can put stock-made batches first (2026-10-22); output of running jobs is not counted as stock yet.
7. **UI:** no active-page highlight in the top menu (planned).

## What feedback is wanted

- Ideas that save Nick logins or ISK, not code style.
- Wrong game mechanics or formulas. Point to the exact place in `src/engine` and the in-game rule.
- Features EVE Guru or other tools (Ravworks, Fuzzwork, Adam4EVE) have that matter for this play style.
- Simplifications: anything that is over-engineered for a single player.
