# AGENTS.md — Aldol Engine (M1)

이 저장소에서 일하는 에이전트(Moa·Ark·Naru 등)의 계약. 게임보다 먼저다.

## 목적
- aldol.js 기반 웹 게임 엔진. M1 첫 게임은 **수풀리** (마을 1맵 슬라이스).
- Three.js 0.160.0, WebGL2 기본. 라이선스는 UNLICENSED (M3 전 MIT).
- 배포는 Cloudflare Pages만. `latest` 태그는 쓰지 않는다.

## 디렉터리
- `src/core/` — 렌더링·벽시계와 무관한 순수 시뮬레이션 (RNG·상태 해시·고정 스텝)
- `src/simulate-cli.mjs` — 헤드리스 실행 CLI
- `tools/check.mjs` — `npm run check` 진입점
- `docs/` — 결정·핸드오프 형식
- `templates/` — 다중 에이전트 태스크 템플릿

## 명령
- `npm run check` — 구문 검사 + 결정성 테스트 + 금지 API 검사. 커밋 전 필수.
- `npm run simulate -- --seed <문자열> --frames <수> [--inputs <JSON>]` — 헤드리스 실행, 상태 해시 출력.

## 결정성 규칙 (절대)
1. 시뮬레이션 경로는 순수 함수다. 렌더링·입력 장치·벽시계를 받지 않는다.
2. 무작위성은 `src/core/rng.js`의 시드 RNG만 쓴다. `Math.random()`·`Date.now()`·`performance.now()`를 `src/core/`에서 쓰면 `npm run check`가 실패한다.
3. 고정 스텝 1/60초. AI 틱은 10~20Hz, 그 사이는 스티어링만 보간한다.
4. 같은 `(seed, frames, inputs)`는 항상 같은 상태 해시를 낸다. 다르면 버그다.

## AI 최소 집합 (M1)
- FSM 3상태: 순찰(patrol) · 추격(chase) · 도망(flee). 전이 조건은 `src/core/sim.js`에 표로 적는다.
- 스티어링 seek/flee/wander + arrive.
- 웨이포인트 그래프 A* (`NavProvider` 인터페이스만 본다. M1 구현은 웨이포인트, M2에서 내비메시로 교체).
- 작성된 대사(bark) 풀 — LLM 없이 시드 RNG로 고른다.
- 포함하지 않는다: GOAP, LLM NPC, 브라우저 ML, 클라우드 LLM 게임 루프 연결.

## 핸드오프
- 모듈마다 `inspect()`(JSON 상태)와 `simulate()`(시드·프레임·입력 → 해시)를 제공한다.
- 작업 결과는 `docs/handoff.md` 형식의 JSON으로 남긴다. 파일·커밋 SHA·해시를 적고, "됐다"는 말만으로는 안 된다.
- 자기 작업은 스스로 PASS라고 하지 않는다. 독립 검증(다른 에이전트·실브라우저·헤드리스 재실행) 뒤에만 검증됐다고 적는다.

## 게임 코드 규칙
- 게임 코드는 `NavProvider`·`Rng` 인터페이스만 본다. 구현을 직접 import하지 않는다.
- 저장 데이터와 설정(소리·카메라)은 분리한다. 저장 키 이름은 바꾸지 않는다.
