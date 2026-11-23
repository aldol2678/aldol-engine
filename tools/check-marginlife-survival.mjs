// P3 MARGINLIFE: real place-graph movement, food, rest and wage accounting.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSim } from '../src/render/sim-loader.js';
import { Rng } from '../src/core/rng.js';
import { createInitialState, step, simulate, GAME_KIND } from '../games/marginlife/sim.js';
import { nextHop, createLifeState, advanceLife } from '../games/marginlife/survival.js';
const world = JSON.parse(readFileSync(new URL('../games/marginlife/world.json', import.meta.url), 'utf8'));
const seed = 'marginlife-life-qa';
const make = () => createInitialState(seed, world);
const run = (s, phase='morning') => {
  const events=[];
  advanceLife(s, world, phase, (type, actor, detail) => events.push({type,actor,detail}));
  return events;
};
const wallet = s => s.merchant.cash + s.heroes.reduce((a,h)=>a+h.cash,0);
let passed=0;
function check(name,fn){fn();passed++;console.log('PASS '+name);}
check('Life state includes exactly the four existing NPC IDs',()=>{
  const s=make();
  assert.equal(s.life.version,1);
  assert.deepEqual(Object.keys(s.life.actors).sort(),world.npcs.map(n=>n.id).sort());
  for (const n of world.npcs) assert.equal(s.life.actors[n.id].locationId,n.homePlaceId);
});
check('Path traversal moves one WorldForge edge, not teleporting',()=>{
  assert.equal(nextHop(world,'spawn','ruins'),'shop');
  assert.equal(nextHop(world,'shop','ruins'),'forest');
  assert.equal(nextHop(world,'forest','ruins'),'ruins');
  assert.equal(nextHop(world,'ruins','spawn'),'forest');
});
check('Inaccessible path refuses movement instead of teleport',()=>{
  const isolated=structuredClone(world);isolated.paths=[];
  const s=make();s.heroes[0].cash=0;
  const events=[];
  advanceLife(s,isolated,'morning',(type,actor,detail)=>events.push({type,actor,detail}));
  assert.equal(s.life.actors['hero-arlen'].locationId,'spawn');
  assert.ok(events.some(e=>e.actor==='hero-arlen'&&e.type==='life_blocked'&&e.detail.reason==='no_path'));
});
check('Each phase creates precisely one survival action per NPC',()=>{
  const s=make(),events=run(s);
  assert.equal(events.length,4);
  assert.equal(new Set(events.map(e=>e.actor)).size,4);
});
check('Eating consumes exactly one ration and lowers hunger',()=>{
  const s=make(), life=s.life.actors['hero-arlen'];
  Object.assign(life,{hunger:75,fatigue:0,food:1});
  const events=run(s);
  assert.equal(life.food,0);assert.equal(life.meals,1);assert.equal(life.hunger,33);
  assert.ok(events.some(e=>e.actor==='hero-arlen'&&e.type==='life_eat'));
});
check('Rest reduces fatigue only after reaching NPC home',()=>{
  const s=make(),life=s.life.actors['hero-arlen'];
  Object.assign(life,{hunger:0,fatigue:70,locationId:'forest'});
  const first=run(s);
  assert.equal(life.locationId,'shop');
  assert.ok(first.some(e=>e.actor==='hero-arlen'&&e.type==='life_move'));
  run(s);
  assert.equal(life.locationId,'spawn');
  const before=life.fatigue;
  const third=run(s);
  assert.ok(third.some(e=>e.actor==='hero-arlen'&&e.type==='life_rest'));
  assert.ok(life.fatigue < before+13);
});
check('Work requires a workplace and tracks external wages in ledger',()=>{
  const s=make(),a=s.heroes[0],life=s.life.actors[a.id];
  Object.assign(life,{locationId:'shop',hunger:0,fatigue:0});a.cash=0;
  const cash=wallet(s),income=s.ledger.outsideIncome;
  const events=run(s);
  assert.equal(a.cash,6);assert.equal(life.wagesEarned,6);
  assert.equal(life.workTicks,1);
  assert.equal(wallet(s)-cash,6);assert.equal(s.ledger.outsideIncome-income,6);
  assert.ok(events.some(e=>e.actor===a.id&&e.type==='life_work'));
});
check('Merchant labor never duplicates potion-store income',()=>{
  const s=make();const cash=wallet(s);const events=run(s);
  assert.equal(s.life.actors[s.merchant.id].wagesEarned,0);
  assert.equal(wallet(s),cash);
  assert.ok(events.some(e=>e.actor===s.merchant.id&&e.type==='life_work'&&e.detail.earned===0));
});
check('No rations means no phantom consumption or negative inventories',()=>{
  const s=make(),life=s.life.actors['hero-arlen'];
  Object.assign(life,{hunger:95,food:0});
  const events=run(s);
  assert.equal(life.food,0);assert.equal(life.meals,0);
  assert.ok(events.some(e=>e.actor==='hero-arlen'&&e.type==='life_blocked'&&e.detail.reason==='no_food'));
});
check('7-day simulation includes move/eat/rest/work actions',()=>{
  const state=simulate(seed,world).state;
  assert.equal(state.tick,21);assert.equal(state.finished,true);
  const types=new Set(state.events.map(e=>e.type));
  for(const type of ['life_move','life_eat','life_rest','life_work']) assert.ok(types.has(type),type);
  assert.equal(state.events.filter(e=>e.type.startsWith('life_')).length,21*4);
});
check('Same world+seed produces identical life states and event history',()=>{
  const a=simulate(seed,world,i=>i===0?{creditPolicy:'offer'}:{});
  const b=simulate(seed,world,i=>i===0?{creditPolicy:'offer'}:{});
  assert.equal(a.hash,b.hash);
  assert.deepEqual(a.state.life,b.state.life);
});
check('21-tick currency and hunger/food bounds across 32 scenarios',()=>{
  for(let i=0;i<16;i++)for(const policy of ['offer','deny']) {
    const r=simulate('life-regression-'+i,world,t=>t===0?{creditPolicy:policy}:{}).state;
    assert.equal(wallet(r),r.ledger.initialCash+r.ledger.outsideIncome-r.ledger.outsideCosts);
    assert.equal(r.merchant.receivables,r.heroes.reduce((a,h)=>a+h.debt,0));
    for(const life of Object.values(r.life.actors)) {
      assert.ok(life.hunger>=0&&life.hunger<=100);
      assert.ok(life.fatigue>=0&&life.fatigue<=100);
      assert.ok(Number.isInteger(life.food)&&life.food>=0);
      assert.ok(life.moves>=0&&life.workTicks>=0&&life.restTicks>=0);
    }
  }
});
check('Pre-P3 P2 state upgrades survival records without mutating old save',()=>{
  const previous=make();delete previous.life;
  const progressed=step(previous,{creditPolicy:'deny'},new Rng(seed+'::heroes'),world);
  assert.equal(previous.life,undefined);
  assert.equal(progressed.life.version,1);
  assert.equal(progressed.tick,1);
});
const snapTest=async()=>{
  const opts={kind:GAME_KIND,seed,rngSeed:seed+'::heroes',world,js:{createInitialState,step},preferJs:true};
  const live=await createSim(opts),continued=await createSim(opts);
  for(let i=0;i<10;i++)live.step(i===0?{creditPolicy:'offer'}:{});
  const snapshot=JSON.parse(JSON.stringify(live.saveSnapshot()));
  continued.loadSnapshot(snapshot);
  assert.equal(continued.hash(),live.hash());
  while(!live.state.finished){live.step({});continued.step({});assert.equal(live.hash(),continued.hash());}
};
await snapTest();passed++;console.log('PASS JSON snapshot at tick 10 resumes identical NPC life and RNG');
console.log('MARGINLIFE P3 survival: '+passed+'/'+passed+' PASS');
