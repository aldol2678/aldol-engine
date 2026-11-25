# Phase A — 착수 게이트와 구조 감사

조사일 2026-11-25. 아래 사실은 모두 이 세션에서 직접 조회·실행한 결과다.

## 0. 착수 게이트

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| origin/main SHA | `df9a494647db3261658a5108a098e82cff927208` — Issue 기재값과 일치 | `git fetch origin` + `git ls-remote origin` |
| 원격 브랜치 | main + MarginLife 4개 (ahead/behind 12/0, 19/0, 29/0, 5/0 — Issue와 일치) + 세션 브랜치 | `git rev-list --left-right --count` |
| open Issue | #5 하나 | GitHub 조회 |
| open PR | **4건 (Draft #1~#4)** — Issue 본문의 "0건"과 다르다 | GitHub 조회. #1 `fix/marginlife-rng-snapshot` → main, #2 `p1-headless-sim` → main, #3 `p2-first-playable-ui` → main, #4 `p3-npc-survival` → p2 브랜치 |
| MarginLife 변경 경로 | `docs/SIM_SNAPSHOTS.md`, `games/marginlife/**`, `package.json`, `src/core/rng.js`, `src/render/sim-loader.js`, `tools/check-marginlife*.mjs`, `tools/check-snapshot.mjs`, `tools/run-marginlife.mjs`, `tools/build-marginlife-standalone.py` | `git diff --stat origin/main...<branch>` |
| 이 작업과 겹치는 파일 | **없음** | 이 브랜치는 기존 파일을 하나도 고치지 않는다 |
| 기준선 `npm run check:all` | PASS (종료 코드 0) | `logs/baseline-check-all.log` |
| 기준 해시 | M1 `754a144e`, M2 `7eb7f2df`, M3 `0d316768` — README 기재값과 일치 | 같은 로그 |

### 브랜치 이름 (편차)
Issue는 `feat/athena-engine-next-01`을 지정했지만, 이 클라우드 세션은 지정 브랜치 `ccr-e410efe4-sqwcin`에만 푸시하도록 구성돼 있다. 그 브랜치는 main(`df9a494`)에서 갈라진 새 독립 브랜치라 "새 독립 브랜치, 기존 브랜치 force-push/rebase 금지" 조건은 충족한다. 이름만 다르다 — 필요하면 요청자가 브랜치명을 바꾸면 된다(HOLD: 이름 편차).

### package.json (편차)
`package.json`은 한 줄짜리 파일이고 MarginLife 브랜치 4개가 모두 이 줄을 다시 쓴다. 스크립트 한 개만 추가해도 4개 PR 전부와 충돌한다. Issue 0항에 따라 **수정하지 않고** 독립 실행 명령 `node tools/check-next-all.mjs`로 대체했다. 결과적으로 `npm run check:all`·CI·pre-push 훅은 신규 검사를 돌리지 않는다 (HOLD: 통합).

### 배포 유발 여부
- `.github/workflows/check.yml`은 main 푸시와 main 대상 PR에서 `npm run check:all`만 돌린다. 배포 단계는 없다.
- 레포에 Cloudflare 설정 파일(`wrangler.*`, `_headers`, Pages 워크플로)이 없다. AGENTS.md는 배포를 "스냅샷 푸시(push-files)"와 "라이브 배포"로 설명한다.
- 기존 Draft PR #2의 head 커밋에는 check run이 GitHub Actions `check` 하나뿐이고 commit status와 봇 댓글이 없다. Cloudflare Pages의 Git 연동이 켜져 있으면 브랜치 푸시마다 `Cloudflare Pages` check run과 Preview 댓글이 붙는데, 그런 흔적이 없다.
- 결론: 관측된 증거로는 브랜치 푸시·Draft PR이 Pages Preview/운영 배포를 일으키지 않는다. **Cloudflare 대시보드 자체는 조회하지 못했다 (NOT RUN)**. 이 PR에도 `check` 외의 check run이 붙지 않는지 PR 생성 후 다시 확인해 PR 본문에 적는다.

## 1. 기존 3게임 감사

| | 수풀리 M1 | 별낚시 M2 | 별수호 디펜스 M3 |
| --- | --- | --- | --- |
| 심 | `src/core/sim.js` | `games/star-fishing/fishing.js` | `games/star-defense/defense.js` |
| 심 API | `createInitialState(seed, world)`, `step(state, input, rng, world)`, `simulate` | 같음 + `loadFishingWorld` | 같음 + `loadDefenseWorld` |
| 스텝 방식 | 매 틱 `structuredClone(state)` 후 새 상태 반환 | 같음 | 같음 |
| 입력 프레임 | `{dx, dy, interact?, attack?}` | `{dx, dy, cast?, reel?, interact?}` | `{placeTower?, startWave?}` |
| 페이지 입력 | 키 상태 + 캔버스 드래그 + 공격 버튼 | 키 + 드래그 + 던지기/챔질 버튼 | 클릭(레이캐스트) + 1/2/스페이스 + 버튼 |
| 월드 | `world.json` → `worldToSim` (웨이포인트·집·나무·조각·작물·약초·NPC·내비메시) | 같은 어댑터 + `rules[game.fishing]` | 같은 어댑터 + `rules[game.defense]` |
| 저장 키 | `aldol-engine.supuli-m1.save.v4` | `aldol-engine.star-fishing-m2.save.v1` | `aldol-engine.star-defense-m3.save.v1` |
| 저장 형식 | 평문 JSON(선택 필드: player, quests, shards, crops, herbs, tick, savedAt), 버전·체크섬 없음, 필드별 느슨한 복원 | 평문 JSON | 평문 JSON, 진행 중 웨이브 미저장 |
| RNG | `Rng(seed)` 클로저 — 위치를 저장하지 않음 | 같음 | 같음 |
| 백엔드 | `sim-loader.js`: WASM 우선, JS 폴백 | 같음 | 같음 |
| 프로브 | `window.__SUPULI_M1__` | `window.__STAR_FISHING__` | `window.__STAR_DEFENSE__` |
| 기준 벡터 | `754a144e` (seed `supuli-m1`, 600프레임, `{dx:1,dy:0}`) | `7eb7f2df` | `0d316768` (seed `star-defense-m3`, 600프레임, `[{startWave:true}]`) |

## 2. 공통화 대상 표

| 대상 | 기존 구현 | 중복·한계 | 계약/변경 금지 | 이번 후보의 처리 |
| --- | --- | --- | --- | --- |
| 시드 RNG | `src/core/rng.js` | 스트림 위치를 저장할 수 없음 | **수정 금지** (PR #1이 같은 파일에 checkpoint/restore 추가 중) | 그대로 import. `CountedRng`가 뽑은 횟수를 세고 복원 시 그만큼 빨리 감는다 |
| 상태 해시 | `src/core/state-hash.js` | — | 유지 | 그대로 재사용 (저장 체크섬에도 사용) |
| 고정 스텝 루프 | 페이지마다 rAF + 누적기 복사 | 3벌 중복 | 기존 페이지 불변 | `render/next/shell.js` `startLoop` (신규 게임만) |
| 심 실행/시뮬레이트 | 게임마다 `simulate()` 복사 | 3벌 중복, 리플레이 없음 | 기존 심 불변 | `core/next/runtime.js` `defineGame` (simulate·inspect·snapshot·replay) |
| 엔티티 모델 | 게임마다 배열 + 수동 id 카운터(`towerSeq`…) | 게임별 재구현 | 기존 상태 형식 불변 | `core/next/ecs.js` |
| 공간/충돌 | `navmesh.js`(연속 공간, 원형 장애물), 게임별 `Math.hypot` 거리 검사 | 격자 게임용 없음 | `navmesh.js` 불변 | `core/next/spatial.js` + `navmeshNav()` 어댑터로 기존 내비메시 재사용 |
| NPC FSM | `sim.js` 안의 전이 표(수풀리 전용), 낚시 물고기 FSM 별도 | 2벌 | 불변 | `core/next/fsm.js` (데이터 기반, 순수) |
| 인벤토리/거래 | 없음 (별 = 숫자 필드) | — | — | `core/next/inventory.js` |
| 전투/쿨다운 | `sim.js` 접촉 피해, `defense.js` 타워 쿨다운 | 2벌, 틱 기반 | 밸런스 불변 | `core/next/combat.js` |
| 퀘스트 | 게임마다 `quest.type` 분기 | 3벌, 보상 없음 | 기존 매니페스트 불변 | `core/next/quest.js` (조건 데이터 + 1회 보상) |
| 저장 | 페이지마다 `saveGame/loadGame` | 3벌, 버전·손상 검사 없음 | **키·형식 변경/마이그레이션 금지** | `core/next/save.js` — 신규 게임 전용 |
| 매니페스트 검증 | `worldforge.js` `validateWorldManifest` | — | 유지 | 그대로 재사용 |
| 매니페스트 → 심 | `worldToSim` (M1~M3 필드 고정) | 게임별 필드가 한 함수에 쌓임 | 수정 시 3게임 체크 필요 | 수정하지 않고 `core/next/manifest.js` 어댑터 추가 |
| HUD | `render/hud.js` | — | id·CSS 유지 | 그대로 재사용 (테마 forest/lake/night). 수정 없음 |
| 오디오 | `core/audio.js` + `render/audio.js` | — | 유지 | 기존 음성만 재사용 |
| 에셋 로더 | `render/asset-loader.js` | — | URI 제한·폴백 유지 | 신규 게임은 primitive만 사용 → 로더 미사용 (계약 변화 없음) |
| WASM | `src/wasm/**`, `sim-loader.js` | — | **변경 금지** | 신규 게임은 JS 전용. WASM 미변경 |

기존 게임을 새 코어로 옮기는 일은 범위 밖이다. 옮기면 상태 형식과 해시가 바뀌므로 별도 제안으로만 남긴다.
