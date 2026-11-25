// ENGINE-NEXT-06: compare exact original Supuli and lifecycle-only candidate.
// Trace uses separate sessionStorage keys; game save format/key unchanged.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {chromium,firefox}=require("playwright");
const ROOT=path.resolve(new URL("../../",import.meta.url).pathname);
const OUT=process.argv[2];
if(!OUT||!process.env.THREE_BUILD_DIR)throw Error("evidence directory and THREE_BUILD_DIR required");
fs.mkdirSync(OUT,{recursive:true});
const REF="e17871761194c08b0c6f9921c802741aaa9b8a90";
const SAVE_KEY="aldol-engine.supuli-m1.save.v4";
const original=execFileSync("git",["show",REF+":games/supuli/index.html"],{cwd:ROOT});
const originalBlob=execFileSync("git",["hash-object","--stdin"],{input:original,encoding:"utf8"}).trim();
if(originalBlob!=="93357bd8f6cabdf8e1926c1538531359cc105dc0")throw Error("baseline blob mismatch");
const candidate=fs.readFileSync(path.join(ROOT,"games/supuli/index.html"));
const MIME={".html":"text/html; charset=utf-8",".js":"text/javascript",".json":"application/json",".wasm":"application/wasm",".png":"image/png",".glb":"model/gltf-binary"};
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,"http://localhost");
  let rel=decodeURIComponent(u.pathname);if(rel.endsWith("/"))rel+="index.html";
  if(rel==="/__next06_blank"){res.writeHead(200,{"Content-Type":"text/html"});res.end("<!doctype html><title>Lifecycle navigation control</title>");return;}
  if(rel==="/games/supuli/index.html"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
    res.end(u.searchParams.get("variant")==="original"?original:candidate);return;
  }
  const file=path.resolve(ROOT,"."+rel);
  if(!file.startsWith(ROOT+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{"Content-Type":MIME[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"});fs.createReadStream(file).pipe(res);
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const base="http://127.0.0.1:"+server.address().port;
const report={baselineRef:REF,originalBlob,candidateBlob:execFileSync("git",["hash-object","--stdin"],{input:candidate,encoding:"utf8"}).trim(),results:[]};
function traceInit(key){
  const nativeSet=Storage.prototype.setItem, logKey="__next06_lifecycle_trace", idKey="__next06_document_id";
  const id=Number(sessionStorage.getItem(idKey)||"0")+1;nativeSet.call(sessionStorage,idKey,String(id));
  window.__NEXT06_DOC__=id;
  function log(kind,extra={}){
    try{
      const rows=JSON.parse(sessionStorage.getItem(logKey)||"[]");
      rows.push({kind,doc:id,at:Date.now(),visibility:document.visibilityState,url:location.pathname,...extra});
      nativeSet.call(sessionStorage,logKey,JSON.stringify(rows.slice(-100)));
    }catch{}
  }
  Storage.prototype.setItem=function(k,v){
    if(this!==localStorage||k!==key)return nativeSet.call(this,k,v);
    let parsed=null;try{parsed=JSON.parse(v);}catch{}
    try{
      const result=nativeSet.call(this,k,v);
      log("save-write",{ok:true,player:parsed?.player??null,tick:parsed?.tick??null,savedAt:parsed?.savedAt??null,questCount:parsed?.quests?.length??null});
      return result;
    }catch(e){log("save-write",{ok:false,error:String(e)});throw e;}
  };
  for(const kind of ["beforeunload","pagehide","pageshow"]){
    addEventListener(kind,e=>log(kind,{persisted:e.persisted??null}),{capture:true});
  }
  document.addEventListener("visibilitychange",()=>log("visibilitychange"),{capture:true});
  log("init");
}
const snap=page=>page.evaluate(key=>{
  const s=window.__SUPULI_M1__?.state;let save=null;
  try{save=JSON.parse(localStorage.getItem(key)||"null");}catch{}
  return {doc:window.__NEXT06_DOC__,at:Date.now(),backend:window.__SUPULI_M1__?.backend,player:s?.player??null,tick:s?.tick??null,save};
},SAVE_KEY);
function shape(save){return !!(save&&save.player&&Number.isFinite(save.player.x)&&Number.isFinite(save.player.y)&&Array.isArray(save.quests)&&save.quests.length===9&&Array.isArray(save.shards)&&Array.isArray(save.crops)&&Array.isArray(save.herbs));}
function samePosition(a,b){return !!(a&&b&&Math.abs(a.x-b.x)<0.05&&Math.abs(a.y-b.y)<0.05);}
async function ready(page){await page.waitForFunction(()=>!!window.__SUPULI_M1__,null,{timeout:30000});}
try{
  for(const [engine,type,options] of [["firefox",firefox,{headless:false,env:{...process.env,LIBGL_ALWAYS_SOFTWARE:"1"}}],["chromium",chromium,{}]]){
    let browser;
    try{
      browser=await type.launch(options);
      for(const variant of ["original","candidate"])for(const mode of ["short-automation-reload","short-location-reload","short-away-return","interval"]){
        const context=await browser.newContext({viewport:{width:1280,height:800}});
        const row={engine,version:browser.version(),variant,mode,result:"FAIL",consoleErrors:[],events:[]};
        let page;
        try{
          await context.addInitScript(traceInit,SAVE_KEY);
          await context.route("https://unpkg.com/three@0.187.0/build/**",route=>{
            const f=path.join(process.env.THREE_BUILD_DIR,path.basename(new URL(route.request().url()).pathname));
            return fs.existsSync(f)?route.fulfill({status:200,contentType:"text/javascript",body:fs.readFileSync(f)}):route.fulfill({status:404,body:""});
          });
          page=await context.newPage();
          page.on("pageerror",e=>row.consoleErrors.push(String(e)));
          page.on("console",m=>{if(m.type()==="error"&&!m.text().includes("favicon"))row.consoleErrors.push(m.text());});
          const url=base+"/games/supuli/index.html?variant="+variant;
          await page.goto(url);await ready(page);row.start=await snap(page);
          await page.keyboard.down("d");await page.waitForTimeout(650);await page.keyboard.up("d");
          await page.keyboard.down("s");await page.waitForTimeout(450);await page.keyboard.up("s");
          await page.waitForTimeout(100);
          row.moved=await snap(page);
          row.movement=!!(row.moved.player.x>row.start.player.x+0.5&&row.moved.player.y>row.start.player.y+0.3);
          if(mode==="interval"){
            await page.waitForFunction(key=>{const s=JSON.parse(localStorage.getItem(key)||"null"),p=window.__SUPULI_M1__.state.player;return !!(s?.player&&Math.abs(s.player.x-p.x)<0.05&&Math.abs(s.player.y-p.y)<0.05);},SAVE_KEY,{timeout:9000});
          }
          row.before=await snap(page);
          row.shortControl=mode==="interval"||(!row.before.save&&row.before.at-row.start.at<4500);
          row.triggerAt=Date.now();
          if(mode==="short-location-reload"){
            await Promise.all([page.waitForNavigation({waitUntil:"load"}),page.evaluate(()=>{setTimeout(()=>location.reload(),0);})]);
          }else if(mode==="short-away-return"){
            await page.goto(base+"/__next06_blank");await page.goto(url);
          }else await page.reload();
          await ready(page);row.after=await snap(page);
          row.events=await page.evaluate(()=>JSON.parse(sessionStorage.getItem("__next06_lifecycle_trace")||"[]"));
          row.oldEvents=row.events.filter(e=>e.doc===row.start.doc);
          row.restored=samePosition(row.before.player,row.after.player)&&samePosition(row.before.player,row.after.save?.player)&&shape(row.after.save);
          row.result=row.movement&&row.shortControl&&row.restored&&!row.consoleErrors.length?"PASS":"FAIL";
        }catch(e){row.error=String(e);if(page)try{row.events=await page.evaluate(()=>JSON.parse(sessionStorage.getItem("__next06_lifecycle_trace")||"[]"));}catch{}}
        finally{await context.close();}
        report.results.push(row);
        console.log("LIFECYCLE_RESULT",JSON.stringify(row));
      }
    }catch(e){report.results.push({engine,result:"FAIL",error:String(e)});}
    finally{if(browser)await browser.close();}
  }
}finally{fs.writeFileSync(path.join(OUT,"lifecycle.json"),JSON.stringify(report,null,2)+"\n");server.closeAllConnections();server.close();}
const candidates=report.results.filter(r=>r.variant==="candidate");
const baselineIntervals=report.results.filter(r=>r.variant==="original"&&r.mode==="interval");
if(report.results.length!==16||candidates.length!==8||baselineIntervals.length!==2||candidates.some(r=>r.result!=="PASS")||baselineIntervals.some(r=>r.result!=="PASS"))process.exitCode=1;
