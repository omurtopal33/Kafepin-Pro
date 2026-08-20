from pathlib import Path
import re, sys

p=Path(sys.argv[1])
s=p.read_text(encoding='utf-8-sig')
orig=s

def replace_between(text, start_marker, end_marker, replacement, label):
    a=text.find(start_marker)
    if a<0: raise SystemExit(f'{label}: start marker missing')
    b=text.find(end_marker,a)
    if b<0: raise SystemExit(f'{label}: end marker missing')
    return text[:a]+replacement+text[b:]

send_repl=r'''const TELEGRAM_PAYLOAD_DEDUP_MS = 45 * 1000;
const telegramRecentPayloads = new Map();

function telegramPayloadKey(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function sendTelegramMessage(text, cb) {
  if (!TELEGRAM_ENABLED) return cb && cb(null, { ok: false, disabled: true });

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return cb && cb(new Error("Telegram token/chat_id eksik"));
  }

  const escapedText = telegramEscape(text);
  const isLiveMonitor = escapedText.startsWith("📊 KAFEPİN CANLI DURUM");
  const payloadKey = isLiveMonitor ? "" : telegramPayloadKey(escapedText);
  const now = Date.now();

  // v3.1.51: ayni normal bildirimin iki ayri kod yolundan ayni anda
  // Telegram'a gitmesini engelle. Canli Durum bu kilide girmez; o mesaj
  // kendi message_id'si ile edit/delete+yeniden-gonder akisini kullanir.
  if (payloadKey) {
    const last = Number(telegramRecentPayloads.get(payloadKey)) || 0;
    if (now - last < TELEGRAM_PAYLOAD_DEDUP_MS) {
      return cb && cb(null, JSON.stringify({ ok:true, skipped:true, reason:"duplicate" }));
    }
    // Istek bitene kadar da kilitle; iki paralel cagri ayni anda HTTP acamaz.
    telegramRecentPayloads.set(payloadKey, now);
    if (telegramRecentPayloads.size > 1000) telegramRecentPayloads.clear();
  }

  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: escapedText
  });

  let callbackDone = false;
  const finish = (err, data) => {
    if (callbackDone) return;
    callbackDone = true;
    if (err && payloadKey) telegramRecentPayloads.delete(payloadKey);

    // Her yeni normal bildirimin ardindan tek Canli Durum mesaji en alta
    // tasinir. Canli Durumun kendisi tekrar tasima tetiklemez.
    if (!err && !isLiveMonitor) {
      try { moveLiveMonitorToBottomSoon(); } catch (_err) {}
    }
    if (cb) cb(err, data);
  };

  const req = https.request(
    {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    },
    (res2) => {
      let data = "";
      res2.on("data", (chunk) => (data += chunk));
      res2.on("end", () => {
        if (res2.statusCode >= 200 && res2.statusCode < 300) {
          return finish(null, data);
        }
        return finish(new Error(`Telegram HTTP ${res2.statusCode}: ${data}`));
      });
    }
  );

  req.setTimeout(12000, () => {
    req.destroy(new Error("Telegram isteği 12 saniyede zaman aşımına uğradı"));
  });
  req.on("error", (err) => finish(err));
  req.write(body);
  req.end();
}
'''
s=replace_between(s,'function sendTelegramMessage(text, cb) {','function editTelegramMessage(messageId, text, cb) {',send_repl,'sendTelegramMessage')

move_repl=r'''let liveMonitorMoveTimer = null;
let liveMonitorMoveInFlight = false;
let liveMonitorMovePending = false;

function moveLiveMonitorToBottomSoon() {
  if (!TELEGRAM_ENABLED) return;
  liveMonitorMovePending = true;

  if (liveMonitorMoveTimer) clearTimeout(liveMonitorMoveTimer);
  liveMonitorMoveTimer = setTimeout(runLiveMonitorMoveToBottom, 2200);
}

function runLiveMonitorMoveToBottom() {
  liveMonitorMoveTimer = null;
  if (!TELEGRAM_ENABLED) return;

  // v3.1.51: tek seferde yalniz bir delete/send dongusu calisabilir.
  if (liveMonitorMoveInFlight || liveMonitorBusy) {
    liveMonitorMoveTimer = setTimeout(runLiveMonitorMoveToBottom, 900);
    return;
  }

  liveMonitorMovePending = false;
  liveMonitorMoveInFlight = true;
  const finishMove = () => {
    liveMonitorMoveInFlight = false;
    if (liveMonitorMovePending) {
      if (liveMonitorMoveTimer) clearTimeout(liveMonitorMoveTimer);
      liveMonitorMoveTimer = setTimeout(runLiveMonitorMoveToBottom, 900);
    }
  };

  const oldMessageId = liveMessageId;
  if (!oldMessageId) {
    finishMove();
    sendLiveMonitor();
    return;
  }

  deleteTelegramMessage(oldMessageId, (deleteErr) => {
    if (deleteErr) {
      const detail = String(deleteErr && deleteErr.message ? deleteErr.message : deleteErr).toLowerCase();
      const missing = detail.includes("message to delete not found") || detail.includes("message_id_invalid");

      if (!missing) {
        // Eski davranis burada ID'yi sifirlayip ikinci Canli Durum mesaji
        // gonderiyordu. Artik eski ID korunur ve yalniz mevcut mesaj editlenir;
        // boylece Telegram'da iki Canli Durum birikmez.
        console.error("Canlı durum silinemedi; kopya oluşturulmayacak:", deleteErr);
        finishMove();
        sendLiveMonitor();
        return;
      }

      // Telegram eski ID'nin artik var olmadigini kesin soyluyorsa yeni tek
      // Canli Durum mesaji olusturmak guvenlidir.
      liveMessageId = 0;
      db.run(
        "UPDATE settings SET value='0' WHERE key='telegram_live_message_id'",
        () => {
          finishMove();
          sendLiveMonitor();
        }
      );
      return;
    }

    // Bildirim(ler) gonderildikten sonra eski Canli Durum silindi; yeni tek
    // Canli Durum mesaji en son mesaj olarak olusturulur.
    liveMessageId = 0;
    db.run(
      "UPDATE settings SET value='0' WHERE key='telegram_live_message_id'",
      () => {
        finishMove();
        sendLiveMonitor();
      }
    );
  });
}

'''
s=replace_between(s,'let liveMonitorMoveTimer = null;','let liveMonitorBusy = false;',move_repl,'live monitor move')

