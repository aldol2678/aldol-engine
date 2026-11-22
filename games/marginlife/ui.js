// MARGINLIFE P2: first playable, turn-based merchant UI using the P1 simulation.
// Visual avatar movement is UI-only and is saved separately from the deterministic WorldCore.
import { createSim } from "../../src/render/sim-loader.js";
import { createInitialState, step, GAME_KIND, DEFAULT_SEED, PHASES } from "./sim.js";

const root = document;
const el = id => root.getElementById(id);
const WORLD = await fetch("./world.json").then(r => {
  if (!r.ok) throw new Error(`world.json could not load (${r.status})`);
  return r.json();
});
const SEED = DEFAULT_SEED;
const SAVE_KEY = "marginlife.p2.demo.save.v1";
const BACKEND = "js";
const create = () => createSim({ kind: GAME_KIND, seed: SEED, rngSeed: `${SEED}::heroes`,
  world: WORLD, js: { createInitialState, step }, preferJs: true });
let sim = await create();
let policy = "deny";
let avatar = { x: 7, y: 9, face: "down" };
let walkTarget = null;
const down = new Set();
let latestToast = 0;
let lastSavedAt = 0;
let frameTime = 0;

const canvas = el("game-canvas");
const ctx = canvas.getContext("2d", { alpha: false });
ctx.imageSmoothingEnabled = false;
const W = 600, H = 360, TILE = 24;
const MAP_W = 25, MAP_H = 15;
const shopDoor = { x: 7, y: 7 };
const locations = [
  { name: "물약 가게", x: 7, y: 6 },
  { name: "마을 광장", x: 12, y: 8 },
  { name: "잔가지 숲", x: 20, y: 10 },
  { name: "석조 유적", x: 21, y: 3 },
];
function proximity(a,b){ return Math.hypot(a.x-b.x,a.y-b.y); }
function nearShop(){ return proximity(avatar, shopDoor) <= 3.5; }
function phaseIndex(){return sim.state.tick % PHASES.length;}
function dayIndex(){return Math.min(7, Math.floor(sim.state.tick / 3)+1);}
function nextPhase(){return sim.state.finished ? "ending" : PHASES[phaseIndex()];}
const phaseName = { morning:"아침", afternoon:"오후", evening:"저녁", ending:"끝" };
const goalName = { glory:"명예", protect:"수호", fortune:"재물" };
const planName = { rest:"휴식", forage:"채집", forest:"숲 모험", ruins:"유적 원정" };

