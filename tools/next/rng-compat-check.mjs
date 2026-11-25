// ENGINE-NEXT-03 compatibility tests, actual modules and pinned MarginLife source.
// The fixture is byte-identical to P3 head dd1a91324fe4f00f7989e0efefd2a92a6c8d144f,
// blob b8e4331bb1fcf2d1d9326b8885d80501c3f178a2 (repository MIT).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Rng } from "../../src/core/rng.js";
import { CountedRng, defineGame, MAX_RNG_DRAWS } from "../../src/core/next/runtime.js";
import { serializeSave, parseSave } from "../../src/core/next/save.js";
import { Rng as MarginRng } from "./fixtures/marginlife-rng.mjs";

const seeds = ["", "engine-next-03", "unicode-별", "🐈‍⬛", "seed-a"];
const positions = [0, 1, 1000, 49_999_999, 50_000_000, 50_000_001, 0xfffffffe, 0xffffffff];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aldol-next-rng-"));
let checks = 0;
function equal(a, b, msg) { assert.deepEqual(a,b,msg); checks++; }
function rejects(fn, re) { assert.throws(fn,re); checks++; }
function testRuntime(Counter, define, serialize, parse, label) {
  const game = define({id:"rng-compat",version:1,createState:()=>({value:0}),step(s,i,{rng}){s.value=rng.next();}});
  const opts = {gameId:game.id,version:game.version,validate:s=>game.validateState(s,null)};
  for(const seed of seeds) {
    const plain = new Rng(seed), counted = new Counter(seed);
    for(let i=0;i<1000;i++) equal(counted.next(),plain.next(),label+" initial sequence");
    for(const pos of positions) {
      // Independent oracle uses actual MarginLife initial state, BigInt
      // arithmetic, and MarginLife's own next() implementation.
      const oracle = new MarginRng(seed);
      const initial = oracle.snapshot().state;
      const state = Number(BigInt.asUintN(32, BigInt(initial) + BigInt(pos)*0x6d2b79f5n));
      const legacySnapshot = {version:1,seed,state};
      oracle.restore(legacySnapshot);
      const rng = new Counter(seed,pos);
      equal(rng.snapshot(),legacySnapshot,"snapshot exact legacy shape");
      equal(rng.draws,pos,"constructor position");
      const fromMargin = new Counter(seed);
      fromMargin.restore(oracle.snapshot());
      equal(fromMargin.draws,pos,"restore derives correct position");
      const fromNext = new MarginRng(seed);
      fromNext.restore(rng.snapshot());
      for(let i=0;i<16;i++){
        const value=oracle.next();
        equal(rng.next(),value,"reference continuation");
        equal(fromMargin.next(),value,"margin to next");
        equal(fromNext.next(),value,"next to margin");
        equal(rng.draws,(pos+i+1)>>>0,"wrap");
      }
      const plainSave = {tick:7,seed,rngDraws:pos,value:0};
      const bytes = serialize({gameId:game.id,version:game.version,state:plainSave});
      // Serializer and envelope unchanged: existing schema can be parsed and
      // reserialized without loss or a save migration.
      const parsed=parse(bytes,opts);
      equal(parsed.ok,true,"save accepted");
      equal(parsed.state,plainSave,"legacy state unchanged");
      const restored=game.restore(parsed.state,null);
      equal(serialize({gameId:game.id,version:game.version,state:game.snapshot(restored)}),bytes,"save round-trip exact bytes");
      const restoredOracle=new MarginRng(seed);
      restoredOracle.restore(legacySnapshot);
      game.step(restored,{});
      equal(restored.state.value,restoredOracle.next(),"saved stream");
      equal(restored.state.rngDraws,(pos+1)>>>0,"runtime boundary");
      const nextBytes=serialize({gameId:game.id,version:game.version,state:game.snapshot(restored)});
      equal(parse(nextBytes,opts).ok,true,"post-step save remains readable");
    }
    const c=new Counter(seed,17), snapshot=c.snapshot();
    for(const bad of [{version:2,seed,state:0},{version:1,seed:seed+"!",state:0},{version:1,seed,state:-1},{version:1,seed,state:2**32},{version:1,seed,state:0.5}]) {
      rejects(()=>c.restore(bad),/snapshot/);
      equal(c.snapshot(),snapshot,"rejection does not mutate state");
      equal(c.draws,17,"rejection does not mutate position");
    }
    rejects(()=>c.next.setState(-1),/invalid RNG state/);
    equal(c.snapshot(),snapshot,"raw invalid setter atomic");
  }
  equal(MAX_RNG_DRAWS,0xffffffff,"uint32 max");
  for(const bad of [-1,0.5,2**32,Infinity,NaN]){
    rejects(()=>new Counter("x",bad),/non-negative/);
    equal(game.validateState({tick:0,seed:"x",rngDraws:bad},null),"rngDraws");
  }
  console.log("PASS",label,"(sequence, snapshot interoperability, old-save bytes, modulo boundary, invalid input)");
}

try {
  testRuntime(CountedRng,defineGame,serializeSave,parseSave,"main RNG source");
  // Isolated combined-source tree; neither original branch is merged or altered.
  await fs.mkdir(path.join(root,"src/core/next"),{recursive:true});
  await fs.writeFile(path.join(root,"package.json"),'{"type":"module"}');
  await fs.copyFile(new URL("./fixtures/marginlife-rng.mjs",import.meta.url),path.join(root,"src/core/rng.js"));
  for(const name of ["state-hash.js","next/runtime.js","next/save.js"]){
    await fs.copyFile(new URL("../../src/core/"+name,import.meta.url),path.join(root,"src/core",name));
  }
  const rt=await import(pathToFileURL(path.join(root,"src/core/next/runtime.js")).href);
  const sv=await import(pathToFileURL(path.join(root,"src/core/next/save.js")).href);
  testRuntime(rt.CountedRng,rt.defineGame,sv.serializeSave,sv.parseSave,"actual MarginLife RNG + Next runtime");
  console.log("PASS RNG compatibility assertions:",checks);
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
