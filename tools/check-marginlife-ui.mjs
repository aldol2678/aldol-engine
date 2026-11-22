// Headless DOM integration smoke for MARGINLIFE P2.
// This does NOT replace a real Chromium/Android browser run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const here=dirname(fileURLToPath(import.meta.url));
const world=JSON.parse(readFileSync(resolve(here,"../games/marginlife/world.json"),"utf8"));
const nodes=new Map();
const listeners=new Map();
const stored=new Map();
const commands=[];
function classList(){const s=new Set();return {add:x=>s.add(x),remove:x=>s.delete(x),toggle:(x,on)=>{if(on)s.add(x);else s.delete(x);},contains:x=>s.has(x)};}
class Node {
  constructor(id){this.id=id;this.dataset={};this.innerHTML="";this.textContent="";this.disabled=false;this.hidden=false;this.classList=classList();this.attributes={};this.handlers={};this.open=false;this.children=[];}
  addEventListener(type,fn){(this.handlers[type] ||= []).push(fn);}
  setAttribute(k,v){this.attributes[k]=v;}
  click(){for(const fn of this.handlers.click||[])fn({preventDefault(){}});}
  showModal(){this.open=true;}
  close(){this.open=false;}
  getBoundingClientRect(){return {left:0,top:0,width:600,height:360};}
  getContext(){return {fillRect(){commands.push('rect');},fillText(){commands.push('text');},set imageSmoothingEnabled(v){},set fillStyle(v){},set font(v){},set textAlign(v){}};}
  focus(){}
  setPointerCapture(){}
}
function el(id){if(!nodes.has(id))nodes.set(id,new Node(id));return nodes.get(id);}
el('phase-list').children=[new Node('morning'),new Node('afternoon'),new Node('evening')];
const pads=['up','down','left','right'].map(x=>{const b=new Node('pad-'+x);b.dataset.move=x;return b;});
globalThis.document={getElementById:el,querySelectorAll:q=>q==='[data-move]'?pads:[]};
globalThis.window=globalThis;
globalThis.addEventListener=(t,fn)=>{(listeners.get(t)||listeners.set(t,[]).get(t)).push(fn);};
globalThis.requestAnimationFrame=fn=>{globalThis.__frame=fn;};
globalThis.confirm=()=>true;
globalThis.localStorage={getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,String(v)),removeItem:k=>stored.delete(k)};
globalThis.fetch=async url=>({ok:true,json:async()=>world});
const mod=await import('../games/marginlife/ui.js');
const api=globalThis.__MARGINLIFE_P2__;
let checked=0;
function check(label,fn){fn();checked++;console.log('PASS '+label);}
check('Game UI bootstraps JS snapshot simulation',()=>{assert.equal(api.backend,'js');assert.equal(api.state.tick,0);assert.equal(api.state.heroes.length,3);});
check('DOM initial merchant, credits and clock render',()=>{assert.match(el('metric-cash').innerHTML,/75/);assert.match(el('world-clock').textContent,/1일 차/);assert.equal(el('btn-advance').disabled,false);});
check('Offer credit branches hero plan',()=>{
  el('btn-offer').click();el('btn-advance').click();assert.equal(api.state.heroes[0].debt,12);
  el('btn-advance').click();assert.equal(api.state.heroes[0].todayPlan,'ruins');
  assert.equal(api.state.tick,2);
});
check('Game save+load matches state and RNG',()=>{
  const old=api.hash;assert.equal(api.saveGame(),true);
  const checkpoint=stored.get(api.saveKey);
  api.advance();assert.equal(api.state.tick,3);
  stored.set(api.saveKey,checkpoint);
  // Async load only changes state after completion, so checked in later async test.
  assert.notEqual(api.hash,old);
});
const savedHash=JSON.parse(stored.get(api.saveKey)).sim.state;
await api.loadGame();
check('Saved checkpoint restored',()=>{assert.equal(api.state.tick,2);assert.deepEqual(api.state,savedHash);});
check('UI sprite movement via keyboard and animation',()=>{
  const x=api.avatar.x;for(const fn of listeners.get('keydown')||[])fn({key:'d',preventDefault(){},target:{matches(){return false}}});
  __frame(100);__frame(150);__frame(200);
  for(const fn of listeners.get('keyup')||[])fn({key:'d'});
  assert.ok(api.avatar.x>x);assert.ok(commands.length>10);
});
{
  const hash=api.hash;
  stored.set(api.saveKey,JSON.stringify({version:1,kind:'marginlife',seed:'marginlife-demo-01',avatar:{x:1,y:1},policy:'offer',sim:{format:'garbage'}}));
  const result=await api.loadGame();
  check('Corrupt saved payload does not replace live world',()=>{assert.equal(result,false);assert.equal(api.hash,hash);});
}
await api.resetGame();
check('Restart returns to empty, deny policy',()=>{assert.equal(api.state.tick,0);assert.equal(api.policy,'deny');});
check('Deny changes Arlen to forage',()=>{api.advance();api.advance();assert.equal(api.state.heroes[0].todayPlan,'forage');});
check('21 phases finish and show independent endings',()=>{
  while(api.state.tick<21)api.advance();assert.equal(api.state.finished,true);
  assert.ok(api.state.ending.heroes.length===3);assert.ok(el('dialog-ending').open);
  assert.equal(api.state.events.filter(e=>e.type==='store_open').length,7);
});
check('Event log dialog shows historical events',()=>{el('btn-full-log').click();assert.ok(el('dialog-log').open);assert.match(el('full-log').innerHTML,/영업 시작/);});
console.log(`MARGINLIFE P2 DOM smoke: ${checked}/${checked} checks`);
