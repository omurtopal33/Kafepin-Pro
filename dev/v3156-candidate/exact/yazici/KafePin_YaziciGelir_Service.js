"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const crypto = require("crypto");
const { URL } = require("url");

const VERSION = "3.1.55-candidate1";
const HOST = "127.0.0.1";
const PORT = 17893;
const DATA_DIR = path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro", "yazici-gelir");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro", "logs", "v3153-yazici-node.log");
const DIRECT_SALE_URL = "http://127.0.0.1:3000/admin/product-sales/add-custom-direct";
const EVENT_LOG = "Microsoft-Windows-PrintService/Operational";
const SUPPORTED_EXT = new Set([".pdf",".jpg",".jpeg",".png",".bmp",".tif",".tiff",".webp",".doc",".docx"]);
const EXCLUDED_PRINTERS = ["microsoft print to pdf","microsoft xps document writer","fax","onenote","adobe pdf","pdf24","cutepdf"];
const DEFAULT_CONFIG = {
  price_bw:5,
  price_color:10,
  price_identity:5,
  price_photo:10,
  price_scan:10,
  price_document:30,
  payment_method:"CASH",
  delete_download_after_print:true
};

function ensureDirs(){ fs.mkdirSync(DATA_DIR,{recursive:true}); fs.mkdirSync(path.dirname(LOG_FILE),{recursive:true}); }
function log(msg){ try{ ensureDirs(); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\r\n`, "utf8"); }catch{} }
function readJson(file, fallback){ try{ const v=JSON.parse(fs.readFileSync(file,"utf8")); return v && typeof v==="object" ? v : fallback; }catch{return fallback;} }
function writeJson(file, value){ ensureDirs(); const tmp=file+".tmp"; fs.writeFileSync(tmp, JSON.stringify(value,null,2),"utf8"); fs.renameSync(tmp,file); }
function config(){ return {...DEFAULT_CONFIG,...readJson(CONFIG_FILE,{})}; }
function normPayment(v){ return String(v||"").toUpperCase()==="CARD"?"CARD":"CASH"; }
function saveConfig(next){
  const c={...config(),...next};
  c.payment_method=normPayment(c.payment_method);
  for(const k of ["price_bw","price_color","price_identity","price_photo","price_scan","price_document"]){
    const n=Number(c[k]); c[k]=Number.isFinite(n)&&n>=0?n:DEFAULT_CONFIG[k];
  }
  c.delete_download_after_print=!!c.delete_download_after_print;
  writeJson(CONFIG_FILE,c); return c;
}
function state(){
  const s=readJson(STATE_FILE,null);
  if(s && s.jobs && typeof s.jobs==="object"){
    if(!s.transactions || typeof s.transactions!=="object") s.transactions={};
    return s;
  }
  return {initialized:false,lastSeenRecordId:0,jobs:{},transactions:{}};
}
function saveState(s){ if(!s.transactions)s.transactions={}; writeJson(STATE_FILE,s); }
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
  while((m=re.exec(text))){
    const x=m[0]; const id=Number(tag(x,"EventRecordID")); if(!Number.isFinite(id)||id<=0) continue;
    const printer=param(x,5); if(!printer||isExcludedPrinter(printer)) continue;
    const pages=Math.max(1,Number(param(x,8))||1);
    rows.push({record_id:id,time:attr(x,"TimeCreated","SystemTime")||new Date().toISOString(),document:param(x,2)||"Belge",printer,pages});
  }
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
function printLabel(type){ return type==="color"?"Renkli Çıktı":type==="identity"?"Kimlik Fotokopisi":type==="photo"?"Fotoğraf":"S/B Çıktı"; }
function money(v){ const n=Number(v); return Number.isFinite(n)?Math.max(0,Math.round(n*100)/100):0; }
function txId(){ return `tx_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`; }
function normalizeItems(items){
  return (Array.isArray(items)?items:[]).map(x=>({
    label:String(x.label||"Hizmet").slice(0,90),
    unitPrice:money(x.unitPrice),
    quantity:Math.max(1,Math.min(999,Number(x.quantity)||1))
  })).filter(x=>x.unitPrice>=0);
}
function calcTotal(items){ return money(items.reduce((t,x)=>t+(Number(x.unitPrice)||0)*(Number(x.quantity)||0),0)); }
function createTransaction({source,title,items,payment,recordIds=[],deleteFile="",meta={}}){
  const s=state();
  const normalized=normalizeItems(items);
  if(!normalized.length) throw new Error("Ücret kalemi bulunamadı.");
  const id=txId();
  const tx={
    id,status:"pending_confirmation",source:String(source||"service"),title:String(title||"Yazıcı Geliri").slice(0,120),
    items:normalized,total:calcTotal(normalized),payment_method:normPayment(payment||config().payment_method),
    record_ids:(recordIds||[]).map(Number).filter(Number.isFinite),delete_file:String(deleteFile||""),meta:meta||{},
    created_at:new Date().toISOString()
  };
  s.transactions[id]=tx;
  for(const rid of tx.record_ids){ const k=String(rid); const j=s.jobs[k]; if(j){ j.status="awaiting_confirmation"; j.transaction_id=id; } }
  saveState(s); return tx;
}
function transaction(id){ const s=state(); return s.transactions[String(id||"")]||null; }
function maybeDeleteSource(tx){
  if(!tx || !tx.delete_file || config().delete_download_after_print!==true) return false;
  try{ if(fs.existsSync(tx.delete_file)){ fs.unlinkSync(tx.delete_file); return true; } }catch(e){ log("Kaynak silme hatası: "+e.message); }
  return false;
}
function markJobsForTx(s,tx,status){
  for(const rid of tx.record_ids||[]){ const k=String(rid); if(s.jobs[k]){ s.jobs[k].status=status; s.jobs[k].closed_at=new Date().toISOString(); s.jobs[k].transaction_id=tx.id; } }
}
function httpJson(urlString,payload,timeoutMs=6000){ return new Promise((resolve,reject)=>{ const u=new URL(urlString); const body=Buffer.from(JSON.stringify(payload)); const req=http.request({hostname:u.hostname,port:u.port,path:u.pathname,method:"POST",headers:{"Content-Type":"application/json","Content-Length":body.length},timeout:timeoutMs},res=>{ let raw=""; res.setEncoding("utf8"); res.on("data",d=>raw+=d); res.on("end",()=>{ let j={}; try{j=raw?JSON.parse(raw):{};}catch{} if(res.statusCode>=200&&res.statusCode<300&&j.ok!==false) resolve(j); else reject(new Error(j.error||`HTTP ${res.statusCode}`)); });}); req.on("timeout",()=>req.destroy(new Error("KafePin satış isteği zaman aşımı"))); req.on("error",reject); req.end(body); }); }
async function confirmTransaction(id,payment,adjustedTotal){
  const s=state(); const tx=s.transactions[String(id||"")]; if(!tx) throw new Error("Onay bekleyen işlem bulunamadı.");
  if(tx.status==="finalized" || tx.status==="free") return tx;
  if(tx.status==="submitting" || tx.status==="uncertain") throw new Error("Bu işlem yeniden gönderilemez; Doğrudan Satış listesini kontrol et.");
  if(tx.status!=="pending_confirmation") throw new Error("İşlem onaya uygun durumda değil.");
  const total=adjustedTotal===undefined||adjustedTotal===null||adjustedTotal===""?money(tx.total):money(adjustedTotal);
  tx.total=total; tx.payment_method=normPayment(payment||tx.payment_method); tx.status="submitting"; tx.submit_started_at=new Date().toISOString();
  markJobsForTx(s,tx,"submitting"); saveState(s);
  try{
    const result=await httpJson(DIRECT_SALE_URL,{name:String(tx.title||"Yazıcı Geliri"),unitPrice:total,quantity:1,paymentMethod:tx.payment_method});
    const s2=state(), t=s2.transactions[tx.id];
    t.status="finalized"; t.closed_at=new Date().toISOString(); t.sale_id=result.id||null; t.total=result.total??total; t.deleted=maybeDeleteSource(t);
    markJobsForTx(s2,t,"finalized"); saveState(s2); return t;
  }catch(err){
    const s2=state(), t=s2.transactions[tx.id]; t.status="uncertain"; t.error=String(err.message||err); t.closed_at=new Date().toISOString(); markJobsForTx(s2,t,"uncertain"); saveState(s2);
    throw new Error("Satış cevabı alınamadı; çift kayıt riskine karşı otomatik tekrar yapılmadı. Doğrudan Satış listesini kontrol et. Ayrıntı: "+String(err.message||err));
  }
}
function freeTransaction(id){
  const s=state(); const tx=s.transactions[String(id||"")]; if(!tx) throw new Error("Onay bekleyen işlem bulunamadı.");
  if(tx.status==="finalized" || tx.status==="free") return tx;
  if(tx.status!=="pending_confirmation") throw new Error("İşlem ücretsiz kapatmaya uygun durumda değil.");
  tx.status="free"; tx.total=0; tx.closed_at=new Date().toISOString(); tx.deleted=maybeDeleteSource(tx); markJobsForTx(s,tx,"free"); saveState(s); return tx;
}
function cancelTransaction(id){
  const s=state(); const key=String(id||""); const tx=s.transactions[key]; if(!tx) throw new Error("Onay bekleyen işlem bulunamadı.");
  if(tx.status==="cancelled") return tx;
  if(tx.status!=="pending_confirmation") throw new Error("İşlem iptal etmeye uygun durumda değil.");
  tx.status="cancelled"; tx.closed_at=new Date().toISOString();
  for(const rid of tx.record_ids||[]){
    const j=s.jobs[String(rid)];
    if(j){ j.status="pending"; delete j.transaction_id; delete j.closed_at; }
  }
  saveState(s); return tx;
}
function deleteTransaction(id){
  const s=state(); const key=String(id||""); const tx=s.transactions[key]; if(!tx) throw new Error("İşlem bulunamadı.");
  if(["finalized","submitting","uncertain"].includes(tx.status)) throw new Error("KafePin'e gönderilmiş veya sonucu belirsiz işlem silinemez.");
  for(const rid of tx.record_ids||[]){ delete s.jobs[String(rid)]; }
  delete s.transactions[key];
  saveState(s);
  return {id:key,status:"deleted"};
}
function deleteQueueJob(recordId){
  const s=state(), key=String(Number(recordId)||0), job=s.jobs[key];
  if(!job) throw new Error("Yazdırma kaydı bulunamadı.");
  if(job.transaction_id){
    const tx=s.transactions[String(job.transaction_id)];
    if(tx && ["finalized","submitting","uncertain"].includes(tx.status)) throw new Error("KafePin'e gönderilmiş veya sonucu belirsiz kayıt silinemez.");
    if(tx) delete s.transactions[String(job.transaction_id)];
  }
  delete s.jobs[key];
  saveState(s);
  return {record_id:Number(recordId),status:"deleted"};
}
function preparePrintJobs(events,type,payment,source,documentPrep=false,deleteFile=""){
  const s=state(); const ids=events.map(e=>Number(e.record_id)).filter(Number.isFinite);
  for(const rid of ids){
    const j=s.jobs[String(rid)];
    if(j && j.transaction_id){ const old=s.transactions[j.transaction_id]; if(old) return old; }
    if(j && !["pending","awaiting_confirmation"].includes(j.status)) throw new Error(`Yazdırma işi zaten işlendi: ${rid}`);
  }
  const qty=events.reduce((n,e)=>n+Math.max(1,Number(e.pages)||1),0); const c=config(); const items=[{label:printLabel(type),unitPrice:Number(priceFor(type,c))||0,quantity:qty}];
  if(documentPrep) items.push({label:"Belge / Dilekçe Hazırlama",unitPrice:Number(c.price_document)||0,quantity:1});
  const title=documentPrep?`Yazıcı Geliri - Belge Hazırlama + ${printLabel(type)}`:`Yazıcı Geliri - ${printLabel(type)}`;
  return createTransaction({source,title,items,payment,recordIds:ids,deleteFile,meta:{service_type:type,pages:qty,document_prep:!!documentPrep}});
}
function prepareService(serviceType,quantity,payment,documentPrep=false,title=""){
  const c=config(); const qty=Math.max(1,Math.min(999,Number(quantity)||1)); const items=[]; let serviceLabel="Tarama";
  if(serviceType==="scan"){ items.push({label:"Tarama",unitPrice:Number(c.price_scan)||0,quantity:qty}); serviceLabel="Tarama"; }
  else if(serviceType==="document"){ items.push({label:"Belge / Dilekçe Hazırlama",unitPrice:Number(c.price_document)||0,quantity:1}); serviceLabel="Belge / Dilekçe Hazırlama"; }
  else throw new Error("Geçersiz hizmet türü.");
  if(documentPrep && serviceType!=="document") items.push({label:"Belge / Dilekçe Hazırlama",unitPrice:Number(c.price_document)||0,quantity:1});
  return createTransaction({source:"service",title:title||`Yazıcı Geliri - ${serviceLabel}${documentPrep&&serviceType!=="document"?" + Belge Hazırlama":""}`,items,payment,meta:{service_type:serviceType,quantity:qty,document_prep:!!documentPrep}});
}
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function waitEvents(after,printer,seconds){ const until=Date.now()+seconds*1000; while(Date.now()<until){ const ev=readEvents(100).filter(e=>e.record_id>after && (!printer || e.printer.toLowerCase()===String(printer).toLowerCase())); if(ev.length) return ev; await wait(900); } return []; }
function downloadsDir(){
  const candidates=[]; const own=path.join(process.env.USERPROFILE || os.homedir(),"Downloads"); if(fs.existsSync(own)) candidates.push(own);
  if(process.platform==="win32"){
    const root=process.env.SystemDrive ? path.join(process.env.SystemDrive+"\\","Users") : "C:\\Users";
    try{ for(const ent of fs.readdirSync(root,{withFileTypes:true})){ if(!ent.isDirectory()) continue; if(["public","default","default user","all users","administrator","defaultaccount","wdagutilityaccount"].includes(ent.name.toLowerCase())) continue; const d=path.join(root,ent.name,"Downloads"); if(fs.existsSync(d) && !candidates.some(x=>x.toLowerCase()===d.toLowerCase())) candidates.push(d); } }catch{}
  }
  let best=own,bestScore=-1;
  for(const d of candidates){ let score=0; try{ for(const ent of fs.readdirSync(d,{withFileTypes:true})){ if(!ent.isFile() || !SUPPORTED_EXT.has(path.extname(ent.name).toLowerCase())) continue; const st=fs.statSync(path.join(d,ent.name)); score=Math.max(score,st.mtimeMs||0); } if(score===0) score=fs.statSync(d).mtimeMs||0; }catch{} if(score>bestScore){bestScore=score;best=d;} }
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
    if(req.method==="POST"&&p==="/config"){ const d=await readBody(req); const x={}; for(const k of ["price_bw","price_color","price_identity","price_photo","price_scan","price_document","payment_method","delete_download_after_print"]) if(Object.prototype.hasOwnProperty.call(d,k)) x[k]=d[k]; return json(res,200,{ok:true,config:saveConfig(x)}); }
    if(req.method==="GET"&&p==="/snapshot") return json(res,200,{ok:true,record_id:maxRecordId()});
    if(req.method==="GET"&&p==="/downloads") return json(res,200,{ok:true,files:listDownloads()});
    if(req.method==="GET"&&p==="/queue"){ const s=pollQueue(); const jobs=Object.values(s.jobs).sort((a,b)=>Number(b.record_id)-Number(a.record_id)).slice(0,100); return json(res,200,{ok:true,jobs}); }
    if(req.method==="GET"&&p==="/transactions"){ const s=state(); const rows=Object.values(s.transactions||{}).sort((a,b)=>String(b.created_at||"").localeCompare(String(a.created_at||""))).slice(0,100); return json(res,200,{ok:true,transactions:rows}); }
    if(req.method==="POST"&&p==="/queue/prepare"){
      const d=await readBody(req),s=pollQueue(),j=s.jobs[String(d.record_id)]; if(!j) throw new Error("Yazdırma işi bulunamadı.");
      if(j.transaction_id && s.transactions[j.transaction_id]) return json(res,200,{ok:true,transaction:s.transactions[j.transaction_id]});
      if(j.status!=="pending") throw new Error("Yazdırma işi zaten işlendi.");
      const tx=preparePrintJobs([j],String(d.service_type||"bw"),String(d.payment_method||"CASH"),"queue",!!d.document_prep,""); return json(res,200,{ok:true,transaction:tx});
    }
    if(req.method==="POST"&&p==="/claim-after"){
      const d=await readBody(req),after=Number(d.after_record_id)||0; const ev=await waitEvents(after,String(d.printer||""),18);
      if(!ev.length) return json(res,409,{ok:false,error:"Yeni yazdırma olayı henüz görünmedi. İş Son Yazdırmalar bölümüne düşebilir."});
      const s=pollQueue(); const events=ev.map(e=>s.jobs[String(e.record_id)]||e);
      const tx=preparePrintJobs(events,String(d.service_type||"bw"),String(d.payment_method||"CASH"),"claim",!!d.document_prep,""); return json(res,200,{ok:true,transaction:tx});
    }
    if(req.method==="POST"&&p==="/quick-print"){
      const d=await readBody(req),file=resolveDownload(d.name),printer=String(d.printer||"").trim(); if(!printer) throw new Error("Önce Yazıcı PRO’dan yazıcı seç.");
      const after=maxRecordId(),copies=Math.max(1,Math.min(99,Number(d.copies)||1)); sendPrintTo(file,printer,copies); const ev=await waitEvents(after,printer,25);
      if(!ev.length) throw new Error("Windows tamamlanmış baskı olayı gelmedi. Dosya silinmedi ve satış hazırlanmadı; normal yazdırıp Son Yazdırmalar’dan kapatabilirsin.");
      const s=pollQueue(),events=ev.map(e=>s.jobs[String(e.record_id)]||e);
      const tx=preparePrintJobs(events,String(d.service_type||"bw"),String(d.payment_method||"CASH"),"quick",!!d.document_prep,file); return json(res,200,{ok:true,transaction:tx});
    }
    if(req.method==="POST"&&p==="/service/prepare"){ const d=await readBody(req); const tx=prepareService(String(d.service_type||"scan"),Number(d.quantity)||1,String(d.payment_method||"CASH"),!!d.document_prep,String(d.title||"")); return json(res,200,{ok:true,transaction:tx}); }
    if(req.method==="POST"&&p==="/transaction/confirm"){ const d=await readBody(req); const tx=await confirmTransaction(String(d.id||""),String(d.payment_method||""),Object.prototype.hasOwnProperty.call(d,"total")?d.total:undefined); return json(res,200,{ok:true,transaction:tx}); }
    if(req.method==="POST"&&p==="/transaction/free"){ const d=await readBody(req); const tx=freeTransaction(String(d.id||"")); return json(res,200,{ok:true,transaction:tx}); }
    if(req.method==="POST"&&p==="/transaction/cancel"){ const d=await readBody(req); const tx=cancelTransaction(String(d.id||"")); return json(res,200,{ok:true,transaction:tx}); }
    if(req.method==="POST"&&p==="/transaction/delete"){ const d=await readBody(req); const tx=deleteTransaction(String(d.id||"")); return json(res,200,{ok:true,transaction:tx}); }
    if(req.method==="POST"&&p==="/queue/delete"){ const d=await readBody(req); const job=deleteQueueJob(d.record_id); return json(res,200,{ok:true,job}); }
    return json(res,404,{ok:false,error:"Endpoint bulunamadı."});
  }catch(e){ log(`İstek hata ${req.method} ${req.url}: ${e.stack||e}`); return json(res,400,{ok:false,error:String(e.message||e)}); }
});
server.on("error",e=>{log("Server hata: "+(e.stack||e));process.exitCode=2;});
server.listen(PORT,HOST,()=>log(`Servis başladı ${HOST}:${PORT} ${VERSION}`));
