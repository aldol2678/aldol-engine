// ENGINE-NEXT-01 local gate: shared core + the three new games, one command.
//   node tools/check-next-all.mjs
// Kept as a standalone command on purpose: package.json is a single-line
// file that every open MarginLife branch rewrites, so adding npm scripts
// here would conflict with them (Issue #5 §0). Wiring these into
// `npm run check:all` / CI is an integration step for whoever adopts this.
import { spawnSync } from "node:child_process";

const CHECKS = ["check-next", "check-rune-vault", "check-star-tactics", "check-star-foundry"];
let failed = 0;
for (const name of CHECKS) {
  const res = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", new URL(`./${name}.mjs`, import.meta.url).pathname], { encoding: "utf8" });
  const lines = (res.stdout || "").trim().split("\n");
  const fails = lines.filter((l) => l.startsWith("FAIL"));
  const summary = lines[lines.length - 1] || "(no output)";
  console.log(`${res.status === 0 ? "PASS" : "FAIL"} tools/${name}.mjs — ${summary}`);
  for (const f of fails) console.log("  " + f);
  if (res.status !== 0) { failed += 1; if (res.stderr) console.log(res.stderr.trim().split("\n").slice(-6).join("\n")); }
}
console.log(failed === 0 ? "ALL NEXT CHECKS PASSED" : `${failed} NEXT CHECK SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
