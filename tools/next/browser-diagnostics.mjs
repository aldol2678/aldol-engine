// ENGINE-NEXT-05: browser-only environment and network controls.
// Run under xvfb-run on the pinned Ubuntu runner. No product settings change.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { firefox, chromium } = require("playwright");
const out = process.argv[2];
if (!out) throw Error("evidence directory required");
fs.mkdirSync(out,{recursive:true});
const three = process.env.THREE_BUILD_DIR;
if (!three) throw Error("THREE_BUILD_DIR required");
const asset = fs.readFileSync(new URL("../../games/star-fishing/assets/models/star-fish.glb", import.meta.url));
assert.equal(asset.subarray(0,4).toString("ascii"),"glTF");
assert.equal(asset.readUInt32LE(8),asset.length);
let slowStarted = null;
const server = http.createServer((req,res)=>{
  const p = new URL(req.url,"http://localhost").pathname;
  if (p === "/slow.glb") {
    res.writeHead(200,{"Content-Type":"model/gltf-binary","Content-Length":asset.length,"Cache-Control":"no-store"});
    res.write(asset.subarray(0,12));
    if(slowStarted) slowStarted();
    const t=setTimeout(()=>res.end(asset.subarray(12)),3000);
    res.once("close",()=>clearTimeout(t)); return;
  }
  if(p === "/missing.glb"){res.writeHead(404);res.end("missing");return;}
  if(p === "/valid.glb"){res.writeHead(200,{"Content-Type":"model/gltf-binary","Content-Length":asset.length});res.end(asset);return;}
  if(p.startsWith("/three/")){
    const f=path.join(three,path.basename(p));if(!fs.existsSync(f)){res.writeHead(404);res.end();return;}
    res.writeHead(200,{"Content-Type":"text/javascript"});res.end(fs.readFileSync(f));return;
  }
  res.writeHead(200,{"Content-Type":"text/html"});res.end("<!doctype html><title>Engine environment control</title><body></body>");
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const base="http://127.0.0.1:"+server.address().port;
const headlessEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!["DISPLAY","WAYLAND_DISPLAY","LIBGL_ALWAYS_SOFTWARE"].includes(k)));
const profiles=[
  {name:"default-headless",options:{headless:true,env:headlessEnv}},
  {name:"headless-software",options:{headless:true,env:{...headlessEnv,LIBGL_ALWAYS_SOFTWARE:"1"}}},
  {name:"headed-software",options:{headless:false,env:{...process.env,LIBGL_ALWAYS_SOFTWARE:"1"}}},
];
const report={display:process.env.DISPLAY||null,firefox:[],chromium:null,assetBytes:asset.length,selectedProfile:null};
try {
  for(const profile of profiles){
    const row={profile:profile.name,console:[],errors:[],raw:null,three:null};
    let browser;
    try{
      browser=await firefox.launch(profile.options);
      row.version=browser.version();
      const page=await browser.newPage();
      page.on("console",m=>row.console.push(m.type()+": "+m.text()));
      page.on("pageerror",e=>row.errors.push(String(e)));
      await page.goto(base);
      row.raw=await page.evaluate(()=>{
        const c=document.createElement("canvas");c.width=c.height=4;
        const messages=[];c.addEventListener("webglcontextcreationerror",e=>messages.push(e.statusMessage));
        const gl=c.getContext("webgl2");
        if(!gl)return {ok:false,messages};
        gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
        const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        const error=gl.getError();const dbg=gl.getExtension("WEBGL_debug_renderer_info");
        return {ok:error===0&&pixel[0]===255&&pixel[1]===0&&pixel[2]===0&&pixel[3]===255,pixel:[...pixel],error,version:gl.getParameter(gl.VERSION),renderer:dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),messages};
      });
      row.three=await page.evaluate(async()=>{
        try{
          const THREE=await import("/three/three.module.js");
          const renderer=new THREE.WebGLRenderer({preserveDrawingBuffer:true});renderer.setSize(4,4,false);
          const scene=new THREE.Scene();scene.background=new THREE.Color(0xff0000);
          renderer.render(scene,new THREE.PerspectiveCamera());
          const gl=renderer.getContext(), pixel=new Uint8Array(4);
          gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
          const error=gl.getError();const ok=error===0&&pixel[0]>240&&pixel[1]<10&&pixel[2]<10;
          renderer.dispose();return {ok,pixel:[...pixel],error,revision:THREE.REVISION};
        }catch(e){return {ok:false,error:String(e)};}
      });
    }catch(e){row.errors.push(String(e));}
    finally{if(browser)await browser.close();}
    row.ok=!!(row.raw?.ok&&row.three?.ok&&!row.errors.length);
    report.firefox.push(row);console.log("FIREFOX_CONTROL",JSON.stringify(row));
  }
  // Prefer a normal headless profile, then a headed software renderer without
  // preference overrides. Do not force WebGL past browser blocklists.
  report.selectedProfile=["default-headless","headed-software","headless-software"].find(n=>report.firefox.some(r=>r.profile===n&&r.ok))||null;
  let browser;
  try{
    browser=await chromium.launch();
    const page=await browser.newPage(), events=[];
    page.on("requestfailed",r=>events.push({kind:"requestfailed",path:new URL(r.url()).pathname,error:r.failure()?.errorText||null}));
    page.on("response",r=>{if(r.url().endsWith(".glb"))events.push({kind:"response",path:new URL(r.url()).pathname,status:r.status()});});
    page.on("requestfinished",r=>{if(r.url().endsWith(".glb"))events.push({kind:"finished",path:new URL(r.url()).pathname});});
    await page.goto(base);
    const started=new Promise(r=>slowStarted=r);
    await page.evaluate(()=>{fetch("/slow.glb").then(r=>r.arrayBuffer()).catch(()=>{});});
    let timer;try{await Promise.race([started,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("slow request never started")),5000))]);}finally{clearTimeout(timer);}
    await page.reload();
    const status=await page.evaluate(async()=>{const r=await fetch("/missing.glb");await r.text();return r.status;});
    const good=await page.evaluate(async()=>{const r=await fetch("/valid.glb");const b=await r.arrayBuffer();return {status:r.status,bytes:b.byteLength,magic:new TextDecoder().decode(b.slice(0,4))};});
    await page.waitForTimeout(250);
    report.chromium={version:browser.version(),status,good,events,ok:status===404&&good.status===200&&good.bytes===asset.length&&good.magic==="glTF"&&events.some(e=>e.kind==="requestfailed"&&e.path==="/slow.glb"&&e.error)&&events.some(e=>e.kind==="response"&&e.path==="/missing.glb"&&e.status===404)&&!events.some(e=>e.kind==="requestfailed"&&e.path==="/valid.glb")};
  }catch(e){report.chromium={ok:false,error:String(e)};}
  finally{if(browser)await browser.close();}
  console.log("CHROMIUM_CONTROL",JSON.stringify(report.chromium));
  console.log("FIREFOX_SELECTED",report.selectedProfile||"NONE");
}finally{
  fs.writeFileSync(path.join(out,"environment.json"),JSON.stringify(report,null,2)+"\n");
  server.closeAllConnections();server.close();
}
if(!report.selectedProfile||!report.chromium?.ok)process.exitCode=1;
