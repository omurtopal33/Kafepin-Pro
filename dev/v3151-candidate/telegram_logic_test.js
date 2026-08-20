"use strict";
const fs=require("fs"),vm=require("vm"),crypto=require("crypto"),{EventEmitter}=require("events");
const serverPath=process.argv[2];
if(!serverPath) throw new Error("server.js path missing");
const s=fs.readFileSync(serverPath,"utf8");
function between(a,b){const i=s.indexOf(a),j=s.indexOf(b,i);if(i<0||j<0)throw new Error(`marker missing ${a}`);return s.slice(i,j);}

(async()=>{
  let networkSends=0,moveCalls=0;
  const https={request(opts,onResponse){networkSends++; const req=new EventEmitter(); req.setTimeout=()=>{}; req.write=()=>{}; req.end=()=>{const res=new EventEmitter();res.statusCode=200;onResponse(res);setImmediate(()=>{res.emit("data",JSON.stringify({ok:true,result:{message_id:900+networkSends}}));res.emit("end");});}; req.destroy=e=>req.emit("error",e); return req;}};
  const ctx={crypto,https,Buffer,Date,JSON,setImmediate,clearImmediate,TELEGRAM_ENABLED:true,TELEGRAM_BOT_TOKEN:"x",TELEGRAM_CHAT_ID:"y",telegramEscape:x=>String(x||""),moveLiveMonitorToBottomSoon:()=>{moveCalls++;}};
  vm.createContext(ctx);
  const sendBlock=between("const TELEGRAM_PAYLOAD_DEDUP_MS", "function editTelegramMessage(messageId, text, cb) {");
  vm.runInContext(sendBlock+"\nthis._send=sendTelegramMessage;",ctx);
  const call=text=>new Promise((resolve,reject)=>ctx._send(text,(e,d)=>e?reject(e):resolve(d)));
  await call("SAĞLIK RAPORU TEST");
  await call("SAĞLIK RAPORU TEST");
  if(networkSends!==1) throw new Error(`payload dedupe failed: ${networkSends}`);
  if(moveCalls!==1) throw new Error(`live-bottom trigger count mismatch: ${moveCalls}`);

  let newLiveMessages=0,editLiveMessages=0;
  const ctx2={console,setTimeout,clearTimeout,TELEGRAM_ENABLED:true,liveMonitorBusy:false,liveMessageId:77,deleteTelegramMessage:(id,cb)=>cb(new Error("temporary delete failure")),db:{run:(sql,args,cb)=>{if(typeof args==="function")args();else if(cb)cb();}},sendLiveMonitor:()=>{if(ctx2.liveMessageId)newLiveMessages+=0,editLiveMessages++;else newLiveMessages++;}};
  vm.createContext(ctx2);
  const moveBlock=between("let liveMonitorMoveTimer = null;", "let liveMonitorBusy = false;");
  vm.runInContext(moveBlock+"\nthis._runMove=runLiveMonitorMoveToBottom;",ctx2);
  ctx2._runMove();
  await new Promise(r=>setTimeout(r,20));
  if(ctx2.liveMessageId!==77) throw new Error("delete failure cleared live message id");
  if(newLiveMessages!==0) throw new Error("delete failure created second live message");
  if(editLiveMessages!==1) throw new Error("existing live message was not refreshed");

  for(const marker of ["telegram_auto_health_alert_state","telegram_eod_health_report_claim","v3.1.51 TELEGRAM_SINGLE_SEND_AND_LIVE_BOTTOM"]){if(!s.includes(marker))throw new Error(`missing ${marker}`);}
  console.log("TELEGRAM_LOGIC_OK",JSON.stringify({networkSends,moveCalls,newLiveMessages,editLiveMessages}));
})().catch(e=>{console.error(e.stack||e);process.exit(1);});
