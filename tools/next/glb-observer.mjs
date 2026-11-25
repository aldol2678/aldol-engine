// ENGINE-NEXT-06: observe native CDP events and the actual GLTFLoader parse input.
// Only the test server appends this tap to the served vendor module.
// No product loader, network error policy, or browser preference is changed.
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
const sha=b=>createHash("sha256").update(b).digest("hex");
export const parseTap=`
const __next06OriginalParse=GLTFLoader.prototype.parse;
GLTFLoader.prototype.parse=function(data,base,onLoad,onError){
  const rows=globalThis.__NEXT06_GLB_PARSE__ ||= [];
  const row={base,at:Date.now(),bytes:data instanceof ArrayBuffer?data.byteLength:null,status:"pending"};
  rows.push(row);
  row.digest=data instanceof ArrayBuffer?
    crypto.subtle.digest("SHA-256",data).then(b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,"0")).join("")).catch(e=>({error:String(e)})):
    Promise.resolve({error:"not ArrayBuffer"});
  try{
    return __next06OriginalParse.call(this,data,base,gltf=>{
      row.status="decoded";row.meshes=0;row.vertices=0;
      gltf.scene?.traverse(o=>{if(o.isMesh){row.meshes++;row.vertices+=o.geometry?.attributes?.position?.count||0;}});
      row.completedAt=Date.now();
      return onLoad?.(gltf);
    },error=>{
      row.status="decode-error";row.error=String(error);row.completedAt=Date.now();
      return onError?.(error);
    });
  }catch(e){row.status="throw";row.error=String(e);row.completedAt=Date.now();throw e;}
};
`;
export function expectedFishingAssets(root){
  return ["star-fish.glb","star-trophy.glb"].map(name=>{
    const urlPath="/games/star-fishing/assets/models/"+name;
    const bytes=fs.readFileSync(path.join(root,"."+urlPath));
    if(bytes.length<12||bytes.subarray(0,4).toString("ascii")!=="glTF"||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw Error("Invalid original GLB "+name);
    return {name,urlPath,bytes:bytes.length,sha256:sha(bytes)};
  });
}
export async function observeGlb(context,page,getStage){
  const cdp=await context.newCDPSession(page);
  const entries=new Map(),events=[],bodies=[],documents=[];
  const isGlb=url=>{try{return new URL(url).pathname.endsWith(".glb");}catch{return false;}};
  const header=(headers,key)=>Object.entries(headers||{}).find(([k])=>k.toLowerCase()===key)?.[1]??null;
  function record(event,p){
    if(event==="requestWillBeSent"&&isGlb(p.request.url)){
      entries.set(p.requestId,{requestId:p.requestId,url:p.request.url,loaderId:p.loaderId,frameId:p.frameId,requestAt:Date.now(),...getStage()});
    }
    const row=entries.get(p.requestId);if(!row)return;
    events.push({event,at:Date.now(),...getStage(),params:p});
    if(event==="responseReceived"){
      row.status=p.response.status;
      row.token=header(p.response.headers,"x-next06-glb-id");
      row.contentLength=header(p.response.headers,"content-length");
      row.mimeType=p.response.mimeType;
      row.responseAt=Date.now();
    }
    if(event==="dataReceived"){
      row.dataLength=(row.dataLength||0)+p.dataLength;
      row.encodedDataLength=(row.encodedDataLength||0)+p.encodedDataLength;
    }
    if(event==="loadingFinished"||event==="loadingFailed"){
      row.terminal=event;row.terminalAt=Date.now();
      if(event==="loadingFailed"){row.errorText=p.errorText;row.canceled=p.canceled;row.blockedReason=p.blockedReason??null;}
      else row.encodedFinished=p.encodedDataLength;
      bodies.push(cdp.send("Network.getResponseBody",{requestId:p.requestId}).then(result=>{
        const b=Buffer.from(result.body,result.base64Encoded?"base64":"utf8");
        row.body={bytes:b.length,sha256:sha(b),base64Encoded:result.base64Encoded};
      }).catch(e=>{row.bodyError=String(e);}));
    }
  }
  for(const name of ["requestWillBeSent","responseReceived","dataReceived","loadingFinished","loadingFailed","requestServedFromCache"]){
    cdp.on("Network."+name,p=>record(name,p));
  }
  await cdp.send("Network.enable");
  return {
    async captureDocument(expected){
      const rows=await page.evaluate(async()=>Promise.all((globalThis.__NEXT06_GLB_PARSE__||[]).map(async ({digest,...row})=>({...row,sha256:await digest}))));
      const assets=await page.evaluate(()=>globalThis.__STAR_FISHING__?.assets??null);
      const match=expected.every(e=>rows.filter(r=>r.sha256===e.sha256&&r.bytes===e.bytes&&r.status==="decoded"&&r.meshes>0&&r.vertices>0).length===1);
      const document={...getStage(),at:Date.now(),rows,assets,ok:rows.length===expected.length&&match&&assets?.loaded?.length===2&&assets?.failed?.length===0};
      documents.push(document);return document;
    },
    async finish(){
      let timer, timedOut=false;
      await Promise.race([Promise.allSettled(bodies),new Promise(r=>{timer=setTimeout(()=>{timedOut=true;r();},3000);})]);clearTimeout(timer);
      return {requests:[...entries.values()],events,documents,bodyCollectionTimedOut:timedOut};
    }
  };
}
export function correlateGlbEvidence(observation,playwrightTrace,serverTrace,expected){
  // The server-provided request token correlates CDP, Playwright and server rows.
  // Exact per-document parser digests independently prove the application input.
  const records=observation.requests.map(r=>{
    const server=serverTrace.find(s=>s.token&&s.token===r.token)||null;
    const pw=playwrightTrace.filter(p=>p.token&&p.token===r.token);
    const model=expected.find(e=>new URL(r.url).pathname===e.urlPath);
    const document=observation.documents.find(d=>d.nav===r.nav);
    const decoded=!!(model&&document?.rows.some(x=>x.sha256===model.sha256&&x.bytes===model.bytes&&x.status==="decoded"&&x.meshes>0&&x.vertices>0));
    return {requestId:r.requestId,token:r.token??null,url:r.url,nav:r.nav,loaderId:r.loaderId,status:r.status??null,terminal:r.terminal??null,errorText:r.errorText??null,cdpBody:r.body??null,cdpBodyError:r.bodyError??null,expected:model??null,server,playwright:pw,decodedInSameDocument:decoded,bodyMatches:!!(model&&r.body&&r.body.bytes===model.bytes&&r.body.sha256===model.sha256)};
  });
  return {records,documentCount:observation.documents.length,decodedAllDocuments:observation.documents.length===3&&observation.documents.every(d=>d.ok),correlatedAll:records.length===6&&records.every(r=>r.token&&r.server&&r.playwright.some(p=>p.event==="response")),cdpFailures:records.filter(r=>r.terminal==="loadingFailed").length};
}
