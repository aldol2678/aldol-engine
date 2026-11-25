# Phase B — 공통 엔진 후보 API

경로: `src/core/next/` (순수 심 코어) · `src/render/next/` (렌더 어댑터). 기존 `src/core/*.js`·`src/render/*.js`는 고치지 않고 import만 한다. 모든 코어 모듈은 렌더·벽시계·네트워크·`localStorage`를 쓰지 않는다 (`tools/check-next.mjs`가 금지 API를 검사하고, 기존 `npm run check`도 `src/core/` 하위를 자동으로 훑는다).

테스트는 전부 `tools/check-next.mjs` (262개)에 있다. 아래 "불변식"은 그 테스트가 확인하는 내용이다.

## ecs.js — 엔티티/컴포넌트/시스템/이벤트
```js
import { createEcs, createScheduler, validateEcsState } from "../../src/core/next/ecs.js";
const ecs = createEcs({ components: {
  Pos: { defaults: { c: 0, r: 0 }, validate: (d) => (Number.isInteger(d.c) ? null : "c") },
  Hp:  { defaults: { hp: 1, max: 1 } },
}});
const id = ecs.spawn({ Pos: { c: 2 }, Hp: { hp: 5, max: 5 } });   // 1, 2, 3 … 재사용 없음
ecs.each(["Pos", "Hp"], (id, pos, hp) => { pos.c += 1; });        // id 오름차순
ecs.emit("moved", { id }); ecs.dispatch({ moved: (data) => {} }); // FIFO
ecs.bind(state.ecs);                                              // 매 스텝 맨 위에서 상태에 연결
```
- 상태는 평범한 JSON 하나: `{ nextId, alive, comps, queue, events, eventSeq }` → 그대로 해시·저장된다.
- `spawn / despawn / isAlive / has / get / set / remove / query / each / find / count / ids`
- `emit / dispatch / beginTick` — `dispatch`가 전달한 이벤트는 `state.events`(그 틱의 로그)에 남아 렌더가 소리·저장 시점을 고른다. `beginTick`이 비운다.
- `createScheduler().add(name, fn, { order })` → `run(ctx)`는 `(order, 등록 순서)`로 실행.
- 불변식: id 안정·오름차순·미재사용 / 미등록 컴포넌트·검증 실패는 throw, 실패한 `spawn`은 id를 쓰지 않음 / 순회 중 생성·삭제 안전 / 이벤트는 emit 순서, 핸들러가 낸 이벤트도 같은 dispatch에서 뒤에 전달, 폭주는 차단 / 같은 연산 → 같은 해시 / 죽은 엔티티의 컴포넌트·정렬 안 된 id·미등록 저장소가 든 상태는 거부.

## runtime.js — 고정 스텝·입력 프레임·RNG·리플레이
```js
import { defineGame, createRecorder, replay, CountedRng, TICK } from "../../src/core/next/runtime.js";
export const game = defineGame({
  id: "my-game", version: 1,
  createState(seed, world, rng) { return { ecs: …, phase: "playing" }; },
  step(state, input, { rng, world, tick }) { /* 제자리 변경, 한 틱 */ },
  validateState(state, world) { return null; },   // 저장·복원 검증
  summarize(state, world) { return { phase: state.phase }; },
});
const session = game.start(seed, world);     // { state, rng, world }
game.step(session, { move: "up" });          // 한 틱 = 입력 프레임 하나
game.simulate(seed, frames, inputs, world);  // 헤드리스
game.inspect(session); game.hash(session);   // JSON 상태, 상태 해시
const snap = game.snapshot(session); game.restore(snap, world);
```
- `TICK = 1/60`. 런타임이 `state.tick / state.seed / state.rngDraws`를 관리한다.
- `CountedRng`는 기존 `Rng`를 상속해 `next()` 호출 수만 센다 — 수열은 `Rng`와 완전히 같다. 복원은 `new CountedRng(seed, draws)`로 같은 위치까지 감는다. **`rng.js`는 수정하지 않았다.**
- 입력은 배열(프레임 인덱스), `{ pairs: [[frame, input]] }`, Map, 객체 모두 받는다. 객체가 아닌 입력은 `{}`가 된다.
- `createRecorder(game, seed, { checkpointEvery })` → `capture(session, input)` / `finish(session)`. `replay(game, record, world)`는 체크포인트와 최종 해시를 비교해 `{ ok, hash, mismatch }`를 준다.
- 불변식: 같은 `(seed, frames, inputs, world)` → 같은 해시 / 중간 스냅샷에서 이어도 같은 최종 해시 / 입력 하나를 바꾸면 리플레이가 첫 불일치 체크포인트를 지목 / 다른 게임·버전의 기록 거부.

