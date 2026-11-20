# DEPENDENCIES — Aldol Engine (Step 0)

Step 0에서 고정한 의존성. 버전은 이 파일 한 곳에만 적는다.

## 런타임
- Three.js **0.160.0** (권고안, 알돌 확정 대기) — CDN importmap
  `https://unpkg.com/three@0.160.0/build/three.module.js`
- 렌더러: **WebGL2 기본**. WebGPU는 M1에 포함하지 않는다 (실험 갈래로만 다룬다).
- `latest` 태그 사용 금지. 버전 올릴 때는 이 파일 + importmap을 같이 바꾼다.

## M0 기준선과의 관계
- M0(Moa 독립 트랙·아크 G2 후보)도 Three.js 0.160.0, 같은 CDN importmap, npm 의존성 없음으로 검증됐다.
- 최신 Three.js는 r187(0.187.0, 2026-10-30)이지만, M1은 0.160.0으로 간다. r187 업그레이드는 별도 태스크다.

## 개발 도구
- Node.js: 정적 검증용(`node --check` 등). 런타임 의존성은 아니다.
- npm 의존성: 아직 없음.

## 라이선스 상태
- 이 저장소에는 아직 LICENSE 파일이 없다. **UNLICENSED(무단 재배포·재라이선스 금지) 취급**이다.
- 라이선스 결정은 Step 0 미결정 항목이다. M3(제3자 사용) 전에 MIT/Apache-2.0 중 하나로 정한다.
