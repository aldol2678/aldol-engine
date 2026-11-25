# 별빛 전술 (M5 후보) — 턴제 분대 전술

ENGINE-NEXT-01 공통 코어(`src/core/next/`) 위에 만든 턴제 전술 게임. 수호병·궁수·치유사 3명으로 그림자 무리를 물리친다. 임무 2개(임무 1을 깨면 임무 2로 이어지고, 임무 2를 깨면 승리).

## 규칙
- **내 턴**: 유닛마다 AP 4. 이동은 칸당 1 AP(BFS 경로, 벽·다른 유닛은 못 지나감), 공격은 2 AP, 스킬은 2~3 AP + 재사용 대기(턴 단위).
  - 수호병: 근접 공격, 스킬 `방패 강타`(강한 일격). 방어 1.
  - 궁수: 사거리 4 사격(벽이 시야를 막음), 스킬 `조준 사격`(사거리 5).
  - 치유사: 스킬 `별빛 치유`(사거리 3, 다친 아군 회복. 최대 HP를 넘지 않음).
- **적 턴**: 입력 없이 고정 틱 위에서 적이 한 행동씩(6틱 간격) 움직인다. 적 AI는 FSM 4상태 — 대기(hold) → 접근(advance) → 공격(attack) → 후퇴(retreat, 저주술사만 HP 절반 이하에서). 3턴째부터는 모든 적이 다가온다.
- **승리**: 임무 2개의 적을 모두 처치. **패배**: 아군 전멸. 턴만 넘기면 진다.
- 피해는 시드 RNG 굴림(기본 ± 편차, 치명타)이라 같은 (seed, 입력)이면 항상 같은 결과.
- 수치·맵·유닛 배치·의뢰는 전부 `world.json`(규칙 `game.tactics`)에 있다. `tactics.js`에는 맵/밸런스 데이터가 없다.

## 조작
- PC: 클릭으로 아군 선택 → 파란 칸 클릭 이동 / 붉은 칸의 적 클릭 공격. `Tab` 다음 아군, 방향키+`Enter`(또는 스페이스) 커서 조작, `F` 스킬 대상 선택, `E` 턴 종료, `N` 새 게임, `M` 음소거.
- 모바일: 탭으로 선택·이동·공격, 오른쪽 아래 버튼 `스킬` / `턴 종료` / `새 게임` / 🔊.

## 저장
- 키: `aldol-engine.star-tactics-m5.save.v1` (버전형 봉투 `aldol-next-save/1`, 체크섬 검증).
- 행동·턴 시작·임무 완료 때 자동 저장, 새로고침하면 이어서 한다. 손상됐거나 버전이 다른 저장은 거부하고 새 게임으로 시작한다(화면에 사유 코드 표시).

## 재사용한 공통 모듈
`ecs.js`(유닛 엔티티·이벤트) · `spatial.js`(격자, floodFill/findPath/lineOfSight/manhattan) · `fsm.js`(적 AI) · `combat.js`(피해·방어·치유·쿨다운) · `quest.js`(의뢰·1회 보상) · `runtime.js`(고정 스텝·리플레이) · `save.js` · `manifest.js`. 화면은 `src/render/hud.js`(night 테마) + `src/render/next/board.js` + `src/render/next/shell.js`.

## 검사
```sh
node --experimental-vm-modules tools/check-star-tactics.mjs        # 헤드리스 규칙·결정성·저장 검사
node tools/next/browser-check.mjs --games star-tactics             # 실브라우저 플레이 (Playwright 필요)
```
기준 해시: seed `star-tactics-m5` + 봇 입력 스크립트(476프레임) → `7cc35f94`.

## 에셋
모두 Three.js 기본 도형(상자·원뿔·구·팔면체)으로 그린다. 외부 모델·이미지·오디오 파일 없음(소리는 기존 WebAudio 합성 음성). 코드 라이선스는 저장소와 같은 MIT.