## spatial.js — 격자·충돌·공간 질의·NavProvider
- 격자: `createGrid({ cols, rows, blocked, cellSize, originX, originZ })`, `inBounds`, `isBlocked`, `cellKey`, `cellToWorld`, `worldToCell`, `manhattan`, `chebyshev`
- 경로: `floodFill(grid, from, { maxCost, isOccupied })`, `findPath(grid, from, to, { isOccupied, maxCost, allowOccupiedGoal })`, `lineOfSight(grid, a, b, isOpaque)`. 이웃 순서는 `DIRS4`(up, right, down, left) 고정 — 동점은 항상 같은 쪽으로 풀린다.
- 도형: `circlesOverlap`, `aabbOverlap`, `circleAabbOverlap`, `pointInAabb`, `moveCircle(circle, dx, dz, obstacles)`(축 분리 슬라이드)
- `createSpatialHash(cellSize)` → `insert / queryCircle / nearest / clear`. 결과는 id 오름차순, 동거리는 작은 id.
- NavProvider `{ isWalkable(x, z), findPath(from, to) }`: `gridNav(grid)`와 `navmeshNav(navmesh)`(기존 `src/core/navmesh.js` 결과를 감쌈). 게임 코드는 인터페이스만 본다.
- 불변식: 벽·범위 밖은 막힘 / 최단 경로·결정적 / `maxCost` 경계 / 접촉은 겹침이 아님 / 1000개 원에서 해시 질의 = 전수 비교.

## fsm.js — 순수 FSM
```js
const def = defineFsm({ id: "guard", initial: "hold", states: {
  hold:    { transitions: [{ to: "advance", when: (ctx) => ctx.dist <= ctx.sight }] },
  advance: { transitions: [{ to: "attack", when: (ctx) => ctx.inRange }] },
  attack:  { transitions: [] },
}});
const fs = createFsmState(def);            // { state, since, prev } — 평범한 JSON
updateFsm(def, fs, ctx, tick);             // 선언 순서로 첫 일치 전이, 한 번에 하나
```
- 불변식: 미정의 상태로의 전이·`when` 없는 전이는 정의 시 거부 / 첫 일치 우선 / 손상된 상태는 throw.

## inventory.js — 아이템·레시피·거래
`createInventory({ capacity, items })`, `count`, `total`, `freeSpace`, `add`, `remove`, `hasAll`, `transfer(from, to, item, qty)`, `craft(inv, inputs, outputs)`, `trade(a, b, give, take)`, `isValidInventory`
- 불변식: 모든 연산은 전부 아니면 전무 / `transfer`·`trade`는 아이템 총량 보존 / 수량은 양의 정수만(0·음수·소수는 throw) / `__proto__` 같은 id 거부 / 0개 스택은 삭제(해시 정규화).

