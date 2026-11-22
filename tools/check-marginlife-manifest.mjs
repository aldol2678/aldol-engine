import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateWorldManifest } from "../src/core/worldforge.js";
const world = JSON.parse(readFileSync(new URL("../games/marginlife/world.json", import.meta.url), "utf8"));
const result = validateWorldManifest(world);
assert.equal(result.valid, true, JSON.stringify(result.errors));
console.log("PASS MARGINLIFE WorldForge manifest");