needle='let autoHealthRunning = false;\nlet autoHealthFinalizeBusySince = 0;'
repl='let autoHealthRunning = false;\nlet autoHealthTelegramSuppressCount = 0;\nlet autoHealthFinalizeBusySince = 0;'
if needle not in s: raise SystemExit('auto health globals marker missing')
s=s.replace(needle,repl,1)

old_block=r'''  const alertIssues = issues.filter((check) => check.alert !== false);
  const fingerprint = alertIssues.map((check) => check.code).sort().join("|");
  if (!alertIssues.length) {
    if (autoHealthAlertFingerprint) {
      addLiveLog("health", "✅ Otomatik sağlık kontrolü yeniden normal");
    }
    autoHealthAlertFingerprint = "";
  } else if (TELEGRAM_ENABLED && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    const shouldAlert = fingerprint !== autoHealthAlertFingerprint || now - autoHealthLastAlertAt >= AUTO_HEALTH_REPEAT_ALERT_MS;
    if (shouldAlert) {
      autoHealthAlertFingerprint = fingerprint;
      autoHealthLastAlertAt = now;
      const message = [
        "⚠️ KafePin Sağlık Kontrolü",
        ...alertIssues.slice(0, 8).map((check) => `• ${check.detail}`),
        `• Kontrol: ${new Date(now).toLocaleString("tr-TR")}`
      ].join("\n");
      addLiveLog("health", `⚠️ Otomatik sağlık kontrolü • ${alertIssues.map((x) => x.code).join(", ")}`);
      sendTelegramMessage(message, (err) => {
        if (err) logErr("automatic health telegram", err);
      });
    }
  }
'''
new_block=r'''  const alertIssues = issues.filter((check) => check.alert !== false);
  const fingerprint = alertIssues.map((check) => check.code).sort().join("|");
  const healthStateKey = "telegram_auto_health_alert_state";
  if (!alertIssues.length) {
    if (autoHealthAlertFingerprint) {
      addLiveLog("health", "✅ Otomatik sağlık kontrolü yeniden normal");
    }
    autoHealthAlertFingerprint = "";
    autoHealthLastAlertAt = 0;
    db.run("DELETE FROM settings WHERE key=?", [healthStateKey], () => {});
  } else if (TELEGRAM_ENABLED && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && autoHealthTelegramSuppressCount <= 0) {
    // v3.1.51: saglik alarmi fingerprint/tarih DB'de tutulur. Server yeniden
    // baslasa bile ayni sorun 6 saat icinde ikinci kez Telegram'a gitmez.
    db.get("SELECT value FROM settings WHERE key=?", [healthStateKey], (stateErr, stateRow) => {
      let persisted = null;
      try { persisted = stateRow && stateRow.value ? JSON.parse(stateRow.value) : null; } catch (_err) {}
      const persistedSame = persisted && persisted.fingerprint === fingerprint && now - Number(persisted.sentAt || 0) < AUTO_HEALTH_REPEAT_ALERT_MS;
      const ramSame = fingerprint === autoHealthAlertFingerprint && now - autoHealthLastAlertAt < AUTO_HEALTH_REPEAT_ALERT_MS;
      if (persistedSame || ramSame) return;

      autoHealthAlertFingerprint = fingerprint;
      autoHealthLastAlertAt = now;
      const reserved = JSON.stringify({ fingerprint, sentAt: now });
      db.run(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [healthStateKey, reserved],
        () => {
          const message = [
            "⚠️ KafePin Sağlık Kontrolü",
            ...alertIssues.slice(0, 8).map((check) => `• ${check.detail}`),
            `• Kontrol: ${new Date(now).toLocaleString("tr-TR")}`
          ].join("\n");
          addLiveLog("health", `⚠️ Otomatik sağlık kontrolü • ${alertIssues.map((x) => x.code).join(", ")}`);
          sendTelegramMessage(message, (err) => {
            if (!err) return;
            logErr("automatic health telegram", err);
            autoHealthAlertFingerprint = "";
            autoHealthLastAlertAt = 0;
            db.run("DELETE FROM settings WHERE key=? AND value=?", [healthStateKey, reserved], () => {});
          });
        }
      );
    });
  }
'''
if old_block not in s: raise SystemExit('auto health block exact marker missing')
s=s.replace(old_block,new_block,1)

