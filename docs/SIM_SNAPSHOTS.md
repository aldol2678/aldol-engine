# Versioned JS simulation snapshots

The **legacy** `sim.loadState(state)` only loads game state. It does **not** restore the position of the simulation PRNG. Avoid claiming deterministic continuation after an ordinary partial save.

For opt-in JS simulations, use `createSim({ kind, seed, rngSeed, world, js, preferJs: true })`. Capture `sim.saveSnapshot()`, serialize it as JSON, and restore it with `sim.loadSnapshot(parsed)`. The format is `aldol.sim.snapshot.v1` with `kind`, `seed`, `rngSeed`, complete `state`, and `rng: {version: 1, seed, state}`. The checkpoint tracks calls from both gameplay `step()` and UI-side `rngNext()/pick()` that use the same stream. It rejects mismatched kinds/seeds, corrupted integer RNG state, or incompatible formats **without changing live state**.

**WASM status:** the current compiled Rust/WASM `Sim` does not expose restorable RNG state; its `saveSnapshot/loadSnapshot` methods explicitly throw. It would be misleading to restore only game state and claim full determinism. `preferJs: true` is the supported opt-in until the Rust crate and compiled artifacts implement equivalent snapshots and pass JS↔WASM replay checks. This change does not rebuild or update WASM.

**Existing games:** Supuli, Star Fishing, and Star Defense currently persist selective progress via their original `SAVE_KEY` files and call legacy `loadState`. This PR deliberately does not change their save schema, backend preference, save keys, or runtime behavior. Adopting complete, compatible snapshots in those games requires separately preserving existing users' saves and conducting all three games' QA. No existing save is overwritten or migrated by this PR.

**Testing:** `npm run check:snapshot` validates preserved seed output, RNG checkpoints, rejected corrupt snapshots, and 21-tick + 14-tick save/resume determinism with a small deterministic mock game. `npm run check:all` includes that test alongside the three existing games. This test is not a browser test or a WASM parity claim.
