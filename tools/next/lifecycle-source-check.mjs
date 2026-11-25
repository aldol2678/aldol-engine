// ENGINE-NEXT-07: trace navigation console provenance and a real blocked-save control.
// Product HTML and modules are served byte-for-byte; optional init hooks are diagnostic only.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {createRequire} from "node:module";
import {judgeSave,consoleSource} from "./evidence-verdict.mjs";
const require=createRequire(import.meta.url);
const {chromium,firefox}=require("playwright");
const ROOT=path.resolve(new URL("../../",import.meta.url).pathname);
const OUT=process.argv[2];
if(!OUT||!process.env.THREE_BUILD_DIR)throw Error("evidence directory and THREE_BUILD_DIR required");
fs.mkdirSync(OUT,{recursive:true});
const KEY="aldol-engine.supuli-m1.save.v4";
const MIME={".html":"text/html; charset=utf-8",".js":"text/javascript",".json":"application/json",".wasm":"application/wasm",".png":"image/png",".glb":"model/gltf-binary"};
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,"http://localhost");
  let rel=decodeURIComponent(u.pathname);if(rel.endsWith("/"))rel+="index.html";
  if(rel==="/__next07_blank"||rel==="/__next07_error"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
    res.end("<!doctype html><title>Navigation control</title>"+(rel.endsWith("_error")?"<script>setTimeout(()=>{throw new Error('NEXT07_EXPLICIT_PAGE_ERROR')},50)</script>":""));
    return;
  }
  const file=path.resolve(ROOT,"."+rel);
  if(!file.startsWith(ROOT+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{"Content-Type":MIME[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"});
  fs.createReadStream(file).pipe(res);
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const base="http://127.0.0.1:"+server.address().port;
const report={results:[],controls:[],note:"No product module altered. Init scripts are instrumentation and fault injection only."};
function traceInit({key,blockWrites,audioMode}){
  const nativeSet=Storage.prototype.setItem,logKey="__next07_lifecycle_trace",docKey="__next07_doc";
  const doc=Number(sessionStorage.getItem(docKey)||"0")+1;nativeSet.call(sessionStorage,docKey,String(doc));window.__NEXT07_DOC__=doc;
  function log(kind,extra={}){
    const entry={kind,doc,at:Date.now(),visibility:document.visibilityState,url:location.pathname,...extra};
    try{const rows=JSON.parse(sessionStorage.getItem(logKey)||"[]");rows.push(entry);nativeSet.call(sessionStorage,logKey,JSON.stringify(rows.slice(-200)));}catch{}
    if(["window-error","unhandledrejection","audio-resume-rejected","save-write-blocked"].includes(kind))console.info("NEXT07_TRACE "+JSON.stringify(entry));
  }
  Storage.prototype.setItem=function(k,v){
    if(this!==localStorage||k!==key)return nativeSet.call(this,k,v);
    if(blockWrites){log("save-write-blocked",{fault:"QuotaExceededError",key:k});throw new DOMException("NEXT07 deliberate quota failure","QuotaExceededError");}
    let parsed=null;try{parsed=JSON.parse(v);}catch{}
    try{const ret=nativeSet.call(this,k,v);log("save-write",{ok:true,player:parsed?.player,tick:parsed?.tick,questCount:parsed?.quests?.length});return ret;}
    catch(e){log("save-write",{ok:false,error:String(e)});throw e;}
  };
  const nativeInterval=window.setInterval;
  window.setInterval=function(fn,delay,...args){
    if(delay!==5000||typeof fn!=="function")return nativeInterval.call(this,fn,delay,...args);
    log("interval-register",{delay});
    return nativeInterval.call(this,function(...a){log("interval-fire");return fn.apply(this,a);},delay,...args);
  };
  const resumes=new WeakMap();
  const AC=window.AudioContext||window.webkitAudioContext;
  if(AC&&audioMode!=="off"){
    const resume=AC.prototype.resume;
    if(typeof resume==="function")AC.prototype.resume=function(...args){
      const stack=new Error("AudioContext.resume call").stack||"";
      const p=resume.apply(this,args);if(p&&typeof p.then==="function"){
        resumes.set(p,stack);log("audio-resume-called",{stack,state:this.state});
        // Test-only rejection-handling control. No production patch, no
        // global suppression. The observation arm returns the original promise.
        if(audioMode==="catch")return p.catch(e=>{log("audio-resume-rejected",{name:e?.name,message:e?.message,stack:e?.stack,callStack:stack});});
      }
      return p;
    };
  }
  window.addEventListener("error",e=>log("window-error",{message:e.message,location:{url:e.filename,line:e.lineno,column:e.colno},stack:e.error?.stack||""}));
  window.addEventListener("unhandledrejection",e=>log("unhandledrejection",{name:e.reason?.name,message:e.reason?.message||String(e.reason),stack:e.reason?.stack||"",audioResumeCallStack:resumes.get(e.promise)||null}));
  for(const event of ["beforeunload","pagehide","pageshow"])addEventListener(event,e=>log(event,{persisted:e.persisted??null}),{capture:true});
  document.addEventListener("visibilitychange",()=>log("visibilitychange"),{capture:true});log("init");
}
const ready=p=>p.waitForFunction(()=>!!window.__SUPULI_M1__,null,{timeout:30000});
const snap=p=>p.evaluate(key=>{
  const s=window.__SUPULI_M1__?.state;let save=null;try{save=JSON.parse(localStorage.getItem(key)||"null");}catch{}
  return {doc:window.__NEXT07_DOC__??null,at:Date.now(),player:s?.player??null,tick:s?.tick??null,backend:window.__SUPULI_M1__?.backend,save};
},KEY);
const same=(a,b)=>!!(a&&b&&Math.abs(a.x-b.x)<0.05&&Math.abs(a.y-b.y)<0.05);
const shape=s=>!!(s&&s.player&&Number.isFinite(s.player.x)&&Number.isFinite(s.player.y)&&Array.isArray(s.quests)&&s.quests.length===9&&Array.isArray(s.shards)&&Array.isArray(s.crops)&&Array.isArray(s.herbs));
async function navigate(page,mode,url){
  if(mode==="short-location-reload")await Promise.all([page.waitForNavigation({waitUntil:"load"}),page.evaluate(()=>{setTimeout(()=>location.reload(),0);})]);
  else if(mode==="short-away-return"){await page.goto(base+"/__next07_blank");await page.goto(url);}
  else await page.reload();
}
function errorCapture(page,row,getStage){
  page.on("console",m=>{
    const message=m.text();if(message.startsWith("NEXT07_TRACE ")){
      try{row.traceConsole.push(JSON.parse(message.slice("NEXT07_TRACE ".length)));}catch{}
    }
    if(m.type()==="error"&&!message.includes("favicon"))row.consoleEvidence.push({kind:"console",message,location:m.location(),stage:getStage(),at:Date.now()});
  });
  page.on("pageerror",e=>row.consoleEvidence.push({kind:"pageerror",name:e.name,message:e.message,stack:e.stack||"",stage:getStage(),at:Date.now()}));
}
async function contextFor(browser,row,init){
  const ctx=await browser.newContext({viewport:{width:1280,height:800}});
  if(init)await ctx.addInitScript(traceInit,init);
  await ctx.route("https://unpkg.com/three@0.187.0/build/**",route=>{
    const f=path.join(process.env.THREE_BUILD_DIR,path.basename(new URL(route.request().url()).pathname));
    return fs.existsSync(f)?route.fulfill({status:200,contentType:"text/javascript",body:fs.readFileSync(f)}):route.fulfill({status:404,body:""});
  });
  return ctx;
}
function collectSources(row){
  const traces=[...(row.events||[]),...row.traceConsole];
  row.errorSources=row.consoleEvidence.map(e=>({...e,source:consoleSource(e)}));
  row.directAudioRejections=traces.filter(e=>(e.kind==="unhandledrejection"&&e.audioResumeCallStack)||e.kind==="audio-resume-rejected");
  row.pageErrors=traces.filter(e=>["window-error","unhandledrejection"].includes(e.kind));
  // Do not clear console errors or infer provenance from disappearance alone.
}
async function gameTrial(browser,engine,mode,variant,trace,blockWrites,audioMode){
  const row={engine,version:browser.version(),mode,variant,trace,blockWrites,audioMode,result:"FAIL",consoleEvidence:[],traceConsole:[],events:[]};
  let ctx,page,stage="setup";
  try{
    ctx=await contextFor(browser,row,trace?{key:KEY,blockWrites,audioMode}:null);page=await ctx.newPage();errorCapture(page,row,()=>stage);
    const url=base+"/games/supuli/index.html";
    stage="initial";await page.goto(url);await ready(page);row.start=await snap(page);
    stage="play";await page.keyboard.down("d");await page.waitForTimeout(650);await page.keyboard.up("d");
    await page.keyboard.down("s");await page.waitForTimeout(450);await page.keyboard.up("s");await page.waitForTimeout(100);row.moved=await snap(page);
    row.movement=!!(row.moved.player.x>row.start.player.x+0.5&&row.moved.player.y>row.start.player.y+0.3);
    if(mode==="interval")await page.waitForFunction(key=>{const s=JSON.parse(localStorage.getItem(key)||"null"),p=window.__SUPULI_M1__.state.player;return !!(s?.player&&Math.abs(s.player.x-p.x)<0.05&&Math.abs(s.player.y-p.y)<0.05);},KEY,{timeout:9000});
    row.before=await snap(page);row.shortControl=mode==="interval"||(!row.before.save&&row.before.at-row.start.at<4500);
    stage="navigation";row.triggerAt=Date.now();await navigate(page,mode,url);await ready(page);
    stage="restored";row.after=await snap(page);await page.waitForTimeout(100);
    if(trace)row.events=await page.evaluate(()=>JSON.parse(sessionStorage.getItem("__next07_lifecycle_trace")||"[]"));
    row.oldEvents=row.events.filter(e=>e.doc===row.start.doc);
    row.intervalObserved=mode!=="interval"||row.oldEvents.some(e=>e.kind==="interval-fire"&&e.at<=row.before.at);
    row.restored=same(row.before.player,row.after.player)&&same(row.before.player,row.after.save?.player)&&shape(row.after.save);
    row.blockedWriteObserved=row.oldEvents.some(e=>e.kind==="save-write-blocked");
    row.separatedVerdicts=judgeSave(row);
    row.result=row.separatedVerdicts.release==="PASS"?"PASS":"FAIL";
  }catch(e){row.error=String(e);row.separatedVerdicts=judgeSave(row);}
  finally{if(ctx)await ctx.close();collectSources(row);report.results.push(row);console.log("NEXT07_SAVE",JSON.stringify({engine,mode,variant,trace,blockWrites,audioMode,result:row.result,verdicts:row.separatedVerdicts,restored:row.restored,blockedWriteObserved:row.blockedWriteObserved,console:row.errorSources,audio:row.directAudioRejections,error:row.error}));}
}
async function blankTrial(browser,mode,trace,explicitError=false){
  const row={engine:"firefox",mode,trace,explicitError,consoleEvidence:[],traceConsole:[],events:[]};
  let ctx,page,stage="setup";
  try{
    ctx=await contextFor(browser,row,trace?{key:KEY,blockWrites:false,audioMode:"observe"}:null);
    page=await ctx.newPage();errorCapture(page,row,()=>stage);
    const url=base+(explicitError?"/__next07_error":"/__next07_blank");
    stage="initial";await page.goto(url);await page.waitForTimeout(200);
    if(!explicitError){stage="navigation";await navigate(page,mode,url);stage="restored";await page.waitForTimeout(100);}
    if(trace)row.events=await page.evaluate(()=>JSON.parse(sessionStorage.getItem("__next07_lifecycle_trace")||"[]"));
    row.completed=true;
  }catch(e){row.error=String(e);}
  finally{if(ctx)await ctx.close();collectSources(row);report.controls.push(row);console.log("NEXT07_SOURCE_CONTROL",JSON.stringify(row));}
}
try{
  for(const [engine,type,options] of [["firefox",firefox,{headless:false,env:{...process.env,LIBGL_ALWAYS_SOFTWARE:"1"}}],["chromium",chromium,{}]]){
    let browser;
    try{
      browser=await type.launch(options);
      for(const mode of ["short-automation-reload","short-location-reload","short-away-return","interval"])
        await gameTrial(browser,engine,mode,"candidate",true,false,"observe");
      // Genuine save failure: deny only the actual v4 game key, all other storage remains available.
      await gameTrial(browser,engine,"short-automation-reload","storage-denied",true,true,"observe");
      if(engine==="firefox"){
        for(const mode of ["short-location-reload","short-away-return"]){
          await gameTrial(browser,engine,mode,"uninstrumented",false,false,"off");
          await gameTrial(browser,engine,mode,"resume-catch-control",true,false,"catch");
          for(const trace of [false,true])await blankTrial(browser,mode,trace);
        }
        await blankTrial(browser,"explicit-error",true,true);
      }
    }finally{if(browser)await browser.close();}
  }
}finally{
  const candidates=report.results.filter(r=>r.variant==="candidate");
  const blocked=report.results.filter(r=>r.variant==="storage-denied");
  report.summary={candidateFunctionalPass:candidates.filter(r=>r.separatedVerdicts?.functional==="PASS").length,candidateCount:candidates.length,blockedDetected:blocked.filter(r=>r.blockedWriteObserved&&r.separatedVerdicts?.functional==="FAIL"&&!r.after?.save).length,blockedCount:blocked.length,unattributed:report.results.flatMap(r=>r.errorSources||[]).filter(e=>e.source==="UNATTRIBUTED").length,explicitErrorDetected:report.controls.some(r=>r.explicitError&&r.consoleEvidence.some(e=>e.message.includes("NEXT07_EXPLICIT_PAGE_ERROR"))),sourceControlsComplete:report.controls.length===5&&report.controls.every(r=>r.completed),sourceVariantsComplete:report.results.length===14&&report.results.filter(r=>["uninstrumented","resume-catch-control"].includes(r.variant)).every(r=>r.separatedVerdicts?.functional==="PASS")};
  report.diagnosticPass=report.summary.candidateFunctionalPass===8&&report.summary.candidateCount===8&&report.summary.blockedDetected===2&&report.summary.blockedCount===2&&report.summary.explicitErrorDetected&&report.summary.sourceControlsComplete&&report.summary.sourceVariantsComplete;
  report.release=report.diagnosticPass&&report.results.filter(r=>r.variant==="candidate").every(r=>r.result==="PASS")?"PASS":"HOLD";
  fs.writeFileSync(path.join(OUT,"source-lifecycle.json"),JSON.stringify(report,null,2)+"\n");console.log("NEXT07_LIFECYCLE_SUMMARY",JSON.stringify({summary:report.summary,diagnosticPass:report.diagnosticPass,release:report.release}));
  server.closeAllConnections();server.close();
}
if(!report.diagnosticPass)process.exitCode=1;
