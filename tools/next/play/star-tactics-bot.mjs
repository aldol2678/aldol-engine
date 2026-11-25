// Star Tactics bot — picks the next player command from a plain state
// (headless check and browser scenario share it; it is not part of the sim).
// Strategy: heal a wounded ally, else use the strike skill, else attack,
// else step to a cell that allows an attack, else (late turns) close in.
// Returns { type, unit, target?, c?, r?, cmd } where cmd is the input frame.
import { listUnits, reachableCells, attackTargets, skillTargets, skillReady } from "../../../games/star-tactics/tactics.js";

const dist = (a, b) => Math.abs(a.c - b.c) + Math.abs(a.r - b.r);

export function planAction(state, world, { huntTurn = 5 } = {}) {
  if (state.phase !== "player") return null;
  const units = listUnits(state);
  const byId = new Map(units.map((u) => [u.id, u]));
  const enemies = units.filter((u) => u.team === "enemy");
  const weakest = (ids) => ids.slice().sort((a, b) => byId.get(a).hp - byId.get(b).hp || a - b)[0];
  for (const u of units.filter((x) => x.team === "player" && x.ap > 0)) {
    const cls = world.classes[u.cls];
    const sk = cls.skill;
    if (sk && u.ap >= sk.cost && skillReady(state, u.id)) {
      const targets = skillTargets(state, world, u.id);
      if (sk.kind === "heal") {
        const hurt = targets.filter((id) => byId.get(id).max - byId.get(id).hp >= Math.min(sk.amount, 4));
        if (hurt.length > 0) {
          const target = hurt.sort((a, b) => (byId.get(b).max - byId.get(b).hp) - (byId.get(a).max - byId.get(a).hp) || a - b)[0];
          return { type: "skill", unit: u.id, target, cmd: { skill: { unit: u.id, target } } };
        }
      } else if (targets.length > 0) {
        const target = weakest(targets);
        return { type: "skill", unit: u.id, target, cmd: { skill: { unit: u.id, target } } };
      }
    }
    if (u.ap >= cls.attack.cost) {
      const targets = attackTargets(state, world, u.id);
      if (targets.length > 0) {
        const target = weakest(targets);
        return { type: "attack", unit: u.id, target, cmd: { attack: { unit: u.id, target } } };
      }
    }
    const cells = reachableCells(state, world, u.id);
    const spot = cells.find((cell) => cell.cost <= u.ap - cls.attack.cost && attackTargets(state, world, u.id, cell).length > 0);
    if (spot) return { type: "move", unit: u.id, c: spot.c, r: spot.r, cmd: { move: { unit: u.id, c: spot.c, r: spot.r } } };
    if (state.turn >= huntTurn && enemies.length > 0 && u.ap >= cls.attack.cost) {
      const near = (p) => Math.min(...enemies.map((e) => dist(p, e)));
      const here = near(u);
      let best = null;
      for (const cell of cells) {
        if (cell.cost > u.ap - 1) continue;
        const d = near(cell);
        if (d < here && (best === null || d < best.d)) best = { ...cell, d };
      }
      if (best && here > cls.attack.range) return { type: "move", unit: u.id, c: best.c, r: best.r, cmd: { move: { unit: u.id, c: best.c, r: best.r } } };
    }
  }
  return { type: "endTurn", cmd: { endTurn: true } };
}

// Headless driver: plays until the game ends (or maxTicks). Returns the
// inputs array it fed so the run can be replayed.
export function botPlay(game, world, seed, { maxTicks = 20000, huntTurn = 5 } = {}) {
  const session = game.start(seed, world);
  const inputs = [];
  while (session.state.tick < maxTicks && (session.state.phase === "player" || session.state.phase === "enemy")) {
    const plan = session.state.phase === "player" ? planAction(session.state, world, { huntTurn }) : null;
    const input = plan ? plan.cmd : {};
    inputs.push(input);
    game.step(session, input);
  }
  return { session, inputs };
}
