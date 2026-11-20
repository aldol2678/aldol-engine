# AGENTS.md — Aldol Engine (M1)

이 저장소에서 일하는 에이전트(Moa·Ark·Naru 등)의 계약. 게임보다 먼저다.

## 목적
- aldol.js 기반 웹 게임 엔진. M1 첫 게임은 **수풀리** (마을 1맵 슬라이스 → 2026-11-20 확장: 마을 + 숲입구 + 숲 깊은 곳 + 농장, 의뢰 9개, 전투 공격/처치, 작물·약초). M2 두 번째 게임은 **별낚시** (호수 낚시: 찌 던지기·물기 타이밍·챔질, 물고기 FSM, 의뢰 3개) — 같은 공유 코어(`src/core/`) 위의 새 게임으로 재사용을 증명한다.
- Three.js 0.160.0, WebGL2 기본. 라이선스는 UNLICENSED (M3 전 MIT).
- 배포는 Cloudflare Pages만. `latest` 태그는 쓰지 않는다.

## 디렉터리
- `src/core/` — 렌더링·벽시계와 무관한 순수 시뮬레이션 (RNG·상태 해시·고정 스텝·WorldForge 매니페스트 검증/변환)
- `src/simulate-cli.mjs` — 헤드리스 실행 CLI
- `tools/check.mjs` — `npm run check` 진입점
- `games/<game>/world.json` — WorldForge 매니페스트 (`worldforge/0.1`). 맵(구역·장소·길·엔티티·NPC·의뢰·규칙)의 유일한 원본. `sim.js`에 맵 데이터를 하드코딩하지 않는다.
- `docs/` — 결정·핸드오프 형식
- `templates/` — 다중 에이전트 태스크 템플릿

## 명령
- `npm run check` — 매니페스트 검증 + 구문 검사 + 결정성 테스트 + 금지 API 검사. 커밋 전 필수.
- `npm run check:all` — `check` + `check:fishing` 전부. 푸시 전 필수 (pre-push 훅이 이걸 돌린다).
- `npm run simulate -- --seed <문자열> --frames <수> [--inputs <JSON>] [--world <경로>]` — 헤드리스 실행, 상태 해시 출력. 기본 월드는 `games/supuli/world.json`.

## 푸시 게이트 (로컬)
- GitHub Actions 포함 분(3,000분)이 소진돼서 클라우드 CI는 못 쓴다. 대신 로컬 pre-push 훅이 푸시 문지기다.
- `tools/hooks/pre-push`가 `npm run check:all`을 돌리고, 실패하면 푸시를 막는다. 클론마다 한 번 `sh tools/install-hooks.sh`로 설치한다 (git 훅은 버전 관리가 안 되니까 체크인된 스크립트를 심링크로 건다).
- 스냅샷 푸시(push-files)에는 git 훅이 안 걸리니까, 그때는 푸시 전에 `npm run check:all`을 직접 돌린다.

## 결정성 규칙 (절대)
1. 시뮬레이션 경로는 순수 함수다. 렌더링·입력 장치·벽시계를 받지 않는다.
2. 무작위성은 `src/core/rng.js`의 시드 RNG만 쓴다. `Math.random()`·`Date.now()`·`performance.now()`를 `src/core/`에서 쓰면 `npm run check`가 실패한다.
3. 고정 스텝 1/60초. AI 틱은 10~20Hz, 그 사이는 스티어링만 보간한다.
4. 같은 `(seed, frames, inputs, world)`는 항상 같은 상태 해시를 낸다. 다르면 버그다.

## WorldForge (월드 데이터)
- 맵은 `games/<game>/world.json` 매니페스트 하나로만 정의한다. 스키마 버전 `worldforge/0.1` (출처: aldol-worldforge P4-2, `world-manifest.schema.json`).
- `src/core/worldforge.js`는 공식 검증기(`validate.ts`)의 최소 JS 미러다. 필수 키·스키마 버전·중복 ID·참조 무결성(장소→구역, 길→장소, 엔티티→에셋, NPC→엔티티/집, 의뢰 노드/간선)을 검사하고, 매니페스트를 sim용 월드 객체로 변환한다(`worldToSim`). 좌표 변환: 매니페스트 `[x, y, z]`(Y-up) → sim 2D `(x, z)`.
- 전체 WorldForge 런타임(Zod + PlayCanvas 앱)은 벤더링하지 않는다. 필요해지면 그때 결정한다.
- 매니페스트가 바뀌면 `npm run check`의 매니페스트 검증이 먼저 잡는다. 검증 실패한 월드는 게임이 시작 전에 멈춘다.

