# ENGINE-NEXT-05 | focused browser defect verification

Status: REVIEW/HOLD. Do not merge or deploy. This candidate changes verification tooling only; do not infer product compatibility from a CI environment workaround.

## Preserved source and evidence
- PR #9 head `66f9f58a77432ba46b4bebc1b472436e4ecb5687`; its branch, commit, failed CI run `45568457383`, job `139048953473` and artifact `15001288177` remain unchanged.
- Original artifact ZIP SHA-256: `4b520365a8c317db9262fd35c4aef987ae1c849f05656d13684e019b517fd57a` (8 files, 13,781 bytes; verified downloaded bytes). Original matrix: 17/27 PASS, 10/27 FAIL; original MarginLife combined checks PASS. No prior failures are reclassified or overwritten.
- PR #1–#4 and #6–#9 remain open/draft/unmerged; preflight Cloudflare Pages source=null, production deployment `a7da14d8-d361-4885-8aaa-85ca982a4f92`.

## F-01: Firefox WebGL2
- Observed: all 9 Firefox runs failed waiting for the ready probe. Original console messages specifically reported AllowWebgl2:false and failure to create a THREE.WebGLRenderer context. No game-specific root cause has been established.
- Test on the same Ubuntu 24.04 and Playwright 1.56.1: (A) normal headless without DISPLAY, (B) headless with LIBGL_ALWAYS_SOFTWARE=1, (C) headed Xvfb with LIBGL_ALWAYS_SOFTWARE=1. No security or browser WebGL blocklist override. Test bare WebGL2 context, clear/read red pixel, and separately Three.js r187 rendering/readback. Preserve errors, versions and renderer information.
- If a control profile passes both tests, repeat exactly the six desktop and three portrait-touch Firefox scenarios under the selected profile. If all profiles fail, leave gameplay NOT RUN for this candidate and keep HOLD. A passing headed software profile is evidence of CI environment support, not default-headless or real-device certification.

## F-02: Chromium fishing GLB
- Observed: two failures of star-fish.glb without failure reason in PR #9. Both GLB assets, movement, catch, score and save restoration passed; no console errors. A cancellation race is a hypothesis, not an established cause.
- Validate the existing binary magic and length, and distinguish controlled delayed GLB cancellation during reload, deliberate 404, and successful complete download with event evidence.
- Original-timing and bounded GLB-settlement-timing variants: three independent runs each, same game and desktop config. Record request IDs, HTTP status, failure errorText, navigation timestamps and server finish/close/bytes-read. Require both assets to load after reload, retain original gameplay gates, and do not waive any request error before intentional test teardown. Record all six outcomes and preserve failed attempts.
- If the historical failure does not recur, classify it UNREPRODUCED / root cause unconfirmed. Controlled cancellation alone is not proof that historical requests were cancelled. A genuine HTTP/asset-load failure requires a targeted repair; no speculative product patch.

## Execution and remaining gate
- New branch `feat/ark-engine-next-05`, separate Draft PR to main, existing single GitHub-hosted check job only. Existing legacy, Next and RNG checks stay enabled. The #9 full combined test and successful unrelated browser cases are preserved, not repeated in this focused branch.
- Local GitHub checkout was blocked by DNS and local browser navigation by ERR_BLOCKED_BY_ADMINISTRATOR. No bypass attempted. Module bodies parsed in a JS isolate for syntax only; full native diagnostics run in CI.
- CI captures environment.json, focused browser logs/JSON, six Chromium traces and old-head provenance. Artifact retention 7 days; the original #9 ZIP is preserved separately. Do not confuse a newly uploaded artifact with the old original.
- Final acceptance remains HOLD until actual CI results are read back and remaining failures/NOT RUN are distinguished. No merge, preview/production deploy, canonical adoption, product/runtime change, or new paid service.
