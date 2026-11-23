# 여백 | MARGINLIFE: P1 autonomous NPC simulation

A **headless prototype**, not a playable UI or production build. The player occupies the role of a potion-shop merchant; three heroes choose their own plans and resolve adventures over seven in-game days (morning/afternoon/evening). A merchant choice about credit on day 1 changes Arlen's first action and the resulting event history.

- Data: `games/marginlife/world.json` (WorldForge 0.1 manifest plus `game.marginlife` rule)
- Pure simulation: `games/marginlife/sim.js` (one tick per day phase)
- Tests: `npm run check:marginlife`; included in `npm run check:all`
- Scenario run: `node tools/run-marginlife.mjs offer marginlife-demo-01` or `deny`

## Design contracts

- **Autonomy:** heroes choose quests and recover without direct player control; the merchant's credit choice changes resources, which may change their plans.
- **Causality:** each plan, purchase, debt repayment and quest result is written to an ordered event log with unique ID, tick and day.
- **Accounting:** all purchases/repayments are bilateral, merchant receivables equal hero debts, and externally earned/rewarded currency is tracked explicitly.
- **Determinism:** `createSim({ kind: "marginlife", seed, rngSeed: `${seed}::heroes`, world, js: {createInitialState, step}, preferJs:true })` uses the dependent snapshot API from the RNG fix PR. `saveSnapshot()/loadSnapshot()` preserve game state and random stream position.
- **No WASM parity claim:** Rust/WASM snapshots are not supported yet. Existing Supuli, Star Fishing and Star Defense save data remain unchanged.

The demonstration uses one merchant, three heroes, 7 days and 21 fixed phase steps. It is a **systems probe**, so there is no polished economy balancing, NPC dialogue, 2D/3D graphics, mobile controls, persistent user save slot or browser QA. Those belong to later gates.

This branch is stacked on `fix/marginlife-rng-snapshot-20261122` (PR #1). It must not be merged to `main` before the RNG dependency is approved or otherwise reworked. No production deploy is part of this change.

## P2 first playable web screen

- Launch `games/marginlife/index.html` on a local HTTP server. An offline, dependency-free single HTML is generated with `python3 tools/build-marginlife-standalone.py` (writes outside the repo by default).
- UI: procedural 2D pixel map, moving merchant avatar (WASD/arrows/tap-to-walk/touch D-pad), shop trade-credit policy, morning/afternoon/evening progression, merchant and autonomous-hero status cards, event journal, seven-day ending.
- Persistence: `marginlife.p2.demo.save.v1` stores the opt-in JS `saveSnapshot()` (including RNG position) and UI-only avatar coordinates. New saves do not overwrite Supuli/Star Fishing/Star Defense.
- **Scope boundary:** the rendered character movement and hero screen positions are visual UI-only, not a WorldCore navmesh or persistent NPC location model. Time advances only on button press (21 turns/7 days). One classic 2D presentation only; HD pixel/3D have not yet been connected.
- `npm run check:marginlife:ui` runs 11 Node/mock-DOM smoke checks. Real Chromium and Android visual QA remain pending because local Chromium was blocked by administrator URL policies during this task. Do not claim browser PASS or deploy readiness from these checks.

## P3 NPC survival life loop (draft)

- `survival.js` now advances one NPC life action for each of the 4 NPCs per P1 phase: move, eat, rest, work. Life state is included in existing game snapshots.
- NPC movement uses one WorldForge graph edge per phase and a deterministic sorted breadth-first route. A new spawn-shop path connects NPC home and workplace. No silent teleport.
- Hunger +13 and fatigue +10 per phase (0..100); initial food 6, eating reduces hunger by 55, resting at home reduces fatigue by 42. Hero wages are 6G and accounted as external income; merchant work pays no external wage.
- IMPORTANT limitation: P1 potion trades and adventures still use the legacy abstract phase rules and are not yet spatially gated. P2 hero sprites are illustrative and do not yet reflect physical life-state positions.
- QA: `node tools/check-marginlife-survival.mjs` 13 checks plus 32 multi-seed scenarios; P1 11/11 and P2 mock DOM 11/11 local. `tools/build-marginlife-standalone.py` now embeds survival code.
- Stacked development only. PR #1/#2/#3 remain prerequisites; no main merge, deployment or live-save migration.