function escapeHtml(input){return String(input).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}
function toast(message){
  const node=el("toast");node.textContent=message;node.classList.add("show");
  latestToast=performance.now();
}
function say(message){el("speech").textContent=message;el("status-bar").textContent=message;}
function validateAvatar(a){return a && Number.isFinite(a.x)&&Number.isFinite(a.y)&&a.x>=.6&&a.x<MAP_W-.6&&a.y>=.6&&a.y<MAP_H-.6;}
function saveGame(showNotice=false){
  try{
    const payload={version:1,kind:GAME_KIND,seed:SEED,sim:sim.saveSnapshot(),
      avatar:{...avatar},policy,savedAt:Date.now()};
    localStorage.setItem(SAVE_KEY,JSON.stringify(payload));
    lastSavedAt=performance.now();
    if(showNotice)toast("마을의 오늘을 저장했어요.");
    return true;
  }catch(error){
    if(showNotice)toast(`저장에 실패했어요: ${String(error.message||error).slice(0,70)}`);
    return false;
  }
}
async function loadGame(showNotice=false){
  let saved;
  try{
    const raw=localStorage.getItem(SAVE_KEY);
    if(!raw){if(showNotice)toast("아직 저장한 이야기가 없어요.");return false;}
    saved=JSON.parse(raw);
    if(saved.version!==1||saved.kind!==GAME_KIND||saved.seed!==SEED||
       !validateAvatar(saved.avatar)||!(["offer","deny"].includes(saved.policy)))throw Error("저장 파일 형식이 맞지 않아요");
    // Construct a new simulator to keep the live session untouched if validation fails.
    const restored=await create();
    restored.loadSnapshot(saved.sim);
    if(restored.state.worldId!==WORLD.world.id||restored.state.tick<0||restored.state.tick>21)
      throw Error("이 세계와 맞지 않는 세이브예요");
    sim=restored;avatar={...saved.avatar};policy=saved.policy;walkTarget=null;
    sync();if(showNotice)toast("저장한 시간부터 이어가요.");
    return true;
  }catch(error){
    if(showNotice)toast(`불러오기를 중단했어요: ${String(error.message||error).slice(0,65)}`);
    return false;
  }
}
async function resetGame(){
  if(!confirm("이 브라우저에 저장된 《여백》 체험 기록만 초기화할까요?"))return;
  sim=await create();policy="deny";avatar={x:7,y:9,face:"down"};walkTarget=null;
  try{localStorage.removeItem(SAVE_KEY);}catch{}
  if(el("dialog-ending").open)el("dialog-ending").close();
  if(el("dialog-log").open)el("dialog-log").close();
  sync();say("아직 누구의 전설도 쓰이지 않은 첫 아침이에요.");toast("새로운 7일이 시작됐어요.");
}
function makeEvent(e){
  const hero=sim.state.heroes.find(h=>h.id===e.actor);
  const name=hero?.name || (e.actor===sim.state.merchant.id?"물약 가게":e.actor);
  const d=e.detail||{};
  const place=d.location==="ruins"?"석조 유적":"잔가지 숲";
  const messages={
    store_open:`영업 시작. 유지비 ${d.upkeep}G, 외상 ${d.creditAllowed?"허용":"거절"}`,
    potion_bought:`${name}, 물약을 ${d.paid}G에 구매`,
    potion_credit:`${name}에게 물약 ${d.amount}G 외상 판매`,
    potion_denied:`${name}, 물약값이 부족해 구매하지 못함`,
    out_of_stock:`물약 재고가 없어 ${name}에게 판매하지 못함`,
    credit_repaid:`${name}, 외상 ${d.amount}G 상환`,
    hero_plan:`${name}의 오늘 계획: ${planName[d.plan]||d.plan}`,
    hero_forage:`${name}, 채집으로 ${d.earned}G 확보`,
    hero_rest:`${name}, 휴식하며 체력 회복`,
    hero_quest_won:`${name}, ${place} 원정 성공 (+${d.reward}G)`,
    hero_quest_failed:`${name}, ${place} 원정 실패`,
  };
  return {text:messages[e.type]||`${name}: ${e.type}`,time:`${e.day}일 ${phaseName[e.phase]||e.phase}`};
}
function sync(){
  const s=sim.state, phase=nextPhase(),day=dayIndex();
  el("world-clock").textContent=s.finished?"7일 차 · 이야기의 끝":`${day}일 차 · ${phaseName[phase]}`;
  el("day-index").textContent=String(day).padStart(2,"0");
  const phases=el("phase-list").children;
  for(let i=0;i<3;i++)phases[i].classList.toggle("active",!s.finished && i===phaseIndex());
  const m=s.merchant;
  el("metric-cash").innerHTML=`${m.cash} <small>G</small>`;
  el("metric-stock").innerHTML=`${m.stock} <small>병</small>`;
  el("metric-credit").innerHTML=`${m.receivables} <small>G</small>`;
  el("metric-rep").textContent=String(m.reputation);
  el("btn-deny").classList.toggle("selected",policy==="deny");
  el("btn-offer").classList.toggle("selected",policy==="offer");
  el("btn-deny").setAttribute("aria-pressed",String(policy==="deny"));
  el("btn-offer").setAttribute("aria-pressed",String(policy==="offer"));
  el("choice-row").hidden=phase!=="morning";
  const advance=el("btn-advance");
  const settings={
    morning:["물약 한 병, 어떤 선택을 할까?","오늘 용사들이 가게를 방문합니다. 외상을 허용할지 정해주세요.","오늘 영업 시작 ↗","가게 앞에서 영업을 시작할 수 있어요. 외상 정책은 방문한 용사 모두에게 적용됩니다."],
    afternoon:["용사들은 스스로 계획을 세운다.","누구도 이들의 여정을 명령하지 않습니다. 가게에 남아 모험 소식을 들어보세요.","용사들의 계획 확인 ↗","오후의 선택은 용사들의 자금과 체력, 보유 물약이 결정합니다."],
    evening:["그들이 떠난 곳에서는 무슨 일이?","세 용사의 모험 결과를 알아봅니다. 성공과 실패의 여파는 다음 날까지 남습니다.","저녁의 원정 결과 보기 ↗","숲과 유적의 모험은 규칙 기반 난수로 판정됩니다."],
    ending:["일곱 날의 기록이 완성됐어요.","용사의 전설과 별도로, 당신의 상점이 살아남았는지 확인할 수 있어요.","7일간의 결말 보기 ↗","다른 선택으로 다시 시작하면 전혀 다른 이야기가 펼쳐질 수 있어요."]
  }[phase];
  el("decision-title").textContent=settings[0];el("decision-desc").textContent=settings[1];
  advance.textContent=settings[2];el("decision-tip").textContent=settings[3];
  advance.disabled=phase==="morning"&&!nearShop();
  if(phase==="morning"&&!nearShop())el("decision-tip").textContent="영업하려면 가게 입구 가까이 이동하세요. WASD 또는 지도를 터치해 걸어갈 수 있어요.";
  el("heroes-list").innerHTML=s.heroes.map((h,i)=>{
    const action=h.todayPlan?`오늘 계획: ${planName[h.todayPlan]||h.todayPlan}`:
      h.lastAction.startsWith("won:")?`원정 성공 · ${planName[h.lastAction.split(":")[1]]}`:
      h.lastAction.startsWith("failed:")?`원정 실패 · ${planName[h.lastAction.split(":")[1]]}`:
      h.lastAction==="foraged"?"재료 채집 중":h.lastAction==="rested"?"휴식 중":"마을에 머무르는 중";
    return `<div class="hero-card" data-hero="${escapeHtml(h.id)}"><span class="hero-swatch">${["⚔","🛡","✧"][i]}</span><div class="hero-info"><div class="hero-name"><span>${escapeHtml(h.name)}</span><span>${h.cash}G</span></div><span class="hero-sub">${escapeHtml(goalName[h.goal]||h.goal)} · ${escapeHtml(action)} · 물약 ${h.potions}병</span><div class="hp-meter"><i style="width:${h.hp}%"></i></div></div></div>`;
  }).join("");
  const events=s.events.slice(-6).reverse();
  el("events-list").innerHTML=events.length?events.map(e=>{
    const msg=makeEvent(e);return `<li><time>${e.day}일</time><span>${escapeHtml(msg.text)}</span></li>`;
  }).join(""):`<li><span>아직 아무 일도 기록되지 않았어요. 오늘 영업을 시작해보세요.</span></li>`;
  updateLocation();
}
function advance(){
  if(sim.state.finished){openEnding();return;}
  const phase=nextPhase();
  if(phase==="morning"&&!nearShop()){toast("가게 앞으로 돌아와야 영업을 시작할 수 있어요.");return;}
  const input=phase==="morning"?{creditPolicy:policy}:{};
  sim.step(input);
  sync();
  const last=sim.state.events.slice(-1)[0];
  const summary=last?makeEvent(last).text:"하루가 흘렀습니다.";
  say(phase==="morning"?"문을 열자, 용사들이 약을 사러 찾아왔어요.":phase==="afternoon"?"그들은 오늘의 모험을 스스로 선택했어요.":"오늘의 원정 소식이 마을에 도착했어요.");
  if(phase==="evening")el("status-bar").textContent=summary;
  saveGame();
  if(sim.state.finished)openEnding();
}
function openEnding(){
  if(!sim.state.ending)return;
  const m=sim.state.ending.merchant;
  const heroes=sim.state.ending.heroes;
  el("ending-content").innerHTML=`<p>용사는 각자의 모험을 마쳤습니다. 그리고 당신도, 가게를 지키며 일곱 날을 보냈습니다.</p><p><strong>상점 ${m.shopSurvived?"유지 성공":"운영 실패"}</strong> · 남은 골드 <strong>${m.cash}G</strong> · 외상 미수금 <strong>${m.receivables}G</strong> · 평판 <strong>${m.reputation}</strong></p><hr><p>${heroes.map(h=>`${escapeHtml(h.name)}: 원정 ${h.questsWon}/${h.questsAttempted}회 성공, ${h.cash}G, 체력 ${h.hp}`).join("<br>")}</p><p>한 사람의 전설이 끝나도, 마을의 내일은 남아 있어요.</p>`;
  el("dialog-ending").showModal();
}
function openLog(){
  el("full-log").innerHTML=sim.state.events.length?
    sim.state.events.slice().reverse().map(e=>{const t=makeEvent(e);return `<p><span class="eyebrow">${escapeHtml(t.time)}</span> &nbsp; ${escapeHtml(t.text)}</p>`;}).join(""):
    "<p>아직 기록된 사건이 없어요.</p>";
  el("dialog-log").showModal();
}