## M2 — 두 번째 게임 (재사용 증명)
- 공유 코어는 `src/core/`만이다: `rng.js` (시드 RNG), `state-hash.js` (결정성 해시), `worldforge.js` (매니페스트 검증 + sim 변환). 게임별 규칙은 각 게임 폴더의 심(`games/<game>/*.js`)에 둔다 — 수풀리 `sim.js`를 복사해서 고치지 않는다.
- 새 게임은 `games/<game>/world.json` (WorldForge 0.1 매니페스트) + 심 + `index.html` + `tools/check-<game>.mjs` + `package.json` 스크립트(`check:<game>`)로 구성한다. 저장 키는 게임마다 별도(`aldol-engine.<game>-m2.save.v1`).
- `worldforge.js`를 바꿀 때는 양쪽 게임 체크(`npm run check` + `npm run check:fishing`)를 둘 다 돌린다. 어댑터에 게임별 필드를 추가할 때는 기본값(null/빈 배열)을 두고, 기존 게임이 안 쓰는 필드는 건드리지 않는다.

## 에셋 (GLB 파이프라인)
- 매니페스트 에셋 URI는 `builtin:<이름>` 또는 `glb:<게임 폴더 안 상대 경로>.glb`만 된다. 상위 폴더(`..`)·절대 경로·외부 URL은 검증이 거부한다.
- GLB는 Blender 스크립트(`tools/blender/make-star-fishing-assets.py`, `npm run assets:fishing`)로 만들고 `games/<game>/assets/models/`에 둔다. 로더는 `src/render/asset-loader.js` (three 0.160.0 GLTFLoader 벤더링, `src/render/vendor/` — CDN 의존 없음).
- GLB 로딩은 렌더러에서만 일어난다. 심은 건드리지 않는다(결정성 유지). 로드 실패 시 원시(primitive) 폴백을 쓰고 게임은 그대로 시작한다.
- 새 게임이 GLB를 쓰면 `tools/check-<game>.mjs`에 매직바이트 검증 + 프로브 훅(`assets.loaded/failed`) 확인을 넣는다.

## AI 최소 집합 (M1)
- 길찾기는 내비메시 (`src/core/navmesh.js`): 걷는 구역을 0.5 셀 격자로 나누고 집·나무·허수아비를 원형 장애물로 막는다. NPC는 직선이 뚫리면 직진, 막히면 A* + 직선 단축(string pulling) 경로를 따라간다. 경로는 결정적이다(힙 동점 해소는 삽입 순서). 심은 `world.navmesh`만 본다.
- 소리 (`src/core/audio.js` + `src/render/audio.js`): 음성(낚시·입질·챔질·대화·의뢰·피격·회복·타격)은 오디오 파일 없이 WebAudio 오실레이터로 합성한다. 음정·길이 표는 코어에 두고(WebAudio 없이 테스트 가능), 재생은 렌더러에서만 한다. BGM은 C–Am–F–G 패드 4초 루프. 오디오는 게임 로직에 절대 영향을 주지 않으며, 로드 실패 시 소리만 안 나고 게임은 그대로 돌아간다. 음소거는 M 키 또는 🔊 버튼, `localStorage`에 저장한다.
- FSM 4상태: 순찰(patrol) · 추격(chase) · 도망(flee) · 처치됨(defeated, 10초 뒤 집에서 리스폰). 전이 조건은 `src/core/sim.js`에 표로 적는다.
- 스티어링 seek/flee/wander + arrive.
- 웨이포인트 그래프 A*는 순찰 목표 선택에만 쓴다. NPC 이동 길찾기는 내비메시(위 참조).
- 작성된 대사(bark) 풀 — LLM 없이 시드 RNG로 고른다.
- 포함하지 않는다: GOAP, LLM NPC, 브라우저 ML, 클라우드 LLM 게임 루프 연결.

## 핸드오프
- 모듈마다 `inspect()`(JSON 상태)와 `simulate()`(시드·프레임·입력 → 해시)를 제공한다.
- 작업 결과는 `docs/handoff.md` 형식의 JSON으로 남긴다. 파일·커밋 SHA·해시를 적고, "됐다"는 말만으로는 안 된다.
- 자기 작업은 스스로 PASS라고 하지 않는다. 독립 검증(다른 에이전트·실브라우저·헤드리스 재실행) 뒤에만 검증됐다고 적는다.

## 게임 코드 규칙
- 게임 코드는 `NavProvider`·`Rng` 인터페이스만 본다. 구현을 직접 import하지 않는다.
- 저장 데이터와 설정(소리·카메라)은 분리한다. 저장 키는 상태 형식이 바뀔 때만 버전을 올린다 (v1 → v2: 의뢰 배열·별조각·체력 추가).
