# 신규 게임 제작 가이드 (ENGINE-NEXT-01 후보 코어 기준)

AGENTS.md의 M2 레시피(매니페스트 + 심 + 페이지 + 체크)를 그대로 따르되, 심과 페이지의 공통 부분을 `src/core/next/`·`src/render/next/`에서 가져온다. 참고 구현: `games/rune-vault/`(가장 작음), `games/star-tactics/`, `games/star-foundry/`.

## 1. `games/<game>/world.json`
- `schemaVersion: "worldforge/0.1"`, 필수 최상위 키 12개. 에셋 URI는 `builtin:*` 또는 `glb:<게임 폴더 안 경로>.glb`.
- 게임 규칙·밸런스·맵은 `rules: [{ id, type: "game.<kind>", enabled: true, config: {…} }]`에 둔다. 격자 맵은 `config`의 타일 줄(`"#..#"`)로, 고정 구조물·유닛은 `entities`(좌표 `[x, 0, z]` = 칸 `[c, r]`)로 적는다.
- 퀘스트는 조건 노드 `params: { stat, op, value }`, 보상 노드 `params: { reward: { items: {…} } }`.
- 심에 맵·수치를 하드코딩하지 않는다.

## 2. `games/<game>/<sim>.js`
```js
import { createEcs, validateEcsState } from "../../src/core/next/ecs.js";
import { defineGame } from "../../src/core/next/runtime.js";
import { saveKey } from "../../src/core/next/save.js";
import { loadGameWorld, parseTileRows } from "../../src/core/next/manifest.js";

export const GAME_ID = "my-game";
export const SEED = "my-game-m7";
export const SAVE_KEY = saveKey(GAME_ID, "m7");

export function loadWorld(manifest) {
  const base = loadGameWorld(manifest, { ruleType: "game.mine", projectId: GAME_ID });
  // config 검증 + 격자 등 파생 데이터. 잘못되면 throw (게임이 시작 전에 멈춘다).
  return Object.freeze({ ...base, grid: … });
}
const ecs = createEcs({ components: { … } });

export const game = defineGame({
  id: GAME_ID, version: 1,
  createState(seed, world, rng) { return { ecs: ecs.bind(createEcsState()).state, phase: "playing", quests: createQuestLog(world.questDefs) }; },
  step(state, input, { rng, world, tick }) {
    ecs.bind(state.ecs); ecs.beginTick();
    // 1) 입력 명령 하나 처리 (불법·쓰레기 입력은 조용히 무시)
    // 2) 시스템을 고정 순서로 실행
    // 3) ecs.dispatch(), 퀘스트 갱신, 승패 판정
  },
  validateState(state, world) { /* 저장을 믿지 말고 구조·참조·보존 법칙을 검사 */ return null; },
  summarize(state) { return { phase: state.phase }; },
});
```
규칙:
- 상태는 평범한 JSON. 함수·Map·Set·클래스를 넣지 않는다. `state.ecs`에 ECS 상태, `state.phase`, `state.quests`를 둔다.
- 스텝은 제자리 변경(틱마다 `structuredClone` 금지). 순회는 id 오름차순, 동점은 작은 id / `DIRS4` 순서.
- 무작위는 `ctx.rng`만. `Math.random`·`Date.now`·`performance.now`·타이머·`fetch`·`localStorage` 금지.
- 턴제도 고정 틱 위에서 돈다: 플레이어 명령은 입력 프레임, 적 턴은 N틱마다 한 행동.
- 입력은 "자기 속성"만 읽는다(`Object.prototype.hasOwnProperty`).
- 게임 사이에 심을 복사하지 않는다. 필요한 공통 기능은 코어 모듈에 추가하고 `tools/check-next.mjs`에 테스트를 넣는다.

## 3. `games/<game>/index.html`
- `<head>`는 기존 게임과 같은 viewport 메타 + three 0.187.0 importmap.
- `installHudCss(theme)` + `createHudPanel`(의뢰·저장 줄은 `collapsible: true`) + `createBoard` + `createSaveSlot` + `createRunner` + `startLoop` + `installProbe`.
- 페이지는 심 상태를 직접 고치지 않는다. 키·버튼·탭은 전부 `runner.push(cmd)`로 간다.
- 저장은 `shouldSave(state, events)`가 고른 이벤트 시점과 300틱마다. 불러오기 실패(`loadResult.code`)는 화면에 알리고 새로 시작한다.
- 모바일 기본값(선택·드래그·롱프레스 차단, `touch-action`)은 HUD 킷 CSS가 넣는다. 버튼은 `createRoundButton`·`createDpad`.
- 1280×800, 390×844, 844×390, 320×568에서 HUD 요소끼리 겹치지 않고 페이지가 스크롤되지 않아야 한다 (`tools/next/browser-check.mjs`가 잰다). 필요하면 페이지 `<style>`에 미디어 쿼리를 둔다 — 킷 CSS는 고치지 않는다. 현재 킷에서 주의할 점: `.hud-panel`의 `max-width`는 패딩을 빼고 계산되므로 페이지에서 `box-sizing: border-box`를 주고, `#bark`가 보드 탭을 가리면 `pointer-events: none`을 준다.

## 4. `tools/check-<game>.mjs`
`tools/next/harness.mjs`를 쓴다.
- 매니페스트 유효 + 손상 매니페스트 거부
- 규칙별 정상·경계·동점·잘못된 입력
- 승리 경로와 실패 경로(해답·봇은 체크 쪽에 둔다)
- `determinismSuite` — seed 10개 이상: 재실행 일치, 리플레이 일치, 중간 저장→복원 후 일치 + `SEED` 기준 해시 고정
- `saveRejectionSuite` — 손상·버전 불일치·다른 게임·형식 불일치·재서명된 불량 상태 거부
- 금지 API·구문·페이지 스크립트 구문·재사용 증거(코어 import 수)

## 5. `tools/next/play/<game>.mjs`
`meta = { id, path, saveKey, ready }`와 `play(page, ctx)`. PC는 실제 키 입력, 모바일은 실제 탭만으로 시작→핵심 플레이→새로고침 복원→완료→새 게임을 확인한다.

## 6. 등록
- `tools/check-next-all.mjs`의 `CHECKS`에 추가한다.
- 채택 단계에서 할 일(이번 후보는 하지 않음): `package.json`에 `check:<game>` 추가와 `check:all` 연결, 랜딩(`index.html`)·`sitemap.xml`·README 표·AGENTS.md 갱신, og 이미지.
