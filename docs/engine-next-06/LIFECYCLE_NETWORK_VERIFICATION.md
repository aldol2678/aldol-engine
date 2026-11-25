# ENGINE-NEXT-06 — 저장 생명주기 및 네트워크 관측 검증

Status: REVIEW / HOLD. Do not merge, deploy, or officially adopt. This is an independent candidate based on Draft PR #10 head `e17871761194c08b0c6f9921c802741aaa9b8a90`.

## Preserved evidence
- PR #9 head `66f9f58a77432ba46b4bebc1b472436e4ecb5687`, CI run `45568457383`, artifact `15001288177`, SHA-256 `4b520365a8c317db9262fd35c4aef987ae1c849f05656d13684e019b517fd57a`.
- PR #10 head `e17871761194c08b0c6f9921c802741aaa9b8a90`, CI run `45573230097`, artifact `15003367416`, SHA-256 `3b9c1ca432d6be94cdd3d5eeb7eec775cb5e0a3404e8ce3ba846b134f0f1add8`.
- Both ZIPs were read locally and their byte hashes matched the registered artifact digests. The original artifacts, branches, and failed verdicts must not be overwritten. Actions artifact retention is limited; keep downloaded originals.
- Pages preflight: Git source null, production deployment `a7da14d8-d361-4885-8aaa-85ca982a4f92`. No deployment requested.

## F-03: Supuli save lifecycle
PR #10 Firefox Xvfb software profile resolved WebGL2 initialization but failed Supuli position restoration and v4 storage shape. Original raw chronology: play-start to before-reload 1,861 ms, less than the 5,000-ms autosave interval. Original source saves at interval, beforeunload and quest completion. This suggests the short reload depends on lifecycle events; old evidence does not prove whether beforeunload was dispatched or a write succeeded.
- Minimal candidate: retain original autosave and beforeunload, add pagehide and visibilitychange(hidden) save calls. Same v4 key, payload, state, and simulation. No changes to other games or save migration.
- `tools/next/save-lifecycle-check.mjs` serves the exact PR #10 Supuli HTML (verified blob) and candidate HTML; isolated fresh browser contexts. Observe actual timer registration/firing, beforeunload/pagehide/visibilitychange and localStorage writes using a separate sessionStorage trace. Compare actual position, persisted shape, and restored position.
- 2 browsers × 2 variants × 4 modes = 16 trials: short automation reload, location.reload, away-and-return navigation, interval autosave. Record original short failures rather than treating them as candidate failures; require both original interval controls and all eight candidate trials to pass. Extra uninstrumented Supuli gameplay regression in Chromium and Firefox. Firefox uses the prior proven headed Xvfb software profile; not a real-device certification.

## F-02: Chromium fishing GLB
PR #10: 3/6 raw network verdicts passed; five HTTP 200 + net::ERR_ABORTED reports occurred although the game loaded both assets and all server writes finished. Some reports occurred before the first reload. Waiting for requests to settle did not solve the problem. Neither server finish nor Playwright's failure event alone establishes what bytes the application actually decoded.
- Observe native CDP Network.requestWillBeSent/responseReceived/dataReceived/loadingFinished/loadingFailed and request cache events. Preserve raw parameters, request IDs, loader IDs, header/status/terminal state, response-body SHA-256 or explicit getResponseBody error.
- Test-only server response token correlates CDP, Playwright and server events; test-only GLTFLoader.parse wrapper records real ArrayBuffer SHA-256, byte count, decode callback, mesh/vertex counts. Compare against original GLBs and both loaded asset IDs/counts on each of three navigations. No product GLTFLoader/asset changes.
- Compare original chunked HTTP response vs explicit Content-Length in the test server, three attempts each. Both variants retain the strict original request failure gate. Require exact decoded bytes for all documents and complete correlated CDP evidence. Any missing CDP body, non-success terminal event, incorrect digest or decode failure remains a failure; no blanket abort exception. Correlation is per-document and digest, not proof of causal attribution to a particular request if duplicates occur.
- Content-Length is an experimental test-server control, not a proposed production patch. If all instrumented trials pass, prior intermittent failure remains UNREPRODUCED. If only length passes, framing is a candidate factor needing confirmation; do not claim a production fix without evidence.

## Execution gate
- Single existing Ubuntu 24.04 CI job; preserve legacy and Next and RNG checks. No repeat of unrelated successful browser/combined checks. Scope is focused lifecycle and network evidence.
- Local clone failed DNS; direct local Chromium navigation blocked by ERR_BLOCKED_BY_ADMINISTRATOR. No bypass attempted. JS module bodies parsed in isolated JS for syntax only. Native CI must be read back on exact candidate head.
- No product patch for GLB before evidence. No change to RNG, simulation, assets, production/preview configuration, or official status.
- Retain original artifacts and newly generated raw evidence. Final disposition HOLD pending actual CI results and source-of-failure analysis.
