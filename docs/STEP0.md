# Step 0 정리 — Aldol Engine

aldol.js를 베이스로 Aldol 엔진까지 가는 첫 단계. 코드 변경이 아니라 결정 정리다.

## 결정 기록

### D1. Three.js 고정 버전 — 확정: 0.160.0 유지
- M0에서 이미 검증됨(정적 검증 22/22, Steel 스모크 콘솔 에러 0).
- 최신은 r187(0.187.0, 2026-10-30)이지만 업그레이드는 별도 태스크로 분리한다.
- 상태: 확정 (2026-11-20 알돌 승인).

### D2. 라이선스 — 확정: 비공개 유지, M3 전에 MIT
- 현재 이 저장소는 LICENSE 파일이 없고 UNLICENSED 취급이다.
- M1까지 비공개 유지하고, M3(제3자 사용) 전에 MIT로 정한다.
- 상태: 확정 (2026-11-20 알돌 승인).

### D3. WebGPU 범위 — 확정: M1은 WebGL2 기본
- M1 게임은 WebGL2로 출시한다. WebGPU는 별도 실험 갈래에서만 다룬다.
- WGSL 컴퓨트·브라우저 ML 추론도 M1 제외.
- 상태: 확정 (2026-11-20 알돌 승인).

### D4. 기준선 저장소 — 완료
- 이 저장소(`aldol2678/aldol-engine`, Private, main)가 기준선이다. 2026-11-20 생성.
- 나머지 갈래(아크 A/B, 모아 M0 스냅샷)는 참조용으로 남긴다.

## Step 0 완료 조건
- [x] D4 기준선 저장소 지정
- [x] D1 버전 고정 확정 (0.160.0, 2026-11-20)
- [x] D2 라이선스 결정 (비공개 유지, M3 전 MIT, 2026-11-20)
- [x] D3 WebGPU 범위 확정 (M1 WebGL2 기본, 2026-11-20)

**Step 0 완료 — 2026-11-20.**

## 다음 단계
M1 인프라: `AGENTS.md` + `npm run check` + 헤드리스 `simulate(seed, frames, inputs)` + 상태 해시 + 핸드오프 JSON. 게임보다 먼저다.

## 근거
- M0: `aldol-procedural-3d-m0` (Three.js 0.160.0, LICENSE-NOTE 2026-11-16)
- 난이도 보고서: `research_notes/game-engine-development-difficulty-20261115-1750/report.md`
- AI 협업 보고서 §1·§7: `research_notes/game-engine-ai-considerations-20261115-1820/report.md`
