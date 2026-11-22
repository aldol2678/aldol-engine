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