// Canvas procedural map. The visual positions for heroes do not feed back into the sim.
const trees=[[1,2],[3,3],[1,9],[2,12],[16,3],[18,4],[20,9],[23,8],[21,11],[18,12],[23,13],[22,1]];
const rocks=[[15,7],[18,2],[23,3],[23,5],[14,11],[4,13]];
function randCell(x,y){let n=Math.imul(x+12,18973)^Math.imul(y+4,6271);n^=n>>>13;return (n>>>0)%100;}
function rect(x,y,w,h,color){ctx.fillStyle=color;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));}
function tile(x,y,color){rect(x*TILE,y*TILE,TILE,TILE,color);}
function text(str,x,y,color="#ffebc0",font="bold 10px sans-serif"){
  ctx.fillStyle=color;ctx.font=font;ctx.textAlign="center";ctx.fillText(str,x,y);
}
function drawTree(x,y){
  const px=x*TILE,py=y*TILE;
  rect(px+10,py+13,5,11,"#654e38");
  rect(px+5,py+5,17,13,"#2b5941");rect(px+3,py+9,18,7,"#407555");
  rect(px+7,py+2,13,8,"#568766");rect(px+9,py+5,4,4,"#84a879");
}
function drawHouse(){
  rect(5*TILE,4*TILE,5*TILE,3*TILE,"#806953");
  rect(5*TILE+5,4*TILE+8,5*TILE-10,3*TILE-8,"#d1b58c");
  rect(5*TILE-8,3*TILE+8,5*TILE+16,30,"#493e43");
  rect(5*TILE-2,3*TILE+1,5*TILE+4,25,"#795b56");
  rect(5*TILE+15,3*TILE+10,5*TILE-30,12,"#ab7b68");
  rect(6*TILE+4,5*TILE+4,20,20,"#725b47");rect(6*TILE+6,5*TILE+6,16,16,"#b3d0bc");
  rect(8*TILE+2,5*TILE+2,15,21,"#433a32");rect(8*TILE+7,5*TILE+11,3,3,"#d5b879");
  rect(6*TILE+12,3*TILE-6,46,13,"#4e6a4f");text("약 초 상 점",7.45*TILE,3*TILE+3,"#f0e1b7","bold 12px sans-serif");
  rect(7*TILE-8,7*TILE-10-0*TILE,16,10,"#897a58");
}
function drawSprite(x,y,coat,head="#e9bc8c",hero=false,step=0){
  const px=Math.round(x*TILE),py=Math.round(y*TILE);
  rect(px+3,py+15,18,4,"#17282788");
  rect(px+9,py+7+step,6,9,coat);rect(px+6,py+10+step,12,7,coat);
  rect(px+9,py+1+step,7,7,head);rect(px+8,py+1+step,9,3,hero?"#57728c":"#5b473b");
  rect(px+8,py+15+step,3,4,"#3b393b");rect(px+15,py+15-step,3,4,"#3b393b");
  if(!hero)rect(px+10,py+11,5,4,"#ebdaaf");
}
function drawMap(now){
  ctx.imageSmoothingEnabled=false;
  rect(0,0,W,H,"#3a654c");
  for(let y=0;y<MAP_H;y++)for(let x=0;x<MAP_W;x++){
    let color=randCell(x,y)>60?"#487153":randCell(x,y)>29?"#466d50":"#41694d";
    if(y>=6&&y<=10&&x>=5&&x<=23)color=randCell(x,y)>40?"#977c5d":"#ad8c65";
    if(x>=10&&x<=14&&y>=5&&y<=12)color="#a18a6b";
    if(y>=11&&x<=12&&x>=1)color="#4a847d";
    tile(x,y,color);
    if(randCell(x+33,y+11)>87&&color[1]==="4")rect(x*TILE+4,y*TILE+4,3,3,"#86a27a");
  }
  // Decorative path stones and market objects.
  for(let x=5;x<24;x+=2){rect(x*TILE+6,8*TILE+6,12,6,"#c5a678");}
  for(let i=0;i<4;i++){rect((i+1)*TILE,11*TILE+6,15,5,"#bfd1b3");}
  for(let x=0;x<12;x++){rect(x*TILE,10*TILE+8,20,3,"#b8a078");}
  rect(12*TILE,6*TILE,2*TILE,2*TILE,"#a18460");rect(12*TILE+17,6*TILE+3,12,28,"#d0c098");
  rect(15*TILE,7*TILE,20,22,"#685c4e");rect(15*TILE+4,7*TILE-7,12,7,"#9c8e70");
  for(const [x,y] of rocks){rect(x*TILE+3,y*TILE+9,18,9,"#64766f");rect(x*TILE+6,y*TILE+7,9,5,"#8b9990");}
  for(const [x,y] of trees)drawTree(x,y);
  // Ruins at the top-right.
  rect(20*TILE,2*TILE,3*TILE,3*TILE,"#8b8977");rect(20*TILE+6,2*TILE+6,3*TILE-12,3*TILE-12,"#576d62");
  for(const [x,y] of [[20,2],[22,2],[20,4],[22,4]]){rect(x*TILE+3,y*TILE+3,17,17,"#b1ad98");rect(x*TILE+7,y*TILE+4,4,14,"#d0cbb0");}
  text("석조 유적",21.5*TILE,1.7*TILE,"#e7e2ce","bold 11px sans-serif");
  drawHouse();
  text("잔가지 숲",20.5*TILE,13.9*TILE,"#f2e7c7","bold 11px sans-serif");
  text("마을 광장",12.8*TILE,5.7*TILE,"#e5d8bd","bold 11px sans-serif");
  // Hero figures represent their current reported phase, not independent spatial simulation.
  const phase=nextPhase();
  sim.state.heroes.forEach((h,i)=>{
    const p=phase==="morning"?{x:9+i,y:8}:{x:h.todayPlan==="ruins"?20:h.todayPlan==="forest"?18:h.todayPlan==="forage"?17:10+i,y:h.todayPlan==="ruins"?5:h.todayPlan==="forest"?10:8};
    drawSprite(p.x,p.y,["#6588bb","#8a759e","#a1a66f"][i],"#f0d3a5",true,0);
    text(h.name,p.x*TILE+11,p.y*TILE-4,"#f1f1e4","bold 10px sans-serif");
  });
  const bob=Math.sin(now/180)>0?0:1;
  drawSprite(avatar.x,avatar.y,"#b58460","#edd2ac",false,bob);
  rect(avatar.x*TILE+6,(avatar.y-.28)*TILE,12,3,"#f1d093");
}
function blocked(x,y){
  if(x<.5||x>MAP_W-1.5||y<.5||y>MAP_H-1.5)return true;
  if(x>4.9&&x<10.2&&y>2.6&&y<6.7)return true;
  if(x>19.6&&x<23.4&&y>1.7&&y<5.4)return true;
  if(y>11.1&&x<12.8)return true;
  return trees.some(([tx,ty])=>Math.hypot(tx+.5-x,ty+.5-y)<.6);
}
function updateLocation(){
  const near=locations.map(p=>({...p,d:proximity(avatar,p)})).sort((a,b)=>a.d-b.d)[0];
  el("current-location").textContent=near.d<4?near.name:"마을 길가";
}
function move(dx,dy,seconds){
  if(!dx&&!dy)return;
  const len=Math.hypot(dx,dy);
  const stepMove=Math.min(.25,seconds*3.7);
  dx=dx/len*stepMove;dy=dy/len*stepMove;
  if(!blocked(avatar.x+dx,avatar.y))avatar.x+=dx;
  if(!blocked(avatar.x,avatar.y+dy))avatar.y+=dy;
  avatar.face=Math.abs(dx)>Math.abs(dy)?(dx>0?"right":"left"):(dy>0?"down":"up");
  if(performance.now()-lastSavedAt>800)saveGame();
}
function animation(now){
  if(!frameTime)frameTime=now;
  const dt=Math.min(.05,(now-frameTime)/1000);frameTime=now;
  let dx=0,dy=0;
  if(down.has("a")||down.has("arrowleft")||down.has("left"))dx--;
  if(down.has("d")||down.has("arrowright")||down.has("right"))dx++;
  if(down.has("w")||down.has("arrowup")||down.has("up"))dy--;
  if(down.has("s")||down.has("arrowdown")||down.has("down"))dy++;
  if(dx||dy){walkTarget=null;move(dx,dy,dt);}else if(walkTarget){
    const diff={x:walkTarget.x-avatar.x,y:walkTarget.y-avatar.y};
    if(Math.hypot(diff.x,diff.y)<.25)walkTarget=null;
    else{const oldX=avatar.x,oldY=avatar.y;move(diff.x,diff.y,dt);if(Math.hypot(oldX-avatar.x,oldY-avatar.y)<.001)walkTarget=null;}
  }
  drawMap(now);
  if(now-latestToast>2600)el("toast").classList.remove("show");
  if(!sim.state.finished){
    if(nextPhase()==="morning"){
      const enabled=nearShop();
      if(el("btn-advance").disabled===enabled){el("btn-advance").disabled=!enabled;}
    }
  }
  updateLocation();
  requestAnimationFrame(animation);
}

