"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const sourceFile = path.resolve(process.argv[2] || "C:\\KafePinPro\\YaziciPRO\\KafePin_YaziciGelir_Service.js");
if (!fs.existsSync(sourceFile)) throw new Error(`Revenue service missing: ${sourceFile}`);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kafepin-edevlet-total-"));
try {
  let source = fs.readFileSync(sourceFile, "utf8");
  source = source.replace(
    /const DATA_DIR = [^;]+;/,
    `const DATA_DIR = ${JSON.stringify(path.join(tempRoot, "data"))};`
  );
  const serverStart = source.indexOf("try{ pollQueue(); }");
  if (serverStart < 0) throw new Error("Revenue service HTTP startup boundary missing");
  source = source.slice(0, serverStart);
  source += `
(async()=>{
  saveConfig({price_bw:10,price_edevlet:10,payment_method:"CASH"});
  let tx=prepareService("edevlet",1,"CASH",false,"e-Devlet Oturumu",10);
  if(tx.total!==10) throw new Error("service total expected 10, got "+tx.total);
  let s=state();
  s.jobs["101"]={record_id:101,pages:1,status:"pending"};
  s.jobs["102"]={record_id:102,pages:1,status:"pending"};
  saveState(s);
  tx=appendPrintJobsToTransaction(tx.id,[{record_id:101,pages:1}],"bw","CASH");
  if(tx.total!==20) throw new Error("first print total expected 20, got "+tx.total);
  tx=appendPrintJobsToTransaction(tx.id,[{record_id:102,pages:1}],"bw","CASH");
  if(tx.total!==30) throw new Error("second print total expected 30, got "+tx.total);
  tx=appendPrintJobsToTransaction(tx.id,[{record_id:101,pages:1}],"bw","CASH");
  if(tx.total!==30) throw new Error("duplicate print changed total: "+tx.total);
  tx=removeOnePrintUnitFromTransaction(tx.id);
  if(tx.total!==20) throw new Error("remove-one total expected 20, got "+tx.total);
  cancelTransaction(tx.id);
  if(transaction(tx.id)) throw new Error("cancelled session still exists");
  console.log("EDEVLET_SESSION_TOTAL_PASS 10+10=20 20+10=30 duplicate=30 remove-one=20 delete=no-sale");
  process.exit(0);
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
`;
  const testService = path.join(tempRoot, "service-under-test.js");
  fs.writeFileSync(testService, source, "utf8");
  fs.writeFileSync(path.join(tempRoot, "yazici-pro-version.json"), JSON.stringify({ version: "test" }), "utf8");
  const result = cp.spawnSync(process.execPath, [testService], {
    encoding: "utf8",
    env: { ...process.env, KAFEPIN_YAZICI_TEST_MODE: "1" },
    timeout: 15000
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) throw new Error(`Session-total test failed: status=${result.status} signal=${result.signal || "none"} error=${result.error ? result.error.message : "none"}`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
