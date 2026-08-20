"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const { URL } = require("url");

const VERSION = "3.1.51-candidate1";
const HOST = "127.0.0.1";
const PORT = 17893;
const DATA_DIR = path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro", "yazici-gelir");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro", "logs", "v3151-yazici-node.log");
const DIRECT_SALE_URL = "http://127.0.0.1:3000/admin/product-sales/add-custom-direct";
const EVENT_LOG = "Microsoft-Windows-PrintService/Operational";
const SUPPORTED_EXT = new Set([".pdf",".jpg",".jpeg",".png",".bmp",".tif",".tiff",".webp",".doc",".docx"]);
const EXCLUDED_PRINTERS = ["microsoft print to pdf","microsoft xps document writer","fax","onenote","adobe pdf","pdf24","cutepdf"];
const DEFAULT_CONFIG = {price_bw:5,price_color:10,price_identity:5,price_photo:10,payment_method:"CASH",delete_download_after_print:true};

function ensureDirs(){ fs.mkdirSync(DATA_DIR,{recursive:true}); fs.mkdirSync(path.dirname(LOG_FILE),{recursive:true}); }
function log(msg){ try{ ensureDirs(); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\r\n`, "utf8"); }catch{} }
function readJson(file, fallback){ try{ const v=JSON.parse(fs.readFileSync(file,"utf8")); return v && typeof v==="object" ? v : fallback; }catch{return fallback;} }
function writeJson(file, value){ ensureDirs(); const tmp=file+".tmp"; fs.writeFileSync(tmp, JSON.stringify(value,null,2),"utf8"); fs.renameSync(tmp,file); }
function config(){ return {...DEFAULT_CONFIG,...readJson(CONFIG_FILE,{})}; }
function saveConfig(next){ const c={...config(),...next}; c.payment_method=String(c.payment_method).toUpperCase()==="CARD"?"CARD":"CASH"; for(const k of ["price_bw","price_color","price_identity","price_photo"]){ const n=Number(c[k]); c[k]=Number.isFinite(n)&&n>=0?n:DEFAULT_CONFIG[k]; } c.delete_download_after_print=!!c.delete_download_after_print; writeJson(CONFIG_FILE,c); return c; }
function state(){ const s=readJson(STATE_FILE,null); if(s && s.jobs && typeof s.jobs==="object") return s; return {initialized:false,lastSeenRecordId:0,jobs:{}}; }
function saveState(s){ writeJson(STATE_FILE,s); }
function xmlDecode(s){ return String(s||"").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&"); }
function tag(xml,name){ const re=new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,"i"); const m=xml.match(re); return m?xmlDecode(m[1].trim()):""; }
function attr(xml,name,attrName){ const re=new RegExp(`<${name}\\b[^>]*\\b${attrName}="([^"]*)"[^>]*/?>`,"i"); const m=xml.match(re); return m?xmlDecode(m[1]):""; }
function param(xml,n){ return tag(xml,`Param${n}`); }
function isExcludedPrinter(name){ const x=String(name||"").toLowerCase(); return EXCLUDED_PRINTERS.some(v=>x.includes(v)); }
function run(file,args,opts={}){ return cp.spawnSync(file,args,{encoding:"utf8",windowsHide:true,maxBuffer:8*1024*1024,...opts}); }
function readEvents(limit=200){
  if(process.env.KAFEPIN_YAZICI_TEST_MODE==="1") return [];
  const q="*[System[(EventID=307)]]";
  const r=run("wevtutil.exe",["qe",EVENT_LOG,`/q:${q}`,"/f:xml","/rd:true",`/c:${limit}`]);
  if(r.status!==0) throw new Error((r.stderr||r.stdout||"PrintService event log okunamadı").trim());
  const text=r.stdout||""; const rows=[]; const re=/<Event\b[\s\S]*?<\/Event>/gi; let m;
  while((m=re.exec(text))){ const x=m[0]; const id=Number(tag(x,"EventRecordID")); if(!Number.isFinite(id)||id<=0) continue; const printer=param(x,5); if(!printer||isExcludedPrinter(printer)) continue; const pages=Math.max(1,Number(param(x,8))||1); rows.push({record_id:id,time:attr(x,"TimeCreated","SystemTime")||new Date().toISOString(),document:param(x,2)||"Belge",printer,pages}); }
  rows.sort((a,b)=>a.record_id-b.record_id); return rows;
}
function pollQueue(){
  const s=state(); const ev=readEvents(); const max=ev.reduce((m,e)=>Math.max(m,e.record_id),0);
  if(!s.initialized){ s.initialized=true; s.lastSeenRecordId=max; saveState(s); return s; }
  for(const e of ev){ if(e.record_id<=s.lastSeenRecordId) continue; const k=String(e.record_id); if(!s.jobs[k]) s.jobs[k]={...e,status:"pending",created_at:new Date().toISOString()}; }
  s.lastSeenRecordId=Math.max(s.lastSeenRecordId,max); saveState(s); return s;
}
function maxRecordId(){ try{ const ev=readEvents(30); return ev.reduce((m,e)=>Math.max(m,e.record_id),0); }catch{return state().lastSeenRecordId||0;} }
function priceFor(type,c){ return type==="color"?c.price_color:type==="identity"?c.price_identity:type==="photo"?c.price_photo:c.price_bw; }
function saleName(type){ return type==="color"?"Yazıcı Geliri - Renkli Çıktı":type==="identity"?"Yazıcı Geliri - Kimlik Fotokopisi":type==="photo"?"Yazıcı Geliri - Fotoğraf":"Yazıcı Geliri - Çıktı"; }
function httpJson(urlString,payload,timeoutMs=6000){ return new Promise((resolve,reject)=>{ const u=new URL(urlString); const body=Buffer.from(JSON.stringify(payload)); const req=http.request({hostname:u.hostname,port:u.port,path:u.pathname,method:"POST",headers:{"Content-Type":"application/json","Content-Length":body.length},timeout:timeoutMs},res=>{ let raw=""; res.setEncoding("utf8"); res.on("data",d=>raw+=d); res.on("end",()=>{ let j={}; try{j=raw?JSON.parse(raw):{};}catch{} if(res.statusCode>=200&&res.statusCode<300&&j.ok!==false) resolve(j); else reject(new Error(j.error||`HTTP ${res.statusCode}`)); });}); req.on("timeout",()=>req.destroy(new Error("KafePin satış isteği zaman aşımı"))); req.on("error",reject); req.end(body); }); }
async function finalizeJobs(events,type,free,payment,source){
  const s=state(); const keys=events.map(e=>String(e.record_id));
  const active=keys.map(k=>s.jobs[k]).filter(Boolean);
  for(const j of active){ if(j.status!=="pending") throw new Error(`Yazdırma işi zaten işlendi: ${j.record_id}`); }
  const qty=events.reduce((n,e)=>n+Math.max(1,Number(e.pages)||1),0);
  if(free){ for(const e of events){ const k=String(e.record_id); s.jobs[k]={...(s.jobs[k]||e),status:"free",closed_at:new Date().toISOString(),source}; } saveState(s); return {free:true,quantity:qty,total:0}; }
  const c=config(), unit=Number(priceFor(type,c))||0; if(unit<0) throw new Error("Geçersiz çıktı ücreti.");
  for(const e of events){ const k=String(e.record_id); s.jobs[k]={...(s.jobs[k]||e),status:"submitting",source,submit_started_at:new Date().toISOString()}; } saveState(s);
  try{
    const result=await httpJson(DIRECT_SALE_URL,{name:saleName(type),unitPrice:unit,quantity:qty,paymentMethod:String(payment).toUpperCase()==="CARD"?"CARD":"CASH"});
    const s2=state(); for(const e of events){ const k=String(e.record_id); s2.jobs[k]={...(s2.jobs[k]||e),status:"finalized",source,closed_at:new Date().toISOString(),sale_id:result.id||null,total:result.total??unit*qty}; } saveState(s2);
    return {free:false,quantity:qty,unitPrice:unit,total:result.total??unit*qty,saleId:result.id||null};
  }catch(err){
    const s2=state(); for(const e of events){ const k=String(e.record_id); s2.jobs[k]={...(s2.jobs[k]||e),status:"uncertain",source,error:String(err.message||err),closed_at:new Date().toISOString()}; } saveState(s2);
    throw new Error("Satış cevabı alınamadı; çift kayıt riskine karşı otomatik tekrar yapılmadı. Doğrudan Satış listesini kontrol et. Ayrıntı: "+String(err.message||err));
  }
}
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function waitEvents(after,printer,seconds){ const until=Date.now()+seconds*1000; while(Date.now()<until){ const ev=readEvents(100).filter(e=>e.record_id>after && (!printer || e.printer.toLowerCase()===String(printer).toLowerCase())); if(ev.length) return ev; await wait(900); } return []; }
function downloadsDir(){
  const candidates=[];
  const own=path.join(process.env.USERPROFILE || os.homedir(),"Downloads");
  if(fs.existsSync(own)) candidates.push(own);
  if(process.platform==="win32"){
    const root=process.env.SystemDrive ? path.join(process.env.SystemDrive+"\\","Users") : "C:\\Users";
    try{
      for(const ent of fs.readdirSync(root,{withFileTypes:true})){
        if(!ent.isDirectory()) continue;
        if(["public","default","default user","all users","administrator","defaultaccount","wdagutilityaccount"].includes(ent.name.toLowerCase())) continue;
        const d=path.join(root,ent.name,"Downloads");
        if(fs.existsSync(d) && !candidates.some(x=>x.toLowerCase()===d.toLowerCase())) candidates.push(d);
      }
    }catch{}
  }
  let best=own,bestScore=-1;
  for(const d of candidates){
    let score=0;
    try{
      for(const ent of fs.readdirSync(d,{withFileTypes:true})){
        if(!ent.isFile() || !SUPPORTED_EXT.has(path.extname(ent.name).toLowerCase())) continue;
        const st=fs.statSync(path.join(d,ent.name)); score=Math.max(score,st.mtimeMs||0);
      }
      if(score===0) score=fs.statSync(d).mtimeMs||0;
    }catch{}
    if(score>bestScore){bestScore=score;best=d;}
  }
  return best;
}
function listDownloads(){ const d=downloadsDir(); try{ return fs.readdirSync(d,{withFileTypes:true}).filter(x=>x.isFile()&&SUPPORTED_EXT.has(path.extname(x.name).toLowerCase())).map(x=>{const p=path.join(d,x.name),st=fs.statSync(p);return{name:x.name,size:st.size,mtime:st.mtime.toISOString()};}).sort((a,b)=>b.mtime.localeCompare(a.mtime)).slice(0,80);}catch{return [];} }
function resolveDownload(name){ const base=path.basename(String(name||"")); if(!base||base!==String(name||"")) throw new Error("Geçersiz dosya adı."); const p=path.join(downloadsDir(),base); if(!fs.existsSync(p)||!fs.statSync(p).isFile()) throw new Error("Dosya İndirilenler içinde bulunamadı."); if(!SUPPORTED_EXT.has(path.extname(p).toLowerCase())) throw new Error("Bu dosya türü hızlı yazdırma için desteklenmiyor."); return p; }
function psQuote(s){ return "'"+String(s).replace(/'/g,"''")+"'"; }
function sendPrintTo(file,printer,copies){ const script=`$ErrorActionPreference='Stop';$f=${psQuote(file)};$p=${psQuote(printer)};for($i=0;$i -lt ${copies};$i++){Start-Process -FilePath $f -Verb PrintTo -ArgumentList ('\"'+$p+'\"') -WindowStyle Hidden -ErrorAction Stop}`; const enc=Buffer.from(script,"utf16le").toString("base64"); const r=run("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-EncodedCommand",enc],{timeout:30000}); if(r.status!==0) throw new Error((r.stderr||r.stdout||"Windows yazdırma komutu başarısız").trim()); }
function json(res,status,obj){ const body=Buffer.from(JSON.stringify(obj)); res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":body.length,"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Cache-Control":"no-store"}); res.end(body); }
async function readBody(req){ return await new Promise((resolve,reject)=>{ let raw=""; req.setEncoding("utf8"); req.on("data",d=>{raw+=d;if(raw.length>1024*1024){reject(new Error("İstek çok büyük"));req.destroy();}}); req.on("end",()=>{try{resolve(raw?JSON.parse(raw):{});}catch{reject(new Error("Geçersiz JSON"));}}); req.on("error",reject); }); }

ensureDirs();
try{ pollQueue(); }catch(e){ log("İlk PrintService okuma hatası: "+e.message); }
setInterval(()=>{ try{pollQueue();}catch(e){log("Poll hata: "+e.message);} },4000).unref();

const server=http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS") return json(res,200,{ok:true});
  try{
    const u=new URL(req.url,`http://${HOST}:${PORT}`); const p=u.pathname;
    if(req.method==="GET"&&p==="/health") return json(res,200,{ok:true,service:"KafePin Yazıcı Geliri",version:VERSION});
    if(req.method==="GET"&&p==="/config") return json(res,200,{ok:true,config:config()});
    if(req.method==="POST"&&p==="/config"){ const d=await readBody(req); const x={}; for(const k of ["price_bw","price_color","price_identity","price_photo","payment_method","delete_download_after_print"]) if(Object.prototype.hasOwnProperty.call(d,k)) x[k]=d[k]; return json(res,200,{ok:true,config:saveConfig(x)}); }
    if(req.method==="GET"&&p==="/snapshot") return json(res,200,{ok:true,record_id:maxRecordId()});
    if(req.method==="GET"&&p==="/downloads") return json(res,200,{ok:true,files:listDownloads()});
    if(req.method==="GET"&&p==="/queue"){ const s=pollQueue(); const jobs=Object.values(s.jobs).sort((a,b)=>Number(b.record_id)-Number(a.record_id)).slice(0,100); return json(res,200,{ok:true,jobs}); }
    if(req.method==="POST"&&p==="/queue/close"){ const d=await readBody(req),s=pollQueue(),j=s.jobs[String(d.record_id)]; if(!j) throw new Error("Yazdırma işi bulunamadı."); if(j.status!=="pending") return json(res,200,{ok:true,job:j}); const result=await finalizeJobs([j],String(d.service_type||"bw"),!!d.free,String(d.payment_method||"CASH"),"queue"); return json(res,200,{ok:true,job:state().jobs[String(d.record_id)],result}); }
    if(req.method==="POST"&&p==="/claim-after"){ const d=await readBody(req),after=Number(d.after_record_id)||0; const ev=await waitEvents(after,String(d.printer||""),18); if(!ev.length) return json(res,409,{ok:false,error:"Yeni yazdırma olayı henüz görünmedi. İş Son Yazdırmalar bölümüne düşebilir."}); const s=pollQueue(); const events=ev.map(e=>s.jobs[String(e.record_id)]||e); const result=await finalizeJobs(events,String(d.service_type||"bw"),!!d.free,String(d.payment_method||"CASH"),"claim"); return json(res,200,{ok:true,result}); }
    if(req.method==="POST"&&p==="/quick-print"){ const d=await readBody(req),file=resolveDownload(d.name),printer=String(d.printer||"").trim(); if(!printer) throw new Error("Önce Yazıcı PRO’dan yazıcı seç."); const after=maxRecordId(),copies=Math.max(1,Math.min(99,Number(d.copies)||1)); sendPrintTo(file,printer,copies); const ev=await waitEvents(after,printer,25); if(!ev.length) throw new Error("Windows tamamlanmış baskı olayı gelmedi. Dosya silinmedi ve satış yazılmadı; normal yazdırıp Son Yazdırmalar’dan kapatabilirsin."); const s=pollQueue(),events=ev.map(e=>s.jobs[String(e.record_id)]||e); const result=await finalizeJobs(events,String(d.service_type||"bw"),!!d.free,String(d.payment_method||"CASH"),"quick"); let deleted=false; if(config().delete_download_after_print){fs.unlinkSync(file);deleted=true;} return json(res,200,{ok:true,result,deleted}); }
    return json(res,404,{ok:false,error:"Endpoint bulunamadı."});
  }catch(e){ log(`İstek hata ${req.method} ${req.url}: ${e.stack||e}`); return json(res,400,{ok:false,error:String(e.message||e)}); }
});
server.on("error",e=>{log("Server hata: "+(e.stack||e));process.exitCode=2;});
server.listen(PORT,HOST,()=>log(`Servis başladı ${HOST}:${PORT} ${VERSION}`));