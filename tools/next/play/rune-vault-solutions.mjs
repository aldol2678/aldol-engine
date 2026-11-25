// Rune Vault solutions (U/R/D/L per move), one string per room. Shared by
// tools/check-rune-vault.mjs and the browser scenario. They live here, not
// in the sim: the sim knows the rules, never the answers. Each one is a
// shortest solution found by the BFS solver in the check, which re-proves
// their length on every run.
export const DIR = { U: "up", R: "right", D: "down", L: "left" };
export const SOLUTIONS = [
  "RRDRDRRRRRDD",
  "RRRRDDRRDDLLLLUUDDRRRRUUUURR",
  "DRDDRDLUURUDRRUURRRRDDUULLLLDDDDRRUUDDRR",
];
