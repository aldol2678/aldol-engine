# ENGINE-NEXT-07 | evidence-based verification candidate

Status: REVIEW / HOLD. Independent candidate based on Draft PR #11 head
`6fed1555d7ee096f79201419d3f332da91adcf17`. Do not merge, deploy, or officially adopt.
No game, engine, vendor, asset, save format, or audio product source is changed by this candidate.

## Preserved baseline
- PR #9 `66f9f58a77432ba46b4bebc1b472436e4ecb5687`, run 45568457383, artifact 15001288177, ZIP SHA-256 `4b520365a8c317db9262fd35c4aef987ae1c849f05656d13684e019b517fd57a`.
- PR #10 `e17871761194c08b0c6f9921c802741aaa9b8a90`, run 45573230097, artifact 15003367416, ZIP SHA-256 `3b9c1ca432d6be94cdd3d5eeb7eec775cb5e0a3404e8ce3ba846b134f0f1add8`.
- PR #11 `6fed1555d7ee096f79201419d3f332da91adcf17`, run 45576673846, artifact 15004098834, ZIP SHA-256 `e17fafa7ee7395b1aa9d0bf1a916de0e5b769ef8c00bdc7fd2b5b1f4bb2c54d3`.
- All three downloaded ZIPs were read and their SHA-256 values matched the registered digests. Original artifacts are still available at preflight (not permanent; keep downloaded ZIPs). Original failed verdicts must remain unchanged.
- Pages preflight: source=null, latest production deployment a7da14d8-d361-4885-8aaa-85ca982a4f92.

## Observed prior facts and limits
PR #11 restored all eight candidate save trials, but two Firefox navigation trials had `InvalidStateError: Navigated away from page`. The error appeared on original and candidate; the previous evidence lacks detailed error-source provenance. The product audio source has `void ctx.resume()` inside a synchronous try/catch, which does not catch a later rejection. It is a hypothesis, not an established cause.
PR #11 decoded both original GLBs in all 18 navigations (36 actual model decodes), while seven of 36 CDP terminal events reported ERR_ABORTED with 200 status, full dataReceived length, full server bytes, and unavailable CDP response bodies. Earlier attribution was per-document, not direct application-response identity. The issue is not resolved merely by suppressing the error. Content-Length did not eliminate it.

## F-03: lifecycle and error provenance
- Serve the exact existing product files; no product patch. Capture console message location, pageerror stack, window error/unhandledrejection evidence, transition stage, and actual save timer/event/write trace.
- Four candidate navigation/interval modes per Firefox and Chromium. Compare Firefox uninstrumented and audio-resume rejection-handling control in two navigation modes, plus blank-page controls with/without tracing. An explicit page error control checks that true JS exceptions are observed.
- Audio observation returns the original resume promise and associates unhandled rejection with that exact promise when possible. A separate test-only catch arm records the rejection and handles it. Do not infer origin merely from the error string or disappearance in one arm. Source can remain UNATTRIBUTED.
- Actual storage denial: inject QuotaExceededError only for the game v4 localStorage key in a fresh context, observe a blocked write, absent persisted save and failed position restoration. Require both browsers to detect the real failure.
- 14 actual game trials + five source controls; require eight candidate functional passes, two genuine negative save detections, completed source-control variants, and detection of explicit page error. Console provenance remains a separate gate; any unresolved error remains HOLD.

## F-02: application integrity vs native network observation
- Test-only server instrumentation associates unique response token and URL from the application's actual fetch response with the GLTFLoader parse callback and actual input digest. It does not clone or consume the fetch body. Capture native CDP, Playwright, server and application records separately. Instrumentation can affect timing, so lack of a reproduced anomaly does not retroactively prove resolution.
- Positive PASS requires unique nav/model/token attribution, expected HTTP 200, full server bytes, CDP loadingFinished and body SHA-256, Playwright completion, exact parse SHA-256/length, decoded meshes/vertices, loaded asset and no fallback.
- HOLD_OBSERVATION_MISMATCH requires unique same-response attribution, full server and CDP dataReceived bytes, intact decoded asset, native ERR_ABORTED+canceled and matching Playwright failed event, CDP body unavailability. Raw result remains FAIL; transport/release remain HOLD. Missing evidence, duplicate responses, inconsistent token or unknown errors cannot become PASS.
- Actual negative controls: truncated transfer (declared original Content-Length, partial bytes, connection destroyed), same-length corrupt GLB bytes (header altered), HTTP 404. Fault only the test server's star-fish.glb; original files untouched. Three navigations per control must detect the matching failure category and fallback, with unaffected trophy integrity proved. Generic scenario failure is not a successful negative control.
- Three nominal browser trials plus three real GLB fault trials. Preserve all raw exit codes, raw JSON, split product/network verdicts and final aggregate. Unexpected nonasset errors remain unexplained.

## Execution status
- Isolated JS body parsing performed on all six diagnostic modules; imports omitted for this parse-only check. Readback of the vendor source transform confirmed the unique load callback anchor. 22 adversarial unit assertions executed on exact candidate classifier and test bodies (assert shim in JS isolate). Native Node module checks and actual browser fault controls require CI; no local browser execution claimed.
- Single pinned Ubuntu 24.04 GitHub-hosted check job. Retain existing game/Next/RNG checks. Branch-scoped browser diagnostics only; do not repeat unrelated integration matrices. Diagnostic method can pass while the strict release gate fails. CI uploads raw evidence before release gate.
- No product patch and no classification of historical raw failures as PASS. Final source attribution, fault control results and official acceptance require exact-head CI readback and separate approval. No merge, preview/production deployment, branch deletion or paid runner.
