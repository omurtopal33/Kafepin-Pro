"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const sourceFile = process.argv[2];
let source = sourceFile === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(sourceFile), "utf8");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kafepin-v407-edevlet-total-"));
try {
  source = source.replace(/const DATA_DIR = [^;]+;/, `const DATA_DIR = ${JSON.stringify(path.join(tempRoot, "data"))};`);
  const serverStart = source.indexOf("try{ pollQueue(); }");
  if (serverStart < 0) throw new Error("Revenue service test boundary missing");
  source = source.slice(0, serverStart);
  source += `
(async()=>{
  saveConfig({price_bw:10,price_edevlet:10,payment_method:"CASH"});
  let tx=prepareService("edevlet",1,"CASH",false,"e-Devlet Oturumu",10);
  if(tx.total!==10||tx.meta.active_session!==true) throw new Error("service fee session expected 10");
  const reused=prepareService("edevlet",1,"CASH",false,"e-Devlet Oturumu",10);
  if(reused.id!==tx.id) throw new Error("active session duplicated");
  let s=state();
  s.initialized=true; s.lastSeenRecordId=101;
  s.jobs={"101":{record_id:101,pages:1,printer:"TEST",document:"Adli Sicil",time:new Date(Date.now()+1000).toISOString(),status:"pending",created_at:new Date().toISOString()}};
  saveState(s);
  readEvents=()=>[{record_id:101,pages:1,printer:"TEST",document:"Adli Sicil",time:s.jobs["101"].time}];
  pollQueue(); tx=transaction(tx.id);
  if(tx.total!==20) throw new Error("pending print recovery expected 20, got "+tx.total);
  pollQueue(); tx=transaction(tx.id);
  if(tx.total!==20) throw new Error("duplicate EventRecordID changed total: "+tx.total);
  readEvents=()=>[{record_id:101,pages:1,printer:"TEST",document:"Adli Sicil"},{record_id:102,pages:2,printer:"TEST",document:"İkametgâh"}];
  pollQueue(); tx=transaction(tx.id);
  if(tx.total!==40) throw new Error("two-page print expected 40, got "+tx.total);
  tx=removeOnePrintUnitFromTransaction(tx.id);
  if(tx.total!==30) throw new Error("remove one expected 30, got "+tx.total);
  cancelTransaction(tx.id);
  if(transaction(tx.id)) throw new Error("deleted session remains");
  console.log("EDEVLET_SESSION_TOTAL_PASS fee=10 first-print=20 duplicate=20 two-pages=40 remove-one=30 delete=no-sale");
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
`;
  const testService = path.join(tempRoot, "service-under-test.js");
  fs.writeFileSync(testService, source, "utf8");
  fs.writeFileSync(path.join(tempRoot, "yazici-pro-version.json"), JSON.stringify({ version: "test" }), "utf8");
  process.env.KAFEPIN_YAZICI_TEST_MODE = "1";
  require(testService);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
