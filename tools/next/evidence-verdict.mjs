// ENGINE-NEXT-07: separate product, transport and observation verdicts.
// No error text alone is sufficient for a product PASS or diagnostic waiver.
const arr=x=>Array.isArray(x)?x:[];
const exactly=(rows,p)=>{const xs=arr(rows).filter(p);return xs.length===1?xs[0]:null;};
const pathOf=u=>typeof u==="string"?(u.match(/^(?:https?:\/\/[^/?#]+)?(\/[^?#]*)(?:[?#].*)?$/)?.[1]??null):null;
const sameBody=(a,e)=>!!(a&&a.bytes===e.bytes&&a.sha256===e.sha256);
export function judgeAsset({expected:e,request:r,server:s,document:d,playwright:pw}) {
  if(!e||!r||!s||!d)return {verdict:"HOLD_MISSING_EVIDENCE",reason:"missing request, server, document or expected bytes"};
  const token=r.token;
  if(!token||s.token!==token||s.path!==e.urlPath||pathOf(r.url)!==e.urlPath||r.nav!==d.nav)return {verdict:"HOLD_ATTRIBUTION",reason:"token/path/document mismatch"};
  const f=exactly(d.fetchRows,x=>x.token===token&&pathOf(x.url)===e.urlPath);
  const parsed=exactly(d.rows,x=>x.token===token&&pathOf(x.modelUrl)===e.urlPath);
  const response=exactly(pw,x=>x.event==="response"&&x.token===token&&pathOf(x.url)===e.urlPath&&x.nav===d.nav);
  if(!response)return {verdict:"HOLD_ATTRIBUTION",reason:"unique response not traced in Playwright"};
  const fallback=arr(d.assets?.failed).includes(e.name.replace(/\.glb$/,""));
  const loaded=arr(d.assets?.loaded).includes(e.name.replace(/\.glb$/,""));
  if(r.status>=400&&s.status===r.status&&f?.status===r.status&&response.status===r.status&&fallback&&!loaded)
    return {verdict:"FAIL_HTTP",reason:"HTTP error and application asset failed"};
  if(parsed&&typeof parsed.sha256==="string"&&!sameBody(parsed,e))
    return {verdict:"FAIL_INTEGRITY",reason:"actual parse input differs from original"};
  if(r.terminal==="loadingFailed"&&s.finished===false&&s.bytesRead<e.bytes&&Number.isInteger(r.dataLength)&&r.dataLength<e.bytes&&(!parsed||parsed.status!=="decoded")&&fallback&&!loaded)
    return {verdict:"FAIL_TRANSFER",reason:"partial transfer and no successful application decode"};
  if(parsed&&["decode-error","throw"].includes(parsed.status))return {verdict:"FAIL_DECODE",reason:"actual decoder rejected input"};
  if(!f)return {verdict:"HOLD_ATTRIBUTION",reason:"unique application response not traced"};
  if(!parsed||!sameBody(parsed,e)||parsed.status!=="decoded"||!(parsed.meshes>0&&parsed.vertices>0)||!loaded||fallback)
    return {verdict:"HOLD_OR_FAIL_DECODE",reason:"application decode not proven"};
  if(r.status!==200||f.status!==200||response.status!==200||s.status!==200||s.finished!==true||s.bytesRead!==e.bytes)
    return {verdict:"HOLD_TRANSFER_CONFLICT",reason:"decoded asset but transfer evidence inconsistent"};
  if(r.terminal==="loadingFinished"&&sameBody(r.body,e)&&exactly(pw,x=>x.event==="finished"&&x.token===token))
    return {verdict:"PASS",reason:"response, exact bytes and decoder all agree"};
  const abort=exactly(pw,x=>x.event==="failed"&&x.token===token&&x.errorText==="net::ERR_ABORTED");
  // Strict qualification: unique response token, full original bytes at the
  // application decoder, CDP dataReceived count and server finish agree.
  // Keep the observation verdict HOLD; do not rewrite the strict raw result.
  if(r.terminal==="loadingFailed"&&r.errorText==="net::ERR_ABORTED"&&r.canceled===true&&r.dataLength===e.bytes&&abort&&!r.body&&typeof r.bodyError==="string"&&r.bodyError.includes("No data found for resource"))
    return {verdict:"HOLD_OBSERVATION_MISMATCH",reason:"same response reached decoder intact but CDP/PW terminal reports abort"};
  return {verdict:"HOLD_NETWORK",reason:"unresolved terminal/body evidence"};
}
export function judgeGlb(run,expected) {
  const requests=arr(run.cdp?.requests),documents=arr(run.cdp?.documents),server=arr(run.serverGlbTrace);
  const records=[];
  for(const d of documents)for(const e of expected){
    const r=exactly(requests,x=>x.nav===d.nav&&pathOf(x.url)===e.urlPath);
    const s=r&&exactly(server,x=>x.token===r.token);
    records.push({nav:d.nav,asset:e.name,token:r?.token??null,...judgeAsset({expected:e,request:r,server:s,document:d,playwright:arr(run.glbTrace)})});
  }
  const tokens=requests.map(x=>x.token);
  const coverage=documents.length===3&&new Set(documents.map(x=>x.nav)).size===3&&requests.length===6&&server.length===6&&tokens.every(Boolean)&&new Set(tokens).size===6&&!run.cdp?.bodyCollectionTimedOut;
  const known=new Set(tokens);
  const unexplained=arr(run.requestFailuresDuringTest).filter(x=>!x.token||!known.has(x.token));
  const failures=records.filter(x=>x.verdict.startsWith("FAIL_"));
  const decodeProven=coverage&&records.length===6&&records.every(x=>["PASS","HOLD_OBSERVATION_MISMATCH"].includes(x.verdict));
  const issuesKnown=Array.isArray(run.functionalIssues);
  const functionalIssues=arr(run.functionalIssues);
  const product=failures.length||functionalIssues.length?"FAIL":decodeProven&&issuesKnown?"PASS":"HOLD";
  const network=coverage&&records.length===6&&records.every(x=>x.verdict==="PASS")&&!unexplained.length?"PASS":failures.length?"FAIL":"HOLD";
  const diagnostic=coverage&&decodeProven&&issuesKnown&&!unexplained.length&&!functionalIssues.length&&!arr(run.consoleErrors).filter(x=>!x.includes("favicon")).length?"PASS":"FAIL";
  return {rawVerdict:run.result,product,network,diagnostic,coverage,unexplained,records,failures,release:product==="PASS"&&network==="PASS"&&run.result==="PASS"?"PASS":"HOLD"};
}
export function judgeSave(row) {
  if(row.error||!row.before||!row.after||row.movement!==true||row.shortControl!==true||row.intervalObserved!==true)return {functional:"HOLD",console:"HOLD",release:"HOLD"};
  const functional=row.restored===true?"PASS":"FAIL";
  const errors=arr(row.consoleEvidence);
  const consoleVerdict=errors.length?"HOLD_UNATTRIBUTED":Array.isArray(row.consoleEvidence)?"PASS":"HOLD";
  return {functional,console:consoleVerdict,release:functional==="PASS"&&consoleVerdict==="PASS"?"PASS":"HOLD"};
}
export function consoleSource(error) {
  // Explicit source only. A message match during reload is not provenance.
  const url=error.location?.url||"";
  const stack=error.stack||"";
  if(error.kind==="window-error"||error.kind==="unhandledrejection"||/\/games\/supuli\/|\/src\/(?:core|render)\//.test(url+" "+stack))
    return "PAGE_OR_PRODUCT_SOURCE";
  if(/^(?:chrome|resource):\/\//.test(url)||/playwright[^\n]*\/(?:lib|server)\//i.test(stack))
    return "BROWSER_OR_HARNESS_SOURCE";
  return "UNATTRIBUTED";
}
