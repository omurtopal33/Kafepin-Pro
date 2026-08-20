"use strict";
const http=require("http");
const fs=require("fs");
const os=require("os");
const path=require("path");
const cp=require("child_process");

const service=process.argv[2];
if(!service) throw new Error("service path missing");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"kp3151-revenue-"));
const dataDir=path.join(tmp,"KafePinPro","yazici-gelir");
fs.mkdirSync(dataDir,{recursive:true});
const jobs={
  "101":{record_id:101,document:"bw.pdf",printer:"TEST",pages:2,status:"pending"},
  "102":{record_id:102,document:"color.pdf",printer:"TEST",pages:2,status:"pending"},
  "103":{record_id:103,document:"free.pdf",printer:"TEST",pages:3,status:"pending"}
};
fs.writeFileSync(path.join(dataDir,"state.json"),JSON.stringify({initialized:true,lastSeenRecordId:103,jobs},null,2));
const sales=[];
const mock=http.createServer((req,res)=>{
  let raw=""; req.on("data",d=>raw+=d); req.on("end",()=>{
    if(req.method!=="POST"||req.url!=="/admin/product-sales/add-custom-direct"){
      res.writeHead(404,{"Content-Type":"application/json"}); return res.end(JSON.stringify({ok:false}));
    }
    const p=JSON.parse(raw||"{}"); sales.push(p);
    const total=Number(p.unitPrice||0)*Number(p.quantity||0);
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true,id:sales.length,total}));
  });
});
function request(method,urlPath,body){return new Promise((resolve,reject)=>{
  const raw=body?JSON.stringify(body):"";
  const req=http.request({host:"127.0.0.1",port:17893,path:urlPath,method,headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(raw)}},res=>{
    let out="";res.on("data",d=>out+=d);res.on("end",()=>{let j={};try{j=JSON.parse(out||"{}");}catch{} if(res.statusCode>=200&&res.statusCode<300)resolve(j);else reject(new Error(`${res.statusCode} ${out}`));});
  });req.on("error",reject);if(raw)req.write(raw);req.end();
});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function waitHealth(){for(let i=0;i<60;i++){try{const h=await request("GET","/health");if(h.ok)return;}catch{}await sleep(100);}throw new Error("revenue service health timeout");}
(async()=>{
  await new Promise((resolve,reject)=>mock.listen(3000,"127.0.0.1",e=>e?reject(e):resolve()));
  const child=cp.spawn(process.execPath,[service],{env:{...process.env,ProgramData:tmp,USERPROFILE:tmp,KAFEPIN_YAZICI_TEST_MODE:"1"},stdio:["ignore","pipe","pipe"]});
  let err="";child.stderr.on("data",d=>err+=d);
  try{
    await waitHealth();
    await request("POST","/config",{price_bw:5,price_color:10,payment_method:"CASH"});
    const cash=await request("POST","/queue/close",{record_id:101,service_type:"bw",free:false,payment_method:"CASH"});
    if(!cash.ok||cash.result.total!==10||cash.result.quantity!==2) throw new Error("cash result mismatch");
    const card=await request("POST","/queue/close",{record_id:102,service_type:"color",free:false,payment_method:"CARD"});
    if(!card.ok||card.result.total!==20||card.result.quantity!==2) throw new Error("card result mismatch");
    const free=await request("POST","/queue/close",{record_id:103,service_type:"bw",free:true,payment_method:"CASH"});
    if(!free.ok||free.result.total!==0||free.result.free!==true) throw new Error("free result mismatch");
    const before=sales.length;
    const duplicate=await request("POST","/queue/close",{record_id:101,service_type:"bw",free:false,payment_method:"CASH"});
    if(!duplicate.ok) throw new Error("duplicate close response mismatch");
    if(sales.length!==before) throw new Error("duplicate generated second sale");
    if(sales.length!==2) throw new Error(`expected 2 paid sales, got ${sales.length}`);
    if(sales[0].paymentMethod!=="CASH"||sales[0].unitPrice!==5||sales[0].quantity!==2) throw new Error("cash POST payload mismatch");
    if(sales[1].paymentMethod!=="CARD"||sales[1].unitPrice!==10||sales[1].quantity!==2) throw new Error("card POST payload mismatch");
    console.log("REVENUE_HTTP_INTEGRATION_OK",JSON.stringify(sales));
  } finally {
    child.kill(); mock.close(); try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
  }
})().catch(e=>{console.error(e.stack||e);process.exit(1);});