needle='''  const sentKey = await getSettingValueP("last_eod_health_report_business_day");\n  if (sentKey === closedKey) return { skipped:true, reason:"already-sent", closedKey };\n  if (eodHealthReportInFlight.has(closedKey)) return { skipped:true, reason:"already-running", closedKey };\n\n  eodHealthReportInFlight.add(closedKey);'''
repl='''  const sentKey = await getSettingValueP("last_eod_health_report_business_day");\n  if (sentKey === closedKey) return { skipped:true, reason:"already-sent", closedKey };\n  const claimKey = "telegram_eod_health_report_claim";\n  const claimRaw = await getSettingValueP(claimKey);\n  let claim = null;\n  try { claim = claimRaw ? JSON.parse(claimRaw) : null; } catch (_err) {}\n  if (claim && claim.closedKey === closedKey && Date.now() - Number(claim.claimedAt || 0) < 15 * 60 * 1000) {\n    return { skipped:true, reason:"already-claimed", closedKey };\n  }\n  if (eodHealthReportInFlight.has(closedKey)) return { skipped:true, reason:"already-running", closedKey };\n\n  eodHealthReportInFlight.add(closedKey);\n  await setSettingValueP(claimKey, JSON.stringify({ closedKey, claimedAt:Date.now() }));'''
if needle not in s: raise SystemExit('eod claim marker missing')
s=s.replace(needle,repl,1)

def replace_once_in_function(text, func_start, func_end, needle, repl, label):
    a=text.find(func_start)
    if a<0: raise SystemExit(label+': function start missing')
    b=text.find(func_end,a)
    if b<0: raise SystemExit(label+': function end missing')
    region=text[a:b]
    if region.count(needle)!=1: raise SystemExit(f'{label}: expected 1 call, got {region.count(needle)}')
    region=region.replace(needle,repl,1)
    return text[:a]+region+text[b:]

s=replace_once_in_function(
    s,
    'app.get("/admin/reliability-health", async (req, res) => {',
    '// Güvenli self-test',
    '    await new Promise(resolve => runAutomaticHealthCheck(() => resolve()));',
    '    autoHealthTelegramSuppressCount += 1;\n    try {\n      await new Promise(resolve => runAutomaticHealthCheck(() => resolve()));\n    } finally {\n      autoHealthTelegramSuppressCount = Math.max(0, autoHealthTelegramSuppressCount - 1);\n    }',
    'reliability-health suppression'
)
s=replace_once_in_function(
    s,
    'async function runEndOfDayHealthReport(reason = "schedule") {',
    'async function runPreviousMonthTelegramSummary',
    '  await new Promise(resolve => runAutomaticHealthCheck(() => resolve()));',
    '  autoHealthTelegramSuppressCount += 1;\n  try {\n    await new Promise(resolve => runAutomaticHealthCheck(() => resolve()));\n  } finally {\n    autoHealthTelegramSuppressCount = Math.max(0, autoHealthTelegramSuppressCount - 1);\n  }',
    'eod-health suppression'
)

needle='''    sendTelegramMessage(message, async (err) => {\n      if (err) return resolve({ok:false,closedKey,error:String(err.message||err)});\n      try { await setSettingValueP("last_eod_health_report_business_day", closedKey); } catch (_err) {}\n      addLiveLog("eod_health", `🩺 Kapanan gün sağlık raporu Telegram'a gönderildi • ${closedKey}`);'''
repl='''    sendTelegramMessage(message, async (err) => {\n      if (err) {\n        try { await setSettingValueP(claimKey, ""); } catch (_err) {}\n        return resolve({ok:false,closedKey,error:String(err.message||err)});\n      }\n      try {\n        await setSettingValueP("last_eod_health_report_business_day", closedKey);\n        await setSettingValueP(claimKey, "");\n      } catch (_err) {}\n      addLiveLog("eod_health", `🩺 Kapanan gün sağlık raporu Telegram'a gönderildi • ${closedKey}`);'''
if needle not in s: raise SystemExit('eod send marker missing')
s=s.replace(needle,repl,1)

marker='// v3.1.51 TELEGRAM_SINGLE_SEND_AND_LIVE_BOTTOM\n'
if marker not in s:
    insert_at=s.find('const GUN_SONU_RAPOR_SAAT = 20;')
    if insert_at<0: raise SystemExit('version marker insertion missing')
    s=s[:insert_at]+marker+s[insert_at:]

p.write_text(s,encoding='utf-8')
print('PATCH_OK', len(orig), '->', len(s))