## combat.js — 체력·피해·쿨다운
`createHealth(max, hp)`, `applyDamage(health, amount, { armor, minDamage })` → `{ dealt, killed, overkill }`, `heal`, `isDead`, `createCooldown`, `cooldownReady`, `cooldownRemaining`, `triggerCooldown(cd, tick, ticks)`, `rollDamage(rng, { base, variance, critChance, critMultiplier })`
- 틱(또는 턴) 기반. `rollDamage`는 결과와 무관하게 정확히 2번 뽑는다 → RNG 위치가 결과에 좌우되지 않는다.
- 불변식: 0 미만으로 안 내려감 / 죽은 대상은 피해·치유 없음 / 최대치 초과 치유 없음 / 쿨다운 경계 틱에 준비됨.

## quest.js — 조건·보상
매니페스트 `quests[].nodes[].params`에 `{ stat, op, value }`(조건)와 `{ reward: { items } }`(보상)를 둔다.
`questDefsFromManifest(quests)`, `createQuestLog(defs)`, `updateQuests(log, defs, stats, grant)`, `allQuestsDone`, `isValidQuestLog`
- 불변식: 보상은 퀘스트당 정확히 한 번(`rewarded`) — 저장을 불러와 다시 갱신해도 중복 지급 없음 / 완료는 되돌아가지 않음 / 중복 id·조건 없는 퀘스트·모르는 연산자는 거부.

## save.js — 버전형 저장 (신규 게임 전용)
```js
const text = serializeSave({ gameId: game.id, version: game.version, state: game.snapshot(session) });
const r = parseSave(text, { gameId, version, validate: (s) => game.validateState(s, world) });
// r = { ok: true, state, tick } | { ok: false, code, detail }
```
- 봉투: `{ format: "aldol-next-save/1", gameId, version, tick, checksum, payload }`, `checksum = stateHash(payload)`.
- 거부 코드: `E_EMPTY` `E_TOO_LARGE` `E_PARSE` `E_FORMAT` `E_GAME` `E_VERSION_UNKNOWN` `E_CHECKSUM` `E_SHAPE`. 거부된 저장은 부분 적용하지 않는다.
- `saveKey("rune-vault", "m4")` → `aldol-engine.rune-vault-m4.save.v1`.
- 기존 3게임의 키·형식은 건드리지 않으며 마이그레이션도 없다. 기존 형식(M3 저장 모양)을 넣으면 `E_FORMAT`으로 거부된다.

## manifest.js — WorldForge 0.1 어댑터 (추가형)
`loadGameWorld(manifest, { ruleType, projectId })` — 기존 `validateWorldManifest`로 검증한 뒤 `{ worldId, config, places, entities, entityById, quests, questDefs, bounds }`를 **깊은 동결**해 돌려준다. `parseTileRows(rows)`는 `"#..#"` 타일 줄을 `{ cols, rows, blocked, marks }`로 바꾼다.
- `worldforge.js`의 `worldToSim`은 M1~M3 전용 필드가 쌓여 있어 건드리지 않았다. 신규 게임은 `rules[].config`를 이 어댑터로 읽는다.
- 불변식: 잘못된 매니페스트·없는/비활성 규칙·다른 프로젝트·외부 URL·`..` 경로 에셋은 시작 전에 throw.

## 렌더 어댑터 (`src/render/next/`)
- `board.js` — `createBoard({ container, cols, rows, isWall, theme, insets })`: WebGL 렌더러, 조명, 타일 바닥(인스턴싱), 세로·가로 모두 보드가 들어오는 카메라, `pick / cellToScreen / onCellTap`, `createHighlightLayer`, `createMeshSync(make, update)`, `easeTo`. 원시 도형만 쓴다.
- `shell.js` — `createSaveSlot`(localStorage + `parseSave`), `createRunner`(시작/복원, 틱당 명령 1개 = 입력 프레임, 자동 저장, 새 게임, 리플레이 기록), `startLoop`(고정 스텝 누적기, `speed` 배속), `bindKeys`, `createDpad`, `installProbe`(`window.__ALDOL_NEXT__`).
- HUD·오디오는 기존 `src/render/hud.js`·`audio.js`를 그대로 쓴다. 킷은 수정하지 않았고, 좁은 화면 보정은 각 페이지의 작은 `<style>`에 둔다.
