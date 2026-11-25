# ENGINE-NEXT-01 — 결정적 공통 엔진 확장 + 신규 장르 3종 (개발 후보)

- 작업 지시: Issue #5 (`aldol2678/aldol-engine`). 이 폴더는 그 납품 증거다.
- 상태: **개발 후보**. 공식 채택·main 병합·운영/Preview 배포는 하지 않았다. 독립 검증 전이므로 전체 결과는 REVIEW/HOLD다.
- 기준(baseline): `origin/main` = `df9a494647db3261658a5108a098e82cff927208` (착수 직전 fetch로 재확인, Issue 기재값과 동일).
- 후보(head): 이 브랜치의 커밋. 전체 SHA는 `handoff.json`과 PR 본문에 적는다.

## 문서
| 파일 | 내용 |
| --- | --- |
| [AUDIT.md](AUDIT.md) | Phase A — 착수 게이트(브랜치·PR·배포 유발 확인), 기존 3게임 구조 감사, 공통화 대상 표 |
| [API.md](API.md) | Phase B — `src/core/next/`·`src/render/next/` 모듈 API, 예시, 불변식 |
| [GUIDE.md](GUIDE.md) | 신규 게임 제작 가이드 (공통 코어 위에 게임 하나 얹는 순서) |
| [VERIFICATION.md](VERIFICATION.md) | Phase C·D — 게이트 G1~G7 결과(PASS/FAIL/HOLD/NOT RUN), 재사용 매트릭스, 성능 원자료 요약, 남은 HOLD, 롤백 |
| [handoff.json](handoff.json) | `docs/handoff.md` 형식 핸드오프 |
| `logs/` | 실제 실행 로그 원문 (기준선·후보 check:all, 신규 검사, 브라우저 검증 JSON) |
| `perf/` | 성능 원자료 JSON (헤드리스 틱 비용, 브라우저 프레임 시간) |
| `captures/` | 브라우저 캡처 (Chromium, PC·휴대폰 세로) |

## 한눈에
- 기존 파일 변경 **0개**. 추가만 했다 (`git diff --stat origin/main` 참고). `package.json`·`src/core/rng.js`·`src/render/sim-loader.js`·`games/marginlife/**` 등 보호 경로는 건드리지 않았다.
- 공통 코어 `src/core/next/` 9개 모듈 + 렌더 어댑터 `src/render/next/` 2개.
- 신규 게임 3종: 룬 금고(M4 후보, 퍼즐 탐험) · 별빛 전술(M5 후보, 턴제 전술) · 별 공방(M6 후보, 물류·생산 자동화).
- 실행:
  ```sh
  npm run check:all                  # 기존 3게임 (변경 없음)
  node tools/check-next-all.mjs      # 공통 코어 + 신규 3게임 (독립 실행 게이트)
  node tools/next/browser-check.mjs  # 6게임 실브라우저 플레이 (Playwright 필요, 게이트 아님)
  python3 -m http.server 8092        # 후 http://127.0.0.1:8092/games/rune-vault/ 등
  ```
