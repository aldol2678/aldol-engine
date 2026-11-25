// ENGINE-NEXT-07 aggregate gate. Raw individual verdicts remain untouched.
import fs from "node:fs";
import path from "node:path";
import {judgeGlb} from "./evidence-verdict.mjs";
const dir=process.argv[2];
if(!dir)throw Error("evidence directory required");
const trials=[];
const names=["nominal-1","nominal-2","nominal-3","fault-truncate","fault-corrupt","fault-404"];
const wanted={"fault-truncate":"FAIL_TRANSFER","fault-corrupt":"FAIL_INTEGRITY","fault-404":"FAIL_HTTP"};
for(const name of names){
  const row={name,kind:name.startsWith("fault-")?"negative":"nominal",controlPass:false};
  try{
    const runDir=path.join(dir,"glb-"+name);
    const d=JSON.parse(fs.readFileSync(path.join(runDir,"logs/browser-check.json"),"utf8"));
    row.exitCode=Number(fs.readFileSync(path.join(runDir,"raw-exit-code.txt"),"utf8").trim());
    if(d.results.length!==1||d.results[0].engine!=="chromium"||d.results[0].game!=="star-fishing"||d.results[0].config!=="desktop")throw Error("unexpected or missing trial");
    const r=d.results[0];row.raw=r.result;
    if(!Array.isArray(d.expectedGlb)||d.expectedGlb.length!==2)throw Error("missing expected asset list");
    row.verdicts=judgeGlb(r,d.expectedGlb);
    if(row.kind==="nominal"){
      row.controlPass=row.verdicts.diagnostic==="PASS"&&row.verdicts.product==="PASS"&&
        (r.result==="PASS"?row.exitCode===0:row.exitCode!==0&&row.verdicts.network==="HOLD");
    }else{
      const fish=row.verdicts.records.filter(x=>x.asset==="star-fish.glb");
      const trophy=row.verdicts.records.filter(x=>x.asset==="star-trophy.glb");
      // Demand actual observed fault, not the label or a generic test failure.
      // The untouched comparison asset must still be decoded with full bytes.
      row.controlPass=row.exitCode!==0&&r.result==="FAIL"&&row.verdicts.product==="FAIL"&&row.verdicts.coverage&&
        fish.length===3&&fish.every(x=>x.verdict===wanted[name])&&
        trophy.length===3&&trophy.every(x=>["PASS","HOLD_OBSERVATION_MISMATCH"].includes(x.verdict))&&
        r.cdp.documents.every(d=>d.assets?.failed?.includes("star-fish")&&d.assets?.loaded?.includes("star-trophy"));
    }
  }catch(e){row.error=String(e);}
  trials.push(row);
  console.log("NEXT07_GLB_TRIAL",JSON.stringify(row));
}
let life=null;try{life=JSON.parse(fs.readFileSync(path.join(dir,"lifecycle/source-lifecycle.json"),"utf8"));}catch{}
const diagnosticPass=trials.length===6&&trials.every(r=>r.controlPass)&&life?.diagnosticPass===true;
const release=diagnosticPass&&life.release==="PASS"&&trials.filter(t=>t.kind==="nominal").every(t=>t.verdicts.release==="PASS")?"PASS":"HOLD";
const summary={diagnosticPass,release,nominalPass:trials.filter(t=>t.kind==="nominal"&&t.controlPass).length,negativeDetected:trials.filter(t=>t.kind==="negative"&&t.controlPass).length,lifecycleDiagnostic:life?.diagnosticPass??false,lifecycleRelease:life?.release??"HOLD",trials};
fs.writeFileSync(path.join(dir,"verdict-summary.json"),JSON.stringify(summary,null,2)+"\n");
console.log("NEXT07_FINAL",JSON.stringify({diagnosticPass,release,nominalPass:summary.nominalPass,negativeDetected:summary.negativeDetected,lifecycleDiagnostic:summary.lifecycleDiagnostic,lifecycleRelease:summary.lifecycleRelease}));
if(!diagnosticPass)process.exitCode=1;
