# Aldol Engine

aldol.js 기반 웹 게임 엔진. Three.js 0.187.0 / WebGL2. 첫 게임은 **수풀리**(M1), 두 번째 게임은 **별낚시**(M2)로 공유 코어의 재사용을 증명한다.

> 에이전트 작업 계약은 [AGENTS.md](AGENTS.md)가 먼저다. 게임보다 먼저 읽을 것.

## 게임

| 게임 | 설명 | 저장 키 |
| --- | --- | --- |
| [수풀리 M1](games/supuli/) | 마을 + 숲 입구 + 숲 깊은 곳 + 농장. 주민·멧돼지·수호자 NPC, 의뢰 9개, 전투·작물·약초 | `aldol-engine.supuli-m1.save.v4` |
| [별낚시 M2](games/star-fishing/) | 호수 낚시. 찌 던지기·물기 타이밍·챔질, 물고기 FSM, 의뢰 3개, GLB 모델 2종 | `aldol-engine.star-fishing-m2.save.v1` |

로컬 실행: 이 디렉토리에서 `python3 -m http.server 8092` 후
`http://127.0.0.1:8092/games/supuli/index.html` (또는 `games/star-fishing/index.html`).

## 구조

```
src/core/      순수 시뮬레이션 (렌더링·벽시계 무관)
  rng.js           시드 RNG (mulberry32 + FNV-1a)
  state-hash.js    결정성 해시
  sim.js           수풀리 심 (고정 스텝 1/60)
  worldforge.js    WorldForge 매니페스트 검증 + sim 변환
  navmesh.js       격자 내비메시 (A* + 직선 단축, DDA lineClear)
  audio.js         음성·BGM 음정/길이 표 (WebAudio 없이 테스트 가능)
  assets.js        에셋 URI 계약 (builtin: / glb:)
src/render/    렌더 전용 공유 모듈 (심 규칙을 넣지 않는다)
  audio.js         WebAudio 재생 + 음소거 (M 키·🔊 버튼, localStorage 저장)
  asset-loader.js  GLB 로더 (three GLTFLoader 벤더링, 실패 시 원시 폴백)
  hud.js           공유 HUD 킷 (패널·말풍선·프롬프트·버튼·음소거·의뢰 목록)
  vendor/          GLTFLoader / BufferGeometryUtils / SkeletonUtils (three 0.187.0 벤더링)
games/<game>/  게임별 폴더: world.json + 심 + index.html
tools/         check.mjs / check-fishing.mjs / hooks/pre-push / blender/ / ci/
docs/          handoff.md (핸드오프 형식)
```

## 결정성 규칙 (절대)

1. 시뮬레이션 경로는 순수 함수다. 렌더링·입력 장치·벽시계를 받지 않는다.
2. 무작위성은 `src/core/rng.js`의 시드 RNG만 쓴다. `Math.random()`·`Date.now()`·`performance.now()`를 `src/core/`에서 쓰면 체크가 실패한다.
3. 고정 스텝 1/60초. AI 틱은 10–20Hz, 그 사이는 스티어링만 보간한다.
4. 같은 `(seed, frames, inputs, world)`는 항상 같은 상태 해시를 낸다. 다르면 버그다.

현재 해시: 수풀리 `d7b601e9` (seed `supuli-m1`, 600프레임, `{dx:1, dy:0}`), 별낚시 `7eb7f2df`.

## 검사

```sh
npm run check          # 수풀리: 매니페스트 검증 + 구문 + 결정성 + 금지 API
npm run check:fishing  # 별낚시: 매니페스트 + GLB 매직바이트 + 결정성 + 금지 API
npm run check:all      # 둘 다 — 푸시 전 필수
npm run simulate -- --seed <문자열> --frames <수>  # 헤드리스 실행, 상태 해시 출력
```

## 월드 데이터 (WorldForge)

맵은 `games/<game>/world.json` 매니페스트 하나로만 정의한다. 스키마 버전 `worldforge/0.1`. 구역·장소·길·엔티티·NPC·의뢰·규칙의 유일한 원본이며, `sim.js`에 맵 데이터를 하드코딩하지 않는다. 매니페스트 `[x, y, z]`(Y-up)는 sim 2D `(x, z)`로 변환한다. 검증 실패한 월드는 게임이 시작 전에 멈춘다.

## 새 게임 추가 (M2 recipe)

새 게임은 `games/<game>/world.json` (WorldForge 0.1 매니페스트) + 심 + `index.html` + `tools/check-<game>.mjs` + `package.json` 스크립트(`check:<game>`)로 구성한다. 공유 코어는 `src/core/`만 쓰고, 게임별 규칙은 각 게임 폴더의 심에 둔다 — 수풀리 `sim.js`를 복사해서 고치지 않는다. HUD는 `src/render/hud.js` 킷으로 만들고, 저장 키는 게임마다 별도로 둔다 (`aldol-engine.<game>-m2.save.v1`).

## 에셋 (GLB 파이프라인)

매니페스트 에셋 URI는 `builtin:<이름>` 또는 `glb:<게임 폴더 안 상대 경로>.glb`만 된다. 상위 폴더(`..`)·절대 경로·외부 URL은 검증이 거부한다. GLB는 Blender 스크립트(`tools/blender/make-star-fishing-assets.py`, `npm run assets:fishing`)로 만들고 `games/<game>/assets/models/`에 둔다. GLB 로딩은 렌더러에서만 일어나고, 로드 실패 시 원시(primitive) 폴백을 쓰고 게임은 그대로 시작한다.

## 소리

음성(낚시·입질·챔질·대화·의뢰·피격·회복·타격)은 오디오 파일 없이 WebAudio 오실레이터로 합성한다. BGM은 C–Am–F–G 패드 4초 루프. 오디오는 게임 로직에 절대 영향을 주지 않는다. 음소거는 M 키 또는 🔊 버튼, `localStorage`에 저장한다.

## CI

- 로컬 pre-push 훅이 푸시 문지기다 (`tools/hooks/pre-push`가 `npm run check:all` 실행, 클론마다 한 번 `sh tools/install-hooks.sh`).
- 임시 셀프호스트 러너(`aldol-burn-vm2`, 번 VM2)가 main 푸시/PR 때 `check:all`을 돌린다. **임시 러너다: VM2가 2026-11-26 00:00 KST에 자동 삭제되면 러너도 같이 사라진다.** 그 뒤엔 로컬 pre-push 훅만 남는다.

## 라이선스

현재 UNLICENSED (비공개). M3 공개 준비 때 MIT로 전환한다.