el("btn-deny").addEventListener("click",()=>{policy="deny";sync();saveGame();});
el("btn-offer").addEventListener("click",()=>{policy="offer";sync();saveGame();});
el("btn-advance").addEventListener("click",advance);
el("btn-save").addEventListener("click",()=>saveGame(true));
el("btn-load").addEventListener("click",()=>loadGame(true));
el("btn-reset").addEventListener("click",resetGame);
el("btn-full-log").addEventListener("click",openLog);
el("close-log").addEventListener("click",()=>el("dialog-log").close());
el("close-ending").addEventListener("click",()=>el("dialog-ending").close());
el("btn-ending-restart").addEventListener("click",resetGame);
window.addEventListener("keydown",e=>{
  if(e.target?.matches("input,textarea,[contenteditable]"))return;
  const key=e.key.toLowerCase();
  if(["w","a","s","d","arrowup","arrowdown","arrowleft","arrowright"].includes(key)){
    e.preventDefault();down.add(key);
  }
});
window.addEventListener("keyup",e=>down.delete(e.key.toLowerCase()));
window.addEventListener("blur",()=>{down.clear();walkTarget=null;saveGame();});
window.addEventListener("pagehide",()=>saveGame());
for(const button of document.querySelectorAll("[data-move]")){
  const dir=button.dataset.move;
  button.addEventListener("pointerdown",e=>{down.add(dir);button.setPointerCapture(e.pointerId);e.preventDefault();});
  button.addEventListener("pointerup",()=>down.delete(dir));
  button.addEventListener("pointercancel",()=>down.delete(dir));
  button.addEventListener("lostpointercapture",()=>down.delete(dir));
}
canvas.addEventListener("pointerdown",e=>{
  const box=canvas.getBoundingClientRect();
  walkTarget={x:(e.clientX-box.left)/box.width*MAP_W,y:(e.clientY-box.top)/box.height*MAP_H};
  canvas.focus({preventScroll:true});
});
await loadGame(false);
sync();
requestAnimationFrame(animation);
window.__MARGINLIFE_P2__={
  get state(){return sim.state;},get hash(){return sim.hash();},get backend(){return sim.backend;},
  get avatar(){return {...avatar};},get policy(){return policy;},get saveKey(){return SAVE_KEY;},
  advance,saveGame,loadGame,resetGame,
};
