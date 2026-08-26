from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_failsafe_patch():
    path = Path(__file__).resolve().parents[1] / "failsafe-update-lock" / "patch_server.py"
    spec = importlib.util.spec_from_file_location("kafepin_failsafe_patch", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"FAILSAFE patch yüklenemedi: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.patch_server


def _replace(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


def patch_server_source(source: bytes) -> bytes:
    text = source.decode("utf-8-sig")
    text = _load_failsafe_patch()(text)
    text = _replace(
        text,
        "function syncEveryCafeClosedSessions(cb = () => {}) {",
        r'''function recoverRecentEveryCafeMissingImports(config, cb = () => {}) {
  const sinceMs = Math.max(0, Date.now() - 48 * 60 * 60 * 1000);
  readEveryCafePaymentAuditSnapshotP(sinceMs).then((snapshot) => {
    const source = (snapshot && snapshot.sessions || [])
      .filter((session) => !isEveryCafeFreeSession(session))
      .filter((session) => Number(session.EndDate || 0) * 1000 >= sinceMs)
      .filter((session) => Boolean(String(session.SessionID || '').trim()))
      .slice(0, 100);
    return kafePinDbAllP("SELECT session_id FROM everycafe_imports").then((rows) => {
      const importedIds = new Set((rows || []).map((row) => String(row.session_id || '').trim()));
      const candidates = source.filter((session) => !importedIds.has(String(session.SessionID || '').trim())).slice(0, 50);
      let checked = 0, imported = 0, skipped = 0, failed = 0, index = 0;
      const next = () => {
        if (index >= candidates.length) return cb(null, { checked, imported, skipped, failed });
        const session = candidates[index++]; checked += 1;
        importEveryCafeSession(session, (err, result) => {
          if (err) { failed += 1; logErr('EveryCafe eksik kapanış otomatik kurtarma', err); }
          else if (result && result.imported) imported += 1;
          else skipped += 1;
          next();
        });
      };
      next();
    });
  }).catch(cb);
}

function syncEveryCafeClosedSessions(cb = () => {}) {''',
        "automatic EveryCafe recovery",
    )
    text = _replace(
        text,
        "            reconcileEveryCafeClosedRewardApprovals((rewardErr, rewardResult) => {\n              if (rewardErr) return finish(rewardErr);",
        "            recoverRecentEveryCafeMissingImports(config, (recoveryErr, recoveryResult) => {\n              if (recoveryErr) return finish(recoveryErr);\n              reconcileEveryCafeClosedRewardApprovals((rewardErr, rewardResult) => {\n              if (rewardErr) return finish(rewardErr);",
        "automatic recovery hook",
    )
    text = _replace(
        text,
        "                autoApprovedRewards: Number(rewardResult && rewardResult.approved) || 0\n              });\n            });",
        "                autoApprovedRewards: Number(rewardResult && rewardResult.approved) || 0,\n                autoRecoveryChecked: Number(recoveryResult && recoveryResult.checked) || 0,\n                autoRecoveryImported: Number(recoveryResult && recoveryResult.imported) || 0,\n                autoRecoveryFailed: Number(recoveryResult && recoveryResult.failed) || 0\n              });\n              });\n            });",
        "automatic recovery result",
    )
    text = _replace(
        text,
        '          everyCafePaymentId: 0,\n          text: directSale',
        '          everyCafePaymentId: 0,\n          sourceSessionId: sessionId,\n          sourceMasa: sourceMasa || 0,\n          sourceEnd: Number(session.EndDate) * 1000,\n          text: directSale',
        "missing session identity",
    )
    marker = '// v3.1.35: Entegrasyon denetimi günlük kaynak toplamı + OrderID ürün kontrolü yapar.'
    endpoint = r'''// v4.0.3 unified candidate: safe idempotent missing-close retry.
app.post("/admin/everycafe/retry-missing", async (req, res) => {
  setNoStore(res);
  const sessionId = String((req.body || {}).sessionId || "").trim();
  if (!sessionId) return res.json({ ok: false, error: "EveryCafe SessionID eksik" });
  try {
    const config = await getEveryCafeConfigP();
    if (!config.enabled || !config.startAt) return res.json({ ok: false, error: "EveryCafe canlı aktarımı aktif değil" });
    const snapshot = await readEveryCafePaymentAuditSnapshotP(Math.max(0, Date.now() - 7 * 24 * 60 * 60 * 1000));
    const session = (snapshot && snapshot.sessions || []).find((row) => String(row.SessionID || "").trim() === sessionId);
    if (!session) return res.json({ ok: false, error: `EveryCafe kaynak SessionID bulunamadı: ${sessionId}` });
    const result = await new Promise((resolve, reject) => importEveryCafeSession(session, (err, value) => err ? reject(err) : resolve(value || {})));
    addEveryCafeIntegrationLog({ category:"RECOVERY", masa:everyCafeTableNumber(session.ClientName)||0, sessionId,
      event:"Eksik kapanış manuel yeniden işlendi", sourceDetail:`EveryCafe SessionID ${sessionId} salt-okunur yeniden okundu`,
      action:"KafePin idempotent kapanış aktarımı", result:result.imported?"Başarılı":`Atlandı • ${String(result.reason||"zaten aktarılmış")}` });
    res.json({ ok:true, sessionId, ...result });
  } catch (err) { logErr("EveryCafe eksik kapanış manuel yeniden işleme", err); res.json({ ok:false, error:String(err && (err.message||err) || err) }); }
});

'''
    text = _replace(text, marker, endpoint + marker, "manual retry endpoint")
    text = _patch_daily_rollover(text)
    return ("\ufeff" + text).encode("utf-8")


def _patch_daily_rollover(text: str) -> str:
    """Persist a successful end-of-day acknowledgement outside the DB too.

    The file is only a recovery marker; all report and import semantics remain
    in the existing SQLite code.  SQLite writes get a small bounded retry so a
    transient reader lock cannot make the next startup ask for the same report.
    """
    text = _replace(
        text,
        'const GUN_SONU_RAPOR_DAKIKA = 0;',
        '''const GUN_SONU_RAPOR_DAKIKA = 0;
const DAILY_ROLLOVER_ACK_FILE = path.join(__dirname, "config", "daily-rollover-ack.json");

function isSqliteBusyError(err) {
  return Boolean(err && /SQLITE_BUSY|database is locked/i.test(String(err.message || err)));
}

function withSqliteBusyRetry(label, operation, cb, attempt = 0) {
  operation((err) => {
    if (isSqliteBusyError(err) && attempt < 3) {
      const delayMs = 200 * (attempt + 1);
      addLiveLog("database", `⏳ ${label} SQLITE_BUSY; yeniden deneniyor (${attempt + 1}/3)`);
      return setTimeout(() => withSqliteBusyRetry(label, operation, cb, attempt + 1), delayMs);
    }
    if (err) logErr(label, err);
    if (cb) cb(err);
  });
}

function readDurableRolloverAck() {
  try {
    const value = JSON.parse(fs.readFileSync(DAILY_ROLLOVER_ACK_FILE, "utf8").replace(/^\\uFEFF/, ""));
    return value && value.status === "success" ? value : null;
  } catch (_err) { return null; }
}

function writeDurableRolloverAck(status) {
  if (!status || status.status !== "success") return;
  try {
    fs.mkdirSync(path.dirname(DAILY_ROLLOVER_ACK_FILE), { recursive: true });
    const tmp = DAILY_ROLLOVER_ACK_FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
    fs.renameSync(tmp, DAILY_ROLLOVER_ACK_FILE);
  } catch (err) { logErr("writeDurableRolloverAck", err); }
}''',
        "daily rollover durable ack helper",
    )

    start = text.index("function saveDailyReport(reportTs, stats, cb) {")
    end = text.index("\n}\n\n// Eski hesapla", start) + 2
    block = text[start:end]
    block = block.replace("  db.run(\n", '  withSqliteBusyRetry("saveDailyReport", (done) => db.run(\n', 1)
    block = block.replace("      if (cb) cb(err);", "      if (done) done(err);", 1)
    block = block.replace("\n  );\n\n}", "\n  ), cb);\n\n}", 1)
    text = text[:start] + block + text[end:]

    start = text.index("function saveRolloverStatus(status, cb) {")
    end = text.index("\n}\n\nfunction recordClosedRolloverResult", start) + 2
    replacement = '''function saveRolloverStatus(status, cb) {
  withSqliteBusyRetry("saveRolloverStatus", (done) => db.run(
    "INSERT INTO settings(key,value) VALUES('last_daily_rollover',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [JSON.stringify(status)],
    (err) => {
      if (!err && status && status.status === "success") writeDurableRolloverAck(status);
      done(err);
    }
  ), cb);
}'''
    text = text[:start] + replacement + text[end:]

    old = '  const lastTs = Number(last && last.rolloverTs) || 0;'
    new = '''  const durableAck = readDurableRolloverAck();
  const dbLastTs = Number(last && last.rolloverTs) || 0;
  const durableTs = Number(durableAck && durableAck.rolloverTs) || 0;
  if (durableAck && durableTs > dbLastTs) last = durableAck;
  const lastTs = Number(last && last.rolloverTs) || 0;'''
    text = _replace(text, old, new, "durable rollover acknowledgement")
    return text


def patch_admin_source(source: bytes) -> bytes:
    text = source.decode("utf-8-sig")
    old = '${issues.slice(0,5).map(issue => `<div class="small" style="color:#ffd5da;margin:5px 0;">• ${escapeHtml(issue.text)}${Number(issue.everyCafePaymentId) > 0 ? ` <button class="redBtn btnSm" style="margin-left:7px;" onclick="voidEveryCafeImport(${Number(issue.everyCafePaymentId)})">EVERYCAFE KAYDINI SİL</button>` : ""}</div>`).join("")}'
    new = '${issues.slice(0,5).map(issue => `<div class="small" style="color:#ffd5da;margin:5px 0;">• ${escapeHtml(issue.text)}${issue.sourceSessionId && String(issue.code||"").includes("MISSING_IMPORT") ? ` <button class="orangeBtn btnSm" style="margin-left:7px;" onclick=\'retryEveryCafeMissing(${JSON.stringify(String(issue.sourceSessionId))})\'>MANUEL AKTAR / YENİDEN İŞLE</button>` : Number(issue.everyCafePaymentId) > 0 ? ` <button class="redBtn btnSm" style="margin-left:7px;" onclick="voidEveryCafeImport(${Number(issue.everyCafePaymentId)})">EVERYCAFE KAYDINI SİL</button>` : ""}</div>`).join("")}'
    text = _replace(text, old, new, "manual retry button")
    marker = "async function voidEveryCafeImport(paymentId){"
    fn = r'''async function retryEveryCafeMissing(sessionId){
  if(!sessionId) return;
  if(!confirm(`EveryCafe SessionID ${sessionId} salt-okunur yeniden okunup KafePin'e aktarılacak. Aynı kayıt daha önce aktarıldıysa ikinci gelir yazılmayacak. Devam edilsin mi?`)) return;
  const d=await fetchJSON("/admin/everycafe/retry-missing",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId})});
  if(!d||!d.ok){alert(d?.error||"Eksik kapanış yeniden işlenemedi");return;}
  alert(d.imported?"✅ Kapanış KafePin'e aktarıldı.":`ℹ️ Yeni gelir yazılmadı: ${d.reason||"kayıt zaten işlenmiş"}`);
  await refreshFastNow(true); await refreshMediumNow(true); await refreshSlowNow();
}

'''
    text = _replace(text, marker, fn + marker, "manual retry function")
    return ("\ufeff" + text).encode("utf-8")
