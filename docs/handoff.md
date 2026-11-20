# 핸드오프 JSON 형식

작업 결과를 남길 때 이 형식을 쓴다. 말로 "됐다"는 안 된다.

```json
{
  "task": "태스크 제목",
  "agent": "moa",
  "date": "2026-11-20",
  "repo": "aldol2678/aldol-engine",
  "commit": "<전체 커밋 SHA>",
  "files": ["경로/파일"],
  "checks": [
    { "name": "npm run check", "result": "PASS", "detail": "ALL CHECKS PASSED" },
    { "name": "simulate seed=supuli-m1 frames=600", "result": "PASS", "detail": "hash=........" }
  ],
  "notes": ["미확인 항목", "다음 할 일"],
  "verified_by": "독립 검증자(없으면 '미검증')"
}
```

규칙:
- `commit`은 확인된 전체 SHA. 머릿글만 적지 않는다.
- `checks`는 실제로 실행한 것만 적는다. 실행 안 한 검사는 적지 않는다.
- `verified_by`가 '미검증'이면 그 결과는 제안일 뿐 확정 사실이 아니다.
