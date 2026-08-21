require("dotenv").config();
const {
  MASA_TOKENS,
  MASA_IPS,
  VIP_MASALAR
} = require("./config/masalar");
const createFeeUtils = require("./utils/fee");
const createDateUtils =
  require("./utils/date");
const {
  logErr,
  logInfo
} = require("./utils/logger");
const createSpinService =
  require("./services/spinService");
const express = require("express");
// Canlı sistem günlüğü
const liveLogs = [];
const MAX_LIVE_LOG = 100;

function addLiveLog(type, text) {
  liveLogs.unshift({
    time: Date.now(),
    type,
    text
  });

  if (liveLogs.length > MAX_LIVE_LOG) {
    liveLogs.length = MAX_LIVE_LOG;
  }
}
const sqlite3 = require("sqlite3").verbose();
const cron = require("node-cron");
const path = require("path");
const https = require("https");
const http = require("http");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const dgram = require("dgram");
const { spawn, spawnSync } = require("child_process");
// KafePin Pro otomatik guncelleme merkezi. Depoda sadece program
// paketleri bulunur; kafe verileri, tokenlar ve yedekler asla yuklenmez.
const PRO_VERSION_FILE = path.join(__dirname, "kafepin-pro-version.json");
const PRO_UPDATE_MANIFEST_URL =
  "https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/latest.json";
let proUpdateCache = { checkedAt: 0, data: null, error: "", errorAt: 0 };
let proUpdateCheckInFlight = false;
const proUpdateCheckWaiters = [];
const PRO_UPDATE_CACHE_MS = 5 * 60 * 1000;
const PRO_UPDATE_FORCE_MIN_INTERVAL_MS = 15 * 1000;
const PRO_UPDATE_ERROR_CACHE_MS = 2 * 60 * 1000;
const PRO_UPDATE_STALE_MAX_MS = 60 * 60 * 1000;

// Güncelleme düğmesi için tarayıcı belleğine güvenilmez. KafePin Pro.exe veya
// WebView yeniden açılsa bile aynı kurulumun ikinci kez başlatılamaması için
// kilit sunucu tarafında, Windows ProgramData altında kalıcı tutulur.
const PRO_SERVER_STARTED_AT = Date.now();
const PRO_UPDATE_STATE_FILE = path.join(__dirname, "logs", "kafepin-pro-update-state.json");
const PRO_UPDATE_INSTALL_LOCK_FILE = process.platform === "win32"
  ? path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro", "update-install-lock.json")
  : path.join(__dirname, "logs", "kafepin-pro-update-install-lock.json");

function readProUpdateInstallLock() {
  try {
    const data = JSON.parse(fs.readFileSync(PRO_UPDATE_INSTALL_LOCK_FILE, "utf8").replace(/^\uFEFF/, ""));
    if (!data || data.locked !== true || !/^\d+(\.\d+){1,3}$/.test(String(data.targetVersion || ""))) return null;
    return data;
  } catch (_err) {
    return null;
  }
}

function writeProUpdateInstallLock(targetVersion) {
  const target = String(targetVersion || "").trim();
  if (!/^\d+(\.\d+){1,3}$/.test(target)) throw new Error("Guncelleme kilidi icin hedef surum gecersiz");
  fs.mkdirSync(path.dirname(PRO_UPDATE_INSTALL_LOCK_FILE), { recursive: true });
  const data = {
    locked: true,
    targetVersion: target,
    startedAt: Date.now(),
    sourceServerStartedAt: PRO_SERVER_STARTED_AT
  };
  fs.writeFileSync(PRO_UPDATE_INSTALL_LOCK_FILE, JSON.stringify(data, null, 2), "utf8");
  return data;
}

function clearProUpdateInstallLock(expectedVersion = "") {
  try {
    if (expectedVersion) {
      const current = readProUpdateInstallLock();
      if (current && String(current.targetVersion || "") !== String(expectedVersion)) return false;
    }
    fs.unlinkSync(PRO_UPDATE_INSTALL_LOCK_FILE);
    return true;
  } catch (_err) {
    return false;
  }
}

function getProUpdateInstallSnapshot() {
  const lock = readProUpdateInstallLock();
  if (!lock) return null;
  const currentVersion = getProVersion();
  const restartedAfterLock = Number(lock.sourceServerStartedAt || 0) > 0 && PRO_SERVER_STARTED_AT > Number(lock.sourceServerStartedAt || 0);
  const stableAfterRestart = Date.now() - PRO_SERVER_STARTED_AT >= 10000;
  const targetInstalled = compareProVersions(currentVersion, lock.targetVersion) >= 0;

  // Eski server kapandı fakat hedef sürüm diske yazılamadan yeni server açıldıysa
  // önceki kurulum artık devam edemez. Kilidi güvenle kaldır ve gerçek güncellemeyi
  // yeniden kullanılabilir bırak. Bu durum normal 2-3 pencere açılışından farklıdır:
  // pencere restartında Node başlangıç zamanı değişmez.
  if (restartedAfterLock && !targetInstalled) {
    clearProUpdateInstallLock(lock.targetVersion);
    try {
      writeProUpdateState("error", `Guncelleme yarida kesildi; hedef surum kurulmadan server yeniden basladi: v${lock.targetVersion}`, {
        version: lock.targetVersion,
        running: false,
        interrupted: true
      });
    } catch (_err) {}
    return null;
  }

  // Kilit yalnız HEDEF sürüm diskteyken, kilidi koyan eski Node süreci gerçekten
  // değişmişken ve yeni server en az 10 sn kararlı kaldığında tamamlanır.
  // Böylece aradaki 2-3 masaüstü/server açılışında düğme asla aktifleşmez.
  if (targetInstalled && restartedAfterLock && stableAfterRestart) {
    clearProUpdateInstallLock(lock.targetVersion);
    try {
      writeProUpdateState("success", `Guncelleme tamamlandi ve yeni server dogrulandi: v${lock.targetVersion}`, {
        version: lock.targetVersion,
        running: false,
        verifiedAfterRestart: true
      });
    } catch (_err) {}
    return null;
  }

  return {
    ...lock,
    currentVersion,
    restartedAfterLock,
    stableAfterRestart,
    targetInstalled
  };
}

// Guncelleyici, sunucu kapaliyken tamamlanan kurulumu bu kucuk sonuc dosyasina
// yazar. Yeni sunucu acildiginda kaydi Canli Sistem Gunlugu'ne bir kez aktarir.
function importProUpdateResult() {
  const resultFile = path.join(__dirname, "logs", "kafepin-pro-update-result.json");
  try {
    const raw = fs.readFileSync(resultFile, "utf8").replace(/^\uFEFF/, "");
    const result = JSON.parse(raw);
    if (result && result.ok && result.version) {
      addLiveLog("pro_update", `⬆️ KafePin Pro v${result.version} guncellemesi basariyla kuruldu`);
    } else if (result && result.error) {
      addLiveLog("pro_update", `⚠️ KafePin Pro guncellemesi tamamlanamadi: ${String(result.error).slice(0, 180)}`);
    }
    fs.unlinkSync(resultFile);
  } catch (_err) {}
}
importProUpdateResult();

function getProVersion() {
  try {
    const raw = fs.readFileSync(PRO_VERSION_FILE, "utf8").replace(/^\uFEFF/, "");
    const value = JSON.parse(raw);
    return String(value.version || "1.0.0");
  } catch (_err) {
    return "1.0.0";
  }
}

function compareProVersions(a, b) {
  const aa = String(a || "0").split(".").map(x => Number(x) || 0);
  const bb = String(b || "0").split(".").map(x => Number(x) || 0);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) > (bb[i] || 0) ? 1 : -1;
  }
  return 0;
}


function fetchManifestUrl(url, callback) {
  const request = https.get(url, {
    headers: {
      "User-Agent": "KafePin-Pro-Updater",
      "Accept": "application/json",
      "Cache-Control": "no-cache"
    }
  }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      return fetchManifestUrl(response.headers.location, callback);
    }
    if (response.statusCode !== 200) {
      response.resume();
      const err = new Error(`Guncelleme sunucusu HTTP ${response.statusCode}`);
      err.statusCode = Number(response.statusCode) || 0;
      return callback(err);
    }
    let body = "";
    response.on("data", chunk => { body += chunk; });
    response.on("end", () => callback(null, body));
  });
  request.setTimeout(10000, () => request.destroy(new Error("Guncelleme kontrolu zaman asimina ugradi")));
  request.on("error", callback);
}

function fetchProUpdateManifest(callback) {
  // v3.1.18: Her kontrol icin benzersiz cache-buster uretilmez. RAW/CDN adreslerine
  // tekil ve sirali istek atilir; 429/5xx alinirsa sonraki kaynak denenir.
  // Ayni anda birden cok panel kontrolu checkProUpdate icinde tek istekte birlestirilir.
  const urls = [
    PRO_UPDATE_MANIFEST_URL,
    "https://cdn.jsdelivr.net/gh/omurtopal33/Kafepin-Pro@main/latest.json"
  ];
  let lastError = null;
  const tryNext = index => {
    if (index >= urls.length) return callback(lastError || new Error("Guncelleme merkezi kullanilamiyor"));
    const requestUrl = urls[index];
    fetchManifestUrl(requestUrl, (err, body) => {
      if (!err) return callback(null, body, requestUrl);
      lastError = err;
      tryNext(index + 1);
    });
  };
  tryNext(0);
}

function finishProUpdateCheck(err, data) {
  proUpdateCheckInFlight = false;
  const waiters = proUpdateCheckWaiters.splice(0, proUpdateCheckWaiters.length);
  for (const waiter of waiters) {
    try { waiter(err || null, data || null); } catch (_err) {}
  }
}

function checkProUpdate(force, callback) {
  const now = Date.now();
  const cacheAge = proUpdateCache.checkedAt ? now - proUpdateCache.checkedAt : Number.POSITIVE_INFINITY;
  const errorAge = proUpdateCache.errorAt ? now - proUpdateCache.errorAt : Number.POSITIVE_INFINITY;

  // Arka plan kontrolleri 5 dakika boyunca ayni dogrulanmis sonucu kullanir.
  if (!force && proUpdateCache.data && cacheAge < PRO_UPDATE_CACHE_MS) {
    return callback(null, { ...proUpdateCache.data, cached: true });
  }

  // Manuel yenileme de 15 saniyeden sik gercek ag istegi uretemez.
  if (force && proUpdateCache.data && cacheAge < PRO_UPDATE_FORCE_MIN_INTERVAL_MS) {
    return callback(null, { ...proUpdateCache.data, cached: true });
  }

  // Son kontrol hata verdiyse 2 dakika boyunca GitHub/CDN tekrar tekrar vurulmaz.
  if (proUpdateCache.error && errorAge < PRO_UPDATE_ERROR_CACHE_MS) {
    if (proUpdateCache.data && cacheAge < PRO_UPDATE_STALE_MAX_MS) {
      return callback(null, {
        ...proUpdateCache.data,
        cached: true,
        stale: true,
        warning: `Son ag kontrolu basarisiz: ${proUpdateCache.error}`
      });
    }
    return callback(new Error(proUpdateCache.error));
  }

  // Ayni anda acilis + gorunurluk + manuel kontrol gelirse tek HTTPS isteginde birlestir.
  proUpdateCheckWaiters.push(callback);
  if (proUpdateCheckInFlight) return;
  proUpdateCheckInFlight = true;

  fetchProUpdateManifest((err, body, manifestUrl) => {
    const completedAt = Date.now();
    if (err) {
      proUpdateCache.error = String(err.message || err);
      proUpdateCache.errorAt = completedAt;
      if (proUpdateCache.data && completedAt - proUpdateCache.checkedAt < PRO_UPDATE_STALE_MAX_MS) {
        return finishProUpdateCheck(null, {
          ...proUpdateCache.data,
          cached: true,
          stale: true,
          warning: `Son ag kontrolu basarisiz: ${proUpdateCache.error}`
        });
      }
      return finishProUpdateCheck(err);
    }

    try {
      const remote = JSON.parse(body);
      if (!remote || !/^\d+(\.\d+){1,3}$/.test(String(remote.version || "")) || !/^https:\/\//i.test(String(remote.downloadUrl || ""))) {
        throw new Error("Guncelleme manifest dosyasi gecersiz");
      }
      const current = getProVersion();
      proUpdateCache.checkedAt = completedAt;
      proUpdateCache.error = "";
      proUpdateCache.errorAt = 0;
      proUpdateCache.data = {
        currentVersion: current,
        latestVersion: String(remote.version),
        available: compareProVersions(remote.version, current) > 0,
        notes: String(remote.notes || "Yeni surum hazir."),
        publishedAt: remote.publishedAt || null,
        downloadUrl: String(remote.downloadUrl),
        sha256: /^[a-f0-9]{64}$/i.test(String(remote.sha256 || "")) ? String(remote.sha256) : "",
        manifestUrl: String(manifestUrl || ""),
        checkedAt: completedAt
      };
      return finishProUpdateCheck(null, proUpdateCache.data);
    } catch (parseErr) {
      proUpdateCache.error = String(parseErr.message || parseErr);
      proUpdateCache.errorAt = completedAt;
      if (proUpdateCache.data && completedAt - proUpdateCache.checkedAt < PRO_UPDATE_STALE_MAX_MS) {
        return finishProUpdateCheck(null, {
          ...proUpdateCache.data,
          cached: true,
          stale: true,
          warning: `Son ag kontrolu basarisiz: ${proUpdateCache.error}`
        });
      }
      return finishProUpdateCheck(parseErr);
    }
  });
}
let liveMessageId = 0;
const masaPingStats = {};
const latestRewardMap = {};
const OFFLINE_MS = 8 * 60 * 1000; // 8 dk
const PING_INTERVAL_MS = 10000; // client ping 10 sn varsayım
const OFFLINE_GRACE_MULTIPLIER = 6; // 6 ping kaçırmayı tolere et
const AUTO_RESET_MS = 12 * 60 * 1000;
const CLEANUP_MS = 20 * 60 * 1000; // 20 dk
const offlineCount = {};
const lastOfflineState = {};
const BOS_ODULLER = [
  "şansına küs",
  "bir dahaki sefere",
  "tekrar dene :)"
];

const lastStartSent = new Map();
const app = express();
const port = 3000;

app.use(express.json());

function isLocalhost(req) {
  const ip = (req.ip || "").replace("::ffff:", "");
  return ip === "127.0.0.1" || ip === "::1";
}

function setNoStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}
function isActuallyOffline(masa, lastSeen, now) {
  if (!lastSeen) return true;

  const diff = now - lastSeen;

  const dynamicPing =
    masaPingStats[masa]?.avg || PING_INTERVAL_MS;

  const threshold = Math.max(
    OFFLINE_MS,
    dynamicPing * OFFLINE_GRACE_MULTIPLIER
  );

  return diff > threshold;
}

app.use((req, res, next) => {
  const p = req.path || "";

  const isProtected =
    p.startsWith("/admin") ||
    p.startsWith("/monitor") ||
    p === "/admin.html" ||
    p === "/monitor.html" ||
    p === "/everycafe-sync.html" ||
    p === "/everycafe-history.html" ||
    p === "/everycafe-integration.html" ||
    p === "/everycafe-reconcile.html";

  if (isProtected && !isLocalhost(req)) {
    return res.status(403).send("Forbidden");
  }
  next();
});

app.use(express.static("public", {
  setHeaders(res, filePath) {
    const ext = path.extname(filePath || "").toLowerCase();
    if (ext === ".html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
    if (ext === ".css") res.setHeader("Content-Type", "text/css; charset=utf-8");
    if (ext === ".js") res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    if (ext === ".json") res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const db = new sqlite3.Database("./database.db");
const KAFEPIN_BACKUP_ROOT = process.env.KAFEPIN_BACKUP_ROOT || "D:\\KAFEPIN_YEDEK";
const FULL_BACKUP_DIR = path.join(KAFEPIN_BACKUP_ROOT, "FULL", "ZIP");
const DB_BACKUP_DIR = path.join(KAFEPIN_BACKUP_ROOT, "DB");
// Eski sürümlerde bazı FULL ZIP'ler doğrudan D:\KAFEPIN_YEDEK altında kalmış olabilir.
// Yeni yedekler FULL\ZIP'e yazılır; listeleme ve geri yükleme iki konumu da tarar.
const FULL_BACKUP_SEARCH_DIRS = [FULL_BACKUP_DIR, KAFEPIN_BACKUP_ROOT];
const EVERYCAFE_DB_PATH = process.env.EVERYCAFE_DB_PATH || "C:\\Program Files (x86)\\EveryCafeManager\\ecmdata.ecm";
// Aktif/ücretsiz EveryCafe oturumları monitöre gecikmeden düşsün. Bağlantı
// salt-okunur olduğu için kısa aralık, kasa ve kapanış kayıtlarını değiştirmez.
const EVERYCAFE_SYNC_MS = 5 * 1000;
// v3.1.34: Canlı aktarım artık sabit 100/500 kayıt penceresine bağlı değildir.
// Kaynak sayfalı okunur; son ilerleme kalıcı tutulur. 24 saatlik güvenli geri
// tarama, EveryCafe'nin kapanış sonrası çok kısa süre içinde güncellediği kaydı
// (örn. Ücretsiz Kapat) yeniden görmemizi sağlar. Çift kayıt koruması source ID'dedir.
const EVERYCAFE_LIVE_PAGE_SIZE = 200;
const EVERYCAFE_LIVE_RECHECK_SECONDS = 24 * 60 * 60;
// v3.0.16: katalog artık otomatik zamanlayıcıyla değişmez. Kullanıcı
// EveryCafe Senkron ekranındaki "Şimdi Senkronla" düğmesine bastığında
// ürün/kategori/fiyat tek yönlü ve katı biçimde aynalanır.
const EVERYCAFE_HEALTH_WARNING_MS = 3 * 60 * 1000;

// v3.1.46: Çark sayfası gerçekten açılmış bir EveryCafe müşterisinin 45 dakikası
// dolduğunda, EveryCafe Client'ın kendi Messenger UDP kanalı üzerinden yalnız
// ilgili masaya tek bildirim gönderilir. EveryCafe DB burada da SADECE okunur.
const EVERYCAFE_SPIN_READY_MESSAGE = "🎁 Çark hakkınız hazır! Çarkınızı çevirebilirsiniz.";
let everyCafeSpinReadyNotifyRunning = false;

// v3.0.24 kalıcı EveryCafe -> KafePin entegrasyon günlüğü. Salt izleme/teşhis.
db.run(`CREATE TABLE IF NOT EXISTS everycafe_integration_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, category TEXT DEFAULT 'SYSTEM', level TEXT DEFAULT 'INFO',
  masa INTEGER DEFAULT 0, session_id TEXT DEFAULT '', event TEXT DEFAULT '', source_detail TEXT DEFAULT '',
  kafepin_action TEXT DEFAULT '', result TEXT DEFAULT '', details_json TEXT DEFAULT ''
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_everycafe_integration_time ON everycafe_integration_logs(time DESC)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_everycafe_integration_masa ON everycafe_integration_logs(masa,time DESC)`);
const everyCafeIntegrationRecent = new Map();
let everyCafeIntegrationInsertCount = 0;
function everyCafeIntegrationTimeText(ts) {
  try { return new Date(Number(ts)||Date.now()).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul',hour12:false}); } catch(_e){ return String(ts||''); }
}
function addEveryCafeIntegrationLog(entry={}) {
  const now=Date.now();
  const key=String(entry.dedupeKey||''); const dedupeMs=Math.max(0,Number(entry.dedupeMs)||0);
  if(key&&dedupeMs){ const prev=Number(everyCafeIntegrationRecent.get(key))||0; if(prev&&now-prev<dedupeMs)return false; everyCafeIntegrationRecent.set(key,now); }
  let details=''; try{details=JSON.stringify(entry.details||{}).slice(0,12000)}catch(_e){}
  db.run(`INSERT INTO everycafe_integration_logs(time,category,level,masa,session_id,event,source_detail,kafepin_action,result,details_json) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [now,String(entry.category||'SYSTEM').toUpperCase().slice(0,32),String(entry.level||'INFO').toUpperCase().slice(0,12),Math.max(0,Number(entry.masa)||0),String(entry.sessionId||'').slice(0,120),String(entry.event||'').slice(0,500),String(entry.sourceDetail||'').slice(0,1000),String(entry.action||'').slice(0,1000),String(entry.result||'').slice(0,1000),details],
    err=>{if(err)logErr('everycafe integration log',err)});
  everyCafeIntegrationInsertCount++;
  if(everyCafeIntegrationInsertCount%100===0)db.run(`DELETE FROM everycafe_integration_logs WHERE id NOT IN (SELECT id FROM everycafe_integration_logs ORDER BY id DESC LIMIT 5000)`,()=>{});
  return true;
}

function cleanupLegacyAutoSeedProducts() {
  // v3.0.16 tek-seferlik veri düzeltmesi:
  // - EveryCafe kataloğu daha önce senkronlandıysa, kaynaksız kalan tüm eski
  //   manuel/örnek kartlar pasife alınır. Aktif katalog yalnız aynalanmış
  //   EveryCafe kartlarından oluşur.
  // - EveryCafe hiç senkronlanmamış bir kafede yalnız 0 ₺/eksik manuel kartlar
  //   pasife alınır; gerçek fiyatlı manuel katalog korunur.
  // Sonraki restartlarda bu migration tekrar çalışmaz.
  const migrationKey = "catalog_seed_cleanup_v3016";
  db.get("SELECT value FROM settings WHERE key=?", [migrationKey], (stateErr, stateRow) => {
    if (stateErr) {
      logErr("cleanupLegacyAutoSeedProducts state", stateErr);
      return;
    }
    if (stateRow && String(stateRow.value || "") === "1") return;

    db.get(
      `SELECT COALESCE(last_success,0) AS last_success
       FROM everycafe_catalog_sync_state WHERE id=1`,
      (catalogStateErr, catalogState) => {
        if (catalogStateErr) {
          logErr("cleanupLegacyAutoSeedProducts catalog state", catalogStateErr);
          return;
        }
        const everyCafeManaged = Number(catalogState && catalogState.last_success) > 0;

        db.all(
          `SELECT id,name,category,price
           FROM product_catalog
           WHERE COALESCE(external_source,'')='' AND active<>0`,
          (readErr, rows) => {
            if (readErr) {
              logErr("cleanupLegacyAutoSeedProducts read", readErr);
              return;
            }
            const targets = (rows || []).filter((row) =>
              everyCafeManaged || Math.abs(Number(row.price) || 0) <= 0.001
            );

            let index = 0;
            let deactivated = 0;
            const next = () => {
              if (index >= targets.length) {
                return db.run(
                  `INSERT INTO settings(key,value) VALUES(?, '1')
                   ON CONFLICT(key) DO UPDATE SET value='1'`,
                  [migrationKey],
                  (markErr) => {
                    if (markErr) return logErr("cleanupLegacyAutoSeedProducts mark", markErr);
                    if (deactivated > 0) {
                      addLiveLog(
                        "catalog_cleanup",
                        `🧹 v3.0.16 katalog temizliği • ${deactivated} eski/eksik kart pasife alındı`
                      );
                    }
                  }
                );
              }
              const row = targets[index++];
              db.run(
                `UPDATE product_catalog SET active=0,updated_at=? WHERE id=? AND active<>0`,
                [Date.now(), Number(row.id)],
                function (err) {
                  if (err) logErr("cleanupLegacyAutoSeedProducts", err);
                  else deactivated += Number(this.changes) || 0;
                  next();
                }
              );
            };
            next();
          }
        );
      }
    );
  });
}

let everyCafeSyncRunning = false;
let everyCafeActiveSyncRunning = false;
let everyCafeCatalogSyncRunning = false;
const everyCafeCatalogByStockId = new Map();
let fullBackupRunning = false;
let lastFullBackup = null;
let everyCafeHealth = {
  lastSuccess: 0,
  lastError: "",
  failureSince: 0,
  warningActive: false
};
let lastEveryCafeDailyAudit = null;
const everyCafeSessionTypes = new Map();
// EveryCafe'de EndDate'i başlangıçtan ileride olan oturumlar süreli açılmıştır.
// Bu masalarda ilk fiyat basamağı 60. dakikadan sonra gelir.
const everyCafeTimedSessions = new Map();
// Süreli EveryCafe oturumlarında kaynak bitişi, canlı fiyatın da üst sınırıdır.
// Böylece EveryCafe kapanışı işlenene kadar monitör fazladan bir ücret basamağı göstermez.
const everyCafeScheduledEnds = new Map();

// EveryCafe'de "Beklemede" ekranında olan masa henüz Windows'a geçmemiştir.
// Bu kayıt izleme içindir; KafePin oturumu, ücret veya çark hakkı oluşturmaz.
const everyCafeWaitingMasalar = new Map();
const everyCafeWaitingLookupCache = new Map();
// Kesin EveryCafe kapanışını, sonrasında gelen bekleme pinglerinden ayırır.
const everyCafeRecentlyClosedMasalar = new Map();
// EveryCafe'de verilen "Ücretsiz Süre" dakikaları yalnızca canlı ücret
// göstergesinden düşülür. Kapanışta kaynak sistemin PaymentAmount değeri
// yine tek doğru tahsilat olarak kullanılmaya devam eder.
const everyCafeGiftMinutes = new Map();
const everyCafeOpenOrderFingerprints = new Map();

function everyCafeGiftMinutesFromSource(value) {
  const raw = Math.max(0, Number(value) || 0);
  // EveryCafe süre alanlarını saniye saklar (ör. 60 dk ek süre = 3600).
  // Eski/alternatif sürümlerde dakika tutulursa 15/30/45/60 değerleri de
  // doğru çalışmaya devam eder.
  const minutes = raw >= 120 ? raw / 60 : raw;
  return Math.min(24 * 60, Math.round(minutes * 100) / 100);
}

function getEveryCafeGiftMinutes(masa) {
  return Math.min(24 * 60, Math.max(0, Number(everyCafeGiftMinutes.get(Number(masa))) || 0));
}

function isEveryCafeTimedMasa(masa) {
  return everyCafeTimedSessions.get(Number(masa)) === true;
}

function getEveryCafeScheduledEnd(masa) {
  return Math.max(0, Number(everyCafeScheduledEnds.get(Number(masa))) || 0);
}

function recordEveryCafeSyncSuccess() {
  const recovered = everyCafeHealth.warningActive;
  everyCafeHealth = { lastSuccess: Date.now(), lastError: "", failureSince: 0, warningActive: false };
  if (recovered) {
    addLiveLog("everycafe_health", "✅ EveryCafe bağlantısı yeniden sağlandı");
    addEveryCafeIntegrationLog({category:"HEALTH",event:"EveryCafe bağlantısı yeniden sağlandı",sourceDetail:"ecmdata.ecm salt-okunur erişim başarılı",action:"KafePin canlı okumaya devam ediyor",result:"Bağlı • EveryCafe'ye yazma yok"});
    if (TELEGRAM_ENABLED) sendTelegramMessage("✅ EveryCafe bağlantısı yeniden sağlandı.", () => {});
  }
}

function recordEveryCafeSyncFailure(scope, err) {
  const now = Date.now();
  if (!everyCafeHealth.failureSince) everyCafeHealth.failureSince = now;
  everyCafeHealth.lastError = String(err && (err.message || err) || "Bilinmeyen hata");
  if (everyCafeHealth.warningActive || now - everyCafeHealth.failureSince < EVERYCAFE_HEALTH_WARNING_MS) return;
  everyCafeHealth.warningActive = true;
  const minutes = Math.floor((now - everyCafeHealth.failureSince) / 60000);
  const text = `⚠️ EveryCafe bağlantısı ${minutes} dk veri okuyamadı: ${everyCafeHealth.lastError}`;
  addLiveLog("everycafe_health", text);
  addEveryCafeIntegrationLog({category:"HEALTH",level:"ERROR",event:"EveryCafe okuma hatası",sourceDetail:everyCafeHealth.lastError,action:`KafePin ${scope||"senkron"} verisini uygulamadı`,result:"Güvenli bekleme",dedupeKey:`health:${scope}:${everyCafeHealth.lastError}`,dedupeMs:60000});
  if (TELEGRAM_ENABLED) sendTelegramMessage(text, () => {});
}

// 🔥 Masa bazlı queue sistemi
const finalizeQueues = new Map();
const finalizeInProgress = new Set();
function enqueueFinalize(masa, task) {
  const prev = finalizeQueues.get(masa) || Promise.resolve();

const next = prev
  .then(() => task())
  .catch((err) => {
    console.error("Queue task error:", err);
    throw err;
  })
  .finally(() => {
    // sadece en son promise ise sil
    if (finalizeQueues.get(masa) === next) {
      finalizeQueues.delete(masa);
    }
  });

finalizeQueues.set(masa, next);

  return next;
}


db.on("error", (err) => {
  console.error("SQLite error:", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);

  
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);

  setTimeout(() => process.exit(1), 500);
});


db.serialize(() => {
  db.run("PRAGMA journal_mode=WAL;");
  db.run("PRAGMA synchronous=NORMAL;");
  db.run("PRAGMA temp_store=MEMORY;");
  db.run("PRAGMA foreign_keys=ON;");
  db.run("PRAGMA busy_timeout=10000;");
  db.run("PRAGMA cache_size=-20000;");
});

let aktifMasalar = {};
const diagnostics = {
  cleanupCount: 0,
  finalizeCount: 0,
  offlineCloseCount: 0,

  lastCleanup: 0,
  lastFinalize: 0,
  lastPing: 0,

  lastCleanupMasa: null,
  lastFinalizeMasa: null
};
const MASA_SAYISI = Math.max(1, Math.min(250, Number(process.env.KAFEPIN_MASA_SAYISI || Object.keys(MASA_TOKENS || {}).length || 23) || 23));
for (let i = 1; i <= MASA_SAYISI; i++) {
  masaPingStats[i] = {
    last: 0,
    avg: PING_INTERVAL_MS,
    lastSeen: 0,
    netSpeed: 0
  };
}



const SPIN_SURE_DK = 45;
const SPIN_WAIT_MS = 45 * 60 * 1000;
const SPIN_ENABLED = String(process.env.KAFEPIN_SPIN_ENABLED || "1").trim() !== "0";

// EveryCafe aktifken manuel masa kapatma/sıfırlama işlemleri ancak bu mod açıkken yapılabilir.
let EVERYCAFE_MAINTENANCE_MODE = 0;

const GUNLUK_SPIN_LIMIT = 5;

/*
SESSION ÜCRETİ
--------------
- Tek sabit üretim tarifesi kullanılır; gün tipine göre fiyat değişmez.
- İlk 60 dakika açılış ücreti.
- Sonrasında 30 dakikalık artış blokları.

SPIN ÖDÜL MALİYETİ
------------------
- Normal 30 dk = 25 TL
- Normal 60 dk = 50 TL
- VIP 30 dk    = 35 TL
- VIP 60 dk    = 70 TL
- İçecek / atıştırmalık / anahtarlık = 20 TL
*/

const NORMAL_OPENING = Math.max(0, Number(process.env.KAFEPIN_NORMAL_OPENING || 50) || 50);
const VIP_OPENING = Math.max(0, Number(process.env.KAFEPIN_VIP_OPENING || 70) || 70);
const OPENING_MINUTES = Math.max(1, Math.min(1440, Number(process.env.KAFEPIN_OPENING_MINUTES || 60) || 60));
const INCREASE_BLOCK_MINUTES = Math.max(1, Math.min(1440, Number(process.env.KAFEPIN_INCREASE_BLOCK_MINUTES || 30) || 30));

/*
60 dk referans ücret bilgileri
*/
const NORMAL_SAAT = Number(process.env.KAFEPIN_NORMAL_SAAT || 87.5) || 87.5;
const VIP_SAAT = Number(process.env.KAFEPIN_VIP_SAAT || 122.5) || 122.5;

const NORMAL_ARTIS = Math.max(0, Number(process.env.KAFEPIN_NORMAL_INCREASE || 25) || 25);
const VIP_ARTIS = Math.max(0, Number(process.env.KAFEPIN_VIP_INCREASE || 35) || 35);

const ICECEK_MALIYET = 20;
const BUYUK_ODUL_HEDEF = Math.max(1, Number(process.env.KAFEPIN_BIG_REWARD_TARGET_NORMAL || 14) || 14);
const BUYUK_ODUL_HEDEF_VIP = Math.max(1, Number(process.env.KAFEPIN_BIG_REWARD_TARGET_VIP || 10) || 10);
const {
  getPricingForTs,
  calcRealFee,
  feeAtTime: calculateFeeAtTime
} = createFeeUtils({
  VIP_MASALAR,
  NORMAL_OPENING,
  VIP_OPENING,
  NORMAL_SAAT,
  VIP_SAAT,
  NORMAL_ARTIS,
  VIP_ARTIS,
  OPENING_MINUTES,
  INCREASE_BLOCK_MINUTES
});

function feeAtTime(masa, startTime, endTime) {
  const start = Number(startTime) || 0;
  const end = Number(endTime) || 0;
  if (!start || !end || end <= start) return 0;
  // EveryCafe ile birebir tarife: başlangıç ve tüm fiyat basamakları
  // kaynak sistemdeki sabit Normal/VIP ücret düzeniyle hesaplanır.
  // EveryCafe: açılır açılmaz taban ücret, her tam 30 dakikada artış.
  const vip = VIP_MASALAR.includes(Number(masa));
  const opening = vip ? VIP_OPENING : NORMAL_OPENING;
  const increase = vip ? VIP_ARTIS : NORMAL_ARTIS;
  // EveryCafe'deki ücretsiz süre, müşterinin hesabına eklenen süre değildir;
  // sadece ücretli geçen zamandan düşer. Böylece canlı toplam, EveryCafe'nin
  // kapanışta tahsil ettiği tutardan erken artmaz.
  const billedElapsed = Math.max(0, (end - start) - getEveryCafeGiftMinutes(masa) * 60 * 1000);
  const stepMs = INCREASE_BLOCK_MINUTES * 60 * 1000;
  // Açılış süresi ve sonraki artış aralığı yeni-kafe kurulumunda yapılandırılabilir.
  const firstIncreaseAt = OPENING_MINUTES * 60 * 1000;
  const stepCount = billedElapsed <= firstIncreaseAt
    ? 0
    : Math.ceil((billedElapsed - firstIncreaseAt) / stepMs);
  return opening + Math.max(0, stepCount) * increase;
}

const {
  weightedRandom,
  getRewardCostAndType,
  isBigReward
} = createSpinService({
  getPricingForTs,
  ICECEK_MALIYET
});

function spinAdjustmentCost(row) {
  const kind = String(row && row.kind || "").trim();
  if (kind !== "SPIN_TIME_COST" && kind !== "SPIN_ITEM_COST") return 0;
  const parsed = getRewardCostAndType(
    Number(row && row.masa) || 0,
    String(row && row.note || "")
  );
  const parsedCost = Math.max(0, Number(parsed && parsed.amount) || 0);
  if (parsedCost > 0) return parsedCost;
  return Math.max(-(Number(row && row.amount) || 0), 0);
}

/*
  Ücret geçiş sistemi:
  - Açılış ücreti ilk 62 dakikaya kadar geçerli
  - Sonrasında her 15 dakikada bir artış uygulanır
*/
const UCRET_ARTIS_BLOK_DK = 30;

const DAY_SHIFT_MS = 20 * 60 * 60 * 1000;
// Banka kesintisi her kart işlemi için kuruşa yuvarlanır.
const CARD_COMMISSION_RATE = 0.0187;
const CARD_SETTLEMENT_DELAY_MS = 24 * 60 * 60 * 1000;
const {
  dayKey,
  dayStartTs
} = createDateUtils(
  DAY_SHIFT_MS
);

// POS bankası gün içindeki kartları tek yatırımla gönderebildiği için bu anahtar
// kafe günü değil, bankanın takvim günündeki kart işlem grubunu temsil eder.
function cardSettlementKey(ts) {
  const d = new Date(Number(ts) || 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let globalSpinCount = 0;

let freeMasalar = new Set();
const freeOfflineCleanupInProgress = new Set();
function reloadBlockedMasalar(cb) {
  db.all(
    "SELECT masa FROM blocked_masalar WHERE until_time > ?",
    [Date.now()],
    (err, rows) => {
      if (err) logErr("reloadBlockedMasalar", err);
      blockedMasalar = new Set((rows || []).map((r) => r.masa));
      cb && cb();
    }
  );
}

const LOCK_MS = 90 * 1000;

let sessionLocks = new Map();
let masaCloseLocks = {};
let blockedMasalar = new Set();
let tokenTracker = {};


const TELEGRAM_ENV_FILE = path.join(__dirname, ".env");
let TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === "1";
let TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
let TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
let telegramSetupSession = null;

function telegramEnvValue(value) {
  const s = String(value == null ? "" : value);
  if (/^[A-Za-z0-9_./:@+\-]*$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function writeTelegramEnv(values) {
  let current = "";
  try { current = fs.readFileSync(TELEGRAM_ENV_FILE, "utf8").replace(/^\uFEFF/, ""); } catch (_err) {}
  let lines = current ? current.split(/\r?\n/) : [];
  const entries = Object.entries(values || {}).map(([k, v]) => [String(k), String(v)]);
  const seen = new Set();
  lines = lines.map(line => {
    for (const [key, value] of entries) {
      const rx = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
      if (rx.test(line)) {
        seen.add(key);
        return `${key}=${telegramEnvValue(value)}`;
      }
    }
    return line;
  });
  for (const [key, value] of entries) {
    if (!seen.has(key)) lines.push(`${key}=${telegramEnvValue(value)}`);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const output = lines.join("\r\n") + "\r\n";
  const tmp = TELEGRAM_ENV_FILE + ".kafepin.tmp";
  fs.writeFileSync(tmp, output, "utf8");
  fs.copyFileSync(tmp, TELEGRAM_ENV_FILE);
  try { fs.unlinkSync(tmp); } catch (_err) {}
  for (const [key, value] of Object.entries(values || {})) process.env[key] = String(value);
}

function ensureTelegramLockedActive() {
  const configured = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
  if (!configured || TELEGRAM_ENABLED) return configured;
  try {
    writeTelegramEnv({ TELEGRAM_ENABLED: "1" });
    TELEGRAM_ENABLED = true;
    addLiveLog("telegram_setup", "🔒 Telegram güvenlik kilidi: kayıtlı bağlantı yeniden etkinleştirildi");
  } catch (err) {
    logErr("telegram locked active", err);
  }
  return configured;
}

// v3.1.6: Token + Chat ID kayıtlıysa Telegram panelden kapatılamaz.
ensureTelegramLockedActive();

function telegramApiRequest(token, method, payload, cb) {
  const safeToken = String(token || "").trim();
  if (!safeToken) return cb(new Error("Telegram bot tokenı eksik"));
  const body = JSON.stringify(payload || {});
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${safeToken}/${method}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  }, response => {
    let data = "";
    response.on("data", chunk => { data += chunk; });
    response.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(data || "{}"); } catch (_err) {}
      if (response.statusCode < 200 || response.statusCode >= 300 || !parsed || parsed.ok !== true) {
        const detail = parsed && parsed.description ? parsed.description : `HTTP ${response.statusCode}`;
        return cb(new Error(`Telegram: ${detail}`));
      }
      cb(null, parsed.result);
    });
  });
  req.setTimeout(8000, () => req.destroy(new Error("Telegram bağlantısı zaman aşımına uğradı")));
  req.on("error", cb);
  req.write(body);
  req.end();
}

function telegramChatLabel(chat) {
  if (!chat) return "Telegram hesabı";
  const full = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
  return full || (chat.username ? `@${chat.username}` : `Chat ${chat.id || ""}`.trim());
}

function telegramMaskedToken() {
  const token = String(TELEGRAM_BOT_TOKEN || "");
  if (!token) return "";
  const head = token.slice(0, Math.min(6, token.length));
  const tail = token.length > 8 ? token.slice(-4) : "";
  return `${head}••••••${tail}`;
}

app.get("/admin/telegram/status", (req, res) => {
  setNoStore(res);
  ensureTelegramLockedActive();
  const configured = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
  res.json({
    ok: true,
    enabled: Boolean(TELEGRAM_ENABLED),
    configured,
    ready: Boolean(TELEGRAM_ENABLED && configured),
    tokenMasked: telegramMaskedToken(),
    chatSaved: Boolean(TELEGRAM_CHAT_ID),
    source: configured ? "server-env" : "none"
  });
});

app.post("/admin/telegram/setup-token", (req, res) => {
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    ensureTelegramLockedActive();
    return res.status(403).json({ ok: false, locked: true, error: "Telegram zaten bağlı. Güvenlik için panelden hesap değiştirilemez." });
  }
  const token = String((req.body && req.body.token) || "").trim();
  if (!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return res.status(400).json({ ok: false, error: "BotFather tokenı geçerli görünmüyor. Tokenı eksiksiz yapıştırın." });
  }

  telegramApiRequest(token, "getMe", {}, (meErr, bot) => {
    if (meErr) return res.status(400).json({ ok: false, error: "Bot tokenı doğrulanamadı. BotFather'dan aldığınız tokenı kontrol edin." });
    telegramApiRequest(token, "getUpdates", { limit: 100, timeout: 0, allowed_updates: ["message"] }, (updatesErr, updates) => {
      if (updatesErr) {
        const msg = String(updatesErr.message || updatesErr);
        const friendly = /webhook|409/i.test(msg)
          ? "Bu bot başka bir sistemde webhook ile kullanılıyor. KafePin için yeni bir Telegram botu oluşturun."
          : "Telegram mesajları okunamadı. İnternet bağlantısını kontrol edip tekrar deneyin.";
        return res.status(400).json({ ok: false, error: friendly });
      }
      const list = Array.isArray(updates) ? updates : [];
      const maxUpdateId = list.reduce((m, u) => Math.max(m, Number(u && u.update_id) || 0), 0);
      telegramSetupSession = {
        token,
        botUsername: String((bot && bot.username) || ""),
        botName: String((bot && (bot.first_name || bot.username)) || "KafePin Bot"),
        minUpdateId: maxUpdateId ? maxUpdateId + 1 : 0,
        createdAt: Date.now()
      };
      addLiveLog("telegram_setup", `📲 Telegram kurulum sihirbazı başladı • @${telegramSetupSession.botUsername || "bot"}`);
      res.json({
        ok: true,
        botUsername: telegramSetupSession.botUsername,
        botName: telegramSetupSession.botName,
        botUrl: telegramSetupSession.botUsername ? `https://t.me/${telegramSetupSession.botUsername}` : ""
      });
    });
  });
});

app.post("/admin/telegram/discover", (req, res) => {
  const setup = telegramSetupSession;
  if (!setup || !setup.token || Date.now() - setup.createdAt > 20 * 60 * 1000) {
    telegramSetupSession = null;
    return res.status(410).json({ ok: false, expired: true, error: "Telegram kurulum süresi doldu. Tokenı yeniden doğrulayın." });
  }
  if (setup.discovering) return res.json({ ok: true, found: false, waiting: true, busy: true });
  setup.discovering = true;
  const payload = { limit: 100, timeout: 0, allowed_updates: ["message"] };
  if (setup.minUpdateId > 0) payload.offset = setup.minUpdateId;
  telegramApiRequest(setup.token, "getUpdates", payload, (err, updates) => {
    setup.discovering = false;
    if (telegramSetupSession !== setup) return res.status(409).json({ ok: false, stale: true, error: "Telegram kurulum oturumu değişti. Yeniden deneyin." });
    if (err) return res.status(502).json({ ok: false, error: "Telegram hesabı aranırken bağlantı kurulamadı." });
    const list = Array.isArray(updates) ? updates : [];
    const maxUpdateId = list.reduce((m, u) => Math.max(m, Number(u && u.update_id) || 0), 0);
    if (maxUpdateId) setup.minUpdateId = maxUpdateId + 1;
    const candidates = list.filter(u => u && u.message && u.message.chat && u.message.chat.type === "private");
    if (!candidates.length) return res.json({ ok: true, found: false, waiting: true });

    const selected = candidates[candidates.length - 1];
    const chat = selected.message.chat;
    const chatId = String(chat.id || "").trim();
    if (!chatId) return res.json({ ok: true, found: false, waiting: true });

    try {
      writeTelegramEnv({
        TELEGRAM_ENABLED: "1",
        TELEGRAM_BOT_TOKEN: setup.token,
        TELEGRAM_CHAT_ID: chatId
      });
      TELEGRAM_ENABLED = true;
      TELEGRAM_BOT_TOKEN = setup.token;
      TELEGRAM_CHAT_ID = chatId;
    } catch (writeErr) {
      return res.status(500).json({ ok: false, error: `Telegram ayarları sunucuya yazılamadı: ${String(writeErr.message || writeErr)}` });
    }

    const label = telegramChatLabel(chat);
    const username = chat.username ? `@${chat.username}` : "";
    telegramSetupSession = null;
    addLiveLog("telegram_setup", `✅ Telegram bağlandı • ${label}${username ? ` • ${username}` : ""}`);
    sendTelegramMessage(
      "✅ KafePin Pro Telegram bağlantısı başarıyla kuruldu.\n\nİşletme raporları ve KafePin bildirimleri artık bu hesaba gönderilecek.",
      sendErr => {
        if (sendErr) {
          logErr("telegram setup welcome", sendErr);
          return res.json({
            ok: true, found: true, connected: true, messageSent: false, label, username,
            warning: "Ayarlar kaydedildi fakat doğrulama mesajı gönderilemedi. Test Mesajı düğmesiyle tekrar deneyin."
          });
        }
        addLiveLog("telegram_setup", "📨 Telegram kurulum doğrulama mesajı gönderildi");
        res.json({ ok: true, found: true, connected: true, messageSent: true, label, username });
      }
    );
  });
});

app.post("/admin/telegram/test", (req, res) => {
  if (!TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(400).json({ ok: false, error: "Telegram bağlı değil." });
  }
  sendTelegramMessage("✅ KafePin Pro test mesajı. Telegram bağlantısı çalışıyor.", err => {
    if (err) return res.status(502).json({ ok: false, error: "Test mesajı gönderilemedi. Telegram ayarlarını kontrol edin." });
    addLiveLog("telegram_test", "📨 Telegram test mesajı başarıyla gönderildi");
    res.json({ ok: true });
  });
});

app.post("/admin/telegram/disable", (req, res) => {
  ensureTelegramLockedActive();
  res.status(403).json({ ok: false, locked: true, error: "Telegram güvenlik nedeniyle Yönetim Merkezi'nden kapatılamaz." });
});

app.post("/admin/telegram/enable", (req, res) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(400).json({ ok: false, error: "Önce Telegram kurulumunu tamamlayın." });
  }
  ensureTelegramLockedActive();
  res.json({ ok: true, enabled: Boolean(TELEGRAM_ENABLED), locked: true });
});

// v3.1.51 TELEGRAM_SINGLE_SEND_AND_LIVE_BOTTOM
const GUN_SONU_RAPOR_SAAT = 20;
const GUN_SONU_RAPOR_DAKIKA = 0;

let lastDailyReportKey = "";
const TELEGRAM_DEDUP_MS = 10000;
const telegramRecentMessages = new Map();

function shouldSendTelegramDedup(key, windowMs = TELEGRAM_DEDUP_MS) {
  const now = Date.now();
  const last = telegramRecentMessages.get(key) || 0;

  if (now - last < windowMs) {
    return false;
  }

  telegramRecentMessages.set(key, now);

if (telegramRecentMessages.size > 1000) {
  telegramRecentMessages.clear();
}

  return true;
}

if (TELEGRAM_ENABLED) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("⚠️ Telegram açık ama TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik.");
  } else {
    console.log("✅ Telegram .env üzerinden aktif.");
  }
} else {
  console.log("ℹ️ Telegram devre dışı.");
}

function reloadFreeMasalar(cb) {

  db.all("SELECT masa FROM free_masalar WHERE enabled=1", (err, rows) => {
    if (err) logErr("reloadFreeMasalar", err);
    freeMasalar = new Set((rows || []).map((r) => r.masa));
    cb && cb();
  });
}

function isFreeMasa(masa) {
  return freeMasalar.has(masa);
}

function setForceNewSession(masa, cb) {
  const now = Date.now();
  db.run(
    "INSERT INTO force_new_sessions(masa, set_time) VALUES(?,?) ON CONFLICT(masa) DO UPDATE SET set_time=excluded.set_time",
    [masa, now],
    (err) => {
      logErr("setForceNewSession", err);
      cb && cb();
    }
  );
}

function clearForceNewSession(masa, cb) {
  db.run("DELETE FROM force_new_sessions WHERE masa=?", [masa], (err) => {
    logErr("clearForceNewSession", err);
    cb && cb();
  });
}

function hasForceNewSession(masa, cb) {
  db.get("SELECT 1 as ok FROM force_new_sessions WHERE masa=? LIMIT 1", [masa], (err, row) => {
    if (err) {
      logErr("hasForceNewSession", err);
      return cb(false);
    }
    cb(!!row);
  });
}

function runAlter(sql, label) {
  db.run(sql, (err) => {
    if (err && !String(err.message || err).includes("duplicate column name")) {
      logErr(label, err);
    }
  });
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      masa INTEGER,
      reward TEXT,
      time INTEGER,
      used INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS spins_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      masa INTEGER,
      reward TEXT,
      time INTEGER,
      used INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      weight INTEGER,
      active INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS masalar (
      masa INTEGER PRIMARY KEY,
      start_time INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      masa INTEGER PRIMARY KEY,
      start_time INTEGER,
      last_seen INTEGER,
      end_time INTEGER DEFAULT 0
    )
  `);

  runAlter("ALTER TABLE sessions ADD COLUMN final_fee REAL DEFAULT 0", "alter sessions final_fee");

  db.run(`
    CREATE TABLE IF NOT EXISTS free_masalar (
      masa INTEGER PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      set_time INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS real_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER,
      day_key TEXT,
      masa INTEGER,
      amount REAL,
      kind TEXT,
      note TEXT
    )
  `);

setImmediate(() => {
  reloadFreeMasalar(() => {
    reloadBlockedMasalar(() => {});
  });
});
db.all("SELECT masa, last_seen FROM sessions WHERE end_time=0", (err, rows) => {

  if (!err && rows) {
    const now = Date.now();

rows.forEach(r => {
  const last = r.last_seen || now;

  if (!isActuallyOffline(r.masa, last, now)) {
    aktifMasalar[r.masa] = last;

    addLiveLog(
      "restore",
      `♻️ Masa ${r.masa} geri yüklendi`
    );
  }
});

console.log("♻️ aktifMasalar restore edildi:", Object.keys(aktifMasalar).length);
  } else {
    console.error("aktifMasalar restore hatası:", err);
  }

});

  runAlter(
    "ALTER TABLE real_adjustments ADD COLUMN session_start INTEGER DEFAULT 0",
    "alter real_adjustments session_start"
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS session_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      masa INTEGER NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      last_seen INTEGER DEFAULT 0,
      minutes INTEGER DEFAULT 0,
      fee REAL DEFAULT 0,
      close_reason TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at INTEGER DEFAULT 0
    )
  `);
  runAlter(
    "ALTER TABLE session_history ADD COLUMN adjustment REAL DEFAULT 0",
    "alter session_history adjustment"
  );
db.run(`
  CREATE TABLE IF NOT EXISTS daily_reports (
    report_date TEXT PRIMARY KEY,

    report_ts INTEGER,

    total_spins INTEGER DEFAULT 0,
    used_rewards INTEGER DEFAULT 0,

    brut_gelir REAL DEFAULT 0,
    admin_duzeltmeleri REAL DEFAULT 0,
    spin_maliyeti REAL DEFAULT 0,
    gercek_gelir REAL DEFAULT 0,

    ortalama_masa_geliri REAL DEFAULT 0,

    top_reward TEXT,
    top_reward_count INTEGER DEFAULT 0,

    top_masa INTEGER,
    top_masa_count INTEGER DEFAULT 0,

    top_revenue_masa TEXT,

    reward_list TEXT
  )
`);


  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_history_unique
    ON session_history(masa, start_time, end_time)
  `);


  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_real_adjustments_finalize_unique
    ON real_adjustments(masa, session_start, kind)
    WHERE kind='SESSION_FINALIZE'
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS session_locks (
      masa INTEGER PRIMARY KEY,
      until_time INTEGER,
      set_time INTEGER
    )
  `);

  db.all("SELECT masa, until_time FROM session_locks", (e, rows) => {
    if (e) {
      logErr("load session_locks", e);
      return;
    }
    sessionLocks = new Map();
    (rows || []).forEach((r) => {
      if (r && r.masa && r.until_time) sessionLocks.set(r.masa, r.until_time);
    });
(rows || []).forEach((r) => {
  if (r && r.masa && r.until_time > Date.now()) {
    masaCloseLocks[r.masa] = r.until_time;
  }
});
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS force_new_sessions (
      masa INTEGER PRIMARY KEY,
      set_time INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS blocked_masalar (
      masa INTEGER PRIMARY KEY,
      until_time INTEGER,
      reason TEXT,
      set_time INTEGER
    )
  `);

  runAlter("ALTER TABLE daily_reports ADD COLUMN product_geliri REAL DEFAULT 0", "alter daily_reports product_geliri");
  runAlter("ALTER TABLE daily_reports ADD COLUMN product_adedi INTEGER DEFAULT 0", "alter daily_reports product_adedi");
  runAlter("ALTER TABLE daily_reports ADD COLUMN genel_gelir REAL DEFAULT 0", "alter daily_reports genel_gelir");
  runAlter("ALTER TABLE daily_reports ADD COLUMN nakit_odeme REAL DEFAULT 0", "alter daily_reports nakit_odeme");
  runAlter("ALTER TABLE daily_reports ADD COLUMN kart_odeme REAL DEFAULT 0", "alter daily_reports kart_odeme");
  runAlter("ALTER TABLE daily_reports ADD COLUMN bekleyen_odeme REAL DEFAULT 0", "alter daily_reports bekleyen_odeme");
  runAlter("ALTER TABLE daily_reports ADD COLUMN bekleyen_adet INTEGER DEFAULT 0", "alter daily_reports bekleyen_adet");
  runAlter("ALTER TABLE daily_reports ADD COLUMN giderler REAL DEFAULT 0", "alter daily_reports giderler");
  runAlter("ALTER TABLE daily_reports ADD COLUMN kart_komisyonu REAL DEFAULT 0", "alter daily_reports kart_komisyonu");
  runAlter("ALTER TABLE daily_reports ADD COLUMN net_isletme_sonucu REAL DEFAULT 0", "alter daily_reports net_isletme_sonucu");
  runAlter("ALTER TABLE daily_reports ADD COLUMN everycafe_genel_gelir REAL DEFAULT 0", "alter daily_reports everycafe_genel_gelir");
  runAlter("ALTER TABLE daily_reports ADD COLUMN kafepin_direct_geliri REAL DEFAULT 0", "alter daily_reports kafepin_direct_geliri");
  runAlter("ALTER TABLE daily_reports ADD COLUMN everycafe_pc_geliri REAL DEFAULT 0", "alter daily_reports everycafe_pc_geliri");
  runAlter("ALTER TABLE daily_reports ADD COLUMN everycafe_masa_urun_geliri REAL DEFAULT 0", "alter daily_reports everycafe_masa_urun_geliri");

  db.run(`
    CREATE TABLE IF NOT EXISTS product_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    )
  `);

  // KafePin'in elle girilen ürünleri ile EveryCafe'den aynalanan ürünleri
  // aynı katalogda güvenle birlikte tutarız. Eski genel unique index,
  // EveryCafe ürününün adı/kategorisi değiştiğinde gereksiz çakışma
  // yaratabileceği için kaynak bazlı indexlere dönüştürülür.
  runAlter("ALTER TABLE product_catalog ADD COLUMN external_source TEXT DEFAULT ''", "alter product_catalog external_source");
  runAlter("ALTER TABLE product_catalog ADD COLUMN external_id TEXT DEFAULT ''", "alter product_catalog external_id");
  db.run(`DROP INDEX IF EXISTS idx_product_catalog_name_category`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_product_catalog_manual_name_category
    ON product_catalog(name,category)
    WHERE external_source=''`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_product_catalog_external_unique
    ON product_catalog(external_source,external_id)
    WHERE external_source<>'' AND external_id<>''`);

  db.run(`
    CREATE TABLE IF NOT EXISTS product_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER NOT NULL,
      masa INTEGER DEFAULT 0,
      session_start INTEGER DEFAULT 0,
      product_id INTEGER DEFAULT 0,
      product_name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit_price REAL DEFAULT 0,
      quantity INTEGER DEFAULT 1,
      total REAL DEFAULT 0,
      sale_type TEXT DEFAULT 'TABLE',
      note TEXT DEFAULT '',
      status TEXT DEFAULT 'OPEN',
      finalized_at INTEGER DEFAULT 0,
      payment_method TEXT DEFAULT 'PENDING',
      voided INTEGER DEFAULT 0,
      voided_at INTEGER DEFAULT 0
    )
  `);

  runAlter("ALTER TABLE product_sales ADD COLUMN status TEXT DEFAULT 'OPEN'", "alter product_sales status");
  runAlter("ALTER TABLE product_sales ADD COLUMN finalized_at INTEGER DEFAULT 0", "alter product_sales finalized_at");

  db.run(`CREATE INDEX IF NOT EXISTS idx_product_sales_time ON product_sales(time)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_product_sales_session ON product_sales(masa, session_start)`);

  runAlter("ALTER TABLE product_sales ADD COLUMN payment_method TEXT DEFAULT 'PENDING'", "alter product_sales payment_method");

  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      paid_at INTEGER DEFAULT 0,
      masa INTEGER DEFAULT 0,
      session_start INTEGER DEFAULT 0,
      session_end INTEGER DEFAULT 0,
      product_sale_id INTEGER DEFAULT 0,
      computer_amount REAL DEFAULT 0,
      product_amount REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      method TEXT DEFAULT 'PENDING',
      source TEXT DEFAULT 'SESSION',
      close_reason TEXT DEFAULT '',
      note TEXT DEFAULT '',
      voided INTEGER DEFAULT 0,
      voided_at INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_session_unique
    ON payments(masa,session_start,session_end,source)
    WHERE source='SESSION'
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_direct_sale_unique
    ON payments(product_sale_id)
    WHERE product_sale_id>0
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method,voided)`);

  runAlter("ALTER TABLE product_sales ADD COLUMN external_source TEXT DEFAULT ''", "alter product_sales external_source");
  runAlter("ALTER TABLE product_sales ADD COLUMN external_id TEXT DEFAULT ''", "alter product_sales external_id");
  runAlter("ALTER TABLE payments ADD COLUMN external_source TEXT DEFAULT ''", "alter payments external_source");
  runAlter("ALTER TABLE payments ADD COLUMN external_id TEXT DEFAULT ''", "alter payments external_id");
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_product_sales_external_unique
    ON product_sales(external_source,external_id)
    WHERE external_source<>'' AND external_id<>''`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external_unique
    ON payments(external_source,external_id)
    WHERE external_source<>'' AND external_id<>''`);
  db.run(`CREATE TABLE IF NOT EXISTS everycafe_imports (
    session_id TEXT PRIMARY KEY,
    masa INTEGER NOT NULL,
    source_end INTEGER NOT NULL,
    total REAL DEFAULT 0,
    imported_at INTEGER NOT NULL
  )`);
  // EveryCafe'nin üye bakiye/tahsilat hareketleri oturumlardan ayrı tutulur.
  // HistoryID kaynak tarafta kalıcı olduğu için aynı üye ödemesi ikinci kez
  // KafePin'e aktarılmaz.
  db.run(`CREATE TABLE IF NOT EXISTS everycafe_member_imports (
    history_id INTEGER PRIMARY KEY,
    source_time INTEGER NOT NULL,
    amount REAL DEFAULT 0,
    imported_at INTEGER NOT NULL
  )`);

  // v3.1.38: EveryCafe kaynak silme / ücretsiz kapanış denetim geçmişi.
  // Kaynak DB salt-okunur kalır. Ücretli bir kaynak kaydı sonradan silinirse
  // KafePin geliri otomatik düşmez; ayrı sayfada kullanıcı onayı bekler.
  db.run(`CREATE TABLE IF NOT EXISTS everycafe_reconcile_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL DEFAULT 'SOURCE_DELETED',
    kind TEXT NOT NULL DEFAULT 'OTHER',
    status TEXT NOT NULL DEFAULT 'WAITING',
    first_detected_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    source_time INTEGER DEFAULT 0,
    source_id TEXT DEFAULT '',
    source_name TEXT DEFAULT '',
    masa INTEGER DEFAULT 0,
    total REAL DEFAULT 0,
    computer_total REAL DEFAULT 0,
    product_total REAL DEFAULT 0,
    method TEXT DEFAULT '',
    local_payment_id INTEGER DEFAULT 0,
    resolved_at INTEGER DEFAULT 0,
    details_json TEXT DEFAULT ''
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_everycafe_reconcile_status_time
    ON everycafe_reconcile_events(status,first_detected_at DESC)`);


  // v3.1.43: KafePin kendi finans/oturum denetimlerini kalıcı audit olarak tutar.
  // Bu tablo gelir kaynağı değildir; yalnız sorunların ilk/son görülme ve çözülme
  // zamanını saklar. Böylece geçici bir fark ile kalıcı bir hata birbirinden ayrılır.
  db.run(`CREATE TABLE IF NOT EXISTS system_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_key TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    detail TEXT NOT NULL DEFAULT '',
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    resolved_at INTEGER DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    details_json TEXT DEFAULT ''
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_system_audit_active_seen
    ON system_audit_events(active,last_seen_at DESC)`);

  // v3.0.19: EveryCafe gerçek rapor + mevcut KafePin kayıtlarını çift yazmadan güvenli geçmiş aktarımı.
  // Activity yalnız silme/audit bilgisinde gösterilir; gelir kaynağı değildir.
  db.run(`CREATE TABLE IF NOT EXISTS everycafe_history_imports (
    source_key TEXT PRIMARY KEY,
    source_session_id TEXT DEFAULT '',
    source_activity_id INTEGER DEFAULT 0,
    source_time INTEGER NOT NULL,
    calendar_day TEXT NOT NULL,
    client_name TEXT DEFAULT '',
    masa INTEGER DEFAULT 0,
    kind TEXT DEFAULT 'TABLE',
    source_action TEXT DEFAULT '',
    total REAL DEFAULT 0,
    imported_at INTEGER NOT NULL,
    product_sale_id INTEGER DEFAULT 0
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_everycafe_history_day
    ON everycafe_history_imports(calendar_day,source_time)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_everycafe_history_session
    ON everycafe_history_imports(source_session_id)`);
  runAlter("ALTER TABLE everycafe_history_imports ADD COLUMN source_start INTEGER DEFAULT 0", "alter everycafe_history_imports source_start");
  runAlter("ALTER TABLE everycafe_history_imports ADD COLUMN computer_total REAL DEFAULT 0", "alter everycafe_history_imports computer_total");
  runAlter("ALTER TABLE everycafe_history_imports ADD COLUMN product_total REAL DEFAULT 0", "alter everycafe_history_imports product_total");
  runAlter("ALTER TABLE everycafe_history_imports ADD COLUMN payment_method TEXT DEFAULT ''", "alter everycafe_history_imports payment_method");
  runAlter("ALTER TABLE everycafe_history_imports ADD COLUMN details_json TEXT DEFAULT ''", "alter everycafe_history_imports details_json");
  db.run(`CREATE TABLE IF NOT EXISTS everycafe_history_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_time INTEGER NOT NULL,
    source_signature TEXT DEFAULT '',
    source_records INTEGER DEFAULT 0,
    source_total REAL DEFAULT 0,
    existing_records INTEGER DEFAULT 0,
    new_records INTEGER DEFAULT 0,
    imported_records INTEGER DEFAULT 0,
    skipped_records INTEGER DEFAULT 0,
    warning_records INTEGER DEFAULT 0,
    status TEXT DEFAULT '',
    backup_path TEXT DEFAULT '',
    details_json TEXT DEFAULT ''
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS everycafe_active_sessions (
    session_id TEXT PRIMARY KEY,
    masa INTEGER NOT NULL,
    source_start INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    source_type TEXT DEFAULT ''
  )`);
  runAlter("ALTER TABLE everycafe_active_sessions ADD COLUMN source_type TEXT DEFAULT ''", "alter everycafe_active_sessions source_type");
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_everycafe_active_masa
    ON everycafe_active_sessions(masa)`);

  // v3.1.46: EveryCafe Client'a gönderilen çark-hazır mesajının aynı müşteri +
  // aynı 45 dk döngüsünde tekrar gönderilmesini engeller. Bu tablo KafePin DB'dedir.
  db.run(`CREATE TABLE IF NOT EXISTS spin_ready_notifications (
    session_id TEXT NOT NULL,
    timer_start INTEGER NOT NULL,
    masa INTEGER NOT NULL,
    sent_at INTEGER NOT NULL DEFAULT 0,
    client_ip TEXT DEFAULT '',
    PRIMARY KEY(session_id,timer_start)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_spin_ready_notifications_masa
    ON spin_ready_notifications(masa,sent_at DESC)`);

  // v3.1.46: Bildirim yalnız müşteri KafePin çark sayfasını gerçekten açtıysa
  // çalışır. Admin force-ready, ping veya yalnız EveryCafe açık oturum bilgisi
  // bu tabloya kayıt oluşturmaz; dolayısıyla sayfa açılmadan mesaj gönderilemez.
  db.run(`CREATE TABLE IF NOT EXISTS spin_page_sessions (
    session_id TEXT PRIMARY KEY,
    masa INTEGER NOT NULL,
    opened_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_spin_page_sessions_masa
    ON spin_page_sessions(masa,opened_at DESC)`);

  // v3.0.22 tek-seferlik güvenli geçiş:
  // Eski EveryCafe canlı senkronu `masalar.start_time` alanına kaynak oturum
  // başlangıcını yazabiliyordu. Yalnızca başlangıcı EveryCafe source_start ile
  // TAM eşleşen satırlar bu eski otomatik yazım olarak kabul edilir ve temizlenir.
  // Index tarafından gerçekten başlatılmış farklı bir çark sayacı/hakkı silinmez.
  db.get("SELECT value FROM settings WHERE key='spin_page_gate_v3022'", (gateErr, gateRow) => {
    if (gateErr) return logErr("spin_page_gate_v3022 read", gateErr);
    if (gateRow && String(gateRow.value || "") === "1") return;
    db.run(
      `DELETE FROM masalar
       WHERE EXISTS (
         SELECT 1
         FROM everycafe_active_sessions e
         WHERE e.masa=masalar.masa
           AND CAST(e.source_start AS INTEGER)=CAST(masalar.start_time AS INTEGER)
       )`,
      (clearErr) => {
        if (clearErr) return logErr("spin_page_gate_v3022 cleanup", clearErr);
        db.run(
          "INSERT INTO settings(key,value) VALUES('spin_page_gate_v3022','1') ON CONFLICT(key) DO UPDATE SET value='1'",
          (markErr) => {
            if (markErr) logErr("spin_page_gate_v3022 mark", markErr);
          }
        );
      }
    );
  });

  // EveryCafe urun/kategori aynasi. Bu tablolar KafePin Dogrudan Satis
  // product_catalog tablosundan tamamen ayridir; kaynak EveryCafe ve yon tek yonludur.
  db.run(`
    CREATE TABLE IF NOT EXISTS everycafe_catalog_categories (
      category_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      first_seen_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0,
      last_seen_at INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS everycafe_catalog_products (
      stock_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category_id INTEGER DEFAULT 0,
      category_name TEXT DEFAULT '',
      price REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      first_seen_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0,
      last_seen_at INTEGER DEFAULT 0
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_everycafe_catalog_products_category
    ON everycafe_catalog_products(category_id,active,sort_order)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS everycafe_catalog_sync_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      last_attempt INTEGER DEFAULT 0,
      last_success INTEGER DEFAULT 0,
      last_error TEXT DEFAULT '',
      source_categories INTEGER DEFAULT 0,
      source_products INTEGER DEFAULT 0,
      category_added INTEGER DEFAULT 0,
      category_updated INTEGER DEFAULT 0,
      category_deactivated INTEGER DEFAULT 0,
      product_added INTEGER DEFAULT 0,
      product_updated INTEGER DEFAULT 0,
      product_deactivated INTEGER DEFAULT 0,
      price_changed INTEGER DEFAULT 0,
      name_changed INTEGER DEFAULT 0,
      category_moved INTEGER DEFAULT 0
    )
  `);
  db.run(`INSERT OR IGNORE INTO everycafe_catalog_sync_state(id) VALUES(1)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS card_settlements (
      settlement_key TEXT PRIMARY KEY,
      actual_net REAL DEFAULT 0,
      confirmed_at INTEGER DEFAULT 0,
      note TEXT DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS accounting_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER NOT NULL,
      type TEXT NOT NULL,
      category TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      method TEXT DEFAULT 'CASH',
      account TEXT DEFAULT '',
      note TEXT DEFAULT '',
      voided INTEGER DEFAULT 0,
      voided_at INTEGER DEFAULT 0
    )
  `);
  runAlter("ALTER TABLE accounting_entries ADD COLUMN account TEXT DEFAULT ''", "alter accounting_entries account");
  db.run(`CREATE INDEX IF NOT EXISTS idx_accounting_entries_time ON accounting_entries(time,voided)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS account_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER NOT NULL,
      from_account TEXT NOT NULL,
      to_account TEXT NOT NULL,
      amount REAL DEFAULT 0,
      note TEXT DEFAULT '',
      voided INTEGER DEFAULT 0,
      voided_at INTEGER DEFAULT 0
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_account_transfers_time ON account_transfers(time,voided)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS admin_preferences (
      pref_key TEXT PRIMARY KEY,
      pref_value TEXT DEFAULT '',
      updated_at INTEGER DEFAULT 0
    )
  `);

  // v3.0.16: Açılışta örnek/varsayılan ürün ÜRETİLMEZ.
  // Ürün ve kategori kataloğu yalnız kullanıcı EveryCafe Senkron'a bastığında
  // kaynak EveryCafe'den tek yönlü olarak aynalanır.
  cleanupLegacyAutoSeedProducts();

  db.get("SELECT value FROM settings WHERE key='everycafe_maintenance_mode'", (err, row) => {
    if (err) return logErr("settings everycafe_maintenance_mode", err);
    if (!row) {
      db.run("INSERT INTO settings (key,value) VALUES ('everycafe_maintenance_mode','0')");
      EVERYCAFE_MAINTENANCE_MODE = 0;
      return;
    }
    EVERYCAFE_MAINTENANCE_MODE = String(row.value) === "1" ? 1 : 0;
  });

  db.run("CREATE INDEX IF NOT EXISTS idx_spins_masa_time ON spins(masa, time)");
  db.run("CREATE INDEX IF NOT EXISTS idx_spins_time ON spins(time)");
  db.run("CREATE INDEX IF NOT EXISTS idx_spins_log_time ON spins_log(time)");
  db.run("CREATE INDEX IF NOT EXISTS idx_spins_log_masa_time ON spins_log(masa, time)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_end_time ON sessions(end_time)");
  db.run("CREATE INDEX IF NOT EXISTS idx_real_adjustments_day_key ON real_adjustments(day_key)");
  db.run("CREATE INDEX IF NOT EXISTS idx_real_adjustments_masa_session_start ON real_adjustments(masa, session_start)");
  db.run("CREATE INDEX IF NOT EXISTS idx_session_history_masa_start_end ON session_history(masa, start_time, end_time)");

db.get("SELECT value FROM settings WHERE key='global_spin_count'", (err, row) => {
    if (err) {
      logErr("settings global_spin_count", err);
      return;
    }

    if (!row) {
      db.run("INSERT INTO settings (key,value) VALUES ('global_spin_count','0')");
      globalSpinCount = 0;
      return;
    }

    const v = parseInt(row.value, 10);
    globalSpinCount = !isNaN(v) && v >= 0 ? v : 0;

    db.get(
      "SELECT value FROM settings WHERE key='telegram_live_message_id'",
      (err, row) => {

        if (!err && row && row.value) {
          liveMessageId = parseInt(row.value, 10) || 0;
        }

      }
    );
});
});

function seedRewardsIfEmpty() {
  const myRewards = [
    { name: "Şansına küs", weight: 40 },
    { name: "Soda", weight: 6 },
    { name: "Bir dahaki sefere", weight: 20 },
    { name: "Enerji içeceği", weight: 4 },
    { name: "30 dakika ek süre", weight: 15 },
    { name: "Ülker Crax", weight: 5 },
    { name: "Kola", weight: 4 },
    { name: "60 dakika ek süre", weight: 4 },
    { name: "Çikolatalı Gofret", weight: 12 },
    { name: "Tekrar dene :)", weight: 6 }
  ];

  db.get("SELECT COUNT(*) as cnt FROM rewards", (err, row) => {
    if (err) {
      logErr("seedRewardsIfEmpty count", err);
      return;
    }

    const cnt = row && row.cnt ? row.cnt : 0;
    if (cnt > 0) return;

    console.log("🎁 Rewards boştu, başlangıç ödülleri yükleniyor...");

    db.serialize(() => {
      const stmt = db.prepare("INSERT INTO rewards (name, weight, active) VALUES (?,?,1)");
      myRewards.forEach((r) => stmt.run(r.name, r.weight));
      stmt.finalize(() => console.log("✅ Rewards yüklendi."));
    });
  });
}
seedRewardsIfEmpty();

function getSpinSureMs() {
  return SPIN_WAIT_MS;
}

// Çark sayacı yalnız çark sayfası ilk kez açıldığında ve her başarılı spin
// sonrasında başlar. EveryCafe ücretsiz/hediye süreleri çark sayacını değiştirmez.
function getSpinReadyAt(startTime) {
  return (Number(startTime) || 0) + SPIN_WAIT_MS;
}

// EveryCafe Manager'ın sahada doğrulanan Messenger paketi:
// SENDMESSAGE iç komutu UTF-8 -> Base64, ardından komutun tamamı tekrar Base64
// yapılıp ClientIP:Comm1Port adresine UDP ile gönderilir. Bu fonksiyon EveryCafe
// veritabanına hiçbir kayıt EKLEMEZ; yalnız readEveryCafeMessengerTarget üzerinden okur.
function buildEveryCafeMessengerPacket(serverGuid, clientIp, serverName, message) {
  const message64 = Buffer.from(String(message || ""), "utf8").toString("base64");
  const command = `SENDMESSAGE:ServerGuid=${String(serverGuid || "")};ClientIP=${String(clientIp || "")};ServerName=${String(serverName || "")};Message=${message64};`;
  return Buffer.from(Buffer.from(command, "utf8").toString("base64"), "ascii");
}

function readEveryCafeMessengerTarget(sessionId, cb) {
  const sid = String(sessionId || "").trim();
  if (!sid) return cb(new Error("EveryCafe Messenger session_id eksik"));
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    source.get(
      `SELECT s.SessionID,s.ClientGuid,c.ClientName,c.ClientIP,c.ClientStatus,
              si.ServerGuid,si.ServerName,si.Comm1Port
       FROM Sessions s
       JOIN Clients c ON c.ClientGuid=s.ClientGuid
       CROSS JOIN ServerInfo si
       WHERE s.SessionID=?
         AND COALESCE(s.Deleted,0)=0
         AND COALESCE(s.IsActive,0)=1
         AND COALESCE(c.ClientIsDeleted,0)=0
         AND COALESCE(c.ClientIsActive,0)=1
       LIMIT 1`,
      [sid],
      (readErr, row) => {
        source.close(() => {});
        if (readErr) return cb(readErr);
        if (!row) return cb(null, null);
        const clientIp = String(row.ClientIP || "").trim();
        const serverGuid = String(row.ServerGuid || "").trim();
        const serverName = String(row.ServerName || "").trim();
        const port = Math.max(1, Math.min(65535, Number(row.Comm1Port) || 45456));
        const clientStatus = Number(row.ClientStatus) || 0;
        const clientRunning = clientStatus === 1
          || ((clientStatus & 4) === 4)
          || ((clientStatus & 128) === 128)
          || ((clientStatus & 1024) === 1024);
        if (!clientIp || !serverGuid || !serverName || !clientRunning) return cb(null, null);
        cb(null, {
          sessionId: sid,
          clientGuid: String(row.ClientGuid || ""),
          clientName: String(row.ClientName || ""),
          clientIp, clientStatus, serverGuid, serverName, port
        });
      }
    );
  });
}

function sendEveryCafeClientMessage(target, message, cb = () => {}) {
  const clientIp = String(target && target.clientIp || "").trim();
  const port = Number(target && target.port) || 45456;
  if (!clientIp) return cb(new Error("EveryCafe Client IP bulunamadı"));
  let socket;
  let done = false;
  const finish = (err) => {
    if (done) return;
    done = true;
    try { if (socket) socket.close(); } catch (_e) {}
    cb(err || null);
  };
  try {
    const packet = buildEveryCafeMessengerPacket(target.serverGuid, clientIp, target.serverName, message);
    socket = dgram.createSocket("udp4");
    socket.once("error", finish);
    socket.send(packet, 0, packet.length, port, clientIp, finish);
  } catch (err) {
    finish(err);
  }
}

function markEveryCafeSpinPageOpened(masa, sessionId, openedAt, cb = () => {}) {
  const key = Number(masa) || 0;
  const sid = String(sessionId || "").trim();
  const now = Number(openedAt) || Date.now();
  if (!key || !sid) return cb(null);
  db.run(
    `INSERT OR IGNORE INTO spin_page_sessions(session_id,masa,opened_at)
     VALUES(?,?,?)`,
    [sid, key, now],
    cb
  );
}

// Bildirim için aktif EveryCafe Session + gerçek sayfa-açılış işareti + 45 dk
// timer birlikte gerekir. Admin force-ready yalnız masalar.start_time değerini
// değiştirebilir; spin_page_sessions kaydı yoksa otomatik mesaj doğurmaz.
// Sayfa açıldıktan sonra pencere kapansa bile timer gerçek zamanda ilerler.
function checkEveryCafeSpinReadyNotifications(cb = () => {}) {
  if (everyCafeSpinReadyNotifyRunning) return cb(null, { skipped: true, reason: "busy" });
  everyCafeSpinReadyNotifyRunning = true;
  let finished = false;
  const finish = (err, result) => {
    if (finished) return;
    finished = true;
    everyCafeSpinReadyNotifyRunning = false;
    cb(err || null, result || {});
  };

  getEveryCafeConfig((configErr, config) => {
    if (configErr) return finish(configErr);
    if (!config || !config.enabled || !config.startAt) return finish(null, { skipped: true, reason: "disabled" });
    const now = Date.now();
    db.all(
      `SELECT m.masa,m.start_time AS timer_start,e.session_id,
              (SELECT COUNT(*) FROM spins sp
               WHERE sp.masa=m.masa
                 AND sp.time>=COALESCE(
                   (SELECT s.start_time FROM sessions s
                    WHERE s.masa=m.masa AND COALESCE(s.end_time,0)=0
                    LIMIT 1),0)) AS used_spins
       FROM masalar m
       JOIN everycafe_active_sessions e ON e.masa=m.masa
       JOIN spin_page_sessions p ON p.session_id=e.session_id AND p.masa=m.masa
       WHERE COALESCE(m.start_time,0)>0
         AND ? >= (m.start_time + ?)
       ORDER BY m.masa ASC`,
      [now, SPIN_WAIT_MS],
      (readErr, rows) => {
        if (readErr) return finish(readErr);
        const candidates = (rows || []).filter((row) => Number(row.used_spins) < GUNLUK_SPIN_LIMIT);
        let index = 0;
        let sent = 0;
        const next = () => {
          if (index >= candidates.length) return finish(null, { checked: candidates.length, sent });
          const row = candidates[index++];
          const masa = Number(row.masa) || 0;
          const timerStart = Number(row.timer_start) || 0;
          const sessionId = String(row.session_id || "").trim();
          if (!masa || !timerStart || !sessionId) return next();
          db.get(
            "SELECT sent_at FROM spin_ready_notifications WHERE session_id=? AND timer_start=? LIMIT 1",
            [sessionId, timerStart],
            (dedupeErr, existing) => {
              if (dedupeErr) return finish(dedupeErr);
              if (existing) return next();
              readEveryCafeMessengerTarget(sessionId, (targetErr, target) => {
                if (targetErr) {
                  const inserted = addEveryCafeIntegrationLog({category:"MESSAGE",level:"ERROR",masa,sessionId,event:"Çark hazır bildirimi hedefi okunamadı",sourceDetail:String(targetErr.message||targetErr),action:"Mesaj gönderilmedi; sonraki taramada yeniden denenecek",result:"EveryCafe DB salt-okunur kaldı",dedupeKey:`spin-ready-target:${sessionId}:${timerStart}`,dedupeMs:5*60*1000});
                  if (inserted) addLiveLog("spin_ready_message_error", `⚠️ Çark bildirimi hedefi okunamadı • Masa ${masa}`);
                  return next();
                }
                if (!target) {
                  const inserted = addEveryCafeIntegrationLog({category:"MESSAGE",level:"WARN",masa,sessionId,event:"Çark hazır bildirimi için aktif EveryCafe Client bulunamadı",sourceDetail:"Aktif Session/Client/IP eşleşmesi yok",action:"Mesaj gönderilmedi; sonraki taramada yeniden denenecek",result:"Güvenli bekleme",dedupeKey:`spin-ready-no-target:${sessionId}:${timerStart}`,dedupeMs:5*60*1000});
                  if (inserted) addLiveLog("spin_ready_message_error", `⚠️ Çark bildirimi gönderilemedi • Masa ${masa} • aktif EveryCafe Client bulunamadı`);
                  return next();
                }
                sendEveryCafeClientMessage(target, EVERYCAFE_SPIN_READY_MESSAGE, (sendErr) => {
                  if (sendErr) {
                    const inserted = addEveryCafeIntegrationLog({category:"MESSAGE",level:"ERROR",masa,sessionId,event:"Çark hazır bildirimi gönderilemedi",sourceDetail:`${target.clientIp}:${target.port}`,action:"UDP Messenger sonraki taramada yeniden denenecek",result:String(sendErr.message||sendErr),dedupeKey:`spin-ready-send:${sessionId}:${timerStart}`,dedupeMs:5*60*1000});
                    if (inserted) addLiveLog("spin_ready_message_error", `⚠️ Çark bildirimi gönderilemedi • Masa ${masa} • ${target.clientIp}`);
                    return next();
                  }
                  db.run(
                    `INSERT OR IGNORE INTO spin_ready_notifications(session_id,timer_start,masa,sent_at,client_ip)
                     VALUES(?,?,?,?,?)`,
                    [sessionId, timerStart, masa, Date.now(), target.clientIp],
                    (writeErr) => {
                      if (writeErr) return finish(writeErr);
                      sent += 1;
                      addLiveLog("spin_ready_message", `🎁 Çark bildirimi gönderildi • Masa ${masa} • ${target.clientIp}`);
                      addEveryCafeIntegrationLog({category:"MESSAGE",masa,sessionId,event:"Çark hakkı hazır bildirimi gönderildi",sourceDetail:`${target.clientName||`Masa ${masa}`} • ${target.clientIp}:${target.port}`,action:"EveryCafe Messenger UDP kanalı kullanıldı",result:"Tek sefer gönderildi • EveryCafe DB'ye yazma yok",details:{timerStart,usedSpins:Number(row.used_spins)||0}});
                      next();
                    }
                  );
                });
              });
            }
          );
        };
        next();
      }
    );
  });
}

function getReqIp(req) {
  return String(req.socket?.remoteAddress || req.ip || "")
    .split(",")[0]
    .trim()
    .replace("::ffff:", "");
}

function getMasaFromRequest(req) {
  const masa = parseInt(req.body?.masa, 10);
  const token = String(req.body?.token || "").trim();
  const ip = getReqIp(req);

  if (!masa || masa < 1 || masa > MASA_SAYISI) {
    return null;
  }

  if (!token) {
    return null;
  }

  if (MASA_TOKENS[masa] !== token) {
    return null;
  }

// IP kontrolü kaldırıldı.
// İstenirse sadece log tutabiliriz.
logInfo("TOKEN_LOGIN", {
  masa,
  ip
});


return masa;
}

function sumRealRevenueInRangeFromSessions(sessions, start, end, nowTs) {
  let sum = 0;

  (sessions || []).forEach((s) => {
    const masa = s.masa;
    if (isFreeMasa(masa)) return;

    const st = s.start_time || 0;
    if (!st) return;

    const sessionEnd = s.end_time && s.end_time > 0 ? s.end_time : s.last_seen || nowTs;

    if (sessionEnd <= start) return;
    if (st >= end) return;

    const a = Math.max(start, st);
    const b = Math.min(end, sessionEnd);
    if (b <= a) return;

    const feeB = feeAtTime(masa, st, b);
    const feeA = feeAtTime(masa, st, a);
    const delta = feeB - feeA;

    if (delta > 0) sum += delta;
  });

  return sum;
}

// Kapanan oturumlar SESSION_FINALIZE kaydında tek toplam olarak tutulur.
// Oturum gün devrini geçtiyse bu toplamı kapanış/başlangıç gününe yığmak
// yerine, aktif oturumlarda olduğu gibi ücret eğrisine göre aralıklara böler.
function sumFinalizedRevenueInRange(adjustments, start, end) {
  let sum = 0;

  (adjustments || []).forEach((a) => {
    if (String(a.kind || "").trim() !== "SESSION_FINALIZE") return;

    const masa = Number(a.masa) || 0;
    const sessionStart = Number(a.session_start) || 0;
    const sessionEnd = Number(a.time) || 0;
    const recordedTotal = Math.max(Number(a.amount) || 0, 0);

    if (!masa || !sessionStart || !sessionEnd || sessionEnd <= sessionStart) return;
    if (sessionEnd <= start || sessionStart >= end) return;

    // Tüm zamanlar toplamında veritabanına sabitlenen kesin tutarı kullan.
    if (start <= sessionStart && end >= sessionEnd) {
      sum += recordedTotal;
      return;
    }

    const rangeStart = Math.max(start, sessionStart);
    const rangeEnd = Math.min(end, sessionEnd);
    if (rangeEnd <= rangeStart) return;

    const feeAtRangeEnd = feeAtTime(masa, sessionStart, rangeEnd);
    const feeAtRangeStart =
      rangeStart <= sessionStart ? 0 : feeAtTime(masa, sessionStart, rangeStart);

    sum += Math.max(Math.min(feeAtRangeEnd - feeAtRangeStart, recordedTotal), 0);
  });

  return sum;
}

function isLocked(masa, now) {
  const until = sessionLocks.get(masa) || 0;
  if (!until) return false;
  if (now < until) return true;

  sessionLocks.delete(masa);
  db.run("DELETE FROM session_locks WHERE masa=?", [masa], (err) => logErr("unlock delete session_locks", err));
  return false;
}

function setLock(masa, untilTs) {
  sessionLocks.set(masa, untilTs);
  const now = Date.now();
  db.run(
    "INSERT INTO session_locks(masa, until_time, set_time) VALUES(?,?,?) ON CONFLICT(masa) DO UPDATE SET until_time=excluded.until_time, set_time=excluded.set_time",
    [masa, untilTs, now],
    (err) => logErr("setLock", err)
  );
}

function recordTokenHit(masa, req) {
  const ip = getReqIp(req);
  const now = Date.now();

  if (!tokenTracker[masa]) tokenTracker[masa] = [];

  tokenTracker[masa].push({
    ip,
    time: now
  });

  tokenTracker[masa] = tokenTracker[masa]
    .filter((x) => now - x.time <= 24 * 60 * 60 * 1000)
    .slice(-50);
}



function isBlockedMasa(masa, cb) {
  db.get(
    "SELECT until_time FROM blocked_masalar WHERE masa=?",
    [masa],
    (err, row) => {
      if (err) {
        logErr("isBlockedMasa", err);
        return cb(false, 0);
      }

      if (!row) {
        blockedMasalar.delete(masa);
        return cb(false, 0);
      }

      const untilTime = parseInt(row.until_time, 10) || 0;

      if (untilTime <= Date.now()) {
        db.run("DELETE FROM blocked_masalar WHERE masa=?", [masa], (e2) => {
          logErr("isBlockedMasa delete expired", e2);
        });
        blockedMasalar.delete(masa);
        return cb(false, 0);
      }

      blockedMasalar.add(masa);
      return cb(true, untilTime);
    }
  );
}

function setBlockedMasa(masa, untilTime, reason, cb) {
  db.run(
    `
    INSERT INTO blocked_masalar(masa, until_time, reason, set_time)
    VALUES(?,?,?,?)
    ON CONFLICT(masa) DO UPDATE SET
      until_time=excluded.until_time,
      reason=excluded.reason,
      set_time=excluded.set_time
    `,
    [masa, untilTime, String(reason || ""), Date.now()],
    (err) => {
      if (err) logErr("setBlockedMasa", err);
      if (!err) blockedMasalar.add(masa);
      cb && cb(err);
    }
  );
}

function clearBlockedMasa(masa, cb) {
  db.run("DELETE FROM blocked_masalar WHERE masa=?", [masa], (err) => {
    if (err) logErr("clearBlockedMasa", err);
    blockedMasalar.delete(masa);
    cb && cb(err);
  });
}

function telegramEscape(s) {
  return String(s || "");
}

const TELEGRAM_PAYLOAD_DEDUP_MS = 45 * 1000;
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
function editTelegramMessage(messageId, text, cb) {

  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    message_id: messageId,
    text
  });

  const req = https.request(
    {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    },
    res => {

      let data = "";

      res.on("data", c => data += c);

      res.on("end", ()=>{

        if(res.statusCode>=200 && res.statusCode<300){
          cb && cb(null,data);
        }else{
          cb && cb(new Error(data));
        }

      });

    }
  );

  req.on("error",err=>cb&&cb(err));

  req.write(body);

  req.end();

}
function deleteTelegramMessage(messageId, cb) {

    if (!TELEGRAM_ENABLED || !messageId) {
        cb && cb();
        return;
    }

    const url =
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`;

    fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            message_id: messageId
        })
    })
    .then(r => r.json())
    .then(d => {

        if (!d.ok) {
            console.log("Telegram mesaj silinemedi:", d.description);
            cb && cb(new Error(d.description || "Telegram mesajı silinemedi"));
            return;
        } else {
            console.log("🗑 Telegram canlı mesaj silindi.");
        }

        cb && cb(null);

    })
    .catch(err => {

        console.error("deleteTelegramMessage:", err);
        cb && cb(err);

    });

}
let liveMonitorMoveTimer = null;
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

let liveMonitorBusy = false;

function sendLiveMonitor() {
  if (liveMonitorBusy) return;
  liveMonitorBusy = true;
  const finishLiveMonitor = () => {
    liveMonitorBusy = false;
  };

  db.all("SELECT * FROM sessions WHERE end_time=0", (e, rows) => {
    if (e) {
      finishLiveMonitor();
      return;
    }

    const liveNow = Date.now();
    const activeRows = (rows || []).slice().sort((a, b) => a.masa - b.masa);
    let txt = "📊 KAFEPİN CANLI DURUM\n\n";
    txt += "🕒 " + new Date(liveNow).toLocaleTimeString("tr-TR") + "\n\n";

    // Açık masa borcu = anlık bilgisayar tutarı + bu oturuma yazılmış açık ürünler.
    // Yalnız aktif oturumun manuel ücret düzeltmeleri anlık borca yansır; çark maliyeti ciro/masa borcundan ayrıdır.
    const sessionStarts = activeRows
      .map((r) => Number(r.start_time) || 0)
      .filter((v) => v > 0);

    const buildActiveDebt = (adjustmentRows, productRows) => {
      const adjMap = new Map();
      (adjustmentRows || []).forEach((r) => {
        adjMap.set(`${Number(r.masa) || 0}:${Number(r.session_start) || 0}`, Number(r.adj) || 0);
      });

      const productMap = new Map();
      (productRows || []).forEach((r) => {
        productMap.set(`${Number(r.masa) || 0}:${Number(r.session_start) || 0}`, Number(r.product_total) || 0);
      });

      let activeDebtTotal = 0;
      let activeComputerDebtTotal = 0;
      let activeProductDebtTotal = 0;
      let activePendingCount = 0;

      activeRows.forEach((r) => {
        const masa = Number(r.masa) || 0;
        const startTime = Number(r.start_time) || 0;
        const end = Number(r.last_seen) || liveNow;
        const scheduledEnd = isEveryCafeTimedMasa(masa) ? getEveryCafeScheduledEnd(masa) : 0;
        const billedEnd = scheduledEnd > startTime
          ? Math.min(end, scheduledEnd - 1)
          : end;
        const dakika = startTime > 0 ? Math.max(0, Math.floor((billedEnd - startTime) / 60000)) : 0;
        const baseFee = startTime > 0 && !isFreeMasa(masa)
          ? feeAtTime(masa, startTime, billedEnd)
          : 0;
        const key = `${masa}:${startTime}`;
        const adjustment = Number(adjMap.get(key)) || 0;
        const productTotal = Number(productMap.get(key)) || 0;
        const computerDebt = Math.max(baseFee + adjustment, 0);
        const currentDebt = Math.max(computerDebt + productTotal, 0);

        activeComputerDebtTotal += computerDebt;
        activeProductDebtTotal += productTotal;
        activeDebtTotal += currentDebt;
        if (currentDebt >= 0.005) activePendingCount += 1;

        const icon = VIP_MASALAR.includes(masa) ? "⭐" : "🖥️";
        txt += `${icon} Masa ${String(masa).padStart(2, "0")} | ⏱️ ${dakika} dk | 💰 ${currentDebt.toFixed(2)} ₺\n`;
      });

      txt += "\n━━━━━━━━━━━━━━━━━━━━━━\n";
      txt += `🎮 Aktif Masa : ${activeRows.length}\n`;
      txt += `🖥️ Aktif PC/Süre Ücreti : ${activeComputerDebtTotal.toFixed(2)} ₺\n`;
      txt += `🍽️ Aktif Masaya Yazılan Ürün : ${activeProductDebtTotal.toFixed(2)} ₺\n`;
      txt += `💰 Aktif Toplam Borç : ${activeDebtTotal.toFixed(2)} ₺\n`;

      const liveDayStart = dayStartTs(liveNow);
      const liveDayEnd = liveDayStart + 24 * 60 * 60 * 1000;

      db.get(
        `SELECT COALESCE(SUM(total),0) AS total,
                COALESCE(SUM(quantity),0) AS quantity
         FROM product_sales
         WHERE time>=? AND time<? AND voided=0`,
        [liveDayStart, liveDayEnd],
        (productErr, productRow) => {
          if (productErr) logErr("sendLiveMonitor product totals", productErr);

          db.get(
            `SELECT
               COALESCE(SUM(CASE WHEN method='CASH' AND COALESCE(NULLIF(paid_at,0),created_at)>=? AND COALESCE(NULLIF(paid_at,0),created_at)<? THEN total_amount ELSE 0 END),0) AS cash,
               COALESCE(SUM(CASE WHEN method='CARD' AND COALESCE(NULLIF(paid_at,0),created_at)>=? AND COALESCE(NULLIF(paid_at,0),created_at)<? THEN total_amount ELSE 0 END),0) AS card,
               COALESCE(SUM(CASE WHEN method='PENDING' AND created_at>=? AND created_at<? THEN total_amount ELSE 0 END),0) AS pending,
               COALESCE(SUM(CASE WHEN method='PENDING' AND created_at>=? AND created_at<? THEN 1 ELSE 0 END),0) AS pending_count
             FROM payments
             WHERE voided=0`,
            [liveDayStart, liveDayEnd, liveDayStart, liveDayEnd, liveDayStart, liveDayEnd, liveDayStart, liveDayEnd],
            (paymentErr, paymentRow) => {
              if (paymentErr) logErr("sendLiveMonitor payment totals", paymentErr);

              // Canlı Telegram finans özetinde EveryCafe "gerçek gelir" doğrudan
              // salt-okunur kaynak veritabanından okunur. Yerel aktarım gecikse bile
              // kaynak ciro kartlarıyla aynı rakamı gösterir.
              // Canlı durum KafePin'in 20:00-20:00 kafe gününü kullanır.
              const everyCafeSourceStart = liveDayStart;
              const everyCafeSourceEnd = liveDayEnd;
              readEveryCafePaymentAuditSnapshot(Math.max(0, everyCafeSourceStart - 1000), (sourceReadErr, sourceSnapshot) => {
                if (sourceReadErr) logErr("sendLiveMonitor EveryCafe source totals", sourceReadErr);
                let everyCafeSourceSummary = null;
                if (!sourceReadErr) {
                  try {
                    everyCafeSourceSummary = summarizeEveryCafeBusinessDaySnapshot(
                      sourceSnapshot || {},
                      everyCafeSourceStart,
                      everyCafeSourceEnd
                    );
                  } catch (sourceSummaryErr) {
                    logErr("sendLiveMonitor EveryCafe source summary", sourceSummaryErr);
                  }
                }

              getRangeStats(liveDayStart, liveDayEnd, (rangeErr, dailyStats) => {
                if (rangeErr) logErr("sendLiveMonitor daily range stats", rangeErr);
                dailyStats = dailyStats || {};

                const adminDuzeltme = Number(dailyStats.adminDuzeltmeleri) || 0;
                const spinMaliyeti = Number(dailyStats.spinMaliyeti) || 0;
                const masaGeliri = Number(dailyStats.gercekGelir) || 0;
                const productTotal = Number(dailyStats.productGeliri) || Number(productRow && productRow.total) || 0;
                const productQuantity = Number(dailyStats.productAdedi) || Number(productRow && productRow.quantity) || 0;
                const masaUrun = Number(dailyStats.masaUrunGeliri) || 0;
                const kafePinDirect = Number(dailyStats.kafePinDirectGeliri) || 0;
                const everyCafeDirect = Number(dailyStats.everyCafeDirectGeliri) || 0;
                const everyCafeUye = Number(dailyStats.everyCafeUyeGeliri) || 0;
                const everyCafeDiger = Number(dailyStats.everyCafeDigerGeliri) || 0;
                const digerUrun = Number(dailyStats.digerUrunGeliri) || 0;
                const everyCafeGercekGelir = everyCafeSourceSummary
                  ? (Number(everyCafeSourceSummary.total) || 0)
                  : (Number(dailyStats.everyCafeGenelGelir) || 0);
                const everyCafeDevirGeliri = everyCafeSourceSummary
                  ? (Number(everyCafeSourceSummary.rolloverTotal) || 0)
                  : 0;
                const everyCafeDevirAdedi = everyCafeSourceSummary
                  ? (Number(everyCafeSourceSummary.rolloverCount) || 0)
                  : 0;
                // Tek ciro kuralı: EveryCafe gerçek kaynak + yalnız KafePin doğrudan satış.
                // Çark maliyeti bu toplamdan hiçbir zaman düşülmez.
                const genelGelir = everyCafeGercekGelir + kafePinDirect;
                const closedMasaGeliriRaw = masaGeliri - activeComputerDebtTotal;
                const closedMasaGeliri = Math.abs(closedMasaGeliriRaw) < 0.005
                  ? 0
                  : closedMasaGeliriRaw;

                const cash = Number(paymentRow && paymentRow.cash) || 0;
                const card = Number(paymentRow && paymentRow.card) || 0;
                const closedPending = Number(paymentRow && paymentRow.pending) || 0;
                const closedPendingCount = Number(paymentRow && paymentRow.pending_count) || 0;
                const pending = closedPending + activeDebtTotal;
                const pendingCount = closedPendingCount + activePendingCount;
                const collected = cash + card;
                const controlTotal = collected + pending;
                const controlDiff = genelGelir - controlTotal;

                txt += `\n📅 BUGÜN SATIŞ DAĞILIMI\n`;
                txt += `\n🖥️ Bugünkü PC/Masa Süre Ücreti : ${masaGeliri.toFixed(2)} ₺`;
                txt += `\n   ✅ Kapanmış Masalar : ${closedMasaGeliri.toFixed(2)} ₺`;
                txt += `\n   ⏳ Açık Masalar : ${activeComputerDebtTotal.toFixed(2)} ₺`;
                if (Math.abs(adminDuzeltme) >= 0.005) {
                  txt += `\n🛠️ Admin Düzeltmesi : ${adminDuzeltme >= 0 ? "+" : ""}${adminDuzeltme.toFixed(2)} ₺ (PC/Masa ücretine dahil)`;
                }
                if (spinMaliyeti >= 0.005) {
                  txt += `\n🎁 Çark Maliyeti : ${spinMaliyeti.toFixed(2)} ₺ (cirodan düşülmez; ayrı maliyet)`;
                }

                txt += `\n\n☕ Ürün/Hizmet Satışı : ${productTotal.toFixed(2)} ₺ (${productQuantity} adet)`;
                txt += `\n   🍽️ Masaya Yazılan : ${masaUrun.toFixed(2)} ₺`;
                txt += `\n   🧾 KafePin Doğrudan : ${kafePinDirect.toFixed(2)} ₺`;
                txt += `\n   🏪 EveryCafe Doğrudan : ${everyCafeDirect.toFixed(2)} ₺`;
                txt += `\n   👤 EveryCafe Üye/Bakiye : ${everyCafeUye.toFixed(2)} ₺`;
                if (everyCafeDiger >= 0.005) {
                  txt += `\n   ➕ EveryCafe Diğer : ${everyCafeDiger.toFixed(2)} ₺`;
                }
                if (digerUrun >= 0.005) {
                  txt += `\n   📦 Diğer Ürün/Hizmet : ${digerUrun.toFixed(2)} ₺`;
                }

                txt += `\n\n🖥️ EveryCafe Gerçek Gelir : ${everyCafeGercekGelir.toFixed(2)} ₺`;
                txt += `\n♻️ 20:00 Devir Geliri : ${everyCafeDevirGeliri.toFixed(2)} ₺${everyCafeDevirAdedi ? ` (${everyCafeDevirAdedi} masa)` : ""}`;
                txt += `\n🧾 KafePin Doğrudan Satış : ${kafePinDirect.toFixed(2)} ₺`;
                txt += `\n💰 Bugün Oluşan Toplam : ${genelGelir.toFixed(2)} ₺`;
                txt += `\n🔎 Ciro Kaynağı : ${everyCafeGercekGelir.toFixed(2)} + ${kafePinDirect.toFixed(2)} = ${genelGelir.toFixed(2)} ₺`;
                txt += `\n\n━━━━━━━━━━━━━━━━━━━━━━`;
                txt += `\n🧾 TAHSİLAT DURUMU\n`;
                txt += `\n💵 Nakit : ${cash.toFixed(2)} ₺`;
                txt += `\n💳 Kart : ${card.toFixed(2)} ₺`;
                txt += `\n⏳ Bekleyen : ${pending.toFixed(2)} ₺ (${pendingCount} açık hesap)`;
                txt += `\n✅ Tahsil Edilen : ${collected.toFixed(2)} ₺`;

                if (Math.abs(controlDiff) < 0.01) {
                  txt += `\n\n🔎 Kontrol : ${collected.toFixed(2)} + ${pending.toFixed(2)} = ${controlTotal.toFixed(2)} ₺ ✅`;
                } else {
                  txt += `\n\n⚠️ Kontrol : ${collected.toFixed(2)} + ${pending.toFixed(2)} = ${controlTotal.toFixed(2)} ₺ • Oluşan toplam farkı ${controlDiff.toFixed(2)} ₺`;
                }

                txt += `\n\n🕒 Son Güncelleme : ${new Date().toLocaleTimeString("tr-TR")}`;

                if (liveMessageId == 0) {
                  sendTelegramMessage(txt, (err, data) => {
                    if (err) {
                      console.error("sendLiveMonitor sendTelegramMessage:", err);
                      finishLiveMonitor();
                      return;
                    }

                    try {
                      const j = JSON.parse(data);
                      liveMessageId = j.result.message_id;
                      db.run(
                        `
                        INSERT INTO settings(key,value)
                        VALUES('telegram_live_message_id',?)
                        ON CONFLICT(key)
                        DO UPDATE SET value=excluded.value
                        `,
                        [String(liveMessageId)],
                        () => finishLiveMonitor()
                      );
                    } catch (parseErr) {
                      console.error("Canlı Telegram message_id okunamadı:", parseErr);
                      finishLiveMonitor();
                    }
                  });
                } else {
                  editTelegramMessage(liveMessageId, txt, (err) => {
                    if (!err) {
                      console.log("✅ Canlı durum güncellendi");
                      finishLiveMonitor();
                      return;
                    }

                    console.error("❌ editTelegramMessage hatası:", err);

                    const editError = String(err && err.message ? err.message : err).toLowerCase();
                    const messageNoLongerExists =
                      editError.includes("message to edit not found") ||
                      editError.includes("message can't be edited") ||
                      editError.includes("message_id_invalid");

                    if (!messageNoLongerExists) {
                      finishLiveMonitor();
                      return;
                    }

                    liveMessageId = 0;
                    db.run(
                      "UPDATE settings SET value='0' WHERE key='telegram_live_message_id'",
                      () => {
                        finishLiveMonitor();
                        setTimeout(sendLiveMonitor, 500);
                      }
                    );
                  });
                }
              });
              });
            }
          );
        }
      );
    };

    if (!sessionStarts.length) {
      buildActiveDebt([], []);
      return;
    }

    const placeholders = sessionStarts.map(() => "?").join(",");
    db.all(
      `SELECT masa,session_start,COALESCE(SUM(amount),0) AS adj
       FROM real_adjustments
       WHERE session_start IN (${placeholders})
       GROUP BY masa,session_start`,
      sessionStarts,
      (adjustmentErr, adjustmentRows) => {
        if (adjustmentErr) logErr("sendLiveMonitor active adjustments", adjustmentErr);

        db.all(
          `SELECT masa,session_start,COALESCE(SUM(total),0) AS product_total
           FROM product_sales
           WHERE voided=0 AND sale_type='TABLE' AND status='OPEN'
             AND session_start IN (${placeholders})
           GROUP BY masa,session_start`,
          sessionStarts,
          (activeProductErr, activeProductRows) => {
            if (activeProductErr) logErr("sendLiveMonitor active products", activeProductErr);
            buildActiveDebt(adjustmentRows || [], activeProductRows || []);
          }
        );
      }
    );
  });
}

function sendSessionStartTelegram(masa, startTime) {
  if (!TELEGRAM_ENABLED) return;

  const last = lastStartSent.get(masa) || 0;
if (startTime - last < 10000) return;

  lastStartSent.set(masa, startTime);

  const msg =
    `🟢 Masa ${masa} bağlandı\n` +
    `🕒 Başlangıç: ${new Date(startTime).toLocaleString("tr-TR")}`;

  sendTelegramMessage(msg, (err) => {
    if (err) {
      logErr("sendSessionStartTelegram", err);
      return;
    }
    moveLiveMonitorToBottomSoon();
  });
}

function sendSessionEndTelegram(masa, startTime, endTime, fee) {
  if (!TELEGRAM_ENABLED) return;

  const dedupKey = `end:${masa}:${startTime}`;
  if (!shouldSendTelegramDedup(dedupKey, TELEGRAM_DEDUP_MS)) return;

  
db.get(
  `
  SELECT COALESCE(SUM(amount),0) as adj
  FROM real_adjustments
  WHERE masa=? 
    AND session_start=? 
    AND kind IN ('MANUAL_FEE_ADJUST','ZERO_FEE')
  `,
  [masa, startTime],
  (err, row) => {

const adj = (row && row.adj) ? Number(row.adj) : 0;

const finalFee =
  Number(fee) || 0;

let minutes = Math.floor((endTime - startTime) / 60000);
    if (minutes < 0) minutes = 0;

    const saat = Math.floor(minutes / 60);
    const dk2 = minutes % 60;

    const msg =
      `🔴 Masa ${masa} kapandı\n` +
      `🕒 Başlangıç: ${new Date(startTime).toLocaleString("tr-TR")}\n` +
      `🕒 Bitiş: ${new Date(endTime).toLocaleString("tr-TR")}\n` +
      `⏱️ Süre: ${saat}s ${dk2}dk\n` +
      `💰 Normal: ${fee} ₺\n` +
      `🛠️ Düzeltme: ${adj} ₺\n` +
      `🟢 Final: ${finalFee} ₺`;

sendTelegramMessage(msg, (err2) => {

  if (err2) {
    logErr("sendSessionEndTelegram", err2);
    return;
  }

  addLiveLog(
    "telegram",
    `📨 Telegram gönderildi • Masa ${masa}`
  );
  moveLiveMonitorToBottomSoon();

});

  }
);
}
function cleanupMasa(masa) {
diagnostics.cleanupCount++;
diagnostics.lastCleanup = Date.now();
diagnostics.lastCleanupMasa = masa;
  delete aktifMasalar[masa];
  delete latestRewardMap[masa];

  delete offlineCount[masa];
  delete lastOfflineState[masa];

  delete tokenTracker[masa];

  masaCloseLocks[masa] = Date.now() + 30000;

  // 30 saniye sonra kilidi temizle
  setTimeout(() => {
    delete masaCloseLocks[masa];
  }, 30000);

  if (masaPingStats[masa]) {
    masaPingStats[masa].last = 0;
    masaPingStats[masa].avg = PING_INTERVAL_MS;
    masaPingStats[masa].lastSeen = 0;
    masaPingStats[masa].netSpeed = 0;
  }
}

function sendBigRewardTelegram(masa, reward, time) {
  if (!TELEGRAM_ENABLED) return;

  const dedupKey = `big:${masa}:${reward}:${time}`;
  if (!shouldSendTelegramDedup(dedupKey, 30000)) return;

  const msg =
    `🎉 BÜYÜK ÖDÜL ÇIKTI\n` +
    `🖥️ Masa: ${masa}\n` +
    `🎁 Ödül: ${reward}\n` +
    `🕒 Saat: ${new Date(time).toLocaleString("tr-TR")}`;

  sendTelegramMessage(msg, (err) => {
    if (err) {
      logErr("sendBigRewardTelegram", err);
      return;
    }
    moveLiveMonitorToBottomSoon();
  });
}

function buildDailyTelegramReport(reportDateTs, stats) {
  const dateText = new Date(reportDateTs).toLocaleString("tr-TR");
  const startText = new Date(dayStartTs(reportDateTs)).toLocaleString("tr-TR");

  const topRewardText = stats.topReward
    ? `${stats.topReward.reward} (${stats.topReward.adet})`
    : "-";

  const topMasaText = stats.topMasa
    ? `Masa ${stats.topMasa.masa} (${stats.topMasa.adet} spin)`
    : "-";

  let rewardListText = "";
  if (stats.rewardList && stats.rewardList.length) {
    stats.rewardList.forEach((r) => {
      rewardListText += `\n${r.reward}: ${parseInt(r.adet, 10) || 0}`;
    });
  } else {
    rewardListText = "\n-";
  }

  return [
    "📊 KAFE GÜN SONU RAPORU",
    "",
    `🕒 Rapor Saati: ${dateText}`,
    `🎯 Gün Başlangıcı: ${startText}`,
    "",
    `💠 Toplam Spin: ${parseInt(stats.totalSpins || 0, 10)}`,
    `✅ Onaylanan Ödül: ${parseInt(stats.usedRewards || 0, 10)}`,
    "",
    `💰 Masa Brüt Geliri: ${(Number(stats.brutGelir) || 0).toFixed(2)} ₺`,
`🛠️ Admin Düzeltmeleri: ${(Number(stats.adminDuzeltmeleri) || 0).toFixed(2)} ₺`,
`🎁 Spin Maliyeti: ${(Number(stats.spinMaliyeti) || 0).toFixed(2)} ₺`,
`🖥️ Masa Gerçek Geliri: ${(Number(stats.gercekGelir) || 0).toFixed(2)} ₺`,
`☕ Ürün/Hizmet Geliri: ${(Number(stats.productGeliri) || 0).toFixed(2)} ₺ (${Number(stats.productAdedi) || 0} adet)`,
`🖥️ EveryCafe Genel Ciro: ${(Number(stats.everyCafeGenelGelir) || 0).toFixed(2)} ₺`,
`🧾 KafePin Doğrudan Satış: ${(Number(stats.kafePinDirectGeliri) || 0).toFixed(2)} ₺`,
`🟢 Genel Gelir: ${(Number(stats.genelGelir) || 0).toFixed(2)} ₺`,
    "",
`💵 Nakit Tahsilat: ${(Number(stats.nakitOdeme) || 0).toFixed(2)} ₺`,
`💳 Kart Tahsilat: ${(Number(stats.kartOdeme) || 0).toFixed(2)} ₺`,
`🧾 Tahsil Edilen: ${(Number(stats.tahsilEdilen) || 0).toFixed(2)} ₺`,
`⏳ Bekleyen Ödeme: ${(Number(stats.bekleyenOdeme) || 0).toFixed(2)} ₺ (${Number(stats.bekleyenAdet) || 0} hesap)`,
    "",
`🧾 Giderler: ${(Number(stats.giderler) || 0).toFixed(2)} ₺`,
`🏦 Kart Komisyonu (%1,87): ${(Number(stats.kartKomisyonu) || 0).toFixed(2)} ₺`,
`📈 Net İşletme Sonucu: ${(Number(stats.netIsletmeSonucu) || 0).toFixed(2)} ₺`,
    "",
`🏆 En çok çıkan ödül: ${topRewardText}`,
`🖥️ En çok spin atan masa: ${topMasaText}`,
`📈 Ortalama masa geliri: ${(Number(stats.ortalamaMasaGeliri) || 0).toFixed(2)} ₺`,
`💰 En çok gelir getiren masa: ${stats.topRevenueMasaText || "-"}`,
"",
    `🎁 Bugün çıkan ödüller:${rewardListText}`
  ].join("\n");
}

function isLegacyEveryCafeManualMemberSale(row) {
  const source = String(row && row.external_source || "").trim();
  if (source === "EVERYCAFE_MEMBER") return true;
  if (source) return false;
  if (String(row && row.sale_type || "").toUpperCase() !== "DIRECT") return false;
  const name = String(row && row.product_name || "").toLocaleUpperCase("tr-TR");
  const category = String(row && row.category || "").toLocaleUpperCase("tr-TR");
  const note = String(row && row.note || "").toLocaleUpperCase("tr-TR");
  return name.startsWith("EVERYCAFE ÜYE GELİRİ") ||
    category === "EVERYCAFE GEÇMİŞ AKTARIM" ||
    note.includes("EVERYCAFE ÜYE GELİRİ");
}

const LEGACY_EVERYCAFE_MEMBER_SQL = `(
  external_source='EVERYCAFE_MEMBER'
  OR (
    COALESCE(external_source,'')=''
    AND sale_type='DIRECT'
    AND (
      product_name LIKE 'EveryCafe Üye Geliri%'
      OR category='EveryCafe Geçmiş Aktarım'
      OR note LIKE '%EveryCafe Üye Geliri%'
    )
  )
)`;

function getCommerceRangeStats(startTs, endTs, cb) {
  db.get(
    `SELECT COALESCE(SUM(total),0) AS total,
            COALESCE(SUM(quantity),0) AS quantity,
            COALESCE(SUM(CASE WHEN sale_type='TABLE' THEN total ELSE 0 END),0) AS table_product_total,
            COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_DIRECT' THEN total ELSE 0 END),0) AS everycafe_direct_total,
            COALESCE(SUM(CASE WHEN ${LEGACY_EVERYCAFE_MEMBER_SQL} THEN total ELSE 0 END),0) AS everycafe_member_total,
            COALESCE(SUM(CASE WHEN sale_type='DIRECT' AND COALESCE(external_source,'') LIKE 'EVERYCAFE%' AND external_source NOT IN ('EVERYCAFE_DIRECT','EVERYCAFE_MEMBER') AND NOT ${LEGACY_EVERYCAFE_MEMBER_SQL} THEN total ELSE 0 END),0) AS everycafe_other_total,
            COALESCE(SUM(CASE WHEN sale_type='DIRECT' AND COALESCE(external_source,'') NOT LIKE 'EVERYCAFE%' AND NOT ${LEGACY_EVERYCAFE_MEMBER_SQL} THEN total ELSE 0 END),0) AS kafepin_direct_total,
            COALESCE(SUM(CASE WHEN sale_type='DIRECT' AND COALESCE(external_source,'') NOT LIKE 'EVERYCAFE%' AND NOT ${LEGACY_EVERYCAFE_MEMBER_SQL} THEN 1 ELSE 0 END),0) AS kafepin_direct_count
     FROM product_sales
     WHERE voided=0 AND time>=? AND time<?`,
    [startTs, endTs],
    (productErr, productRow) => {
      if (productErr) return cb(productErr);
      db.get(
        `SELECT
           COALESCE(SUM(CASE WHEN method='CASH' AND COALESCE(NULLIF(paid_at,0),created_at)>=? AND COALESCE(NULLIF(paid_at,0),created_at)<? THEN total_amount ELSE 0 END),0) AS cash,
           COALESCE(SUM(CASE WHEN method='CARD' AND COALESCE(NULLIF(paid_at,0),created_at)>=? AND COALESCE(NULLIF(paid_at,0),created_at)<? THEN total_amount ELSE 0 END),0) AS card,
           COALESCE(SUM(CASE WHEN method='CARD' AND COALESCE(NULLIF(paid_at,0),created_at)>=? AND COALESCE(NULLIF(paid_at,0),created_at)<? THEN ROUND(total_amount * ${CARD_COMMISSION_RATE}, 2) ELSE 0 END),0) AS card_commission,
           COALESCE(SUM(CASE WHEN method='PENDING' AND created_at>=? AND created_at<? THEN total_amount ELSE 0 END),0) AS pending,
           COALESCE(SUM(CASE WHEN method='PENDING' AND created_at>=? AND created_at<? THEN 1 ELSE 0 END),0) AS pending_count
         FROM payments
         WHERE voided=0`,
        [startTs, endTs, startTs, endTs, startTs, endTs, startTs, endTs, startTs, endTs],
        (paymentErr, paymentRow) => {
          if (paymentErr) return cb(paymentErr);
          const productGeliri = Number(productRow && productRow.total) || 0;
          const nakitOdeme = Number(paymentRow && paymentRow.cash) || 0;
          const kartOdeme = Number(paymentRow && paymentRow.card) || 0;
          db.get(
            `SELECT
               COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END),0) AS expenses,
               COALESCE(SUM(CASE WHEN type='CAPITAL_IN' THEN amount ELSE 0 END),0) AS capital_in,
               COALESCE(SUM(CASE WHEN type='CAPITAL_OUT' THEN amount ELSE 0 END),0) AS capital_out
             FROM accounting_entries
             WHERE voided=0 AND time>=? AND time<?`,
            [startTs, endTs],
            (accountingErr, accountingRow) => {
              if (accountingErr) return cb(accountingErr);
              const masaUrunGeliri = Number(productRow && productRow.table_product_total) || 0;
              const everyCafeDirectGeliri = Number(productRow && productRow.everycafe_direct_total) || 0;
              const everyCafeUyeGeliri = Number(productRow && productRow.everycafe_member_total) || 0;
              const everyCafeDigerGeliri = Number(productRow && productRow.everycafe_other_total) || 0;
              const kafePinDirectGeliri = Number(productRow && productRow.kafepin_direct_total) || 0;
              const siniflanmisUrunGeliri =
                masaUrunGeliri +
                everyCafeDirectGeliri +
                everyCafeUyeGeliri +
                everyCafeDigerGeliri +
                kafePinDirectGeliri;
              const digerUrunGeliri = Math.max(productGeliri - siniflanmisUrunGeliri, 0);

              // Finansın tek gerçek kaynağı:
              // 1) EveryCafe'den içeri alınmış gerçek tahsilatlar
              // 2) yalnız KafePin'de yapılan manuel doğrudan satışlar.
              // EveryCafe ürün/üye/doğrudan/bilet satırları burada ikinci kez eklenmez.
              db.get(
                `SELECT
                   COALESCE(SUM(CASE WHEN (source LIKE 'EVERYCAFE%' OR external_source LIKE 'EVERYCAFE%') THEN total_amount ELSE 0 END),0) AS everycafe_total,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE' THEN computer_amount ELSE 0 END),0) AS everycafe_computer,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE' THEN product_amount ELSE 0 END),0) AS everycafe_table_product,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_DIRECT' THEN total_amount ELSE 0 END),0) AS everycafe_direct,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_MEMBER' THEN total_amount ELSE 0 END),0) AS everycafe_member,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_OTHER' THEN total_amount ELSE 0 END),0) AS everycafe_other,
                   COALESCE(SUM(CASE WHEN (source LIKE 'EVERYCAFE%' OR external_source LIKE 'EVERYCAFE%') THEN 1 ELSE 0 END),0) AS everycafe_count,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE' THEN 1 ELSE 0 END),0) AS everycafe_table_count
                 FROM payments
                 WHERE voided=0 AND created_at>=? AND created_at<?`,
                [startTs, endTs],
                (sourceErr, sourceRow) => {
                  if (sourceErr) return cb(sourceErr);
                  cb(null, {
                    productGeliri,
                    productAdedi: Number(productRow && productRow.quantity) || 0,
                    masaUrunGeliri,
                    everyCafeDirectGeliri,
                    everyCafeUyeGeliri,
                    everyCafeDigerGeliri,
                    kafePinDirectGeliri,
                    kafePinDirectAdedi: Number(productRow && productRow.kafepin_direct_count) || 0,
                    digerUrunGeliri,
                    everyCafeGenelGelir: Number(sourceRow && sourceRow.everycafe_total) || 0,
                    everyCafeMasaBilgisayarGeliri: Number(sourceRow && sourceRow.everycafe_computer) || 0,
                    everyCafeMasaUrunGeliri: Number(sourceRow && sourceRow.everycafe_table_product) || 0,
                    everyCafeKaynakDirectGeliri: Number(sourceRow && sourceRow.everycafe_direct) || 0,
                    everyCafeKaynakUyeGeliri: Number(sourceRow && sourceRow.everycafe_member) || 0,
                    everyCafeKaynakDigerGeliri: Number(sourceRow && sourceRow.everycafe_other) || 0,
                    everyCafeIslemAdedi: Number(sourceRow && sourceRow.everycafe_count) || 0,
                    everyCafeMasaHesapAdedi: Number(sourceRow && sourceRow.everycafe_table_count) || 0,
                    nakitOdeme,
                    kartOdeme,
                    bekleyenOdeme: Number(paymentRow && paymentRow.pending) || 0,
                    bekleyenAdet: Number(paymentRow && paymentRow.pending_count) || 0,
                    tahsilEdilen: nakitOdeme + kartOdeme,
                    giderler: Number(accountingRow && accountingRow.expenses) || 0,
                    sermayeGirisi: Number(accountingRow && accountingRow.capital_in) || 0,
                    sermayeCekisi: Number(accountingRow && accountingRow.capital_out) || 0,
                    kartKomisyonu: Number(paymentRow && paymentRow.card_commission) || 0
                  });
                }
              );
            }
          );
        }
      );
    }
  );
}

function buildCardSettlementGroups(paymentRows, settlementRows, now = Date.now()) {
  const confirmations = new Map(
    (settlementRows || []).map((row) => [String(row.settlement_key), row])
  );
  const groups = new Map();
  (paymentRows || []).forEach((payment) => {
    if (payment.method !== "CARD" || Number(payment.voided)) return;
    const paidAt = Number(payment.paid_at) || Number(payment.created_at) || 0;
    if (!paidAt) return;
    const key = cardSettlementKey(paidAt);
    const amount = Number(payment.total_amount) || 0;
    if (!groups.has(key)) groups.set(key, {
      key,
      gross: 0,
      expectedCommission: 0,
      latestPaidAt: 0,
      paymentCount: 0
    });
    const group = groups.get(key);
    group.gross += amount;
    group.expectedCommission += Math.round(amount * CARD_COMMISSION_RATE * 100) / 100;
    group.latestPaidAt = Math.max(group.latestPaidAt, paidAt);
    group.paymentCount += 1;
  });

  return [...groups.values()].map((group) => {
    const saved = confirmations.get(group.key);
    const confirmed = !!(saved && Number(saved.confirmed_at) > 0);
    const actualNet = confirmed ? (Number(saved.actual_net) || 0) : 0;
    const commission = confirmed
      ? Math.max(group.gross - actualNet, 0)
      : group.expectedCommission;
    const settlementAt = group.latestPaidAt + CARD_SETTLEMENT_DELAY_MS;
    return {
      ...group,
      expectedNet: group.gross - group.expectedCommission,
      actualNet,
      commission,
      confirmed,
      confirmedAt: confirmed ? Number(saved.confirmed_at) || 0 : 0,
      note: confirmed ? String(saved.note || "") : "",
      settlementAt,
      settled: confirmed || settlementAt <= now
    };
  }).sort((a, b) => b.latestPaidAt - a.latestPaidAt);
}

function getCardSettlementGroupsFromDb(paymentRows, now, cb) {
  db.all("SELECT * FROM card_settlements", (err, settlementRows) => {
    if (err) return cb(err);
    cb(null, buildCardSettlementGroups(paymentRows, settlementRows, now));
  });
}

function actualCardCommissionForRange(paymentRows, groups, startTs, endTs) {
  const groupMap = new Map((groups || []).map((group) => [group.key, group]));
  return (paymentRows || []).reduce((sum, payment) => {
    if (payment.method !== "CARD" || Number(payment.voided)) return sum;
    const paidAt = Number(payment.paid_at) || Number(payment.created_at) || 0;
    if (paidAt < startTs || paidAt >= endTs) return sum;
    const expected = Math.round((Number(payment.total_amount) || 0) * CARD_COMMISSION_RATE * 100) / 100;
    const group = groupMap.get(cardSettlementKey(paidAt));
    if (!group || !group.confirmed || !(Number(group.expectedCommission) > 0)) return sum + expected;
    return sum + (expected * ((Number(group.commission) || 0) / Number(group.expectedCommission)));
  }, 0);
}

function getRangeStats(startTs, endTs, cb) {
  db.all("SELECT * FROM sessions", (err2, sessions) => {

    if (err2) {
      logErr("getRangeStats sessions", err2);
      return cb(err2);
    }
    if (!sessions) sessions = [];
const masaRevenueMap = {};
    const addMasaRevenue = (masa, amount) => {
      const masaNo = Number(masa) || 0;
      const value = Number(amount) || 0;
      if (!masaNo || !value) return;
      masaRevenueMap[masaNo] = (Number(masaRevenueMap[masaNo]) || 0) + value;
    };

    const now = Date.now();

    const activeSessions = (sessions || []).filter((s) => !s.end_time || s.end_time === 0);
    const liveRealBrutGelir = sumRealRevenueInRangeFromSessions(
      activeSessions, startTs, endTs, now
    );

    // Genel toplamla masa sıralaması aynı günlük aralığı kullanmalı.
    activeSessions.forEach((session) => {
      const masa = Number(session.masa) || 0;
      const sessionStart = Number(session.start_time) || 0;
      const sessionEnd = Number(session.last_seen) || now;
      if (!masa || !sessionStart || isFreeMasa(masa)) return;
      if (sessionEnd <= startTs || sessionStart >= endTs) return;

      const rangeStart = Math.max(startTs, sessionStart);
      const rangeEnd = Math.min(endTs, sessionEnd);
      if (rangeEnd <= rangeStart) return;

      addMasaRevenue(
        masa,
        Math.max(
          feeAtTime(masa, sessionStart, rangeEnd) -
          feeAtTime(masa, sessionStart, rangeStart),
          0
        )
      );
    });

    db.all(
      "SELECT time, amount, kind, masa, session_start, note FROM real_adjustments",
      (eAdj, adjRows) => {
      if (eAdj) {
        logErr("getRangeStats real_adjustments", eAdj);
        return cb(eAdj);
      }

      adjRows = adjRows || [];

      let finalizedSessionRange = 0;
      let feeAdjustRange = 0;
      let spinCostRange = 0;

      (adjRows || []).forEach((a) => {
        const amt = Number(a.amount) || 0;
        const kind = String(a.kind || "").trim();

        if (kind === "SESSION_FINALIZE") {
          const sessionStart = Number(a.session_start) || 0;
          const sessionEnd = Number(a.time) || 0;
          const masa = Number(a.masa) || 0;

          if (!sessionStart || !sessionEnd || !masa) return;
          if (sessionEnd <= startTs || sessionStart >= endTs) return;

          const rangeStart = Math.max(sessionStart, startTs);
          const rangeEnd = Math.min(sessionEnd, endTs);
          if (rangeEnd <= rangeStart) return;

          // Kapanış sırasında sabitlenen kesin brüt tutar esastır.
          // 0 ₺ kapanmış kısa/ücretsiz oturum tarifeden tekrar hesaplanmaz.
          const recordedTotal = Math.max(amt, 0);
          if (recordedTotal <= 0) return;

          if (rangeStart <= sessionStart && rangeEnd >= sessionEnd) {
            finalizedSessionRange += recordedTotal;
            addMasaRevenue(masa, recordedTotal);
            return;
          }

          const feeAtRangeEnd = feeAtTime(masa, sessionStart, rangeEnd);
          const feeAtRangeStart =
            rangeStart <= sessionStart
              ? 0
              : feeAtTime(masa, sessionStart, rangeStart);

          const allocatedFinalized = Math.max(
            Math.min(feeAtRangeEnd - feeAtRangeStart, recordedTotal),
            0
          );
          finalizedSessionRange += allocatedFinalized;
          addMasaRevenue(masa, allocatedFinalized);
          return;
        }

        const t = Number(a.time || a.session_start || 0);
        if (t < startTs || t >= endTs) return;

        if (kind === "MANUAL_FEE_ADJUST" || kind === "ZERO_FEE") {
          feeAdjustRange += amt;
          addMasaRevenue(a.masa, amt);
          return;
        }

if (
  kind === "SPIN_TIME_COST" ||
  kind === "SPIN_ITEM_COST"
) {
          const cost = spinAdjustmentCost(a);
          spinCostRange += cost;
          return;
        }
      });

      const brutGelir = liveRealBrutGelir + finalizedSessionRange;
      const adminDuzeltmeleri = feeAdjustRange;
      const spinMaliyeti = spinCostRange;
const gercekGelir =
    brutGelir +
    adminDuzeltmeleri;

      db.get("SELECT COUNT(*) as cnt FROM spins_log WHERE time>=? AND time<?", [startTs, endTs], (eSpin, spinRow) => {
        if (eSpin) {
          logErr("getRangeStats spins_log count", eSpin);
          return cb(eSpin);
        }

        db.get(
          "SELECT COUNT(*) as cnt FROM spins_log WHERE time>=? AND time<? AND used=1",
          [startTs, endTs],
          (eUsed, usedRow) => {
            if (eUsed) {
              logErr("getRangeStats spins_log used count", eUsed);
              return cb(eUsed);
            }

            db.get(
              `
              SELECT reward, COUNT(*) as adet
              FROM spins_log
              WHERE time>=? AND time<? AND used=1
              GROUP BY reward
              ORDER BY adet DESC, reward ASC
              LIMIT 1
              `,
              [startTs, endTs],
              (eTopReward, topRewardRow) => {
                if (eTopReward) {
                  logErr("getRangeStats top reward", eTopReward);
                  return cb(eTopReward);
                }

                db.get(
                  `
                  SELECT masa, COUNT(*) as adet
                  FROM spins_log
                  WHERE time>=? AND time<?
                  GROUP BY masa
                  ORDER BY adet DESC, masa ASC
                  LIMIT 1
                  `,
                  [startTs, endTs],
                  (eTopMasa, topMasaRow) => {
                    if (eTopMasa) {
                      logErr("getRangeStats top masa", eTopMasa);
                      return cb(eTopMasa);
                    }

                    db.all(
                      `
                      SELECT reward, COUNT(*) as adet
                      FROM spins_log
                      WHERE time>=? AND time<?
                      GROUP BY reward
                      ORDER BY adet DESC, reward ASC
                      `,
                      [startTs, endTs],
                      (eList, rewardRows) => {
if (eList) rewardRows = [];

{
    let ortalamaMasaGeliri = 0;
    let topRevenueMasaText = "-";
    const revenueMasaRows = Object.entries(masaRevenueMap)
      .map(([masa, gelir]) => ({ masa: Number(masa), gelir: Number(gelir) || 0 }))
      .filter((row) => row.gelir > 0);

    if (revenueMasaRows.length) {

      const toplamGelir =
        revenueMasaRows.reduce(
          (t, r) => t + (Number(r.gelir) || 0),
          0
        );

      ortalamaMasaGeliri =
        toplamGelir / revenueMasaRows.length;

      revenueMasaRows.sort(
        (a, b) =>
          (Number(b.gelir) || 0) -
          (Number(a.gelir) || 0)
      );

      const top = revenueMasaRows[0];

      topRevenueMasaText =
        `Masa ${top.masa} (${(Number(top.gelir) || 0).toFixed(2)} ₺)`;
    }

    const baseStats = {
      brutGelir,
      adminDuzeltmeleri,
      spinMaliyeti,
      gercekGelir,

      ortalamaMasaGeliri,
      topRevenueMasaText,

      brut: brutGelir,
      net: gercekGelir,
      spinCost: spinMaliyeti,

      totalSpins: (spinRow && spinRow.cnt) || 0,
      usedRewards: (usedRow && usedRow.cnt) || 0,

      topReward: topRewardRow
        ? {
            reward: topRewardRow.reward || "-",
            adet: parseInt(topRewardRow.adet, 10) || 0
          }
        : null,

      topMasa: topMasaRow
        ? {
            masa: topMasaRow.masa || "-",
            adet: parseInt(topMasaRow.adet, 10) || 0
          }
        : null,

      rewardList: rewardRows || []
    };

    getCommerceRangeStats(startTs, endTs, (commerceErr, commerce) => {
      if (commerceErr) return cb(commerceErr);
      // Masa sıralamasında yalnız bilgisayar değil, o masaya yazılan ürünler de yer alır.
      db.all(
        `SELECT masa, COALESCE(SUM(total),0) AS total
         FROM product_sales
         WHERE voided=0 AND sale_type='TABLE' AND masa>0 AND time>=? AND time<?
         GROUP BY masa`,
        [startTs, endTs],
        (productMapErr, productRows) => {
          if (productMapErr) logErr("getRangeStats table product totals", productMapErr);
          (productRows || []).forEach((row) => addMasaRevenue(row.masa, row.total));

          const enrichedRows = Object.entries(masaRevenueMap)
            .map(([masa, gelir]) => ({ masa: Number(masa), gelir: Number(gelir) || 0 }))
            .filter((row) => row.gelir > 0)
            .sort((a, b) => b.gelir - a.gelir || a.masa - b.masa);
          const enrichedAverage = enrichedRows.length
            ? enrichedRows.reduce((sum, row) => sum + row.gelir, 0) / enrichedRows.length
            : 0;
          const enrichedTopText = enrichedRows.length
            ? `Masa ${enrichedRows[0].masa} (${enrichedRows[0].gelir.toFixed(2)} ₺)`
            : "-";

          const everyCafeGenelGelir = Number(commerce.everyCafeGenelGelir) || 0;
          const kafePinDirectGeliri = Number(commerce.kafePinDirectGeliri) || 0;
          const genelGelir = everyCafeGenelGelir + kafePinDirectGeliri;
          const netIsletmeSonucu =
            genelGelir -
            (Number(commerce.giderler) || 0) -
            (Number(commerce.kartKomisyonu) || 0) -
            spinMaliyeti;

          return cb(null, {
            ...baseStats,
            ...commerce,
            ortalamaMasaGeliri: enrichedAverage,
            topRevenueMasaText: enrichedTopText,
            // Tek gerçek ciro: EveryCafe birebir + KafePin manuel doğrudan satış.
            // Çark maliyeti genel ciroyu hiçbir zaman azaltmaz.
            genelGelir,
            everyCafeGenelGelir,
            kafePinDirectGeliri,
            netIsletmeSonucu
          });
        }
      );
    });

  }

                      }
                    );
                  }
                );
              }
            );
          }
        );
      });
    });
  });
}

function sendEndOfDayTelegramReport(cb, reportEndTs) {
  const endTs = Number(reportEndTs) || Date.now();
  const reportTs = Math.max(endTs - 1, 0);
  const startTs = dayStartTs(reportTs);

  const reportKey = `daily-report:${dayKey(reportTs)}:${GUN_SONU_RAPOR_SAAT}:${GUN_SONU_RAPOR_DAKIKA}`;
  if (!shouldSendTelegramDedup(reportKey, 5 * 60 * 1000)) {
    return getRangeStats(startTs, endTs, (err, stats) => {
      if (err) return cb && cb(err);
      return cb && cb(null, { ...stats, skipped: true, reason: "dedup" });
    });
  }

  getRangeStats(startTs, endTs, (err, stats) => {
    if (err) return cb && cb(err);

saveDailyReport(reportTs, stats, (saveErr) => {

  if (saveErr) {
    logErr("saveDailyReport", saveErr);
  }

  const msg = buildDailyTelegramReport(reportTs, stats);

  sendTelegramMessage(msg, (e2) => {

    if (e2) {
      logErr("sendEndOfDayTelegramReport telegram", e2);
      return cb && cb(e2);
    }

    console.log("✅ Gün sonu Telegram raporu gönderildi.");

    addLiveLog(
      "daily_report",
      "🌙 Gün sonu raporu Telegram'a gönderildi"
    );
    moveLiveMonitorToBottomSoon();

    return cb && cb(null, stats);

  });

});
  });
}
function saveDailyReport(reportTs, stats, cb) {

  const reportDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(reportTs));

  db.run(
    `
    INSERT OR REPLACE INTO daily_reports (
      report_date,
      report_ts,

      total_spins,
      used_rewards,

      brut_gelir,
      admin_duzeltmeleri,
      spin_maliyeti,
      gercek_gelir,
      product_geliri,
      product_adedi,
      genel_gelir,
      nakit_odeme,
      kart_odeme,
      bekleyen_odeme,
      bekleyen_adet,
      giderler,
      kart_komisyonu,
      net_isletme_sonucu,
      everycafe_genel_gelir,
      kafepin_direct_geliri,
      everycafe_pc_geliri,
      everycafe_masa_urun_geliri,

      ortalama_masa_geliri,

      top_reward,
      top_reward_count,

      top_masa,
      top_masa_count,

      top_revenue_masa,

      reward_list
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `,
    [
      reportDate,
      reportTs,

      Number(stats.totalSpins || 0),
      Number(stats.usedRewards || 0),

      Number(stats.brutGelir || 0),
      Number(stats.adminDuzeltmeleri || 0),
      Number(stats.spinMaliyeti || 0),
      Number(stats.gercekGelir || 0),
      Number(stats.productGeliri || 0),
      Number(stats.productAdedi || 0),
      Number(stats.genelGelir || 0),
      Number(stats.nakitOdeme || 0),
      Number(stats.kartOdeme || 0),
      Number(stats.bekleyenOdeme || 0),
      Number(stats.bekleyenAdet || 0),
      Number(stats.giderler || 0),
      Number(stats.kartKomisyonu || 0),
      Number(stats.netIsletmeSonucu || 0),
      Number(stats.everyCafeGenelGelir || 0),
      Number(stats.kafePinDirectGeliri || 0),
      Number(stats.everyCafeMasaBilgisayarGeliri || 0),
      Number(stats.everyCafeMasaUrunGeliri || 0),

      Number(stats.ortalamaMasaGeliri || 0),

      stats.topReward ? stats.topReward.reward : "",
      stats.topReward ? Number(stats.topReward.adet || 0) : 0,

      stats.topMasa ? Number(stats.topMasa.masa || 0) : 0,
      stats.topMasa ? Number(stats.topMasa.adet || 0) : 0,

      stats.topRevenueMasaText || "",

      JSON.stringify(stats.rewardList || [])
    ],
    (err) => {

      if (err) {
        logErr("saveDailyReport", err);
      } else {
        console.log("💾 Gün sonu raporu kaydedildi.");
      }

      if (cb) cb(err);

    }
  );

}

// Eski hesapla 0 ₺ oturumu ücretli saymış en son kayıtlı raporu da düzeltir.
// Telegram'da daha önce gönderilmiş mesaj değişmez; admin rapor kaydı doğru olur.
function repairLatestStoredDailyReport() {
  db.get(
    "SELECT report_ts FROM daily_reports ORDER BY report_ts DESC LIMIT 1",
    (selectErr, row) => {
      if (selectErr) {
        logErr("repairLatestStoredDailyReport select", selectErr);
        return;
      }

      const reportTs = Number(row && row.report_ts) || 0;
      if (!reportTs) return;

      const startTs = dayStartTs(reportTs);
      const endTs = reportTs + 1;
      getRangeStats(startTs, endTs, (statsErr, stats) => {
        if (statsErr) {
          logErr("repairLatestStoredDailyReport stats", statsErr);
          return;
        }

        saveDailyReport(reportTs, stats, (saveErr) => {
          if (saveErr) return;
          addLiveLog(
            "daily_report_repair",
            `🧮 Son gün sonu raporu kesin gelirlerle düzeltildi: EveryCafe Entegrasyonu ${Number(stats.everyCafeGenelGelir || 0).toFixed(2)} ₺ + KafePin Doğrudan Satış ${Number(stats.kafePinDirectGeliri || 0).toFixed(2)} ₺ = Toplam ${Number(stats.genelGelir || 0).toFixed(2)} ₺`
          );
        });
      });
    }
  );
}

function maybeSendScheduledDailyReport() {
  if (!TELEGRAM_ENABLED) return;

  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  if (currentHour !== GUN_SONU_RAPOR_SAAT || currentMinute !== GUN_SONU_RAPOR_DAKIKA) {
    return;
  }

  const reportKey = dayKey(Date.now()) + `-${GUN_SONU_RAPOR_SAAT}:${GUN_SONU_RAPOR_DAKIKA}`;
  if (lastDailyReportKey === reportKey) return;

  lastDailyReportKey = reportKey;

  sendEndOfDayTelegramReport((err) => {
    if (err) {
      console.log("Gün sonu raporu gönderilemedi:", err.message || err);
    }
  });
}

function insertSessionHistory(sessionRow, fee, closeReason, note, cb) {
  try {
    if (!sessionRow) return cb && cb(null);

    const masa = parseInt(sessionRow.masa, 10) || 0;
    const startTime = parseInt(sessionRow.start_time, 10) || 0;
    const endTime = parseInt(sessionRow.end_time, 10) || 0;
    const lastSeen = parseInt(sessionRow.last_seen, 10) || 0;

    if (!masa || !startTime || !endTime || endTime <= startTime) {
      return cb && cb(null);
    }

    let minutes = Math.floor((endTime - startTime) / 60000);
    if (minutes < 0) minutes = 0;

    // Kesinleşen tutarı 0 ₺ olan kısa/ücretsiz/iptal oturumlar geçmişe yazılmaz.
    if ((Number(fee) || 0) <= 0) {
      return cb && cb(null);
    }

db.run(
  `
INSERT OR IGNORE INTO session_history
(masa, start_time, end_time, last_seen, minutes, fee, adjustment, close_reason, note, created_at)
VALUES (?,?,?,?,?,?,?,?,?,?)
  `,
[
  masa,
  startTime,
  endTime,
  lastSeen,
  minutes,

  Number(fee) || 0,

  Number(sessionRow.adjustment) || 0,

  String(closeReason || ""),
  String(note || ""),
  Date.now()
],
  function (err) {
    if (err) {
      logErr("insertSessionHistory", err);
      return cb && cb(err);
    }

    // 🔥 BURAYA KOY
    if ((this.changes || 0) === 0) {
      // zaten var → sorun yok
    }
    return cb && cb(null);
  }
);
  } catch (err) {
    logErr("insertSessionHistory catch", err);
    return cb && cb(err);
  }
}
function withTimeout(promise, ms = 8000) {
  // Stabilite koruması: süre aşımı yalnız uyarıdır. Gerçek SQLite işlemi
  // tamamlanmadan finalize kuyruğu/kilidi serbest bırakılmaz.
  const timer = setTimeout(() => {
    console.error(`⚠️ finalize işlemi ${ms} ms üzerinde sürdü; DB sonucu bekleniyor`);
  }, ms);
  return promise.finally(() => clearTimeout(timer));
}
function finalizeEndedSessionToAdjustments(row, now, cb) {
  if (!row) return cb && cb();

  db.get(
    `SELECT 1 FROM real_adjustments 
     WHERE masa=? AND session_start=? AND kind='SESSION_FINALIZE'`,
    [row.masa, row.start_time],
    (err, exists) => {

      if (err) {
        logErr("finalize duplicate check", err);
        return cb && cb(err);
      }

      if (exists) {
        db.get(
          "SELECT final_fee FROM sessions WHERE masa=? AND start_time=?",
          [row.masa, row.start_time],
          (e2, sRow) => {
            if (e2) {
              logErr("finalize duplicate session read", e2);
              return cb && cb(e2);
            }
            if (sRow) {
              db.run(
                "DELETE FROM sessions WHERE masa=? AND start_time=?",
                [row.masa, row.start_time],
                (deleteErr) => cb && cb(deleteErr || null)
              );
            } else {
              cb && cb();
            }
          }
        );
        return;
      }

      const key = `${row.masa}-${row.start_time}`;

      if (finalizeInProgress.has(key)) {
        return enqueueFinalize(row.masa, async () => {})
          .then(() => cb && cb(null))
          .catch((queueErr) => cb && cb(queueErr));
      }

      finalizeInProgress.add(key);

      const masa = row.masa;

      enqueueFinalize(masa, async () => {
        try {
          await withTimeout(
            new Promise((resolve, reject) => {

              const safety = setTimeout(() => {
                console.error("⚠️ finalize 7 saniyeyi geçti; SQLite işleminin gerçek sonucu bekleniyor");
              }, 7000);

              const start = row.start_time;
              const end = row.end_time;
const safeEnd = Math.min(end, (row.last_seen || end) + 15000);

              if (!masa || !start || !end || end <= start) {
                clearTimeout(safety);
                return resolve();
              }

if (isFreeMasa(masa)) {
  const minutes = Math.floor((end - start) / 60000);
  const seconds = Math.floor(((end - start) % 60000) / 1000);

  return db.run(
    "DELETE FROM sessions WHERE masa=? AND start_time=?",
    [masa, start],
    (freeDeleteErr) => {
      if (freeDeleteErr) {
        logErr("DELETE free session", freeDeleteErr);
        clearTimeout(safety);
        return reject(freeDeleteErr);
      }

      cleanupMasa(masa);
      addLiveLog(
        "free_session_end",
        `🔵 Masa ${masa} ücretsiz olarak kapandı • ${minutes} dk ${seconds} sn • Gelir yazılmadı`
      );

      clearTimeout(safety);
      return resolve();
    }
  );
}

const baseFee = feeAtTime(masa, start, safeEnd);
const frozenFee = row.final_fee || 0;
const isShortSession = baseFee <= 0;

db.get(
  `
  SELECT COALESCE(SUM(amount),0) as adj
  FROM real_adjustments
  WHERE masa=? AND session_start=? 
  AND kind IN ('MANUAL_FEE_ADJUST','ZERO_FEE')
  `,
  [masa, start],
  (e2, rowAdj) => {

    if (e2) {
      logErr("finalize adjustment SELECT", e2);
      clearTimeout(safety);
      return reject(e2);
    }

    const adj = (rowAdj && rowAdj.adj) ? Number(rowAdj.adj) : 0;
const rawFee =
  isShortSession
    ? 0
    : frozenFee > 0
    ? frozenFee
    : Math.max(baseFee, 0);

// SESSION_FINALIZE brüt ücreti, adjustment kayıtları ise düzeltmeyi temsil eder.
// Final ücret hiçbir zaman negatif olamaz.
const finalFee = Math.max(rawFee + adj, 0);
    const dk = dayKey(end);

    db.serialize(() => {

db.run("BEGIN IMMEDIATE TRANSACTION", (err) => {

    if (err) {

        logErr("BEGIN IMMEDIATE TRANSACTION", err);

        clearTimeout(safety);

        return reject(err);

    }

    db.run(
      `INSERT OR IGNORE INTO real_adjustments
           (time, day_key, masa, amount, kind, note, session_start)
           VALUES (?,?,?,?,?,?,?)`,
          [end, dk, masa, rawFee, "SESSION_FINALIZE", `Masa ${masa}`, start],
(insertErr) => {

    if (insertErr) {

        logErr("SESSION_FINALIZE INSERT", insertErr);

        return db.run("ROLLBACK", () => {

            clearTimeout(safety);

            reject(insertErr);

        });

    }

insertSessionHistory(
  {
    masa,
    start_time: start,
    end_time: end,
    last_seen: end,
    adjustment: adj
  },
  finalFee,
  "FINALIZED",
  "",
  (historyErr) => {

      if (historyErr) {

          logErr("insertSessionHistory", historyErr);

          return db.run("ROLLBACK", () => {

              clearTimeout(safety);

              reject(historyErr);

          });

      }

db.run(
  "UPDATE sessions SET final_fee=? WHERE masa=? AND start_time=?",
  [finalFee, masa, start],
  (updateErr) => {

      if (updateErr) {

          logErr("UPDATE final_fee", updateErr);

          return db.run("ROLLBACK", () => {

              clearTimeout(safety);

              reject(updateErr);

          });

      }

db.run(
  "DELETE FROM sessions WHERE masa=? AND start_time=?",
  [masa, start],
  (deleteErr) => {

    if (deleteErr) {

      logErr("DELETE session", deleteErr);

      return db.run("ROLLBACK", () => {
        clearTimeout(safety);
        reject(deleteErr);
      });

    }

    db.run("COMMIT", (commitErr) => {

      if (commitErr) {

        logErr("finalize COMMIT", commitErr);

        return db.run("ROLLBACK", () => {
          clearTimeout(safety);
          reject(commitErr);
        });

      }

      diagnostics.finalizeCount++;
      diagnostics.lastFinalize = Date.now();
      diagnostics.lastFinalizeMasa = masa;

      cleanupMasa(masa);

      const minutes = Math.floor((end - start) / 60000);
      const seconds = Math.floor(((end - start) % 60000) / 1000);

      addLiveLog(
        "session_end",
        `🔴 Session kapandı • Masa ${masa} • ${minutes} dk ${seconds} sn • ${finalFee.toFixed(2)} TL`
      );

      recordClosedRolloverResult(masa, start, end, finalFee);
      sendSessionEndTelegram(masa, start, end, finalFee);

      clearTimeout(safety);
      resolve();

    }); // COMMIT

  } // deleteErr
); // DELETE

} // updateErr
); // UPDATE

} // historyErr
); // insertSessionHistory

} // INSERT callback
); // INSERT

}); // BEGIN IMMEDIATE

}); // serialize

}); // rowAdj

            }) // new Promise
          );
        } finally {
          finalizeInProgress.delete(key);
        }
      })
        .then(() => cb && cb(null))
        .catch((queueErr) => {
          logErr("finalize queue", queueErr);
          cb && cb(queueErr);
        });
    }
  );
}
function backfillMissingFinalizedSessions() {
  db.all(`
    SELECT *
    FROM sessions
    WHERE end_time > 0
  `, (err, rows) => {

    const now = Date.now();

    (rows || []).forEach((r) => {

      const masa = r.masa;
      const st = r.start_time;
      const end = r.end_time;

      if (!masa || !st || !end) return;

      // 🔥 HISTORY VAR MI?
      db.get(`
        SELECT 1 FROM session_history
        WHERE masa=? AND start_time=? AND end_time=?
      `, [masa, st, end], (e2, exists) => {

        if (exists) return;

        const fee = Number(r.final_fee) || feeAtTime(masa, st, end);

        insertSessionHistory(
          r,
          fee,
          "BACKFILL_FIX",
          "Missing history recovered",
          () => {}
        );

      });

    });

  });
}
setInterval(backfillMissingFinalizedSessions, 60 * 1000);
// EveryCafe aktarımı açıkken masa oturumunun tek sahibi EveryCafe'dir.
// Ping yalnız bağlantı bilgisidir. KafePin, EveryCafe'de gerçekten aktif bir
// oturum eşlemesi yoksa ping/status/spin üzerinden yeni müşteri oturumu yaratmaz.
function ensureSessionStarted(masa, now, cb) {
  getEveryCafeConfig((configErr, config) => {
    if (!configErr && config && config.enabled) {
      return db.get(
        "SELECT session_id,source_start,source_type FROM everycafe_active_sessions WHERE masa=? LIMIT 1",
        [masa],
        (mapErr, mapping) => {
          if (mapErr) return cb && cb(mapErr);
          return cb && cb(null, {
            masa,
            sourceManaged: true,
            sourceActive: Boolean(mapping),
            sourceSessionId: mapping ? String(mapping.session_id || "") : "",
            sourceStart: mapping ? Number(mapping.source_start) || 0 : 0,
            sourceType: mapping ? String(mapping.source_type || "") : ""
          });
        }
      );
    }
    ensureSessionStartedLocal(masa, now, cb);
  });
}

function ensureSessionStartedLocal(masa, now, cb) {
  if (isFreeMasa(masa)) return cb && cb(null, null);

  hasForceNewSession(masa, (forceNew) => {

    db.get("SELECT * FROM sessions WHERE masa=?", [masa], (err, row) => {


      if (err) {
        logErr("ensureSessionStarted select", err);
        return cb && cb(err);
      }

      // 🔹 Force new session varsa
      if (forceNew) {
        db.run(
          `
          INSERT INTO sessions (masa,start_time,last_seen,end_time,final_fee)
          VALUES (?,?,?,0,0)
          ON CONFLICT(masa) DO UPDATE SET
            start_time=excluded.start_time,
            last_seen=excluded.last_seen,
            end_time=0,
            final_fee=0
          `,
          [masa, now, now],
          (e2) => {
            logErr("ensureSessionStarted force new", e2);
            if (!e2) {
              clearForceNewSession(masa);
              addLiveLog(
  "session_start",
  `🟢 Session başladı • Masa ${masa}`
);

sendSessionStartTelegram(masa, now);
            }
            return cb && cb(e2 || null, {
              masa,
              start_time: now,
              last_seen: now,
              end_time: 0,
              final_fee: 0
            });
          }
        );
        return;
      }

      // 🔹 Session yoksa yeni başlat
      if (!row) {
        db.run(
          "INSERT INTO sessions (masa,start_time,last_seen,end_time,final_fee) VALUES (?,?,?,0,0)",
          [masa, now, now],
          (e2) => {
            logErr("ensureSessionStarted insert", e2);
           if (!e2) {
  addLiveLog(
    "session_start",
    `🟢 Session başladı • Masa ${masa}`
  );

  sendSessionStartTelegram(masa, now);
}
            return cb && cb(e2 || null, {
              masa,
              start_time: now,
              last_seen: now,
              end_time: 0,
              final_fee: 0
            });
          }
        );
        return;
      }

      // 🔹 start_time yoksa düzelt
      if (!row.start_time || row.start_time <= 0) {
        db.run(
          "UPDATE sessions SET start_time=?, last_seen=?, end_time=0, final_fee=0 WHERE masa=?",
          [now, now, masa],
          (e2) => {
            logErr("ensureSessionStarted repair start_time", e2);
            if (!e2) {
  addLiveLog(
    "session_start",
    `🟢 Session başladı • Masa ${masa}`
  );

  sendSessionStartTelegram(masa, now);
}
            return cb && cb(e2 || null, {
              ...row,
              start_time: now,
              last_seen: now,
              end_time: 0,
              final_fee: 0
            });
          }
        );
        return;
      }

      // 🔹 Session kapanmışsa yenisini başlat
      if (row.end_time && row.end_time > 0) {
        db.run(
          "UPDATE sessions SET start_time=?, last_seen=?, end_time=0, final_fee=0 WHERE masa=?",
          [now, now, masa],
          (e2) => {
            logErr("ensureSessionStarted restart closed session", e2);
            if (!e2) {
  addLiveLog(
    "session_start",
    `🟢 Session başladı • Masa ${masa}`
  );

  sendSessionStartTelegram(masa, now);
}
            return cb && cb(e2 || null, {
              ...row,
              start_time: now,
              last_seen: now,
              end_time: 0,
              final_fee: 0
            });
          }
        );
        return;
      }

      // 🔹 Normal durumda sadece ping güncelle
      db.run(
        "UPDATE sessions SET last_seen=? WHERE masa=?",
        [now, masa],
        (e2) => {
          logErr("ensureSessionStarted update last_seen", e2);
          return cb && cb(e2 || null, {
            ...row,
            last_seen: now
          });
        }
      );

    });
  });
}

function upsertSessionPing(masa, now) {
  if (isFreeMasa(masa)) {
    db.get("SELECT * FROM sessions WHERE masa=?", [masa], (err, row) => {
      if (err) {
        logErr("upsertSessionPing free select", err);
        return;
      }
      if (row && (!row.end_time || row.end_time === 0)) {
        finalizeEndedSessionToAdjustments({ ...row, end_time: now }, now, () => {});
      }
    });
    return;
  }

  hasForceNewSession(masa, (forceNew) => {
    db.get("SELECT * FROM sessions WHERE masa=?", [masa], (err, row) => {
      if (err) {
        logErr("upsertSessionPing select", err);
        return;
      }

      if (forceNew) {
        if (row && row.end_time && row.end_time > 0) {
          finalizeEndedSessionToAdjustments(row, now, () => {});
        }

        db.run(
          "INSERT INTO sessions (masa,start_time,last_seen,end_time,final_fee) VALUES (?,?,?,0,0) ON CONFLICT(masa) DO UPDATE SET start_time=excluded.start_time, last_seen=excluded.last_seen, end_time=0, final_fee=0",
          [masa, now, now],
          (e2) => {
            logErr("upsertSessionPing force new session", e2);
            if (!e2) sendSessionStartTelegram(masa, now);
            clearForceNewSession(masa);
          }
        );
        return;
      }

      ensureSessionStarted(masa, now, () => {});
    });
  });
}

function finalizeOpenProductSales(masa, endTime, paymentMethod, cb) {
  db.run(
    `UPDATE product_sales
     SET status='FINALIZED', finalized_at=?, payment_method=?
     WHERE masa=? AND sale_type='TABLE' AND status='OPEN' AND voided=0`,
    [Number(endTime) || Date.now(), normalizePaymentMethod(paymentMethod), masa],
    (err) => {
      if (err) logErr("finalizeOpenProductSales", err);
      cb && cb(err || null);
    }
  );
}

function normalizePaymentMethod(value, fallback = "PENDING") {
  const method = String(value || "").trim().toUpperCase();
  return ["CASH", "CARD", "PENDING"].includes(method) ? method : fallback;
}

function createSessionPaymentRecord({
  masa,
  sessionStart,
  sessionEnd,
  computerAmount,
  productAmount,
  method,
  closeReason
}, cb) {
  const computer = Math.max(Number(computerAmount) || 0, 0);
  const products = Math.max(Number(productAmount) || 0, 0);
  const total = computer + products;
  if (total <= 0) return cb && cb(null, null);

  const normalizedMethod = normalizePaymentMethod(method);
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO payments
     (created_at,paid_at,masa,session_start,session_end,product_sale_id,
      computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at)
     VALUES (?,?,?,?,?,0,?,?,?,?,'SESSION',?,'',0,0)`,
    [
      now,
      normalizedMethod === "PENDING" ? 0 : now,
      masa,
      Number(sessionStart) || Number(sessionEnd) || now,
      Number(sessionEnd) || now,
      computer,
      products,
      total,
      normalizedMethod,
      String(closeReason || "").slice(0, 60)
    ],
    function (err) {
      if (err) return cb && cb(err);
      cb && cb(null, { id: this.lastID || 0, total, method: normalizedMethod });
    }
  );
}

function finalizeAndPrepareSession(masa, endTime, cb, options = {}) {
  const now = Date.now();
  const todayStart = dayStartTs(now);

  db.get("SELECT * FROM sessions WHERE masa=?", [masa], (err, row) => {
    if (err) {
      logErr("finalizeAndPrepareSession select", err);
      return cb && cb(err);
    }

const afterFinalize = () => {
  db.get(
    `SELECT COALESCE(SUM(total),0) AS total,
            COALESCE(MIN(session_start),0) AS first_session_start
     FROM product_sales
     WHERE masa=? AND sale_type='TABLE' AND status='OPEN' AND voided=0`,
    [masa],
    (productTotalErr, productRow) => {
      if (productTotalErr) return cb && cb(productTotalErr);

      const sessionStart = Number(row && row.start_time) ||
        Number(productRow && productRow.first_session_start) ||
        Number(endTime) || now;

      const finishWithComputerAmount = (computerAmount) => {
        createSessionPaymentRecord(
          {
            masa,
            sessionStart,
            sessionEnd: endTime,
            computerAmount,
            productAmount: Number(productRow && productRow.total) || 0,
            method: options.paymentMethod || "PENDING",
            closeReason: options.closeReason || "SESSION_CLOSE"
          },
          (paymentErr, paymentInfo) => {
            if (paymentErr) return cb && cb(paymentErr);

            finalizeOpenProductSales(masa, endTime, paymentInfo ? paymentInfo.method : "PENDING", (productErr) => {
              if (productErr) return cb && cb(productErr);

              if (paymentInfo && paymentInfo.total > 0) {
                addLiveLog(
                  "payment_created",
                  `💳 Masa ${masa} ödeme • ${paymentInfo.total.toFixed(2)} ₺ • ${paymentInfo.method}`
                );
              }

    db.run("DELETE FROM masalar WHERE masa=?", [masa], (e1) => {
      logErr("autoResetIfStale delete masalar", e1);

      db.run(
        "DELETE FROM spins WHERE masa=? AND time>=?",
        [masa, todayStart],
        (e2) => {

cleanupMasa(masa);
          return cb && cb(null, true, paymentInfo || null);
        }
      );
    });
            });
          }
        );
      };

      if (!row || !row.start_time) return finishWithComputerAmount(0);
      db.get(
        `SELECT fee FROM session_history
         WHERE masa=? AND start_time=?
         ORDER BY end_time DESC LIMIT 1`,
        [masa, row.start_time],
        (historyErr, historyRow) => {
          if (historyErr) return cb && cb(historyErr);
          finishWithComputerAmount(Number(historyRow && historyRow.fee) || 0);
        }
      );
    }
  );

};

    if (row && (!row.end_time || row.end_time === 0)) {
      return finalizeEndedSessionToAdjustments({ ...row, end_time: endTime }, now, (e2) => {
        if (e2) {
          logErr("finalizeAndPrepareSession finalize", e2);
          return cb && cb(e2);
        }
        return afterFinalize();
      });
    }

    return afterFinalize();
  });
}

// EveryCafe entegrasyonu açıkken PING hiçbir koşulda müşteri kapatma kararı
// vermez. PC donabilir/restart olabilir; EveryCafe oturumu açık kaldığı sürece
// müşteri devam eder. 8 dk offline kapanışı yalnız EveryCafe kapalı yerel modda
// kullanılır.
function closeSessionIfOffline(masa, now, cb) {
  getEveryCafeConfig((configErr, config) => {
    if (configErr) {
      logErr("closeSessionIfOffline EveryCafe config", configErr);
      return cb && cb();
    }
    if (config && config.enabled) return cb && cb();
    return closeSessionIfOfflineLocal(masa, now, cb);
  });
}

function closeSessionIfOfflineLocal(masa, now, cb) {
  if (isFreeMasa(masa)) {
    // Ücretsiz masalar ücret oturumu oluşturmaz; bu nedenle normal offline
    // kapanış yolunda sessions kaydı bulunmayabilir. Son canlı ping görüldükten
    // sonra 8 dakika boyunca yeni ping gelmezse test bitmiş kabul edilir ve
    // masa ücretsiz listesinden otomatik çıkarılır.
    const freeLastSeen = Number(aktifMasalar[masa]) ||
      Number(masaPingStats[masa] && masaPingStats[masa].lastSeen) || 0;

    // Sunucu yeni açıldığında henüz ping görmediğimiz kayıtları yanlışlıkla silme.
    if (!freeLastSeen || !isActuallyOffline(masa, freeLastSeen, now)) {
      return cb && cb();
    }

    if (freeOfflineCleanupInProgress.has(masa)) return cb && cb();
    freeOfflineCleanupInProgress.add(masa);

    return autoApprovePendingRewardsForMasa(
      masa,
      "ücretsiz masa offline kapanışı",
      (approveErr) => {
        if (approveErr) logErr("free offline auto approve reward", approveErr);

        finalizeAndPrepareSession(masa, freeLastSeen, (finalizeErr) => {
          if (finalizeErr) {
            logErr("free offline finalizeAndPrepareSession", finalizeErr);
            freeOfflineCleanupInProgress.delete(masa);
            return cb && cb();
          }

          db.run(
            "UPDATE free_masalar SET enabled=0, set_time=? WHERE masa=?",
            [Date.now(), masa],
            (disableErr) => {
              if (disableErr) {
                logErr("free offline disable", disableErr);
              } else {
                freeMasalar.delete(masa);
                addLiveLog(
                  "free_offline_close",
                  `🔵 Masa ${masa} ping kesildiği için ücretsiz moddan otomatik çıkarıldı`
                );
              }

              freeOfflineCleanupInProgress.delete(masa);
              return cb && cb();
            }
          );
        }, { paymentMethod: "PENDING", closeReason: "FREE_OFFLINE" });
      }
    );
  }

  db.get(
    "SELECT * FROM sessions WHERE masa=?",
    [masa],
    (err, row) => {

      if (err) {
        logErr("closeSessionIfOffline select", err);
        return cb && cb();
      }

      if (!row) return cb && cb();
      if (row.end_time && row.end_time > 0) return cb && cb();

      const firstLastSeen = row.last_seen || 0;

      // İlk kontrolde offline değilse çık
      if (!isActuallyOffline(masa, firstLastSeen, now)) {
        return cb && cb();
      }

      autoApprovePendingRewardsForMasa(
        masa,
        "8 dakikalık offline kapanışı",
        (approveErr) => {

        if (approveErr) {
          logErr("closeSessionIfOffline auto approve reward", approveErr);
          return cb && cb();
        }

        // Session tekrar okunuyor
        db.get(
          "SELECT * FROM sessions WHERE masa=?",
          [masa],
          (e2, currentRow) => {

            if (e2) {
              logErr("closeSessionIfOffline recheck", e2);
              return cb && cb();
            }

            if (!currentRow) {
              return cb && cb();
            }

            if (currentRow.start_time !== row.start_time) {
              return cb && cb();
            }

            if (currentRow.end_time && currentRow.end_time > 0) {
              return cb && cb();
            }

            // ***** EN ÖNEMLİ KISIM *****
            const refreshedLastSeen = currentRow.last_seen || 0;

            if (!isActuallyOffline(masa, refreshedLastSeen, Date.now())) {
              return cb && cb();
            }

            diagnostics.offlineCloseCount++;

            return finalizeAndPrepareSession(
              masa,
              refreshedLastSeen || Date.now(),
              (err3) => {

                if (err3) {
                  logErr(
                    "closeSessionIfOffline finalizeAndPrepareSession",
                    err3
                  );
                }

                return cb && cb();
              },
              { paymentMethod: "PENDING", closeReason: "OFFLINE_8_MIN" }
            );

          }
        );

      });

    }
  );
}

function autoResetIfStale(masa, now, cb) {
  // EveryCafe açıkken stale/ping süresi müşteri bitiş kriteri değildir.
  // Kapanış yalnız EveryCafe Sessions.IsActive kaynağından gelir.
  getEveryCafeConfig((configErr, config) => {
    if (configErr) {
      logErr("autoResetIfStale EveryCafe config", configErr);
      return cb && cb();
    }
    if (config && config.enabled) return cb && cb();

  const lastSeen = aktifMasalar[masa] || 0;
  if (!lastSeen) return cb && cb();
  if (now - lastSeen < AUTO_RESET_MS) return cb && cb();

  const todayStart = dayStartTs(now);

db.run("DELETE FROM masalar WHERE masa=?", [masa], (e1) => {
  logErr("autoResetIfStale delete masalar", e1);

    db.run("DELETE FROM spins WHERE masa=? AND time>=?", [masa, todayStart], (e2) => {
      logErr("autoResetIfStale delete spins", e2);

      db.get("SELECT * FROM sessions WHERE masa=?", [masa], (err, row) => {

        if (err) {
          logErr("autoResetIfStale select session", err);

cleanupMasa(masa);
return cb && cb();
        }

        if (row && (!row.end_time || row.end_time === 0)) {

          return finalizeAndPrepareSession(
            masa,
            lastSeen,
            () => cb && cb(),
            { paymentMethod: "PENDING", closeReason: "AUTO_STALE" }
          );
        }

cleanupMasa(masa);
cb && cb();

      });

    });

  });
  });

}
function getPendingRewardForMasa(masa, cb) {
  const now = Date.now();
  const todayStart = dayStartTs(now);

  db.get(
    `
    SELECT id, masa, reward, time, used
    FROM spins
    WHERE masa = ?
      AND used = 0
      AND time >= ?
    ORDER BY id DESC
    LIMIT 1
    `,
    [masa, todayStart],
    (err, row) => {
      if (err) {
        logErr("getPendingRewardForMasa", err);
        return cb(err);
      }
      return cb(null, row || null);
    }
  );
}

function getAnyPendingReward(cb) {
  const now = Date.now();
  const todayStart = dayStartTs(now);

  db.get(
    `
    SELECT id, masa, reward, time, used
    FROM spins
    WHERE used = 0
      AND time >= ?
    ORDER BY time DESC, id DESC
    LIMIT 1
    `,
    [todayStart],
    (err, row) => {
      if (err) {
        logErr("getAnyPendingReward", err);
        return cb(err);
      }
      return cb(null, row || null);
    }
  );
}

function blockIfPendingReward(masa, res, next) {
  getPendingRewardForMasa(masa, (err, pendingRow) => {
    if (err) {
      return res.json({ ok: false, error: String(err) });
    }

    if (pendingRow) {
      return res.json({
        ok: false,
        error: "Bu masada bekleyen ödül onayı var. Önce ödülü onaylayın.",
        code: "PENDING_REWARD_APPROVAL",
        pendingReward: {
          id: pendingRow.id,
          masa: pendingRow.masa,
          reward: pendingRow.reward,
          time: pendingRow.time
        }
      });
    }

    return next();
  });
}

function blockIfAnyPendingReward(res, next) {
  getAnyPendingReward((err, pendingRow) => {
    if (err) {
      return res.json({ ok: false, error: String(err) });
    }

    if (pendingRow) {
      return res.json({
        ok: false,
        error: "Sistemde bekleyen ödül onayı var. Önce ödülü onaylayın.",
        code: "PENDING_REWARD_APPROVAL",
        pendingReward: {
          id: pendingRow.id,
          masa: pendingRow.masa,
          reward: pendingRow.reward,
          time: pendingRow.time
        }
      });
    }

    return next();
  });
}

app.get("/api/health", (req, res) => {
  setNoStore(res);
  db.get("SELECT 1 as ok", (err) => {
    if (err) {
      logErr("/api/health", err);
      return res.status(500).json({ ok: false, db: false });
    }
    const version = getProVersion();
    res.setHeader("X-KafePin-Version", version);
    return res.json({ ok: true, db: true, version, time: Date.now() });
  });
});

// Kurulumda secilen kafe ayarlarini yonetim ekrani ve client kurucusu
// ayni kaynaktan okur. Bu endpoint veri degistirmez.
app.get("/api/system-config", (req, res) => {
  setNoStore(res);
  return res.json({
    ok: true,
    role: "server",
    masaCount: MASA_SAYISI,
    vipMasalar: VIP_MASALAR,
    spinEnabled: SPIN_ENABLED,
    spinMinutes: SPIN_SURE_DK,
    spinDailyLimit: GUNLUK_SPIN_LIMIT,
    pricing: {
      normalOpening: NORMAL_OPENING,
      vipOpening: VIP_OPENING,
      normalIncrease: NORMAL_ARTIS,
      vipIncrease: VIP_ARTIS,
      openingMinutes: OPENING_MINUTES,
      increaseBlockMinutes: INCREASE_BLOCK_MINUTES
    }
  });
});

app.get("/admin/pro/update-status", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  const force = String(req.query.force || "") === "1";
  const audit = String(req.query.audit || "") === "1";

  // Kurulum sürüyorsa GitHub kontrolüne bile geçme. Bu endpoint güncelleme
  // düğmesinin tek otoritesidir; masaüstü pencere kaç kez yeniden açılırsa
  // açılsın hedef sürüm doğrulanana kadar available=false kalır.
  const install = getProUpdateInstallSnapshot();
  if (install) {
    return res.json({
      ok: true,
      currentVersion: install.currentVersion,
      latestVersion: install.targetVersion,
      available: false,
      installing: true,
      installTargetVersion: install.targetVersion,
      installMessage: install.targetInstalled
        ? `v${install.targetVersion} kuruldu; yeni serverin kararlı açılışı doğrulanıyor.`
        : `v${install.targetVersion} kuruluyor; işlem tamamlanana kadar tekrar başlatılamaz.`
    });
  }

  checkProUpdate(force, (err, status) => {
    if (err) {
      const currentVersion = getProVersion();
      if (audit) addLiveLog("pro_update_check", "⚠️ Uzak guncelleme merkezi gecici olarak kullanilamiyor; kurulu surum korunuyor");
      // 429/503/568 gibi gecici upstream hatalari calisan sistemi "bozuk" gostermesin.
      // Yeni surum bilinmedigi icin buton guvenli sekilde kapali kalir ve sonraki kontrollu
      // denemede RAW/CDN tekrar sorgulanir.
      return res.json({
        ok: true,
        currentVersion,
        latestVersion: currentVersion,
        available: false,
        installing: false,
        degraded: true,
        stale: true,
        warning: String(err.message || err || "Guncelleme merkezi kullanilamiyor")
      });
    }
    if (audit) addLiveLog("pro_update_check", status.available
      ? `⬆️ Guncelleme kontrolu • yeni surum hazir: v${status.latestVersion}`
      : `✅ Guncelleme kontrolu • sistem guncel: v${status.currentVersion}`);
    return res.json({ ok: true, installing: false, ...status });
  });
});

function writeProUpdateState(stage, message, extra = {}) {
  try {
    fs.mkdirSync(path.dirname(PRO_UPDATE_STATE_FILE), { recursive: true });
    fs.writeFileSync(PRO_UPDATE_STATE_FILE, JSON.stringify({
      ok: true,
      running: !["success", "error"].includes(stage),
      stage,
      message,
      time: Date.now(),
      ...extra
    }, null, 2), "utf8");
  } catch (_err) {}
}

function downloadUpdateFile(url, destination, callback) {
  const request = https.get(url, {
    headers: {
      "User-Agent": "KafePin-Pro-Updater",
      "Cache-Control": "no-cache, no-store, max-age=0",
      "Pragma": "no-cache"
    }
  }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      return downloadUpdateFile(response.headers.location, destination, callback);
    }
    if (response.statusCode !== 200) {
      response.resume();
      return callback(new Error(`Paket indirme HTTP ${response.statusCode}`));
    }
    const output = fs.createWriteStream(destination);
    response.pipe(output);
    output.on("finish", () => output.close(() => callback(null)));
    output.on("error", err => {
      try { fs.unlinkSync(destination); } catch (_err) {}
      callback(err);
    });
  });
  request.setTimeout(30000, () => request.destroy(new Error("Paket indirme zaman asimina ugradi")));
  request.on("error", err => {
    try { fs.unlinkSync(destination); } catch (_err) {}
    callback(err);
  });
}

app.get("/admin/pro/update-progress", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  setNoStore(res);
  try {
    const state = JSON.parse(fs.readFileSync(PRO_UPDATE_STATE_FILE, "utf8").replace(/^\uFEFF/, ""));
    if (state && state.running === false && Date.now() - Number(state.time || 0) > 30000) {
      return res.json({ ok: true, running: false, stage: "idle", message: "Bekleyen guncelleme islemi yok" });
    }
    return res.json({ ok: true, ...state });
  } catch (_err) {
    return res.json({ ok: true, running: false, stage: "idle", message: "Bekleyen guncelleme islemi yok" });
  }
});


function runChildTracked(command, args, timeoutMs, callback) {
  let finished = false;
  let stderr = "";
  let stdout = "";
  let child = null;
  const done = (err) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    callback(err, { stdout, stderr });
  };

  try {
    child = spawn(command, args, { windowsHide: true });
  } catch (err) {
    return done(err);
  }

  child.stdout && child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
  child.stderr && child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
  child.on("error", err => done(err));
  child.on("close", code => {
    if (code === 0) return done(null);
    done(new Error(`${command} cikis kodu ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`));
  });

  const timer = setTimeout(() => {
    try { child.kill(); } catch (_err) {}
    done(new Error(`${command} zaman asimina ugradi`));
  }, timeoutMs);
}


// ================= KAFEPIN PRO MASAUSTU UYGULAMASI =================
// Edge uygulama penceresi yerine KafePin'in kendi WebView2 tabanli EXE'si
// kullanilir. Bu bolum sadece masaustu kabugunu hazirlar; guncelleme motoruna
// ve kafe is mantigina dokunmaz.
// v3.1.48: Masaüstü kabuğunda bağımsız Yazıcı PRO sekmesi de kurulur.
const KAFEPIN_DESKTOP_APP_VERSION = "1.1.5";
const KAFEPIN_DESKTOP_APP_DIR = path.join(__dirname, "desktop-app");
const KAFEPIN_DESKTOP_APP_EXE = path.join(KAFEPIN_DESKTOP_APP_DIR, "KafePin Pro.exe");
const KAFEPIN_DESKTOP_APP_MARKER = path.join(KAFEPIN_DESKTOP_APP_DIR, "desktop-app-installed.json");
const KAFEPIN_DESKTOP_APP_SETUP = path.join(__dirname, "KafePin_Desktop_App_Setup.ps1");
const KAFEPIN_RECOVERY_HELPER_SOURCE = path.join(__dirname, "KafePin_Recovery.ps1");
const KAFEPIN_MANAGER_ENSURE = path.join(__dirname, "KafePin_Manager_Ensure.ps1");
const KAFEPIN_MANAGER_CONTROL_PORT = 2999;
const KAFEPIN_MANAGER_TOKEN_FILE = path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro", "manager.token");
const KAFEPIN_SYSTEM_ROOT = path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro");
const KAFEPIN_RECOVERY_HELPER_SYSTEM = path.join(KAFEPIN_SYSTEM_ROOT, "KafePin_Recovery.ps1");
let kafepinDesktopSetupRunning = false;

function syncKafePinRecoveryHelper() {
  if (process.platform !== "win32") return "";
  if (!fs.existsSync(KAFEPIN_RECOVERY_HELPER_SOURCE)) return "";
  try {
    fs.mkdirSync(KAFEPIN_SYSTEM_ROOT, { recursive: true });
    let same = false;
    if (fs.existsSync(KAFEPIN_RECOVERY_HELPER_SYSTEM)) {
      try {
        const a = crypto.createHash("sha256").update(fs.readFileSync(KAFEPIN_RECOVERY_HELPER_SOURCE)).digest("hex");
        const b = crypto.createHash("sha256").update(fs.readFileSync(KAFEPIN_RECOVERY_HELPER_SYSTEM)).digest("hex");
        same = a === b;
      } catch (_err) {}
    }
    if (!same) fs.copyFileSync(KAFEPIN_RECOVERY_HELPER_SOURCE, KAFEPIN_RECOVERY_HELPER_SYSTEM);
    return KAFEPIN_RECOVERY_HELPER_SYSTEM;
  } catch (err) {
    logErr("recovery helper sync", err);
    return "";
  }
}

function launchKafePinRecoveryHelper(options = {}) {
  if (process.platform !== "win32") return false;
  try {
    const helper = syncKafePinRecoveryHelper();
    if (!helper) throw new Error("KafePin kurtarma motoru bulunamadi");
    const args = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper,
      "-InstallRoot", __dirname,
      "-Reason", String(options.reason || "automatic")
    ];
    if (options.waitForDownFirst) args.push("-WaitForDownFirst");
    if (options.launchDesktop) args.push("-LaunchDesktop");
    const child = spawn("powershell.exe", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    addLiveLog("recovery", `🛟 Kurtarma motoru devreye alindi • ${String(options.reason || "automatic")}`);
    return true;
  } catch (err) {
    logErr("launch recovery helper", err);
    return false;
  }
}

if (process.platform === "win32") {
  try { syncKafePinRecoveryHelper(); } catch (_err) {}
}

function getKafePinDesktopAppVersion() {
  try {
    const data = JSON.parse(fs.readFileSync(KAFEPIN_DESKTOP_APP_MARKER, "utf8").replace(/^\uFEFF/, ""));
    return String(data.version || "");
  } catch (_err) {
    return "";
  }
}

function ensureKafePinDesktopApp(force = false) {
  if (process.platform !== "win32") return;
  if (kafepinDesktopSetupRunning) return;

  const installedVersion = getKafePinDesktopAppVersion();
  if (!force && installedVersion === KAFEPIN_DESKTOP_APP_VERSION && fs.existsSync(KAFEPIN_DESKTOP_APP_EXE)) {
    return;
  }
  if (!fs.existsSync(KAFEPIN_DESKTOP_APP_SETUP)) {
    addLiveLog("desktop_app", "⚠️ Masaustu uygulamasi kurulum dosyasi bulunamadi");
    return;
  }

  kafepinDesktopSetupRunning = true;
  addLiveLog("desktop_app", "🪟 KafePin Pro masaustu uygulamasi hazirlaniyor");

  runChildTracked(
    "powershell.exe",
    [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", KAFEPIN_DESKTOP_APP_SETUP,
      "-InstallRoot", __dirname,
      "-AppVersion", KAFEPIN_DESKTOP_APP_VERSION,
      "-Launch"
    ],
    240000,
    (err, result) => {
      kafepinDesktopSetupRunning = false;
      if (err) {
        const detail = String((result && result.stderr) || err.message || err).trim();
        addLiveLog("desktop_app", `⚠️ Masaustu uygulamasi hazirlanamadi: ${detail.slice(0, 180)}`);
        return;
      }
      addLiveLog("desktop_app", "✅ KafePin Pro masaustu uygulamasi hazir • mevcut kisayol korundu / gerekirse olusturuldu");
    }
  );
}

function extractUpdateZipTracked(zipPath, destination, callback) {
  try { fs.mkdirSync(destination, { recursive: true }); } catch (err) { return callback(err); }

  // Windows 11'de yerlesik tar.exe ZIP acar. Bu yol PowerShell'den tamamen bagimsizdir.
  runChildTracked(process.platform === "win32" ? "tar.exe" : "unzip", process.platform === "win32" ? ["-xf", zipPath, "-C", destination] : ["-o", zipPath, "-d", destination], 45000, (tarErr) => {
    if (!tarErr) return callback(null);

    // tar.exe kullanilamazsa .NET ZipFile kontrollu fallback.
    const helper = path.join(os.tmpdir(), `kafepin-extract-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    const script = [
      "param([string]$ZipPath,[string]$Destination)",
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "[IO.Compression.ZipFile]::ExtractToDirectory($ZipPath,$Destination)"
    ].join("\r\n");

    try { fs.writeFileSync(helper, script, "utf8"); }
    catch (err) { return callback(new Error(`ZIP acma yardimcisi yazilamadi: ${err.message || err}`)); }

    runChildTracked("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper,
      "-ZipPath", zipPath, "-Destination", destination
    ], 45000, (psErr) => {
      try { fs.unlinkSync(helper); } catch (_err) {}
      if (!psErr) return callback(null);
      callback(new Error(`ZIP acilamadi. tar: ${tarErr.message || tarErr}; .NET: ${psErr.message || psErr}`));
    });
  });
}

function parseUpdaterArg(args, flag) {
  const i = Array.isArray(args) ? args.indexOf(flag) : -1;
  return i >= 0 && i + 1 < args.length ? String(args[i + 1] || "") : "";
}


function ensureKafePinManagerReadySync() {
  if (process.platform !== "win32") return true;
  if (!fs.existsSync(KAFEPIN_MANAGER_ENSURE)) throw new Error("Server Manager on-kontrol dosyasi bulunamadi");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", KAFEPIN_MANAGER_ENSURE,
    "-InstallRoot", __dirname,
    "-NodePath", process.execPath
  ], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 35000
  });
  if (result.error) throw result.error;
  if (Number(result.status) !== 0) {
    const detail = String(result.stderr || result.stdout || `cikis kodu ${result.status}`).trim();
    throw new Error(`Server Manager hazirlanamadi: ${detail.slice(0, 500)}`);
  }
  return true;
}

function managerControlRequest(route, method, callback) {
  if (process.platform !== "win32") return callback(null, { ok: true, accepted: true, simulated: true });
  let token = "";
  try { token = fs.readFileSync(KAFEPIN_MANAGER_TOKEN_FILE, "utf8").trim(); } catch (_err) {}
  if (!token) return callback(new Error("Server Manager token bulunamadi"));
  const req = http.request({
    host: "127.0.0.1",
    port: KAFEPIN_MANAGER_CONTROL_PORT,
    path: route,
    method: method || "GET",
    headers: {
      "X-KafePin-Manager-Token": token,
      "Cache-Control": "no-cache"
    },
    timeout: 5000
  }, response => {
    let body = "";
    response.on("data", chunk => { body += chunk; });
    response.on("end", () => {
      let data = null;
      try { data = JSON.parse(body || "{}"); } catch (_err) {}
      if (response.statusCode < 200 || response.statusCode >= 300 || !data || data.ok !== true) {
        return callback(new Error(`Server Manager ${route} HTTP ${response.statusCode}: ${String(body).slice(0, 300)}`));
      }
      callback(null, data);
    });
  });
  req.on("error", callback);
  req.on("timeout", () => req.destroy(new Error("Server Manager istegi zaman asimina ugradi")));
  req.end();
}

function requestManagerRestartHandoff(callback) {
  managerControlRequest("/restart-async", "POST", callback);
}
function requestManagerRestoreHandoff(callback) {
  managerControlRequest("/restore-async", "POST", callback);
}

function applyPreparedUpdateDirect(zipPath, expectedVersion, onError) {
  const installWork = fs.mkdtempSync(path.join(os.tmpdir(), "kafepin-direct-apply-"));
  const expanded = path.join(installWork, "expanded");
  let finished = false;

  const fail = err => {
    if (finished) return;
    finished = true;
    const message = String((err && err.message) || err || "Bilinmeyen guncelleme hatasi");
    try { writeProUpdateState("error", message, { version: expectedVersion || "" }); } catch (_err) {}
    try {
      fs.writeFileSync(
        path.join(__dirname, "logs", "kafepin-pro-update-result.json"),
        JSON.stringify({ ok: false, error: message, time: new Date().toISOString() }, null, 2),
        "utf8"
      );
    } catch (_err) {}
    try { fs.rmSync(installWork, { recursive: true, force: true }); } catch (_err) {}
    try { clearProUpdateInstallLock(expectedVersion || ""); } catch (_err) {}
    addLiveLog("pro_update", `⚠️ Guncelleme tamamlanamadi: ${message.slice(0, 180)}`);
    if (onError) onError(new Error(message));
  };

  writeProUpdateState("extract", "Paket aciliyor", { version: expectedVersion || "" });

  extractUpdateZipTracked(zipPath, expanded, extractErr => {
    if (extractErr) return fail(extractErr);

    try {
      writeProUpdateState("verify", "Paket icerigi dogrulaniyor", { version: expectedVersion || "" });

      const infoPath = path.join(expanded, "update.json");
      if (!fs.existsSync(infoPath)) throw new Error("Paket tanim dosyasi update.json bulunamadi");
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8").replace(/^\uFEFF/, ""));
      const targetVersion = String(info.version || "");
      const files = Array.isArray(info.files) ? info.files.map(String) : [];

      if (!/^\d+(\.\d+){1,3}$/.test(targetVersion)) throw new Error("Paket surumu gecersiz");
      if (expectedVersion && targetVersion !== expectedVersion) {
        throw new Error(`Paket surumu uyusmuyor. Beklenen ${expectedVersion}, paket ${targetVersion}`);
      }
      if (!files.length) throw new Error("Paket dosya listesi bos");

      for (const rel of files) {
        if (!rel || /(^|[\\/])\.\.([\\/]|$)/.test(rel) || path.isAbsolute(rel)) {
          throw new Error(`Gecersiz paket yolu: ${rel}`);
        }
        const src = path.join(expanded, rel);
        if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
          throw new Error(`Paket dosyasi eksik: ${rel}`);
        }
      }

      writeProUpdateState("copy", `Dosyalar kuruluyor: v${targetVersion}`, { version: targetVersion });

      // Node server calisirken JS/HTML dosyalari Windows'ta guvenle degistirilebilir.
      // Server ancak tum kopyalama ve surum yazma bittikten SONRA kapanir.
      for (const rel of files) {
        const src = path.join(expanded, rel);
        const dst = path.join(__dirname, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }

      // Yeni manager dosyasini ProgramData'ya da koy. Calisan manager eski kodla
      // serveri yeniden kaldirabilir; reboot sonrasi yeni manager kesin yuklenir.
      const managerSource = path.join(__dirname, "KafePin_System_Manager.ps1");
      if (fs.existsSync(managerSource)) {
        const systemRoot = path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro");
        fs.mkdirSync(systemRoot, { recursive: true });
        try { fs.copyFileSync(managerSource, path.join(systemRoot, "KafePin_System_Manager.ps1")); } catch (_err) {}
        try { fs.unlinkSync(path.join(systemRoot, "server.manual-stop")); } catch (_err) {}
        try { fs.unlinkSync(path.join(systemRoot, "maintenance.lock")); } catch (_err) {}
      }

      const versionData = {
        version: targetVersion,
        channel: "stable",
        mode: "panel-direct-updater",
        installedAt: new Date().toISOString()
      };
      fs.writeFileSync(
        path.join(__dirname, "kafepin-pro-version.json"),
        JSON.stringify(versionData, null, 2) + "\n",
        "utf8"
      );

      fs.mkdirSync(path.join(__dirname, "logs"), { recursive: true });
      fs.writeFileSync(
        path.join(__dirname, "logs", "kafepin-pro-update-result.json"),
        JSON.stringify({ ok: true, version: targetVersion, time: new Date().toISOString() }, null, 2),
        "utf8"
      );
      // v3.1.2: Diskteki manager degistiyse CALISAN manager da ayni surume alinir.
      // Boylece ProgramData yeni fakat bellekte eski manager kalmaz.
      ensureKafePinManagerReadySync();

      writeProUpdateState("handoff", `v${targetVersion} kuruldu; Server Manager yeniden baslatma teslimini aliyor`, {
        version: targetVersion,
        running: true
      });
      addLiveLog("pro_update", `✅ v${targetVersion} dosyalari kuruldu • yeniden baslatma Server Manager'a teslim ediliyor`);

      // v3.1.2: Guncelleme sonrasinda Node kendini kapatmaz ve Recovery/schtasks
      // zinciri baslatmaz. Kalici Server Manager control API istegi ONCE kabul eder,
      // cevabi dondurur ve sonraki manager dongusunde serveri kontrollu restart eder.
      // Handoff kabul edilmezse mevcut server calismaya devam eder; kilitli ekran yoktur.
      requestManagerRestartHandoff((handoffErr, handoff) => {
        if (handoffErr || !handoff || handoff.accepted !== true) {
          const message = String((handoffErr && handoffErr.message) || "Server Manager yeniden baslatma istegini kabul etmedi");
          writeProUpdateState("error", `Dosyalar kuruldu fakat yeniden baslatma teslimi basarisiz: ${message}`, {
            version: targetVersion,
            running: false
          });
          addLiveLog("pro_update", `⚠️ v${targetVersion} dosyalari kuruldu fakat Server Manager restart teslimi basarisiz: ${message.slice(0, 160)}`);
          try {
            fs.writeFileSync(
              path.join(__dirname, "logs", "kafepin-pro-update-result.json"),
              JSON.stringify({ ok: false, version: targetVersion, error: `Restart handoff basarisiz: ${message}`, time: new Date().toISOString() }, null, 2),
              "utf8"
            );
          } catch (_err) {}
          try { fs.rmSync(installWork, { recursive: true, force: true }); } catch (_err) {}
          try { clearProUpdateInstallLock(targetVersion); } catch (_err) {}
          if (onError) onError(new Error(message));
          return;
        }

        writeProUpdateState("restart_pending", `v${targetVersion} dosyalari kuruldu; yeni server kararlı açılana kadar güncelleme kilidi korunuyor`, {
          version: targetVersion,
          running: true,
          managerHandoff: true
        });
        addLiveLog("pro_update", `🧭 Server Manager restart istegini kabul etti • yeni server doğrulanana kadar güncelleme kilidi açık`);
        finished = true;
        try { fs.rmSync(installWork, { recursive: true, force: true }); } catch (_err) {}

        // v3.1.19: Manager restart-async teslimini kabul ettikten sonra normalde
        // manager bu Node'u kapatip yeni serveri baslatir. Sahada manager istegi
        // kabul ettigi halde eski Node'un calismaya devam ettigi durum goruldu.
        // HTTP kurulum cevabi zaten daha once dondugu ve tum dosyalar diske
        // yazildigi icin, kisa bir emniyet gecikmesinden sonra kaynak Node kendini
        // kapatir. Manager ayakta oldugundan restart-request'i tuketerek veya
        // sunucu yok kontroluyle yeni Node'u tekrar baslatir. Manager daha once
        // kapatirsa bu timer zaten calisamaz; yani cift restart olusmaz.
        setTimeout(() => {
          try {
            addLiveLog("pro_update", `🔄 v${targetVersion} • eski server kapanıyor; yeni server Server Manager tarafından açılacak`);
          } catch (_err) {}
          process.exit(0);
        }, 1800);
      });
    } catch (err) {
      fail(err);
    }
  });
}

// Eski fonksiyon adi korunuyor ki mevcut panel endpointleri degismeden calissin.
// Artik gizli/detached PowerShell updater BASLATMAZ.
function launchProUpdaterExternal(_updaterPath, updaterArgs, onError) {
  try {
    const zipPath = parseUpdaterArg(updaterArgs, "-LocalZipPath");
    const expectedVersion = parseUpdaterArg(updaterArgs, "-ExpectedVersion");
    if (!zipPath || !fs.existsSync(zipPath)) {
      throw new Error("Kurulacak ZIP paketi bulunamadi");
    }
    applyPreparedUpdateDirect(zipPath, expectedVersion, onError);
    return true;
  } catch (err) {
    if (onError) onError(err);
    return false;
  }
}
app.post("/admin/pro/apply-update", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  checkProUpdate(true, (err, status) => {
    if (err || !status || !status.available) return res.status(409).json({ ok: false, error: "Yuklenecek yeni surum bulunamadi" });
    const updater = path.join(__dirname, "KafePin_Pro_OtoGuncelle.ps1");
    if (!fs.existsSync(updater)) return res.status(500).json({ ok: false, error: "Otomatik guncelleme dosyasi bulunamadi" });

    try {
      ensureKafePinManagerReadySync();
    } catch (managerErr) {
      const message = String(managerErr.message || managerErr);
      writeProUpdateState("error", `Server Manager on-kontrolu basarisiz: ${message}`, { version: status.latestVersion });
      addLiveLog("pro_update", `⚠️ Guncelleme baslatilmadi • Server Manager hazir degil: ${message.slice(0, 150)}`);
      return res.status(500).json({ ok: false, error: `Server Manager hazir degil: ${message}` });
    }

    try {
      writeProUpdateInstallLock(status.latestVersion);
    } catch (lockErr) {
      const message = String(lockErr.message || lockErr);
      addLiveLog("pro_update", `⚠️ Guncelleme kilidi olusturulamadi: ${message.slice(0, 150)}`);
      return res.status(500).json({ ok: false, error: `Guncelleme guvenlik kilidi olusturulamadi: ${message}` });
    }

    writeProUpdateState("backup", "Emniyet yedegi aliniyor", { version: status.latestVersion });
    addLiveLog("pro_update", `⬆️ KafePin Pro v${status.latestVersion} kurulumu • emniyet yedegi aliniyor`);

    createFullProjectBackup((backupErr, safetyBackup) => {
      if (backupErr) {
        writeProUpdateState("error", `Emniyet yedegi alinamadi: ${backupErr.message || backupErr}`, { version: status.latestVersion });
        clearProUpdateInstallLock(status.latestVersion);
        addLiveLog("pro_update", `⚠️ Guncelleme iptal edildi • yedek alinamadi: ${String(backupErr.message || backupErr).slice(0, 160)}`);
        return res.status(500).json({ ok: false, error: `Emniyet yedegi alinamadi: ${backupErr.message || backupErr}` });
      }

      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "kafepin-pro-download-"));
      const zipPath = path.join(workDir, `KafePin-Pro-Update-v${status.latestVersion}.zip`);
      writeProUpdateState("download", "Guncelleme paketi indiriliyor", { version: status.latestVersion, safetyBackup: safetyBackup && safetyBackup.fileName });

      downloadUpdateFile(status.downloadUrl, zipPath, downloadErr => {
        if (downloadErr) {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_err) {}
          writeProUpdateState("error", `Paket indirilemedi: ${downloadErr.message || downloadErr}`, { version: status.latestVersion });
          clearProUpdateInstallLock(status.latestVersion);
          addLiveLog("pro_update", `⚠️ Guncelleme paketi indirilemedi: ${String(downloadErr.message || downloadErr).slice(0, 160)}`);
          return res.status(502).json({ ok: false, error: `Paket indirilemedi: ${downloadErr.message || downloadErr}` });
        }

        try {
          if (status.sha256) {
            const hash = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex").toLowerCase();
            const expectedHash = String(status.sha256).toLowerCase();
            if (hash !== expectedHash) {
              addLiveLog("pro_update", `⚠️ SHA-256 uyusmazligi • beklenen ${expectedHash.slice(0, 12)}... • gelen ${hash.slice(0, 12)}...`);
              throw new Error(`Indirilen paketin SHA-256 dogrulamasi basarisiz (beklenen ${expectedHash.slice(0,12)}..., gelen ${hash.slice(0,12)}...)`);
            }
          }
        } catch (verifyErr) {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_err) {}
          writeProUpdateState("error", verifyErr.message || String(verifyErr), { version: status.latestVersion });
          clearProUpdateInstallLock(status.latestVersion);
          return res.status(500).json({ ok: false, error: verifyErr.message || String(verifyErr) });
        }

        writeProUpdateState("install", "Paket dogrulandi; kurulum baslatiliyor", { version: status.latestVersion, safetyBackup: safetyBackup && safetyBackup.fileName });
        addLiveLog("pro_update", `💾 Emniyet yedegi hazir • ${safetyBackup && safetyBackup.fileName ? safetyBackup.fileName : "tamam"}`);
        res.json({ ok: true, message: "Yedek ve paket dogrulandi; kurulum baslatiliyor", version: status.latestVersion, safetyBackup: safetyBackup && safetyBackup.fileName });

        setTimeout(() => {
          launchProUpdaterExternal(updater, [
            "-LocalZipPath", zipPath,
            "-ExpectedVersion", status.latestVersion,
            "-SkipBackup"
          ], spawnErr => {
            writeProUpdateState("error", `Kurucu baslatilamadi: ${spawnErr.message || spawnErr}`, { version: status.latestVersion });
            clearProUpdateInstallLock(status.latestVersion);
            addLiveLog("pro_update", "⚠️ Otomatik guncelleme kurucusu baslatilamadi");
          });
        }, 500);
      });
    });
  });
});

// Internet olmadiginda da ayni guvenli akis kullanilabilir. Dosya secme
// penceresi sunucunun calistigi bilgisayarda acilir; tarayici dosya yoluna
// erismek zorunda kalmaz.
let localUpdatePickerRunning = false;
function selectLocalUpdateZipWindows(callback) {
  if (localUpdatePickerRunning) {
    return callback(new Error("ZIP seçici zaten açık; mevcut seçim tamamlanmadan yeni seçim başlatılamaz"), {});
  }
  localUpdatePickerRunning = true;

  const finishOnce = (() => {
    let done = false;
    return (err, detail) => {
      if (done) return;
      done = true;
      localUpdatePickerRunning = false;
      callback(err || null, detail || {});
    };
  })();

  if (process.platform !== "win32") {
    return finishOnce(new Error("Yerel ZIP seçici yalnız Windows üzerinde kullanılabilir"));
  }

  const programData = process.env.ProgramData || "C:\\ProgramData";
  const bridgeDir = path.join(programData, "KafePinPro", "DesktopBridge");
  const requestFile = path.join(bridgeDir, "request.json");
  const resultFile = path.join(bridgeDir, "result.json");
  const helperEnsure = path.join(__dirname, "KafePin_Desktop_Helper_Ensure.ps1");
  const taskName = "KafePin Pro Desktop Action";
  const requestId = crypto.randomBytes(12).toString("hex");

  try {
    fs.mkdirSync(bridgeDir, { recursive: true });
    const tempRequest = `${requestFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempRequest, JSON.stringify({ requestId, action: "select-update-zip", createdAt: Date.now() }), "utf8");
    try { fs.unlinkSync(requestFile); } catch (_err) {}
    fs.renameSync(tempRequest, requestFile);
    try { fs.unlinkSync(resultFile); } catch (_err) {}
  } catch (err) {
    return finishOnce(new Error(`ZIP seçme isteği hazırlanamadı: ${err.message || err}`));
  }

  let ensureAttempted = false;
  const ensureAndRetry = () => {
    if (ensureAttempted) return finishOnce(new Error("Windows dosya seçici masaüstü yardımcısı yanıt vermedi"));
    ensureAttempted = true;
    if (!fs.existsSync(helperEnsure)) {
      return finishOnce(new Error("KafePin masaüstü yardımcısı kurulum dosyası bulunamadı"));
    }
    runDesktopBridgeProcess("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", helperEnsure,
      "-InstallRoot", __dirname
    ], 7000, ensureErr => {
      if (ensureErr) return finishOnce(new Error(`Masaüstü yardımcısı hazırlanamadı: ${ensureErr.message || ensureErr}`));
      triggerTask(false);
    });
  };

  const pollResult = () => {
    // Dosya seçici kullanıcı açık tuttuğu sürece bekleyebilir; 10 dakika sonra güvenli timeout.
    const deadline = Date.now() + 10 * 60 * 1000;
    const poll = () => {
      if (Date.now() > deadline) return finishOnce(new Error("ZIP seçimi zaman aşımına uğradı"));
      try {
        const raw = fs.readFileSync(resultFile, "utf8").replace(/^\uFEFF/, "");
        const data = JSON.parse(raw);
        if (!data || String(data.requestId || "") !== requestId) return setTimeout(poll, 100);
        if (data.ok !== true) return finishOnce(new Error(String(data.error || "ZIP seçilemedi")));
        if (data.cancelled === true) return finishOnce(null, { cancelled: true });
        const selectedPath = String(data.selectedPath || "").trim();
        if (!selectedPath || !/\.zip$/i.test(selectedPath) || !fs.existsSync(selectedPath)) {
          return finishOnce(new Error("Geçerli bir ZIP paketi seçilmedi"));
        }
        return finishOnce(null, { cancelled: false, zipPath: selectedPath, sessionId: Number(data.sessionId) || 0, method: "interactive-desktop-picker" });
      } catch (_err) {
        setTimeout(poll, 100);
      }
    };
    poll();
  };

  function triggerTask(allowEnsure) {
    runDesktopBridgeProcess("schtasks.exe", ["/Run", "/TN", taskName], 3000, err => {
      if (!err) return pollResult();
      if (!allowEnsure) return finishOnce(err);
      ensureAndRetry();
    });
  }

  triggerTask(true);
}

app.post("/admin/pro/apply-local-update", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  const updater = path.join(__dirname, "KafePin_Pro_OtoGuncelle.ps1");
  if (!fs.existsSync(updater)) return res.status(500).json({ ok: false, error: "Guncelleme dosyasi bulunamadi" });

  // v3.1.28: OpenFileDialog artık SYSTEM/Session 0 içinde oluşturulmaz. Aynı
  // v3.1.27 Desktop Bridge görevi aktif Windows kullanıcısının interaktif
  // oturumunda çalışır. Dosya seçici Windows'un gerçek İndirilenler klasöründen
  // başlar; kullanıcı ZIP başka yerdeyse dialog içinde istediği konuma gidebilir.
  selectLocalUpdateZipWindows((pickerErr, pickerDetail) => {
    if (pickerErr) return res.status(500).json({ ok: false, error: pickerErr.message || String(pickerErr) });
    if (pickerDetail && pickerDetail.cancelled) return res.json({ ok: false, cancelled: true });
    const zipPath = String((pickerDetail && pickerDetail.zipPath) || "").trim();
    if (!zipPath || !/\.zip$/i.test(zipPath) || !fs.existsSync(zipPath)) {
      return res.status(400).json({ ok: false, error: "Gecerli bir ZIP paketi secilmedi" });
    }

    writeProUpdateState("backup", "Yerel paket icin emniyet yedegi aliniyor");
    createFullProjectBackup((backupErr, safetyBackup) => {
      if (backupErr) {
        writeProUpdateState("error", `Emniyet yedegi alinamadi: ${backupErr.message || backupErr}`);
        return res.status(500).json({ ok: false, error: `Emniyet yedegi alinamadi: ${backupErr.message || backupErr}` });
      }
      addLiveLog("pro_update", `⬆️ Yerel guncelleme paketi kurulumu • ${path.basename(zipPath)}`);
      writeProUpdateState("install", "Yerel paket kurulumu baslatiliyor", { safetyBackup: safetyBackup && safetyBackup.fileName });
      res.json({ ok: true, message: "Emniyet yedegi alindi; secilen paket kuruluyor", safetyBackup: safetyBackup && safetyBackup.fileName });
      setTimeout(() => {
        launchProUpdaterExternal(updater, ["-LocalZipPath", zipPath, "-SkipBackup"], spawnErr => {
          writeProUpdateState("error", `Kurucu baslatilamadi: ${spawnErr.message || spawnErr}`);
        });
      }, 500);
    });
  });
});

// Pro Yonetim Merkezi yalnizca ayni bilgisayardan (veya Tailscale'in yerel
// proxy'sinden) kullanilir. Yeniden baslatma, kullanicinin BAT menusune
// girmesine gerek kalmadan ana programdaki tek dugmeden yapilir.
app.post("/admin/pro/restart", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  res.json({ ok: true, message: "Sunucu Windows Sistem Yoneticisi tarafindan yeniden baslatilacak" });
  setTimeout(() => process.exit(0), 300);
});

function getProBackupList() {
  const found = new Map();
  for (const dir of FULL_BACKUP_SEARCH_DIRS) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/^KafePin_.*\.zip$/i.test(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const stat = fs.statSync(fullPath);
        const key = entry.name.toLowerCase();
        const prev = found.get(key);
        if (!prev || stat.mtimeMs > prev.time) {
          found.set(key, { fileName: entry.name, time: stat.mtimeMs, size: stat.size, path: fullPath });
        }
      }
    } catch (_err) {}
  }
  return Array.from(found.values()).sort((a, b) => b.time - a.time);
}

function resolveProBackupPath(fileName) {
  const safeName = path.basename(String(fileName || ""));
  for (const dir of FULL_BACKUP_SEARCH_DIRS) {
    const candidate = path.join(dir, safeName);
    try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch (_err) {}
  }
  return path.join(FULL_BACKUP_DIR, safeName);
}

app.get("/admin/pro/backups", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  res.json({ ok: true, destination: KAFEPIN_BACKUP_ROOT, fullDestination: FULL_BACKUP_DIR, list: getProBackupList().slice(0, 30) });
});

app.post("/admin/pro/db-backup", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  const dbDir = path.join(KAFEPIN_BACKUP_ROOT, "DB");
  try { fs.mkdirSync(dbDir, { recursive: true }); } catch (err) { return res.status(500).json({ ok: false, error: String(err.message || err) }); }
  const output = path.join(dbDir, `database_${backupFileStamp()}.db`);
  createVerifiedKafePinSnapshot(output, (err, detail) => {
    if (err) return res.status(500).json({ ok: false, error: String(err.message || err) });
    addLiveLog("db_backup", `💾 Veritabanı yedeği alındı ve doğrulandı • ${path.basename(output)}`);
    res.json({ ok: true, path: output, time: Date.now(), verified: true, method: detail && detail.method, size: Number(detail && detail.size) || 0 });
  });
});

function runDesktopBridgeProcess(exe, args, timeoutMs, callback) {
  let child;
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (err, detail) => {
    if (settled) return;
    settled = true;
    callback(err, detail || {});
  };
  try {
    child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return finish(err);
  }
  if (child.stdout) child.stdout.on("data", chunk => { stdout += String(chunk || ""); });
  if (child.stderr) child.stderr.on("data", chunk => { stderr += String(chunk || ""); });
  const timer = setTimeout(() => {
    try { child.kill(); } catch (_err) {}
    finish(new Error(`${path.basename(exe)} zaman aşımı`), { stdout, stderr });
  }, Math.max(500, Number(timeoutMs) || 3000));
  child.on("error", err => {
    clearTimeout(timer);
    finish(err, { stdout, stderr });
  });
  child.on("close", code => {
    clearTimeout(timer);
    if (Number(code) === 0) return finish(null, { code: 0, stdout, stderr });
    finish(new Error((stderr || stdout || `${path.basename(exe)} çıkış kodu ${code}`).trim()), { code, stdout, stderr });
  });
}

function focusExplorerFolderWindows(folder, callback) {
  const finishOnce = (() => {
    let done = false;
    return (err, detail) => {
      if (done) return;
      done = true;
      callback(err, detail || {});
    };
  })();

  // Linux/test ortami icin koruyucu fallback. Saha kurulumu Windows'tur.
  if (process.platform !== "win32") {
    try {
      const child = spawn("xdg-open", [folder], { detached: true, stdio: "ignore" });
      child.unref();
      return finishOnce(null, { verified: true, hwnd: 0, method: "xdg-open" });
    } catch (err) {
      return finishOnce(err);
    }
  }

  // v3.1.27: Node/Server Manager SYSTEM oturumunda calisir. Windows, Session 0'daki
  // bir prosesin kullanicinin Explorer penceresini foreground yapmasini guvenlik geregi
  // engelleyebilir. Bu nedenle pencere islemi artik SYSTEM'den yapilmaz. Sunucu sadece
  // ProgramData bridge istegini yazar ve "KafePin Pro Desktop Action" gorevini tetikler.
  // O gorev aktif kullanicinin TASK_LOGON_INTERACTIVE_TOKEN oturumunda calisir; Explorer'i
  // ayni masaustu/session icinde acar, HWND'yi one getirir ve sonucu bridge dosyasina yazar.
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const bridgeDir = path.join(programData, "KafePinPro", "DesktopBridge");
  const requestFile = path.join(bridgeDir, "request.json");
  const resultFile = path.join(bridgeDir, "result.json");
  const helperEnsure = path.join(__dirname, "KafePin_Desktop_Helper_Ensure.ps1");
  const taskName = "KafePin Pro Desktop Action";
  const requestId = crypto.randomBytes(12).toString("hex");

  try {
    fs.mkdirSync(bridgeDir, { recursive: true });
    const tempRequest = `${requestFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempRequest, JSON.stringify({ requestId, folder, createdAt: Date.now() }), "utf8");
    try { fs.unlinkSync(requestFile); } catch (_err) {}
    fs.renameSync(tempRequest, requestFile);
    try { fs.unlinkSync(resultFile); } catch (_err) {}
  } catch (err) {
    return finishOnce(new Error(`Masaüstü klasör isteği hazırlanamadı: ${err.message || err}`));
  }

  let ensureAttempted = false;
  const ensureAndRetry = () => {
    if (ensureAttempted) return finishOnce(new Error("Explorer masaüstü yardımcısı yanıt vermedi"));
    ensureAttempted = true;
    if (!fs.existsSync(helperEnsure)) {
      return finishOnce(new Error("KafePin masaüstü yardımcısı kurulum dosyası bulunamadı"));
    }
    runDesktopBridgeProcess("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", helperEnsure,
      "-InstallRoot", __dirname
    ], 7000, ensureErr => {
      if (ensureErr) return finishOnce(new Error(`Masaüstü yardımcısı hazırlanamadı: ${ensureErr.message || ensureErr}`));
      triggerTask(false);
    });
  };

  const pollResult = () => {
    const deadline = Date.now() + (ensureAttempted ? 6500 : 3500);
    const poll = () => {
      if (Date.now() > deadline) {
        return ensureAndRetry();
      }
      try {
        const raw = fs.readFileSync(resultFile, "utf8").replace(/^\uFEFF/, "");
        const data = JSON.parse(raw);
        if (!data || String(data.requestId || "") !== requestId) {
          return setTimeout(poll, 80);
        }
        if (data.ok === true && data.foreground === true) {
          return finishOnce(null, {
            verified: true,
            hwnd: Number(data.hwnd) || 0,
            sessionId: Number(data.sessionId) || 0,
            method: "interactive-desktop-task"
          });
        }
        return finishOnce(new Error(String(data.error || "Explorer kullanıcı masaüstünde öne getirilemedi")));
      } catch (_err) {
        return setTimeout(poll, 80);
      }
    };
    poll();
  };

  function triggerTask(allowEnsure) {
    runDesktopBridgeProcess("schtasks.exe", ["/Run", "/TN", taskName], 3000, err => {
      if (!err) return pollResult();
      if (!allowEnsure) return finishOnce(err);
      ensureAndRetry();
    });
  }

  triggerTask(true);
}

app.post("/admin/pro/open-folder", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  const kind = String((req.body || {}).kind || "app").toLowerCase();
  const destinations = {
    app: __dirname,
    backups: KAFEPIN_BACKUP_ROOT,
    db: path.join(KAFEPIN_BACKUP_ROOT, "DB"),
    full: FULL_BACKUP_DIR
  };
  const folder = destinations[kind] || destinations.app;
  try {
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Klasör hazırlanamadı: ${err.message || err}` });
  }

  focusExplorerFolderWindows(folder, (err, detail) => {
    if (err || !detail || detail.verified !== true) {
      addLiveLog("folder_focus_error", `⚠️ Explorer öne getirilemedi • ${folder}`);
      return res.status(500).json({ ok: false, verified: false, path: folder, kind, error: String((err && err.message) || "Explorer penceresi öne getirilemedi") });
    }
    addLiveLog("folder_open", `📁 Explorer öne getirildi • ${folder}`);
    return res.json({ ok: true, path: folder, kind, verified: true, launched: true, foreground: true, hwnd: Number(detail.hwnd) || 0, method: detail.method || "hwnd-foreground" });
  });
});
app.get("/admin/pro/runtime", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  setNoStore(res);
  res.json({
    ok: true,
    pid: process.pid,
    root: __dirname,
    port: Number(port || 3000),
    version: getProVersion()
  });
});

app.get("/admin/pro/manager-info", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  setNoStore(res);
  const systemRoot = path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro");
  const tokenFile = path.join(systemRoot, "manager.token");
  try {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    if (!token) throw new Error("Sistem yoneticisi tokeni bos");
    res.json({ ok: true, controlUrl: "http://127.0.0.1:2999", token });
  } catch (err) {
    res.status(503).json({ ok: false, error: `Windows Sistem Yoneticisi hazir degil: ${err.message || err}` });
  }
});

app.post("/admin/pro/stop", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  res.json({ ok: true, message: "Sunucu durduruluyor" });
  setTimeout(() => process.exit(0), 250);
});


function validateKafePinSQLiteFile(filePath, callback) {
  let completed = false;
  const finish = (err, detail = {}) => {
    if (completed) return;
    completed = true;
    callback(err || null, detail);
  };

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 100) return finish(new Error("SQLite dosyasi bos veya cok kucuk"));
    const fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    if (read !== 16 || !head.equals(Buffer.from("SQLite format 3\u0000", "binary"))) {
      return finish(new Error("SQLite basligi gecersiz"));
    }
  } catch (err) {
    return finish(err);
  }

  let checkDb;
  try {
    checkDb = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) {
        try { checkDb && checkDb.close(); } catch (_err) {}
        return finish(openErr);
      }
      checkDb.get("PRAGMA quick_check", (quickErr, row) => {
        const closeAndFinish = (err, detail = {}) => {
          try { checkDb.close(() => finish(err, detail)); }
          catch (_closeErr) { finish(err, detail); }
        };
        if (quickErr) return closeAndFinish(quickErr);
        const result = row ? String(Object.values(row)[0] || "") : "";
        if (result.toLowerCase() !== "ok") {
          return closeAndFinish(new Error(`SQLite quick_check basarisiz: ${result || "sonuc yok"}`));
        }
        checkDb.get(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type='table' AND name IN ('settings','sessions','masalar','payments','product_catalog','spins')`,
          (schemaErr, schemaRow) => {
            if (schemaErr) return closeAndFinish(schemaErr);
            const knownTables = Number(schemaRow && schemaRow.count) || 0;
            if (knownTables < 1) return closeAndFinish(new Error("KafePin tablo yapisi bulunamadi"));
            let size = 0;
            try { size = fs.statSync(filePath).size; } catch (_err) {}
            closeAndFinish(null, { size, knownTables });
          }
        );
      });
    });
  } catch (err) {
    finish(err);
  }
}

function waitForValidKafePinSQLiteFile(filePath, timeoutMs, callback) {
  const startedAt = Date.now();
  let lastErr = null;
  const probe = () => {
    validateKafePinSQLiteFile(filePath, (err, detail) => {
      if (!err) return callback(null, detail);
      lastErr = err;
      if (Date.now() - startedAt >= timeoutMs) return callback(lastErr || new Error("SQLite snapshot hazir olmadi"));
      setTimeout(probe, 250);
    });
  };
  probe();
}

function sqliteStringLiteral(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function createVerifiedKafePinSnapshot(destination, callback) {
  let done = false;
  const finish = (err, detail = {}) => {
    if (done) return;
    done = true;
    callback(err || null, detail);
  };

  const finalPath = path.resolve(destination);
  const tempVacuum = `${finalPath}.vacuum-${process.pid}-${Date.now()}.tmp`;
  const clean = target => { try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (_err) {} };

  const backupFallback = (vacuumErr) => {
    clean(tempVacuum);
    clean(finalPath);
    let backupReturned = false;
    try {
      db.backup(finalPath, backupErr => {
        if (backupReturned) return;
        backupReturned = true;
        if (backupErr) {
          return finish(new Error(`DB snapshot alinamadi • VACUUM: ${vacuumErr && vacuumErr.message ? vacuumErr.message : vacuumErr || "basarisiz"} • backup: ${backupErr.message || backupErr}`));
        }
        waitForValidKafePinSQLiteFile(finalPath, 20000, (waitErr, detail) => {
          if (waitErr) {
            return finish(new Error(`DB snapshot dogrulanamadi • VACUUM: ${vacuumErr && vacuumErr.message ? vacuumErr.message : vacuumErr || "basarisiz"} • backup: ${waitErr.message || waitErr}`));
          }
          finish(null, { ...detail, method: "sqlite_backup_wait" });
        });
      });
    } catch (backupThrow) {
      finish(new Error(`DB snapshot baslatilamadi • VACUUM: ${vacuumErr && vacuumErr.message ? vacuumErr.message : vacuumErr || "basarisiz"} • backup: ${backupThrow.message || backupThrow}`));
    }
  };

  const publishVacuum = () => {
    validateKafePinSQLiteFile(tempVacuum, (verifyErr) => {
      if (verifyErr) return backupFallback(new Error(`VACUUM snapshot dogrulanamadi: ${verifyErr.message || verifyErr}`));
      try {
        clean(finalPath);
        fs.copyFileSync(tempVacuum, finalPath);
      } catch (copyErr) {
        return backupFallback(new Error(`VACUUM snapshot kopyalanamadi: ${copyErr.message || copyErr}`));
      } finally {
        clean(tempVacuum);
      }
      waitForValidKafePinSQLiteFile(finalPath, 3000, (finalErr, finalDetail) => {
        if (finalErr) return backupFallback(new Error(`VACUUM snapshot son dogrulama basarisiz: ${finalErr.message || finalErr}`));
        finish(null, { ...finalDetail, method: "vacuum_into" });
      });
    });
  };

  try {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    clean(finalPath);
    clean(tempVacuum);
    db.exec(`VACUUM INTO ${sqliteStringLiteral(tempVacuum)}`, vacuumErr => {
      if (vacuumErr) return backupFallback(vacuumErr);
      publishVacuum();
    });
  } catch (err) {
    backupFallback(err);
  }
}

function validateGenericSQLiteFile(filePath, callback) {
  let completed = false;
  const finish = err => {
    if (completed) return;
    completed = true;
    callback(err || null);
  };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 100) return finish(new Error("SQLite dosyasi bos veya cok kucuk"));
    const fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    if (read !== 16 || !head.equals(Buffer.from("SQLite format 3\u0000", "binary"))) return finish(new Error("SQLite basligi gecersiz"));
  } catch (err) {
    return finish(err);
  }
  let checkDb;
  try {
    checkDb = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, openErr => {
      if (openErr) return finish(openErr);
      checkDb.get("PRAGMA quick_check", (quickErr, row) => {
        const result = row ? String(Object.values(row)[0] || "") : "";
        const complete = () => {
          if (quickErr) return finish(quickErr);
          if (result.toLowerCase() !== "ok") return finish(new Error(`SQLite quick_check basarisiz: ${result || "sonuc yok"}`));
          finish(null);
        };
        try { checkDb.close(complete); } catch (_err) { complete(); }
      });
    });
  } catch (err) {
    finish(err);
  }
}

function waitForValidGenericSQLiteFile(filePath, timeoutMs, callback) {
  const startedAt = Date.now();
  let lastErr = null;
  const probe = () => {
    validateGenericSQLiteFile(filePath, err => {
      if (!err) return callback(null);
      lastErr = err;
      if (Date.now() - startedAt >= timeoutMs) return callback(lastErr || new Error("SQLite snapshot hazir olmadi"));
      setTimeout(probe, 250);
    });
  };
  probe();
}

function listFilesRecursive(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (_err) { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function isSafeArchiveEntryName(name) {
  const raw = String(name || "").replace(/\\/g, "/").trim();
  if (!raw) return true;
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return false;
  const parts = raw.split("/").filter(Boolean);
  return !parts.some(part => part === "..");
}

function listSafeArchiveEntries(zipPath, callback) {
  const listCommand = process.platform === "win32" ? "tar.exe" : "unzip";
  const listArgs = process.platform === "win32" ? ["-tf", zipPath] : ["-Z1", zipPath];
  runChildTracked(listCommand, listArgs, 45000, (listErr, listed) => {
    if (listErr) return callback(new Error(`ZIP icerigi okunamadi: ${listErr.message || listErr}`));
    const entries = String((listed && listed.stdout) || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!entries.length) return callback(new Error("Yedek ZIP bos"));
    const unsafe = entries.find(name => !isSafeArchiveEntryName(name));
    if (unsafe) return callback(new Error(`Guvenli olmayan ZIP yolu reddedildi: ${unsafe.slice(0, 160)}`));
    callback(null, entries);
  });
}

function extractArchiveEntryToSafeStage(zipPath, entryName, extractRoot, callback) {
  if (!isSafeArchiveEntryName(entryName)) return callback(new Error("Guvenli olmayan ZIP yolu reddedildi"));
  try { fs.mkdirSync(extractRoot, { recursive: true }); }
  catch (err) { return callback(err); }
  const extractCommand = process.platform === "win32" ? "tar.exe" : "unzip";
  const extractArgs = process.platform === "win32"
    ? ["-xf", zipPath, "-C", extractRoot, entryName]
    : ["-q", zipPath, entryName, "-d", extractRoot];
  runChildTracked(extractCommand, extractArgs, 45000, (extractErr) => {
    if (extractErr) return callback(new Error(`ZIP veritabani acilamadi: ${extractErr.message || extractErr}`));
    const normalized = String(entryName || "").replace(/\\/g, "/").replace(/^\.\//, "");
    const extracted = path.resolve(extractRoot, ...normalized.split("/").filter(Boolean));
    const root = path.resolve(extractRoot) + path.sep;
    if (!(extracted + path.sep).startsWith(root) && extracted !== path.resolve(extractRoot)) {
      return callback(new Error("ZIP veritabani hedef yolu guvenli degil"));
    }
    if (!fs.existsSync(extracted)) return callback(new Error("ZIP veritabani cikarilamadi"));
    callback(null, extracted);
  });
}

function extractArchiveToSafeStage(zipPath, extractRoot, callback) {
  try { fs.mkdirSync(extractRoot, { recursive: true }); }
  catch (err) { return callback(err); }

  listSafeArchiveEntries(zipPath, (listErr, entries) => {
    if (listErr) return callback(listErr);
    const extractCommand = process.platform === "win32" ? "tar.exe" : "unzip";
    const extractArgs = process.platform === "win32"
      ? ["-xf", zipPath, "-C", extractRoot]
      : ["-q", zipPath, "-d", extractRoot];
    runChildTracked(extractCommand, extractArgs, 90000, (extractErr) => {
      if (extractErr) return callback(new Error(`ZIP acilamadi: ${extractErr.message || extractErr}`));
      callback(null, { entries: entries.length });
    });
  });
}

function extractDatabaseCandidatesFromFullBackup(zipPath, destination, callback) {
  const extractRoot = path.join(destination, "archive");
  extractArchiveToSafeStage(zipPath, extractRoot, (extractErr) => {
    if (extractErr) return callback(extractErr);
    let files = [];
    try { files = listFilesRecursive(extractRoot); }
    catch (readErr) { return callback(readErr); }

    const sqliteHeader = Buffer.from("SQLite format 3\u0000", "binary");
    const candidates = [];
    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size < 100) continue;
        const fd = fs.openSync(filePath, "r");
        const head = Buffer.alloc(16);
        const read = fs.readSync(fd, head, 0, 16, 0);
        fs.closeSync(fd);
        if (read === 16 && head.equals(sqliteHeader)) candidates.push(filePath);
      } catch (_err) {}
    }

    if (!candidates.length) return callback(new Error("Yedek ZIP icinde SQLite veritabani bulunamadi"));
    // KafePin database.db adayini oncele; EveryCafe .ecm ancak KafePin tablo
    // dogrulamasindan gecerse secilebilir (normalde gecmez).
    candidates.sort((a, b) => {
      const score = p => {
        const base = path.basename(p).toLowerCase();
        if (base === "database.db") return 100;
        if (base.endsWith(".db")) return 60;
        if (base.endsWith(".sqlite") || base.endsWith(".sqlite3")) return 40;
        if (base.endsWith(".ecm")) return 10;
        return 20;
      };
      const diff = score(a) - score(b);
      return diff || a.localeCompare(b, "en", { numeric: true });
    });
    callback(null, candidates);
  });
}

function extractValidDatabaseFromFullBackup(zipPath, destination, callback) {
  const stagedDb = path.join(destination, "database.db");

  // v3.1.23 hizli yol: yeni KafePin FULL ZIP'lerinde database.db arsivin kokundedir.
  // Once yalniz bu dosyayi cikarip quick_check yapariz; 70+ MB arsivin tamamini
  // acmak gerekmez. Eski/alisilmadik yedeklerde mevcut tam tarama fallback'i korunur.
  listSafeArchiveEntries(zipPath, (listErr, entries) => {
    if (listErr) return callback(listErr);
    const directEntries = entries
      .filter(name => path.posix.basename(String(name).replace(/\\/g, "/")).toLowerCase() === "database.db")
      .sort((a, b) => {
        const score = name => {
          const normalized = String(name).replace(/\\/g, "/").replace(/^\.\//, "");
          return normalized.toLowerCase() === "database.db" ? 100 : 50;
        };
        return score(b) - score(a);
      });

    let directIndex = 0;
    const directErrors = [];
    const tryDirect = () => {
      if (directIndex >= directEntries.length) return fallbackFullScan();
      const entry = directEntries[directIndex++];
      const directRoot = path.join(destination, `direct-db-${directIndex}`);
      extractArchiveEntryToSafeStage(zipPath, entry, directRoot, (extractErr, candidate) => {
        if (extractErr) {
          directErrors.push(String(extractErr.message || extractErr).slice(0, 120));
          return tryDirect();
        }
        validateKafePinSQLiteFile(candidate, (validateErr, detail) => {
          if (validateErr) {
            directErrors.push(`${entry}: ${String(validateErr.message || validateErr).slice(0, 120)}`);
            return tryDirect();
          }
          try {
            fs.copyFileSync(candidate, stagedDb);
            return callback(null, {
              stagedDb,
              candidateCount: directEntries.length,
              selectedCandidate: entry,
              size: Number(detail && detail.size) || 0,
              fastPath: true
            });
          } catch (copyErr) {
            callback(copyErr);
          }
        });
      });
    };

    const fallbackFullScan = () => {
      extractDatabaseCandidatesFromFullBackup(zipPath, destination, (extractErr, candidates) => {
        if (extractErr) return callback(extractErr);
        let index = candidates.length - 1;
        const errors = [...directErrors];
        const tryNext = () => {
          if (index < 0) {
            return callback(new Error(`ZIP icindeki ${candidates.length} SQLite adayinin hicbiri gecerli KafePin veritabani degil${errors.length ? ` • ${errors.slice(-2).join(" | ")}` : ""}`));
          }
          const candidate = candidates[index--];
          validateKafePinSQLiteFile(candidate, (validateErr, detail) => {
            if (validateErr) {
              errors.push(`${path.basename(candidate)}: ${String(validateErr.message || validateErr).slice(0, 120)}`);
              return tryNext();
            }
            try {
              fs.copyFileSync(candidate, stagedDb);
              return callback(null, {
                stagedDb,
                candidateCount: candidates.length,
                selectedCandidate: path.basename(candidate),
                size: Number(detail && detail.size) || 0,
                fastPath: false
              });
            } catch (copyErr) {
              callback(copyErr);
            }
          });
        };
        tryNext();
      });
    };

    tryDirect();
  });
}

function verifyFullBackupArchive(zipPath, callback) {
  let stage = "";
  try {
    stage = fs.mkdtempSync(path.join(os.tmpdir(), "kafepin-backup-verify-"));
  } catch (err) {
    return callback(err);
  }
  extractValidDatabaseFromFullBackup(zipPath, stage, (err, info) => {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_err) {}
    callback(err || null, info || null);
  });
}

const KAFEPIN_RESTORE_WORKER_TASK = "KafePin Pro Restore Worker";
function launchScheduledRestoreWorker(callback) {
  // KRITIK: restore worker Node'un child process'i olarak baslatilmaz.
  // Windows Task Scheduler ayri SYSTEM gorevi olarak calistirir; server kapatilinca
  // worker hayatta kalir ve DB restore + restart zincirini tamamlar.
  let result;
  try {
    result = spawnSync("schtasks.exe", ["/Run", "/TN", KAFEPIN_RESTORE_WORKER_TASK], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000
    });
  } catch (err) {
    return callback(err);
  }
  if (result.error) return callback(result.error);
  if (Number(result.status) !== 0) {
    const detail = String(result.stderr || result.stdout || "Restore Worker gorevi calistirilamadi").trim();
    return callback(new Error(detail.slice(0, 400)));
  }
  callback(null, { taskName: KAFEPIN_RESTORE_WORKER_TASK });
}

app.post("/admin/pro/restore", (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ ok: false, error: "Yerel erisim gerekli" });
  const fileName = path.basename(String((req.body || {}).fileName || ""));
  if (!/^KafePin_.*\.zip$/i.test(fileName)) return res.status(400).json({ ok: false, error: "Gecersiz yedek dosyasi" });
  const zipPath = resolveProBackupPath(fileName);
  if (!fs.existsSync(zipPath)) return res.status(404).json({ ok: false, error: "Yedek bulunamadi" });
  if (fullBackupRunning) return res.status(409).json({ ok: false, error: "Once devam eden yedekleme bitsin" });

  const restoreSystemRoot = path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro");
  const restoreJob = path.join(restoreSystemRoot, "restore-worker-job.json");
  const restoreResult = path.join(restoreSystemRoot, "restore-result.json");
  const maintenanceFile = path.join(restoreSystemRoot, "maintenance.lock");
  const oldRestoreFiles = [
    path.join(restoreSystemRoot, "restore-request.json"),
    path.join(restoreSystemRoot, "restore-request.pending.json")
  ];
  if (fs.existsSync(restoreJob)) return res.status(409).json({ ok: false, error: "Baska bir geri yukleme islemi zaten calisiyor" });

  addLiveLog("pro_restore", `↩️ Yedekten veri geri yükleme istendi • ${fileName}`);
  let restoreStage = "";
  try {
    fs.mkdirSync(restoreSystemRoot, { recursive: true });
    restoreStage = fs.mkdtempSync(path.join(restoreSystemRoot, "restore-bat-stage-"));
  } catch (stageErr) {
    return res.status(500).json({ ok: false, error: `Geri yukleme hazirlik klasoru olusturulamadi: ${stageErr.message || stageErr}` });
  }
  const cleanupStage = () => { try { fs.rmSync(restoreStage, { recursive: true, force: true }); } catch (_err) {} };

  extractValidDatabaseFromFullBackup(zipPath, restoreStage, (extractErr, extractInfo) => {
    if (extractErr) {
      cleanupStage();
      addLiveLog("pro_restore", `⚠️ Yedek doğrulanamadı • ${String(extractErr.message || extractErr).slice(0, 180)}`);
      return res.status(500).json({ ok: false, error: `Yedek doğrulanamadı: ${extractErr.message || extractErr}` });
    }

    // v3.1.23: restore yalniz KafePin verisini degistirir; kurulu program dosyalari
    // korunur. Bu nedenle restore oncesi 70+ MB FULL ZIP tekrar uretmek yerine
    // kalici ve dogrulanmis DB emniyet yedegi alinir. Restore Worker'in otomatik
    // rollback kullandigi safetyDb aynen korunur; sadece gereksiz FULL ZIP adimi kalkar.
    let persistentSafetyDb = "";
    try {
      fs.mkdirSync(DB_BACKUP_DIR, { recursive: true });
      persistentSafetyDb = path.join(DB_BACKUP_DIR, `database_pre_restore_${backupFileStamp()}.db`);
    } catch (safetyPathErr) {
      cleanupStage();
      return res.status(500).json({ ok: false, error: `Emniyet DB klasoru hazirlanamadi: ${safetyPathErr.message || safetyPathErr}` });
    }

    createVerifiedKafePinSnapshot(persistentSafetyDb, (safetyErr, safetyDetail) => {
      if (safetyErr) {
        cleanupStage();
        return res.status(500).json({ ok: false, error: `Geri donus DB snapshot'i alinamadi: ${safetyErr.message || safetyErr}` });
      }
      const safetyDb = path.join(restoreStage, "pre-restore-safety.db");
      try {
        fs.copyFileSync(persistentSafetyDb, safetyDb);
        const stagedDb = path.join(restoreStage, "database.db");
        const stagedSha256 = crypto.createHash("sha256").update(fs.readFileSync(stagedDb)).digest("hex").toUpperCase();
        const persistentSafetySha256 = crypto.createHash("sha256").update(fs.readFileSync(persistentSafetyDb)).digest("hex").toUpperCase();
        const safetySha256 = crypto.createHash("sha256").update(fs.readFileSync(safetyDb)).digest("hex").toUpperCase();
        if (persistentSafetySha256 !== safetySha256) throw new Error("Emniyet DB stage SHA-256 eslesmedi");
        for (const oldFile of oldRestoreFiles) { try { fs.unlinkSync(oldFile); } catch (_err) {} }
        try { fs.unlinkSync(restoreResult); } catch (_err) {}
        const job = {
          schema: 2,
          type: "KAFEPIN_DB_RESTORE_WORKER",
          createdAt: new Date().toISOString(),
          sourceServerPid: process.pid,
          nodePath: process.execPath,
          installRoot: __dirname,
          systemRoot: restoreSystemRoot,
          stageDir: restoreStage,
          stagedDb,
          stagedSha256,
          safetyDb,
          safetySha256,
          sourceBackup: fileName,
          safetyBackup: path.basename(persistentSafetyDb),
          candidateCount: extractInfo && extractInfo.candidateCount ? extractInfo.candidateCount : 1
        };
        fs.writeFileSync(restoreJob, JSON.stringify(job, null, 2), "utf8");
        fs.writeFileSync(maintenanceFile, `restore-worker ${new Date().toISOString()}`, "ascii");
      } catch (jobErr) {
        cleanupStage();
        try { fs.unlinkSync(restoreJob); } catch (_err) {}
        try { fs.unlinkSync(maintenanceFile); } catch (_err) {}
        return res.status(500).json({ ok: false, error: `Restore isi hazirlanamadi: ${jobErr.message || jobErr}` });
      }

      addLiveLog("pro_restore", `✅ Yedek doğrulandı • ${extractInfo && extractInfo.fastPath ? "database.db hedefli hızlı doğrulama" : `${extractInfo && extractInfo.candidateCount ? extractInfo.candidateCount : 1} DB adayı tarandı`}`);
      addLiveLog("pro_restore", `💾 Geri yükleme öncesi doğrulanmış DB emniyet yedeği • ${path.basename(persistentSafetyDb)} • ${((Number(safetyDetail && safetyDetail.size) || 0) / 1048576).toFixed(2)} MB`);
      addLiveLog("pro_restore", "⚙️ Bağımsız Restore Worker başlatılıyor • server PID doğrudan kapatılıp tek kez yeniden açılacak");

      launchScheduledRestoreWorker((launchErr, worker) => {
        if (launchErr) {
          try { fs.unlinkSync(restoreJob); } catch (_err) {}
          try { fs.unlinkSync(maintenanceFile); } catch (_err) {}
          cleanupStage();
          addLiveLog("pro_restore", `⚠️ Restore Worker görevi başlatılamadı • ${String(launchErr.message || launchErr).slice(0, 180)}`);
          return res.status(500).json({ ok: false, error: `Restore Worker görevi başlatılamadı: ${launchErr.message || launchErr}` });
        }
        return res.json({
          ok: true,
          message: "KafePin Restore Worker baslatildi; sunucu dogrudan tek kez yeniden acilacak ve panel geri donecek",
          safetyBackup: path.basename(persistentSafetyDb),
          safetyBackupType: "VERIFIED_DB",
          preservesInstalledVersion: true,
          backupVerified: true,
          fastDatabaseExtract: Boolean(extractInfo && extractInfo.fastPath),
          candidateCount: extractInfo && extractInfo.candidateCount,
          restoreEngine: "scheduled-direct-v3-fast",
          workerTask: worker && worker.taskName ? worker.taskName : KAFEPIN_RESTORE_WORKER_TASK
        });
      });
    });
  });
});

app.get("/debug/live", async (req, res) => {
  try {
    setNoStore(res);

    const now = Date.now();

    const tasks = [];

    for (let masa = 1; masa <= MASA_SAYISI; masa++) {
      tasks.push(new Promise((resolve) => {

        const lastSeen = aktifMasalar[masa] || 0;
        const online = !isActuallyOffline(masa, lastSeen, now);

        if (lastOfflineState[masa] === true && online === false) {
          offlineCount[masa] = (offlineCount[masa] || 0) + 1;
        }
        lastOfflineState[masa] = online;

        const ping = masaPingStats[masa] || {};

        db.get("SELECT * FROM sessions WHERE masa=?", [masa], (err, s) => {

          let minutes = 0;
          let fee = 0;
          let adj = 0;
          let productTotal = 0;

          if (!err && s && s.start_time && (!s.end_time || s.end_time === 0)) {
            const end = s.last_seen || now;
            const scheduledEnd = isEveryCafeTimedMasa(masa) ? getEveryCafeScheduledEnd(masa) : 0;
            // EveryCafe'de 60 dk'lık oturum [başlangıç, bitiş) aralığıdır:
            // bitiş anı henüz +25/+35 basamağı değildir. Kaynak süre uzatırsa
            // EndDate zaten yeni bitişe taşınır ve yeni ücret o zaman görünür.
            const billedEnd = scheduledEnd > Number(s.start_time)
              ? Math.min(end, scheduledEnd - 1)
              : end;
            minutes = Math.floor((billedEnd - s.start_time) / 60000);
            // EveryCafe'de ücretsiz açılan oturumda yerel eski bir kayıt kalsa
            // bile monitör/Canlı Panel bilgisayar ücreti göstermemelidir.
            fee = isFreeMasa(masa) ? 0 : feeAtTime(masa, s.start_time, billedEnd);
          }

          const finish = () => {
const BASE = 60;
const STEP = 30;
const giftMinutes = getEveryCafeGiftMinutes(masa);
const billedMinutes = Math.max(0, minutes - giftMinutes);

let nextIncreaseInSec = null;

if (minutes != null) {

  if (billedMinutes < BASE) {
    nextIncreaseInSec = (BASE - billedMinutes) * 60;
  } else {
    const diff = billedMinutes - BASE;
    const mod = diff % STEP;
    const remaining = mod === 0 ? STEP : (STEP - mod);

    nextIncreaseInSec = remaining * 60;
  }

}
const realFee = fee + adj;
            const totalWithProducts = realFee + productTotal;
            resolve({
              masa,
              online,
              lastSeen,
              lastSeenAgoSec: lastSeen ? Math.floor((now - lastSeen) / 1000) : null,
              avgPingMs: Math.floor(ping.avg || 0),
              netSpeed: ping.netSpeed || 0,
              lastPingDiffMs: ping.last ? (now - ping.last) : null,
              locked: isLocked(masa, now),
lastReward: latestRewardMap[masa] || "-",
              free: isFreeMasa(masa),
              blocked: blockedMasalar.has(masa),

             minutes,
fee,
feeAdj: realFee,
realFee,
productTotal,
totalWithProducts,
offlineCount: offlineCount[masa] || 0,
giftMinutes,
nextIncreaseInSec,
            });
          };

          if (!err && s) {
            db.all(
              "SELECT amount FROM real_adjustments WHERE masa=? AND session_start=?",
              [masa, s.start_time || 0],
              (e2, rows) => {

                if (!e2 && rows) {
                  adj = rows.reduce((sum, r) => sum + (r.amount || 0), 0);
                }

                db.get(
                  `SELECT COALESCE(SUM(total),0) AS total
                   FROM product_sales
                   WHERE masa=? AND session_start=? AND sale_type='TABLE'
                     AND status='OPEN' AND voided=0`,
                  [masa, s.start_time || 0],
                  (productErr, productRow) => {
                    if (!productErr && productRow) productTotal = Number(productRow.total) || 0;
                    finish();
                  }
                );
              }
            );
          } else {
            finish();
          }

        });

      }));
    }

const out = await Promise.all(tasks);

db.get(
  `
  SELECT
    COALESCE((
      SELECT SUM(h.fee)
      FROM session_history h
      WHERE h.end_time >= ?
    ),0)
    + COALESCE((
      SELECT SUM(p.total)
      FROM product_sales p
      LEFT JOIN session_history h
        ON h.masa=p.masa AND h.start_time=p.session_start
      WHERE p.voided=0 AND (
        (p.sale_type='TABLE' AND p.status='FINALIZED' AND h.end_time >= ?)
        OR (p.sale_type='DIRECT' AND p.time >= ?)
      )
    ),0) AS gelir
  `,
  [now - (60 * 60 * 1000), now - (60 * 60 * 1000), now - (60 * 60 * 1000)],
  (eHour, hourRow) => {

    const thisHourRevenue =
      !eHour && hourRow
        ? Number(hourRow.gelir) || 0
        : 0;

    res.json({
      now,
      masalar: out,

      totalRevenue: out.reduce(
        (sum, m) => sum + (m.totalWithProducts || m.feeAdj || 0),
        0
      ),

      thisHourRevenue
    });

  }
);

  } catch (err) {
    console.error("/debug/live ERROR:", err);
    res.status(500).json({ ok: false });
  }
});
function getDayAwareDashboardStats(startTs, endTs, cb) {
  db.all(
    "SELECT masa,start_time,last_seen,end_time FROM sessions WHERE start_time<? AND (end_time=0 OR end_time>?)",
    [endTs, startTs],
    (activeErr, activeRows) => {
      if (activeErr) return cb(activeErr);

      db.all(
        "SELECT masa,start_time,end_time,fee FROM session_history WHERE start_time<? AND end_time>?",
        [endTs, startTs],
        (historyErr, historyRows) => {
          if (historyErr) return cb(historyErr);

          db.all(
            `SELECT masa,session_start,amount,kind,time FROM real_adjustments
             WHERE (kind='SESSION_FINALIZE' AND session_start<? AND time>?)
                OR (kind<>'SESSION_FINALIZE' AND time>=? AND time<?)`,
            [endTs, startTs, startTs, endTs],
            (adjustErr, adjustmentRows) => {
              if (adjustErr) return cb(adjustErr);

              const sessionsByKey = new Map();
              const masaSummary = new Map();
              const finalizedByKey = new Map();

              (adjustmentRows || []).forEach((row) => {
                if (String(row.kind || "").trim() !== "SESSION_FINALIZE") return;
                const masa = Number(row.masa) || 0;
                const sessionStart = Number(row.session_start) || 0;
                if (!masa || !sessionStart) return;
                finalizedByKey.set(`${masa}:${sessionStart}`, row);
              });
              const ensureMasa = (masa) => {
                const key = Number(masa);
                if (!masaSummary.has(key)) {
                  masaSummary.set(key, { masa:key, minutes:0, revenue:0, sessions:0 });
                }
                return masaSummary.get(key);
              };

              const addSession = (row, isActive) => {
                const masa = Number(row.masa) || 0;
                const sessionStart = Number(row.start_time) || 0;
                if (!masa || !sessionStart || isFreeMasa(masa)) return;

                const rawEnd = isActive
                  ? (Number(row.last_seen) || endTs)
                  : (Number(row.end_time) || 0);
                const rangeStart = Math.max(startTs, sessionStart);
                const rangeEnd = Math.min(endTs, rawEnd);
                if (rangeEnd <= rangeStart) return;

                const key = `${masa}:${sessionStart}`;
                if (sessionsByKey.has(key)) return;

                let gross = 0;

                if (isActive) {
                  gross = Math.max(
                    feeAtTime(masa, sessionStart, rangeEnd) -
                    feeAtTime(masa, sessionStart, rangeStart),
                    0
                  );
                } else {
                  const finalized = finalizedByKey.get(key);
                  const recordedTotal = Math.max(
                    Number(finalized ? finalized.amount : row.fee) || 0,
                    0
                  );

                  // Kapanmış oturumda veritabanına sabitlenen kesin tutar esastır.
                  // Böylece kısa, ücretsiz veya 0 ₺ yapılan oturum tekrar 50 ₺ olmaz.
                  if (recordedTotal <= 0) return;

                  const sessionEnd = Number(row.end_time) || rangeEnd;
                  if (rangeStart <= sessionStart && rangeEnd >= sessionEnd) {
                    gross = recordedTotal;
                  } else {
                    gross = Math.max(
                      Math.min(
                        feeAtTime(masa, sessionStart, rangeEnd) -
                        feeAtTime(masa, sessionStart, rangeStart),
                        recordedTotal
                      ),
                      0
                    );
                  }
                }
                const minutes = Math.max(0, (rangeEnd - rangeStart) / 60000);
                const item = { masa, sessionStart, minutes, revenue:gross };
                sessionsByKey.set(key, item);

                const summary = ensureMasa(masa);
                summary.minutes += minutes;
                summary.revenue += gross;
                summary.sessions += 1;
              };

              (historyRows || []).forEach((row) => addSession(row, false));
              (activeRows || []).forEach((row) => addSession(row, true));

              (adjustmentRows || []).forEach((row) => {
                if (String(row.kind || "").trim() === "SESSION_FINALIZE") return;
                const masa = Number(row.masa) || 0;
                if (!masa || isFreeMasa(masa)) return;
                const amount = Number(row.amount) || 0;
                const sessionKey = `${masa}:${Number(row.session_start) || 0}`;
                const session = sessionsByKey.get(sessionKey);
                if (session) session.revenue += amount;
                ensureMasa(masa).revenue += amount;
              });

              // Dashboard oturum adedi yalnızca bu gün aralığında gerçek ücret
              // oluşturan oturumları sayar. İlk ücretsiz dakikalardaki aktif
              // oturumlar ve devirden sonra henüz yeni ücret üretmeyen oturumlar
              // gelir gibi oturum adedini de şişirmemelidir.
              db.all(
                `SELECT masa,session_start,total
                 FROM product_sales
                 WHERE voided=0 AND sale_type='TABLE' AND masa>0
                   AND time>=? AND time<?`,
                [startTs, endTs],
                (productErr, productRows) => {
                  if (productErr) return cb(productErr);
                  (productRows || []).forEach((row) => {
                    const masa = Number(row.masa) || 0;
                    const total = Number(row.total) || 0;
                    if (!masa || !total) return;
                    const session = sessionsByKey.get(`${masa}:${Number(row.session_start) || 0}`);
                    if (session) session.revenue += total;
                    ensureMasa(masa).revenue += total;
                  });

                  const sessionList = Array.from(sessionsByKey.values()).filter(
                    (session) => Number(session.revenue) > 0
                  );
                  const masaList = Array.from(masaSummary.values());
                  const totalSessions = sessionList.length;
                  const totalMinutes = sessionList.reduce((sum, x) => sum + x.minutes, 0);
                  const totalRevenue = masaList.reduce((sum, x) => sum + x.revenue, 0);

                  masaList.sort((a,b) => b.minutes - a.minutes || a.masa - b.masa);
                  const busiest = masaList.find((x) => x.minutes > 0) || null;
                  const revenueSorted = [...masaList].sort((a,b) => b.revenue - a.revenue || a.masa - b.masa);
                  const bestRevenue = revenueSorted.find((x) => x.revenue > 0) || null;

                  return cb(null, {
                    totalSessions,
                    totalRevenue,
                    avgFee: totalSessions ? totalRevenue / totalSessions : 0,
                    avgMinutes: totalSessions ? totalMinutes / totalSessions : 0,
                    busiestTable: busiest ? busiest.masa : null,
                    busiestMinutes: busiest ? busiest.minutes : 0,
                    bestRevenueTable: bestRevenue ? bestRevenue.masa : null,
                    bestRevenue: bestRevenue ? bestRevenue.revenue : 0
                  });
                }
              );
            }
          );
        }
      );
    }
  );
}

let tailscaleHealthCache = {
  checkedAt: 0,
  online: false,
  detail: "Henüz kontrol edilmedi"
};

function checkTailscaleHealth(cb) {
  const now = Date.now();
  if (now - tailscaleHealthCache.checkedAt < 60000) {
    return cb(null, tailscaleHealthCache);
  }

  const interfaces = os.networkInterfaces();
  const tailscaleEntries = Object.entries(interfaces)
    .filter(([name]) => String(name).toLowerCase().includes("tailscale"))
    .flatMap(([, entries]) => entries || []);
  const ipv4 = tailscaleEntries.find((entry) =>
    entry && entry.family === "IPv4" && /^100\./.test(String(entry.address || ""))
  );

  const online = Boolean(ipv4);
  const detail = online ? `Bağlı • ${ipv4.address}` : "Bağlı değil";
  tailscaleHealthCache = { checkedAt: now, online, detail };
  cb(null, tailscaleHealthCache);
}

app.get("/admin/system-health", (req, res) => {
  setNoStore(res);
  const startedAt = Date.now() - Math.floor(process.uptime() * 1000);

  db.get("SELECT 1 AS ok", (dbErr) => {
    checkTailscaleHealth((tailErr, tailscale) => {
      const telegramConfigured = Boolean(
        TELEGRAM_ENABLED && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID
      );

      res.json({
        ok: !dbErr,
        checkedAt: Date.now(),
        server: { ok: true, startedAt, uptimeSeconds: Math.floor(process.uptime()) },
        database: { ok: !dbErr, detail: dbErr ? String(dbErr.message || dbErr) : "Bağlı" },
        telegram: {
          ok: telegramConfigured,
          enabled: TELEGRAM_ENABLED,
          detail: telegramConfigured ? "Hazır" : (TELEGRAM_ENABLED ? "Ayar eksik" : "Kapalı")
        },
        tailscale: tailscale || { online: false, detail: tailErr ? "Kontrol edilemedi" : "Bilinmiyor" }
      });
    });
  });
});


// ================= OTOMATIK SISTEM SAGLIK KONTROLU (v3.0.25) =================
// Panel kapali olsa bile arka planda calisir. Telegram yalniz gercek bir sorun
// oldugunda gonderilir; ayni sorun 6 saat boyunca tekrar tekrar bildirilmez.
const AUTO_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_HEALTH_REPEAT_ALERT_MS = 6 * 60 * 60 * 1000;
const AUTO_HEALTH_BACKUP_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const AUTO_HEALTH_ROLLOVER_MAX_AGE_MS = 30 * 60 * 60 * 1000;
const AUTO_HEALTH_FINALIZE_STUCK_MS = 3 * 60 * 1000;
const AUTO_HEALTH_DISK_CRITICAL_BYTES = 2 * 1024 * 1024 * 1024;
const AUTO_HEALTH_DISK_WARNING_BYTES = 5 * 1024 * 1024 * 1024;

let autoHealthRunning = false;
let autoHealthTelegramSuppressCount = 0;
let autoHealthFinalizeBusySince = 0;
let autoHealthAlertFingerprint = "";
let autoHealthLastAlertAt = 0;
let autoHealthLast = {
  checkedAt: 0,
  status: "unknown",
  healthy: false,
  summary: "Henüz kontrol edilmedi",
  checks: [],
  issues: []
};

function formatHealthBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function getHealthDiskCheck() {
  try {
    const rootPath = path.parse(path.resolve(__dirname)).root || path.resolve(__dirname);
    const stat = fs.statfsSync(rootPath);
    const free = Number(stat.bavail || stat.bfree || 0) * Number(stat.bsize || 0);
    const total = Number(stat.blocks || 0) * Number(stat.bsize || 0);
    const freePct = total > 0 ? (free / total) * 100 : 0;
    if (free < AUTO_HEALTH_DISK_CRITICAL_BYTES || (total > 0 && freePct < 3)) {
      return { code: "disk", ok: false, severity: "critical", alert: true, detail: `Disk alanı kritik • ${formatHealthBytes(free)} boş` };
    }
    if (free < AUTO_HEALTH_DISK_WARNING_BYTES || (total > 0 && freePct < 7)) {
      return { code: "disk", ok: false, severity: "warning", alert: true, detail: `Disk alanı azalıyor • ${formatHealthBytes(free)} boş` };
    }
    return { code: "disk", ok: true, severity: "ok", detail: `Disk ${formatHealthBytes(free)} boş` };
  } catch (err) {
    return { code: "disk", ok: false, severity: "warning", alert: false, detail: `Disk alanı okunamadı: ${String(err.message || err).slice(0, 120)}` };
  }
}

function getHealthBackupCheck(now) {
  const latest = getProBackupList()[0] || null;
  if (!latest) {
    return { code: "backup", ok: false, severity: "warning", alert: true, detail: "FULL ZIP yedeği bulunamadı" };
  }
  const ageMs = Math.max(0, now - (Number(latest.time) || 0));
  const ageHours = ageMs / (60 * 60 * 1000);
  if (ageMs > AUTO_HEALTH_BACKUP_MAX_AGE_MS) {
    return {
      code: "backup", ok: false, severity: "warning", alert: true,
      detail: `Son FULL ZIP yedeği ${Math.floor(ageHours)} saat önce • ${latest.fileName}`,
      time: Number(latest.time) || 0, fileName: latest.fileName
    };
  }
  return {
    code: "backup", ok: true, severity: "ok",
    detail: `Son FULL ZIP yedeği ${Math.max(0, Math.floor(ageHours))} saat önce • ${latest.fileName}`,
    time: Number(latest.time) || 0, fileName: latest.fileName
  };
}

function getHealthFinalizeCheck(now) {
  const activeCount = Math.max(finalizeQueues.size, finalizeInProgress.size);
  if (activeCount > 0) {
    if (!autoHealthFinalizeBusySince) autoHealthFinalizeBusySince = now;
  } else {
    autoHealthFinalizeBusySince = 0;
  }
  const busyMs = autoHealthFinalizeBusySince ? now - autoHealthFinalizeBusySince : 0;
  if (activeCount > 0 && busyMs >= AUTO_HEALTH_FINALIZE_STUCK_MS) {
    return {
      code: "finalize", ok: false, severity: "critical", alert: true,
      detail: `Finalize kuyruğu ${Math.floor(busyMs / 60000)} dk takılı • ${activeCount} işlem`
    };
  }
  return {
    code: "finalize", ok: true, severity: "ok",
    detail: activeCount > 0 ? `Finalize çalışıyor • ${activeCount} işlem` : "Finalize kuyruğu temiz"
  };
}

function getHealthEveryCafeCheck(now, config) {
  if (!config || !config.enabled || !config.startAt) {
    return { code: "everycafe", ok: true, severity: "ok", detail: "EveryCafe canlı entegrasyonu kapalı" };
  }
  const lastSuccess = Number(everyCafeHealth.lastSuccess) || 0;
  const staleMs = lastSuccess ? now - lastSuccess : Number.POSITIVE_INFINITY;
  const staleLimit = Math.max(2 * 60 * 1000, EVERYCAFE_SYNC_MS * 24);
  if (everyCafeHealth.warningActive || everyCafeHealth.lastError || staleMs > staleLimit) {
    return {
      code: "everycafe", ok: false, severity: "warning", alert: false,
      detail: everyCafeHealth.lastError
        ? `EveryCafe okuma uyarısı • ${String(everyCafeHealth.lastError).slice(0, 130)}`
        : "EveryCafe canlı okuma uzun süredir yenilenmedi"
    };
  }

  let longestWaitingMs = 0;
  for (const state of everyCafeWaitingMasalar.values()) {
    const ts = Number(state && (state.waitingAt || state.start)) || 0;
    if (ts > 0) longestWaitingMs = Math.max(longestWaitingMs, now - ts);
  }
  if (longestWaitingMs > 12 * 60 * 60 * 1000) {
    return {
      code: "everycafe", ok: false, severity: "warning", alert: false,
      detail: `EveryCafe bekleme durumu ${Math.floor(longestWaitingMs / 3600000)} saattir açık • ${everyCafeWaitingMasalar.size} masa`
    };
  }

  if (lastEveryCafeDailyAudit && lastEveryCafeDailyAudit.checkedAt &&
      now - Number(lastEveryCafeDailyAudit.checkedAt) < 30 * 60 * 60 * 1000 &&
      lastEveryCafeDailyAudit.ok === false) {
    return {
      code: "everycafe", ok: false, severity: "warning", alert: false,
      detail: `EveryCafe gün sonu farkı • ${Number(lastEveryCafeDailyAudit.difference || 0).toFixed(2)} ₺`
    };
  }

  return {
    code: "everycafe", ok: true, severity: "ok",
    detail: `EveryCafe bağlı • son okuma ${lastSuccess ? Math.max(0, Math.floor((now - lastSuccess) / 1000)) : 0} sn önce`
  };
}

function finalizeAutomaticHealthResult(checks, cb) {
  const now = Date.now();
  const issues = checks.filter((check) => !check.ok);
  const hasCritical = issues.some((check) => check.severity === "critical");
  const status = hasCritical ? "critical" : (issues.length ? "warning" : "healthy");
  const result = {
    checkedAt: now,
    status,
    healthy: issues.length === 0,
    summary: issues.length ? `${issues.length} kontrol dikkat istiyor` : "Tüm temel kontroller normal",
    checks,
    issues
  };
  autoHealthLast = result;
  autoHealthRunning = false;

  const alertIssues = issues.filter((check) => check.alert !== false);
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
  if (cb) cb(null, result);
}

function runAutomaticHealthCheck(cb = () => {}) {
  if (autoHealthRunning) return cb(null, { ...autoHealthLast, running: true });
  autoHealthRunning = true;
  const now = Date.now();
  const telegramReady = Boolean(TELEGRAM_ENABLED && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
  const checks = [
    { code: "server", ok: true, severity: "ok", detail: `Sunucu çalışıyor • ${Math.floor(process.uptime() / 60)} dk uptime` },
    telegramReady
      ? { code: "telegram", ok: true, severity: "ok", detail: "Telegram alarmı hazır" }
      : { code: "telegram", ok: false, severity: TELEGRAM_ENABLED ? "critical" : "warning", alert: false, detail: TELEGRAM_ENABLED ? "Telegram açık ama token/chat_id eksik" : "Telegram alarmı kapalı" },
    getHealthBackupCheck(now),
    getHealthFinalizeCheck(now),
    getHealthDiskCheck()
  ];

  db.get("SELECT 1 AS ok", (dbErr) => {
    if (dbErr) {
      checks.push({ code: "database", ok: false, severity: "critical", alert: true, detail: `Veritabanı erişim hatası • ${String(dbErr.message || dbErr).slice(0, 130)}` });
      checks.push({ code: "rollover", ok: false, severity: "warning", alert: false, detail: "Gün sonu durumu DB hatası nedeniyle okunamadı" });
      checks.push(getHealthEveryCafeCheck(now, null));
      return finalizeAutomaticHealthResult(checks, cb);
    }

    checks.push({ code: "database", ok: true, severity: "ok", detail: "Veritabanı bağlı" });
    db.get("SELECT value FROM settings WHERE key='last_daily_rollover'", (rollErr, row) => {
      if (rollErr) {
        checks.push({ code: "rollover", ok: false, severity: "critical", alert: true, detail: `Gün sonu kaydı okunamadı • ${String(rollErr.message || rollErr).slice(0, 120)}` });
      } else {
        let last = null;
        try { last = row && row.value ? JSON.parse(row.value) : null; } catch (_err) {}
        const rolloverTs = Number(last && last.rolloverTs) || 0;
        const ageMs = rolloverTs ? now - rolloverTs : 0;
        const repairTs = getNextMissedRolloverBoundary(last, now);
        const repairMeta = repairTs ? {
          repairAvailable: true,
          repairTs,
          repairLabel: getMissedRolloverRepairLabel(repairTs, now)
        } : {};
        if (last && last.status === "error") {
          checks.push({ code: "rollover", ok: false, severity: "critical", alert: true, detail: `Son gün sonu başarısız • ${String(last.error || "bilinmeyen hata").slice(0, 130)}`, ...repairMeta });
        } else if (rolloverTs && ageMs > AUTO_HEALTH_ROLLOVER_MAX_AGE_MS) {
          checks.push({ code: "rollover", ok: false, severity: "critical", alert: true, detail: `Gün sonu kaydı gecikmiş • ${Math.floor(ageMs / 3600000)} saat`, ...repairMeta });
        } else if (last && last.status === "success") {
          checks.push({ code: "rollover", ok: true, severity: "ok", detail: `Son gün sonu başarılı • ${new Date(rolloverTs).toLocaleString("tr-TR")}` });
        } else {
          checks.push({ code: "rollover", ok: true, severity: "ok", detail: "İlk gün sonu kaydı bekleniyor" });
        }
      }

      getEveryCafeConfig((configErr, config) => {
        if (configErr) {
          checks.push({ code: "everycafe", ok: false, severity: "warning", alert: false, detail: `EveryCafe durumu okunamadı • ${String(configErr.message || configErr).slice(0, 120)}` });
        } else {
          checks.push(getHealthEveryCafeCheck(now, config));
        }
        // v3.1.43: finans/oturum denetimini de otomatik sağlık kontrolüne bağla.
        // İlk 10 dakikada geçici senkron farkı yalnız panelde uyarı olur; kalıcı
        // hale gelirse Telegram sağlık alarmına dönüşür.
        runIntegrityAudit({ persist:true }).then((integrity) => {
          const financeDiff = Math.abs(Number(integrity && integrity.finance && integrity.finance.localGeneralDifference) || 0);
          const financeIssue = (integrity && integrity.issues || []).find(issue =>
            ["GENERAL_CIRO_MISMATCH","EVERYCAFE_TRANSFER_MISMATCH","DIRECT_PAYMENT_MISMATCH"].includes(String(issue.code || ""))
          );
          checks.push({
            code:"finance_integrity",
            ok:financeDiff <= 0.01 && !(integrity && integrity.payment && Math.abs(Number(integrity.payment.difference)||0)>0.01),
            severity:financeIssue && financeIssue.severity === "critical" ? "critical" : "warning",
            alert:Boolean(financeIssue && financeIssue.alertReady),
            detail:financeIssue ? String(financeIssue.detail || integrity.summary) : `Ciro formülü doğru • ${Number(integrity && integrity.finance && integrity.finance.expectedGeneral || 0).toFixed(2)} ₺`
          });
          const criticalAnomaly = (integrity && integrity.issues || []).find(issue => issue.severity === "critical" && !["DIRECT_PAYMENT_MISMATCH"].includes(String(issue.code||"")));
          checks.push({
            code:"anomaly",
            ok:!criticalAnomaly,
            severity:criticalAnomaly ? "critical" : "ok",
            alert:Boolean(criticalAnomaly && criticalAnomaly.alertReady),
            detail:criticalAnomaly ? String(criticalAnomaly.detail || "Kritik anomali") : "Oturum/ürün anomali kontrolü temiz"
          });
          finalizeAutomaticHealthResult(checks, cb);
        }).catch((auditErr) => {
          checks.push({ code:"finance_integrity", ok:false, severity:"warning", alert:false, detail:`Finans denetimi çalışmadı • ${String(auditErr.message || auditErr).slice(0,120)}` });
          finalizeAutomaticHealthResult(checks, cb);
        });
      });
    });
  });
}

app.get("/admin/automatic-health", (req, res) => {
  setNoStore(res);
  const force = String(req.query && req.query.force || "") === "1";
  if (!force && autoHealthLast.checkedAt) {
    return res.json({ ok: true, running: autoHealthRunning, ...autoHealthLast });
  }
  runAutomaticHealthCheck((_err, result) => {
    res.json({ ok: true, ...result });
  });
});


// ================= v3.1.43 • TAM DENETIM / GUVENILIRLIK KATMANI =================
// Bu katman finans kaynagini DEĞİŞTİRMEZ. EveryCafe salt-okunur gerçek kaynak,
// KafePin doğrudan satış ve mevcut muhasebe kayıtlarını birbirinden bağımsız
// okuyup yalnız tutarlılık kontrolü yapar.
let lastIntegrityAudit = {
  checkedAt: 0,
  healthy: false,
  status: "unknown",
  summary: "Henüz kontrol edilmedi",
  issues: [],
  finance: {},
  payment: {},
  anomalies: {}
};
let integrityAuditRunning = false;

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getRangeStatsP(startTs, endTs) {
  return new Promise((resolve, reject) => {
    getRangeStats(startTs, endTs, (err, stats) => err ? reject(err) : resolve(stats || {}));
  });
}

function getSettingValueP(key) {
  return new Promise((resolve, reject) => {
    db.get("SELECT value FROM settings WHERE key=?", [String(key)], (err, row) => {
      if (err) return reject(err);
      resolve(row ? String(row.value || "") : "");
    });
  });
}

function setSettingValueP(key, value) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [String(key), String(value)],
      (err) => err ? reject(err) : resolve()
    );
  });
}

function createFullProjectBackupP43() {
  return new Promise((resolve, reject) => {
    createFullProjectBackup((err, result) => err ? reject(err) : resolve(result || {}));
  });
}

async function readEveryCafeSourceRange(startTs, endTs) {
  const start = Math.max(0, Number(startTs) || 0);
  const end = Math.max(start + 1, Number(endTs) || (Date.now() + 1));
  const config = await getEveryCafeConfigP();
  if (!config || !config.enabled || !config.startAt) {
    const empty = { total:0, cash:0, card:0, rolloverTotal:0, rolloverCount:0 };
    return { enabled:false, start, end, summary:empty, rawSummary:empty };
  }
  const snapshot = await readEveryCafePaymentAuditSnapshotP(Math.max(0, start - 1000));
  const rawSummary = summarizeEveryCafeSourceSnapshot(snapshot, start, end);
  const summary = summarizeEveryCafeBusinessDaySnapshot(snapshot, start, end);
  return { enabled:true, start, end, summary, rawSummary };
}

async function readBusinessDayEveryCafeSource(nowTs = Date.now()) {
  const now = Number(nowTs) || Date.now();
  return readEveryCafeSourceRange(dayStartTs(now), now + 1);
}

async function persistIntegrityIssues(issues, now) {
  const current = Array.isArray(issues) ? issues : [];
  const activeRows = await kafePinDbAllP("SELECT issue_key FROM system_audit_events WHERE active=1");
  const activeKeys = new Set(current.map(item => String(item.key || item.code || "")).filter(Boolean));

  for (const issue of current) {
    const issueKey = String(issue.key || issue.code || "").slice(0, 180);
    if (!issueKey) continue;
    await kafePinDbRunP(
      `INSERT INTO system_audit_events
       (issue_key,code,severity,detail,first_seen_at,last_seen_at,resolved_at,active,details_json)
       VALUES(?,?,?,?,?,?,0,1,?)
       ON CONFLICT(issue_key) DO UPDATE SET
         code=excluded.code,
         severity=excluded.severity,
         detail=excluded.detail,
         last_seen_at=excluded.last_seen_at,
         resolved_at=0,
         active=1,
         details_json=excluded.details_json`,
      [
        issueKey,
        String(issue.code || "AUDIT"),
        String(issue.severity || "warning"),
        String(issue.detail || "").slice(0, 600),
        now,
        now,
        JSON.stringify(issue.details || {})
      ]
    );
  }

  for (const row of activeRows || []) {
    const key = String(row.issue_key || "");
    if (!key || activeKeys.has(key)) continue;
    await kafePinDbRunP(
      "UPDATE system_audit_events SET active=0,resolved_at=?,last_seen_at=? WHERE issue_key=? AND active=1",
      [now, now, key]
    );
  }
  return kafePinDbAllP("SELECT * FROM system_audit_events WHERE active=1 ORDER BY first_seen_at ASC");
}

async function runIntegrityAudit(options = {}) {
  if (integrityAuditRunning && !options.force) return { ...lastIntegrityAudit, running: true };
  integrityAuditRunning = true;
  const now = Date.now();
  const start = dayStartTs(now);
  const end = now + 1;
  const issues = [];

  try {
    const [sourceData, stats, directRow, directPaymentRow, activeSessions, negativeProductRow, duplicateSessionRows] = await Promise.all([
      readBusinessDayEveryCafeSource(now),
      getRangeStatsP(start, end),
      kafePinDbGetP(
        `SELECT COALESCE(SUM(total),0) AS total,COALESCE(SUM(quantity),0) AS quantity,COUNT(*) AS count
         FROM product_sales
         WHERE voided=0 AND sale_type='DIRECT' AND time>=? AND time<?
           AND COALESCE(external_source,'') NOT LIKE 'EVERYCAFE%'
           AND NOT ${LEGACY_EVERYCAFE_MEMBER_SQL}`,
        [start, end]
      ),
      kafePinDbGetP(
        `SELECT
           COALESCE(SUM(total_amount),0) AS total,
           COALESCE(SUM(CASE WHEN method='CASH' THEN total_amount ELSE 0 END),0) AS cash,
           COALESCE(SUM(CASE WHEN method='CARD' THEN total_amount ELSE 0 END),0) AS card,
           COALESCE(SUM(CASE WHEN method='PENDING' THEN total_amount ELSE 0 END),0) AS pending,
           COUNT(*) AS count
         FROM payments
         WHERE voided=0 AND source='DIRECT_PRODUCT' AND created_at>=? AND created_at<?`,
        [start, end]
      ),
      kafePinDbAllP("SELECT masa,start_time,last_seen,end_time FROM sessions WHERE COALESCE(end_time,0)=0"),
      kafePinDbGetP(
        `SELECT COUNT(*) AS count,COALESCE(SUM(total),0) AS total
         FROM product_sales WHERE voided=0 AND time>=? AND time<? AND (total<0 OR quantity<0 OR unit_price<0)`,
        [start, end]
      ),
      kafePinDbAllP(
        `SELECT masa,COUNT(*) AS count FROM sessions WHERE COALESCE(end_time,0)=0 GROUP BY masa HAVING COUNT(*)>1`
      )
    ]);

    const source = sourceData && sourceData.summary ? sourceData.summary : {};
    const rawSource = sourceData && sourceData.rawSummary ? sourceData.rawSummary : source;
    const everyCafeReal = roundMoney(source.total);
    const kafePinDirect = roundMoney(directRow && directRow.total);
    const expectedGeneral = roundMoney(everyCafeReal + kafePinDirect);
    const localEveryCafe = roundMoney(stats.everyCafeGenelGelir);
    const localGeneral = roundMoney(stats.genelGelir);
    // EveryCafe devreden bir oturumu kapanışta tek tahsilat olarak yazar. Yerel
    // ödeme kaydı da tam tahsilattır; finans kartı ise 20:00 öncesi payı eski güne
    // bırakır. Denetimde bu meşru devir payını çıkar ki sahte "ciro farkı" alarmı oluşmasın.
    const rolloverCarryBefore = Math.max(0, roundMoney((Number(rawSource.total)||0) - everyCafeReal));
    const adjustedLocalEveryCafe = roundMoney(localEveryCafe - rolloverCarryBefore);
    const adjustedLocalGeneral = roundMoney(localGeneral - rolloverCarryBefore);
    const sourceTransferDifference = roundMoney(adjustedLocalEveryCafe - everyCafeReal);
    const localGeneralDifference = roundMoney(adjustedLocalGeneral - expectedGeneral);
    const directPaymentTotal = roundMoney(directPaymentRow && directPaymentRow.total);
    const directPaymentDifference = roundMoney(directPaymentTotal - kafePinDirect);

    if (sourceData.enabled && Math.abs(sourceTransferDifference) > 0.01) {
      issues.push({
        key:"finance:everycafe-transfer",
        code:"EVERYCAFE_TRANSFER_MISMATCH",
        severity:"warning",
        detail:`EveryCafe gerçek kaynak ${everyCafeReal.toFixed(2)} ₺, KafePin aktarımı ${localEveryCafe.toFixed(2)} ₺ • fark ${sourceTransferDifference >= 0 ? "+" : ""}${sourceTransferDifference.toFixed(2)} ₺`,
        details:{ everyCafeReal, localEveryCafe, difference:sourceTransferDifference }
      });
    }
    if (Math.abs(localGeneralDifference) > 0.01) {
      issues.push({
        key:"finance:general-canonical",
        code:"GENERAL_CIRO_MISMATCH",
        severity:"warning",
        detail:`Ciro denetimi: gerçek kaynak + KafePin doğrudan ${expectedGeneral.toFixed(2)} ₺, yerel muhasebe ${localGeneral.toFixed(2)} ₺`,
        details:{ expectedGeneral, localGeneral, difference:localGeneralDifference }
      });
    }
    if (Math.abs(directPaymentDifference) > 0.01) {
      issues.push({
        key:"payment:kafepin-direct",
        code:"DIRECT_PAYMENT_MISMATCH",
        severity:"critical",
        detail:`KafePin doğrudan satış ${kafePinDirect.toFixed(2)} ₺, ödeme kaydı ${directPaymentTotal.toFixed(2)} ₺ • fark ${directPaymentDifference >= 0 ? "+" : ""}${directPaymentDifference.toFixed(2)} ₺`,
        details:{ kafePinDirect, directPaymentTotal, difference:directPaymentDifference }
      });
    }

    const freeSet = freeMasalar instanceof Set ? freeMasalar : new Set();
    for (const session of activeSessions || []) {
      const masa = Number(session.masa) || 0;
      const sessionStart = Number(session.start_time) || 0;
      if (!masa || !sessionStart) continue;
      if (sessionStart > now + 2 * 60 * 1000) {
        issues.push({ key:`session:future:${masa}`, code:"SESSION_START_IN_FUTURE", severity:"critical", detail:`Masa ${masa} oturum başlangıcı gelecekte görünüyor`, details:{masa,sessionStart} });
        continue;
      }
      const ageMs = Math.max(0, now - sessionStart);
      if (ageMs > 16 * 60 * 60 * 1000) {
        issues.push({ key:`session:long:${masa}`, code:"SESSION_TOO_LONG", severity:"warning", detail:`Masa ${masa} ${Math.floor(ageMs / 3600000)} saattir açık`, details:{masa,ageMs} });
      }
      if (!freeSet.has(masa) && ageMs > 70 * 60 * 1000) {
        const fee = Number(feeAtTime(masa, sessionStart, now)) || 0;
        if (fee <= 0) {
          issues.push({ key:`session:zero-fee:${masa}`, code:"LONG_SESSION_ZERO_FEE", severity:"critical", detail:`Masa ${masa} 70 dk üzeri açık ancak hesaplanan ücret 0 ₺`, details:{masa,ageMs,fee} });
        }
      }
    }
    for (const row of duplicateSessionRows || []) {
      issues.push({ key:`session:duplicate:${Number(row.masa)||0}`, code:"DUPLICATE_OPEN_SESSION", severity:"critical", detail:`Masa ${Number(row.masa)||0} için ${Number(row.count)||0} açık oturum bulundu`, details:row });
    }
    if (Number(negativeProductRow && negativeProductRow.count) > 0) {
      issues.push({ key:"product:negative", code:"NEGATIVE_PRODUCT_SALE", severity:"critical", detail:`Bugünkü ürün kayıtlarında ${Number(negativeProductRow.count)||0} negatif satır bulundu`, details:negativeProductRow });
    }

    let activeEvents = [];
    if (options.persist !== false) activeEvents = await persistIntegrityIssues(issues, now);
    const firstSeenMap = new Map((activeEvents || []).map(row => [String(row.issue_key||""), Number(row.first_seen_at)||now]));
    const alertReadyIssues = issues.map(issue => ({
      ...issue,
      firstSeenAt:firstSeenMap.get(String(issue.key||"")) || now,
      alertReady:(now - (firstSeenMap.get(String(issue.key||"")) || now)) >= 10 * 60 * 1000
    }));
    const criticalCount = issues.filter(issue => issue.severity === "critical").length;
    const warningCount = issues.filter(issue => issue.severity !== "critical").length;
    lastIntegrityAudit = {
      checkedAt:now,
      healthy:issues.length===0,
      status:criticalCount ? "critical" : (issues.length ? "warning" : "healthy"),
      summary:issues.length ? `${issues.length} tutarsızlık/anomali bulundu` : "Finans ve oturum denetimleri normal",
      issues:alertReadyIssues,
      finance:{
        everyCafeReal,kafePinDirect,expectedGeneral,localEveryCafe,localGeneral,
        adjustedLocalEveryCafe,adjustedLocalGeneral,rolloverCarryBefore,
        sourceTransferDifference,localGeneralDifference,
        rolloverTotal:roundMoney(source.rolloverTotal),rolloverCount:Number(source.rolloverCount)||0
      },
      payment:{
        kafePinDirectSales:kafePinDirect,
        kafePinDirectPayments:directPaymentTotal,
        difference:directPaymentDifference,
        cash:roundMoney(directPaymentRow && directPaymentRow.cash),
        card:roundMoney(directPaymentRow && directPaymentRow.card),
        pending:roundMoney(directPaymentRow && directPaymentRow.pending)
      },
      anomalies:{ criticalCount, warningCount, activeSessionCount:(activeSessions||[]).length }
    };
    return lastIntegrityAudit;
  } catch (err) {
    lastIntegrityAudit = {
      checkedAt:now, healthy:false, status:"critical",
      summary:`Denetim çalıştırılamadı: ${String(err.message || err).slice(0,180)}`,
      issues:[{key:"audit:runtime",code:"AUDIT_RUNTIME_ERROR",severity:"critical",detail:String(err.message||err),alertReady:true}],
      finance:{},payment:{},anomalies:{criticalCount:1,warningCount:0}
    };
    return lastIntegrityAudit;
  } finally {
    integrityAuditRunning = false;
  }
}

app.get("/admin/integrity-audit", async (req, res) => {
  setNoStore(res);
  const force = String(req.query && req.query.force || "") === "1";
  if (!force && lastIntegrityAudit.checkedAt && Date.now() - lastIntegrityAudit.checkedAt < 60000) {
    return res.json({ ok:true, ...lastIntegrityAudit });
  }
  const result = await runIntegrityAudit({ force, persist:true });
  res.json({ ok:true, ...result });
});

app.get("/admin/audit-events", async (req, res) => {
  setNoStore(res);
  try {
    const activeOnly = String(req.query && req.query.active || "1") !== "0";
    const rows = await kafePinDbAllP(
      `SELECT * FROM system_audit_events ${activeOnly ? "WHERE active=1" : ""} ORDER BY last_seen_at DESC LIMIT 300`
    );
    res.json({ ok:true, activeOnly, rows:rows || [] });
  } catch (err) {
    res.status(500).json({ ok:false, error:String(err.message || err) });
  }
});

function getAutomaticHealthCheck(code) {
  return (autoHealthLast.checks || []).find(item => String(item.code) === String(code)) || null;
}

// Mevcut basit Sistem Sağlığı uç noktasına gerçek finans/backup/devir/anomali
// durumlarını da ekle. Eski alanlar aynen korunur; eski arayüzler bozulmaz.
app.get("/admin/reliability-health", async (req, res) => {
  setNoStore(res);
  const force = String(req.query.force||"") === "1";
  const integrity = !force && lastIntegrityAudit.checkedAt && Date.now() - lastIntegrityAudit.checkedAt < 60000
    ? lastIntegrityAudit
    : await runIntegrityAudit({ force, persist:true });
  if (!autoHealthLast.checkedAt || Date.now() - autoHealthLast.checkedAt > AUTO_HEALTH_INTERVAL_MS) {
    autoHealthTelegramSuppressCount += 1;
    try {
      await new Promise(resolve => runAutomaticHealthCheck(() => resolve()));
    } finally {
      autoHealthTelegramSuppressCount = Math.max(0, autoHealthTelegramSuppressCount - 1);
    }
  }
  const backup = getHealthBackupCheck(Date.now());
  const rollover = getAutomaticHealthCheck("rollover") || { ok:true, severity:"ok", detail:"Gün sonu kaydı bekleniyor" };
  res.json({
    ok:true,
    checkedAt:Date.now(),
    finance:{ ok:Math.abs(Number(integrity.finance && integrity.finance.localGeneralDifference)||0)<=0.01, detail:integrity.finance },
    integrity,
    rollover,
    backup:{ ...backup, running:fullBackupRunning },
    automaticHealth:autoHealthLast
  });
});

// Güvenli self-test işletme/finans kayıtlarını DEĞİŞTİRMEZ. Formüller, 20:00 sınırı,
// sabit çark tarifesi, 45 dk sayaç ve EveryCafe salt-okunur kilidini sınar.
// Yalnız denetim metadata'sının ilk/son görülme zamanını güncelleyebilir.
app.post("/admin/self-test", async (req, res) => {
  setNoStore(res);
  const tests = [];
  const push = (name, ok, detail) => tests.push({ name, ok:Boolean(ok), detail:String(detail||"") });
  try {
    const boundary = new Date(2026, 7, 18, 20, 0, 0, 0).getTime();
    const oldOnlySnapshot = {
      sessions:[{
        SessionID:"SELFTEST-OLD",ClientName:"MASA-01",SessionType:1,
        StartDate:Math.floor((boundary-2*3600000)/1000),EndDate:Math.floor((boundary-3600000)/1000),
        PaymentAmount:175,PaymentMethod:1,orders:[]
      }], members:[], others:[], tickets:[]
    };
    const oldSummary = summarizeEveryCafeBusinessDaySnapshot(oldOnlySnapshot, boundary, boundary + 3600000);
    push("20:00 eski gün taşınmıyor", Math.abs(Number(oldSummary.total)||0) < 0.01, `Yeni gün toplamı ${(Number(oldSummary.total)||0).toFixed(2)} ₺`);

    const vipTestMasa = Number((VIP_MASALAR || [])[0]) || 21;
    const normalTestMasa = Array.from({length:100},(_,i)=>i+1).find(m => !(VIP_MASALAR || []).includes(m)) || 1;
    const normal30 = getRewardCostAndType(normalTestMasa,"30 dakika");
    const normal60 = getRewardCostAndType(normalTestMasa,"60 dakika");
    const vip30 = getRewardCostAndType(vipTestMasa,"30 dakika");
    const vip60 = getRewardCostAndType(vipTestMasa,"60 dakika");
    const item = getRewardCostAndType(normalTestMasa,"anahtarlık");
    push("Çark sabit maliyet", Number(normal30.amount)===25 && Number(normal60.amount)===50 && Number(vip30.amount)===35 && Number(vip60.amount)===70 && Number(item.amount)===20,
      `N30=${normal30.amount}, N60=${normal60.amount}, V30=${vip30.amount}, V60=${vip60.amount}, ürün=${item.amount}`);
    push("Çark 45 dakika", getSpinReadyAt(1000) === 1000 + 45*60*1000, `${(getSpinReadyAt(1000)-1000)/60000} dk`);
    push("Ciro formülü", roundMoney(175+29)===204 && roundMoney(204-25)===179, "175 + 29 = 204; çark sonrası bilgi 179; genel ciro 204 kalır");

    const ownSource = fs.readFileSync(__filename,"utf8");
    const roCount = (ownSource.match(/new sqlite3\.Database\(EVERYCAFE_DB_PATH,\s*sqlite3\.OPEN_READONLY/g)||[]).length;
    const unsafeCount = (ownSource.match(/new sqlite3\.Database\(EVERYCAFE_DB_PATH(?!,\s*sqlite3\.OPEN_READONLY)/g)||[]).length;
    push("EveryCafe salt-okunur", roCount>0 && unsafeCount===0, `${roCount} salt-okunur açılış, ${unsafeCount} güvensiz açılış`);
    const messengerProbe = buildEveryCafeMessengerPacket("{TEST-SERVER}", "192.0.2.20", "SERVER", "KAFEPIN_TEST").toString("ascii");
    const messengerDecoded = Buffer.from(messengerProbe, "base64").toString("utf8");
    push("EveryCafe Messenger paket biçimi", messengerDecoded === "SENDMESSAGE:ServerGuid={TEST-SERVER};ClientIP=192.0.2.20;ServerName=SERVER;Message=S0FGRVBJTl9URVNU;", messengerDecoded);
    push("Çark bildirim sayfa-açılış kilidi", ownSource.includes("JOIN spin_page_sessions p ON p.session_id=e.session_id AND p.masa=m.masa"), "Bildirim aktif Session + gerçek sayfa açılışı ister");

    const quick = await kafePinDbGetP("PRAGMA quick_check");
    const quickValue = String((quick && (quick.quick_check || quick.integrity_check)) || Object.values(quick||{})[0] || "").toLowerCase();
    push("KafePin DB quick_check", quickValue === "ok", quickValue || "yanıt yok");

    const integrity = await runIntegrityAudit({ force:true, persist:true });
    push("Canlı finans denetimi çalışıyor", Boolean(integrity && integrity.checkedAt), integrity.summary || "-");
  } catch (err) {
    push("Self-test çalışma", false, String(err.message || err));
  }
  const failed = tests.filter(test => !test.ok);
  res.json({ ok:failed.length===0, checkedAt:Date.now(), passed:tests.length-failed.length, failed:failed.length, tests });
});

function getClosedBusinessDayKey(boundaryTs) {
  return dayKey(Math.max(0, Number(boundaryTs)||Date.now()) - 1);
}

async function getLastRolloverStatusP() {
  const raw = await getSettingValueP("last_daily_rollover");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_err) { return null; }
}

async function runAutomaticDailyBackup(reason = "schedule") {
  const last = await getLastRolloverStatusP();
  if (!last || last.status !== "success" || !Number(last.rolloverTs)) return { skipped:true, reason:"rollover-not-ready" };
  const closedKey = getClosedBusinessDayKey(last.rolloverTs);
  const doneKey = await getSettingValueP("last_auto_full_backup_business_day");
  if (doneKey === closedKey) return { skipped:true, reason:"already-done", closedKey };
  if (fullBackupRunning) return { skipped:true, reason:"backup-running", closedKey };
  try {
    addLiveLog("auto_backup", `💾 Gün sonu otomatik FULL ZIP yedeği başlatıldı • ${closedKey}`);
    const result = await createFullProjectBackupP43();
    await setSettingValueP("last_auto_full_backup_business_day", closedKey);
    addLiveLog("auto_backup", `✅ Gün sonu otomatik yedek tamamlandı • ${result.fileName || closedKey}`);
    return { ok:true, closedKey, reason, ...result };
  } catch (err) {
    addLiveLog("auto_backup", `⚠️ Gün sonu otomatik yedek başarısız • ${String(err.message||err).slice(0,160)}`);
    if (TELEGRAM_ENABLED) sendTelegramMessage(`⚠️ KafePin otomatik yedek alınamadı\n• ${String(err.message||err).slice(0,180)}`, () => {});
    return { ok:false, closedKey, error:String(err.message||err) };
  }
}

// v3.1.47: 20:08 cron ile 5 dakikalık catch-up aynı anda tetiklenirse aynı
// kapanan iş günü için iki Telegram sağlık raporu gönderilmesini engeller.
// Gönderim başarısız olursa kilit finally içinde açılır ve sonraki tur yeniden deneyebilir.
const eodHealthReportInFlight = new Set();

async function runEndOfDayHealthReport(reason = "schedule") {
  if (!TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { skipped:true, reason:"telegram-disabled" };
  const last = await getLastRolloverStatusP();
  if (!last || last.status !== "success" || !Number(last.rolloverTs)) return { skipped:true, reason:"rollover-not-ready" };
  const boundary = Number(last.rolloverTs);
  const closedKey = getClosedBusinessDayKey(boundary);
  const sentKey = await getSettingValueP("last_eod_health_report_business_day");
  if (sentKey === closedKey) return { skipped:true, reason:"already-sent", closedKey };
  const claimKey = "telegram_eod_health_report_claim";
  const claimRaw = await getSettingValueP(claimKey);
  let claim = null;
  try { claim = claimRaw ? JSON.parse(claimRaw) : null; } catch (_err) {}
  if (claim && claim.closedKey === closedKey && Date.now() - Number(claim.claimedAt || 0) < 15 * 60 * 1000) {
    return { skipped:true, reason:"already-claimed", closedKey };
  }
  if (eodHealthReportInFlight.has(closedKey)) return { skipped:true, reason:"already-running", closedKey };

  eodHealthReportInFlight.add(closedKey);
  await setSettingValueP(claimKey, JSON.stringify({ closedKey, claimedAt:Date.now() }));
  try {
  // Rapor 20:08'de gönderildiği için "canlı yeni gün" değil, az önce kapanan
  // 20:00–20:00 iş gününü yeniden salt-okunur kaynaktan doğrular.
  const closedStart = dayStartTs(Math.max(0, boundary - 1));
  const closedEnd = boundary;
  const [closedStats, closedSource, directPaymentRow] = await Promise.all([
    getRangeStatsP(closedStart, closedEnd),
    readEveryCafeSourceRange(closedStart, closedEnd),
    kafePinDbGetP(
      `SELECT COALESCE(SUM(total_amount),0) AS total
       FROM payments
       WHERE voided=0 AND source='DIRECT_PRODUCT' AND created_at>=? AND created_at<?`,
      [closedStart, closedEnd]
    )
  ]);
  autoHealthTelegramSuppressCount += 1;
  try {
    await new Promise(resolve => runAutomaticHealthCheck(() => resolve()));
  } finally {
    autoHealthTelegramSuppressCount = Math.max(0, autoHealthTelegramSuppressCount - 1);
  }

  const everyCafeReal = roundMoney(closedSource && closedSource.summary && closedSource.summary.total);
  const direct = roundMoney(closedStats && closedStats.kafePinDirectGeliri);
  const expectedGeneral = roundMoney(everyCafeReal + direct);
  const localGeneral = roundMoney(closedStats && closedStats.genelGelir);
  const rawTotal = roundMoney(closedSource && closedSource.rawSummary && closedSource.rawSummary.total);
  const rolloverCarryBefore = Math.max(0, roundMoney(rawTotal - everyCafeReal));
  const adjustedLocalGeneral = roundMoney(localGeneral - rolloverCarryBefore);
  const generalDifference = roundMoney(adjustedLocalGeneral - expectedGeneral);
  const directPaymentDifference = roundMoney((Number(directPaymentRow && directPaymentRow.total)||0) - direct);

  const backupCheck = fullBackupRunning
    ? { ok:true, detail:"Otomatik yedek devam ediyor" }
    : getHealthBackupCheck(Date.now());
  const dbCheck = getAutomaticHealthCheck("database") || {ok:false,detail:"DB kontrolü yok"};
  const everyCafeCheck = getAutomaticHealthCheck("everycafe") || {ok:true,detail:"EveryCafe kontrolü bekleniyor"};
  const rolloverCheck = getAutomaticHealthCheck("rollover") || {ok:false,detail:"Gün sonu kontrolü yok"};
  const liveIntegrity = lastIntegrityAudit.checkedAt && Date.now() - lastIntegrityAudit.checkedAt < 10 * 60 * 1000
    ? lastIntegrityAudit
    : await runIntegrityAudit({ force:true, persist:true });
  const financeOk = Math.abs(generalDifference) <= 0.01;
  const directPaymentOk = Math.abs(directPaymentDifference) <= 0.01;
  const anomalyOk = Number(liveIntegrity.anomalies && liveIntegrity.anomalies.criticalCount || 0) === 0;
  const icon = ok => ok ? "✅" : "⚠️";
  const message = [
    `🩺 KAFEPİN GÜN SONU SAĞLIK RAPORU`,
    `📅 ${closedKey} • kapanan 20:00–20:00 iş günü`,
    "",
    `${icon(financeOk)} Kapanan Gün Ciro : EveryCafe ${everyCafeReal.toFixed(2)} + KafePin ${direct.toFixed(2)} = ${expectedGeneral.toFixed(2)} ₺`,
    `${icon(financeOk)} Muhasebe Ciro Farkı : ${generalDifference.toFixed(2)} ₺`,
    `${icon(directPaymentOk)} KafePin Doğrudan Ödeme : fark ${directPaymentDifference.toFixed(2)} ₺`,
    `${icon(rolloverCheck.ok)} 20:00 Gün Devri : ${String(rolloverCheck.detail||"")}`,
    `${icon(everyCafeCheck.ok)} EveryCafe : ${String(everyCafeCheck.detail||"")}`,
    `${icon(dbCheck.ok)} Veritabanı : ${String(dbCheck.detail||"")}`,
    `${icon(backupCheck.ok)} Yedek : ${String(backupCheck.detail||"")}`,
    `${icon(anomalyOk)} Yeni Gün Anomali : ${anomalyOk ? "kritik sorun yok" : `${Number(liveIntegrity.anomalies.criticalCount)||0} kritik sorun`}`,
    "",
    financeOk && directPaymentOk && rolloverCheck.ok && dbCheck.ok && backupCheck.ok
      ? "✅ Genel sonuç: Kapanan gün kontrolleri normal"
      : "⚠️ Genel sonuç: Bir veya daha fazla kontrol dikkat istiyor"
  ].join("\n");

  return await new Promise(resolve => {
    sendTelegramMessage(message, async (err) => {
      if (err) {
        try { await setSettingValueP(claimKey, ""); } catch (_err) {}
        return resolve({ok:false,closedKey,error:String(err.message||err)});
      }
      try {
        await setSettingValueP("last_eod_health_report_business_day", closedKey);
        await setSettingValueP(claimKey, "");
      } catch (_err) {}
      addLiveLog("eod_health", `🩺 Kapanan gün sağlık raporu Telegram'a gönderildi • ${closedKey}`);
      // Sağlık raporu yeni bir Telegram mesajıdır; canlı masa durumunun
      // her bildirimden sonra en altta kalması için mevcut güvenli taşıma
      // mekanizmasını burada da çalıştır.
      moveLiveMonitorToBottomSoon();
      resolve({ok:true,closedKey,reason,finance:{everyCafeReal,direct,expectedGeneral,generalDifference,directPaymentDifference}});
    });
  });
  } finally {
    eodHealthReportInFlight.delete(closedKey);
  }
}

async function runPreviousMonthTelegramSummary(reason = "schedule") {
  if (!TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { skipped:true, reason:"telegram-disabled" };
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), 1, 20, 0, 0, 0).getTime();
  const startDate = new Date(now.getFullYear(), now.getMonth()-1, 1, 20, 0, 0, 0);
  const start = startDate.getTime();
  if (Date.now() < end) return { skipped:true, reason:"month-not-closed" };
  const monthKey = `${startDate.getFullYear()}-${String(startDate.getMonth()+1).padStart(2,"0")}`;
  if (await getSettingValueP("last_monthly_summary_key") === monthKey) return { skipped:true, reason:"already-sent", monthKey };
  try {
    const [stats, config] = await Promise.all([getRangeStatsP(start,end), getEveryCafeConfigP()]);
    let everyCafeReal = Number(stats.everyCafeGenelGelir)||0;
    if (config && config.enabled && config.startAt) {
      const snapshot = await readEveryCafePaymentAuditSnapshotP(Math.max(0,start-1000));
      everyCafeReal = Number(summarizeEveryCafeBusinessDaySnapshot(snapshot,start,end).total)||0;
    }
    const direct = Number(stats.kafePinDirectGeliri)||0;
    const general = roundMoney(everyCafeReal + direct);
    const net = roundMoney(general - (Number(stats.giderler)||0) - (Number(stats.kartKomisyonu)||0) - (Number(stats.spinMaliyeti)||0));
    const message = [
      `📊 KAFEPİN AYLIK İŞLETME ÖZETİ`,
      `📅 ${monthKey}`,
      "",
      `🖥️ EveryCafe Gerçek Gelir : ${everyCafeReal.toFixed(2)} ₺`,
      `🧾 KafePin Doğrudan : ${direct.toFixed(2)} ₺`,
      `💰 Genel Ciro : ${general.toFixed(2)} ₺`,
      `🎁 Çark Maliyeti : ${Number(stats.spinMaliyeti||0).toFixed(2)} ₺`,
      `🧾 Gider : ${Number(stats.giderler||0).toFixed(2)} ₺`,
      `💳 Kart Komisyonu : ${Number(stats.kartKomisyonu||0).toFixed(2)} ₺`,
      `📈 Net Sonuç : ${net.toFixed(2)} ₺`,
      `🎰 Spin : ${Number(stats.totalSpins)||0}`
    ].join("\n");
    await new Promise((resolve,reject)=>sendTelegramMessage(message,err=>err?reject(err):resolve()));
    await setSettingValueP("last_monthly_summary_key", monthKey);
    addLiveLog("monthly_summary", `📊 Aylık işletme özeti gönderildi • ${monthKey}`);
    return {ok:true,monthKey,reason};
  } catch (err) {
    logErr("monthly telegram summary", err);
    return {ok:false,error:String(err.message||err),monthKey};
  }
}

// 20:00 devrinden sonra backup ve sağlık raporu. Cron anı kaçarsa aşağıdaki
// catch-up zamanlayıcısı aynı iş gününde yalnız bir kez tamamlar.
cron.schedule("2 20 * * *", () => { runAutomaticDailyBackup("cron").catch(err => logErr("auto daily backup",err)); }, { timezone:"Europe/Istanbul" });
cron.schedule("8 20 * * *", () => { runEndOfDayHealthReport("cron").catch(err => logErr("eod health report",err)); }, { timezone:"Europe/Istanbul" });
cron.schedule("15 20 1 * *", () => { runPreviousMonthTelegramSummary("cron").catch(err => logErr("monthly summary",err)); }, { timezone:"Europe/Istanbul" });

async function ensureReliabilityJobs() {
  const now = new Date();
  const minutes = now.getHours()*60 + now.getMinutes();
  if (minutes >= 20*60+2) {
    try { await runAutomaticDailyBackup("catch_up"); } catch (err) { logErr("auto backup catch_up",err); }
  }
  if (minutes >= 20*60+8) {
    try { await runEndOfDayHealthReport("catch_up"); } catch (err) { logErr("health report catch_up",err); }
  }
  if (now.getDate() <= 3 && minutes >= 20*60+15) {
    try { await runPreviousMonthTelegramSummary("catch_up"); } catch (err) { logErr("monthly summary catch_up",err); }
  }
}
setTimeout(() => ensureReliabilityJobs(), 2 * 60 * 1000);
setInterval(() => ensureReliabilityJobs(), 5 * 60 * 1000);

app.get("/admin/daily-comparison", (req, res) => {
  setNoStore(res);

  const now = Date.now();
  const todayStart = dayStartTs(now);
  const dayMs = 24 * 60 * 60 * 1000;
  const ranges = {
    today: [todayStart, now],
    yesterday: [todayStart - dayMs, todayStart],
    lastWeekSameDay: [todayStart - 7 * dayMs, todayStart - 6 * dayMs]
  };

  const readRange = ([start, end]) =>
    new Promise((resolve, reject) => {
      getRangeStats(start, end, (err, stats) => {
        if (err) return reject(err);
        getDayAwareDashboardStats(start, end, (dashboardErr, dashboardStats) => {
          if (dashboardErr) return reject(dashboardErr);
          resolve({
            ...(stats || {}),
            totalSessions: Number((dashboardStats && dashboardStats.totalSessions) || 0)
          });
        });
      });
    });

  Promise.all([
    readRange(ranges.today),
    readRange(ranges.yesterday),
    readRange(ranges.lastWeekSameDay)
  ])
    .then(([today, yesterday, lastWeekSameDay]) => {
      // Karşılaştırmada masa geliriyle birlikte o gün satılan ürün/hizmetleri
      // de kullan. getRangeStats tüm aralıklarda aynı kafe günü sınırını kullanır.
      const revenue = (x) => Number(x.genelGelir || 0);
      const todayRevenue = revenue(today);
      const yesterdayRevenue = revenue(yesterday);
      const lastWeekRevenue = revenue(lastWeekSameDay);
      const percent = (base) => base === 0 ? null : ((todayRevenue - base) / Math.abs(base)) * 100;

      res.json({
        ok: true,
        today: { revenue: todayRevenue, sessions: Number(today.totalSessions || 0) },
        yesterday: { revenue: yesterdayRevenue, sessions: Number(yesterday.totalSessions || 0) },
        lastWeekSameDay: { revenue: lastWeekRevenue, sessions: Number(lastWeekSameDay.totalSessions || 0) },
        versusYesterdayPercent: percent(yesterdayRevenue),
        versusLastWeekPercent: percent(lastWeekRevenue)
      });
    })
    .catch((err) => {
      logErr("/admin/daily-comparison", err);
      res.status(500).json({ ok: false });
    });
});

app.get("/admin/dashboard-stats", (req, res) => {

  setNoStore(res);

  const todayStart = dayStartTs(Date.now());

  db.get(
    `
SELECT
  COUNT(*) as totalSessions,
  COALESCE(AVG(minutes),0) as avgMinutes,
  COALESCE(AVG(CASE WHEN fee > 0 THEN fee END),0) as avgFee,
  COALESCE(SUM(fee),0) as totalRevenue,

  (SELECT COUNT(*) FROM session_history WHERE fee > 0) AS allTimeSessions,

  (SELECT COALESCE(AVG(minutes),0)
   FROM session_history WHERE fee > 0) AS allTimeAvgMinutes,

  (SELECT COALESCE(AVG(h.fee + COALESCE((
    SELECT SUM(p.total) FROM product_sales p
    WHERE p.masa=h.masa AND p.session_start=h.start_time
      AND p.sale_type='TABLE' AND p.voided=0
  ),0)),0)
 FROM session_history h
 WHERE h.fee>0 OR EXISTS(
   SELECT 1 FROM product_sales p
   WHERE p.masa=h.masa AND p.session_start=h.start_time
     AND p.sale_type='TABLE' AND p.voided=0
 )) AS allTimeAvgFee,

  (SELECT COALESCE(SUM(h.fee + COALESCE((
    SELECT SUM(p.total) FROM product_sales p
    WHERE p.masa=h.masa AND p.session_start=h.start_time
      AND p.sale_type='TABLE' AND p.voided=0
  ),0)),0)
   FROM session_history h) AS allTimeRevenue,

  (SELECT COALESCE(MAX(h.fee + COALESCE((
    SELECT SUM(p.total)
    FROM product_sales p
    WHERE p.masa=h.masa
      AND p.session_start=h.start_time
      AND p.sale_type='TABLE'
      AND p.voided=0
  ),0)),0)
   FROM session_history h) AS allTimeMaxFee,
(SELECT COALESCE(MAX(minutes),0)
 FROM session_history WHERE fee > 0) AS longestSessionMinutes,

(SELECT masa
 FROM session_history
 WHERE fee > 0
 ORDER BY minutes DESC
 LIMIT 1) AS longestSessionTable,

(SELECT COALESCE(SUM(h.fee + COALESCE((
  SELECT SUM(p.total) FROM product_sales p
  WHERE p.masa=h.masa AND p.session_start=h.start_time
    AND p.sale_type='TABLE' AND p.voided=0
),0)),0)
 FROM session_history h
 WHERE h.end_time >= strftime('%s','now','start of month')*1000
) AS thisMonthRevenue,

(SELECT COALESCE(SUM(h.fee + COALESCE((
  SELECT SUM(p.total) FROM product_sales p
  WHERE p.masa=h.masa AND p.session_start=h.start_time
    AND p.sale_type='TABLE' AND p.voided=0
),0)),0)
 FROM session_history h
 WHERE h.end_time >= strftime('%s','now','-30 day')*1000
) AS last30Revenue,

(SELECT SUM(h.fee + COALESCE((
  SELECT SUM(p.total) FROM product_sales p
  WHERE p.masa=h.masa AND p.session_start=h.start_time
    AND p.sale_type='TABLE' AND p.voided=0
),0))
 FROM session_history h
 GROUP BY DATE(h.end_time/1000,'unixepoch','localtime')
 ORDER BY SUM(h.fee + COALESCE((
  SELECT SUM(p.total) FROM product_sales p
  WHERE p.masa=h.masa AND p.session_start=h.start_time
    AND p.sale_type='TABLE' AND p.voided=0
 ),0)) DESC
 LIMIT 1
) AS bestDailyRevenue,

(SELECT DATE(h.end_time/1000,'unixepoch','localtime')
 FROM session_history h
 GROUP BY DATE(h.end_time/1000,'unixepoch','localtime')
 ORDER BY SUM(h.fee + COALESCE((
  SELECT SUM(p.total) FROM product_sales p
  WHERE p.masa=h.masa AND p.session_start=h.start_time
    AND p.sale_type='TABLE' AND p.voided=0
 ),0)) DESC
 LIMIT 1
) AS bestDailyRevenueDate,

(SELECT masa
 FROM session_history
 WHERE fee > 0
 GROUP BY masa
 ORDER BY AVG(minutes) DESC
 LIMIT 1
) AS avgLeaderTable,

(SELECT ROUND(AVG(minutes))
 FROM session_history
 WHERE fee > 0
 GROUP BY masa
 ORDER BY AVG(minutes) DESC
 LIMIT 1
) AS avgLeaderMinutes

FROM session_history
WHERE end_time >= ? AND fee > 0
    `,
    [todayStart],
    (err, stats) => {

      if (err) {
        logErr("dashboard-stats", err);
        return res.json({ ok:false });
      }
let onlineCount = 0;
let offlineCount = 0;
let freeCount = 0;
const onlineMasalar = [];
const offlineMasalar = [];

const now = Date.now();

for (let masa = 1; masa <= MASA_SAYISI; masa++) {

  if (isFreeMasa(masa)) {
    freeCount++;
    continue;
  }

  const lastSeen = aktifMasalar[masa] || 0;

  const online = !isActuallyOffline(
    masa,
    lastSeen,
    now
  );

if (online) {

  onlineCount++;
  onlineMasalar.push(masa);

} else {

  offlineCount++;
  offlineMasalar.push(masa);

}
}
db.all(
  `
SELECT
    masa,

    COUNT(CASE WHEN end_time >= ? AND fee > 0 THEN 1 END) AS sessionCount,
    SUM(CASE WHEN end_time >= ? THEN fee + COALESCE((
      SELECT SUM(p.total) FROM product_sales p
      WHERE p.masa=session_history.masa AND p.session_start=session_history.start_time
        AND p.sale_type='TABLE' AND p.voided=0
    ),0) ELSE 0 END) AS totalFee,

    COUNT(CASE WHEN fee > 0 THEN 1 END) AS allSessionCount,
    SUM(fee + COALESCE((
      SELECT SUM(p.total) FROM product_sales p
      WHERE p.masa=session_history.masa AND p.session_start=session_history.start_time
        AND p.sale_type='TABLE' AND p.voided=0
    ),0)) AS allTotalFee

FROM session_history
GROUP BY masa
  `,
  [todayStart, todayStart],   // <-- BURADA VİRGÜL OLMALI
  (err2, masaStats) => {

    if (err2) {
      logErr("dashboard-masa-stats", err2);
      return res.json({ ok:false });
    }

    let busiestTable = null;
    let busiestCount = 0;

    let bestRevenueTable = null;
    let bestRevenue = 0;
let allTimeBusyTable = null;
let allTimeBusyCount = 0;

let allTimeBestRevenueTable = null;
let allTimeBestRevenue = 0;

for (const row of masaStats) {

  // Bugün
  if (row.sessionCount > busiestCount) {
    busiestCount = row.sessionCount;
    busiestTable = row.masa;
  }

  if (Number(row.totalFee) > bestRevenue) {
    bestRevenue = Number(row.totalFee);
    bestRevenueTable = row.masa;
  }

  // Tüm zamanlar
  if (row.allSessionCount > allTimeBusyCount) {
    allTimeBusyCount = row.allSessionCount;
    allTimeBusyTable = row.masa;
  }

  if (Number(row.allTotalFee) > allTimeBestRevenue) {
    allTimeBestRevenue = Number(row.allTotalFee);
    allTimeBestRevenueTable = row.masa;
  }

}

getDayAwareDashboardStats(todayStart, now, (dayErr, todayStats) => {
  if (dayErr) {
    logErr("dashboard day-aware stats", dayErr);
    return res.json({ ok:false });
  }

  // Dashboard'daki ciro kartları, muhasebe ile aynı kaynaktan hesaplanır:
  // gerçek masa geliri + masa/doğrudan ürün-hizmet geliri. Böylece eski
  // yalnızca oturum toplamı hiçbir kartta genel ciro gibi görünmez.
  const monthDate = new Date(now);
  monthDate.setDate(1);
  monthDate.setHours(20, 0, 0, 0);
  const monthStart = monthDate.getTime() > now
    ? new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1, 20, 0, 0, 0).getTime()
    : monthDate.getTime();
  const last30Start = now - (30 * 24 * 60 * 60 * 1000);

  getRangeStats(0, now + 1, (allRangeErr, allRange) => {
    if (allRangeErr) {
      logErr("dashboard all-time general revenue", allRangeErr);
      return res.json({ ok:false });
    }
    getRangeStats(monthStart, now + 1, (monthRangeErr, monthRange) => {
      if (monthRangeErr) {
        logErr("dashboard month general revenue", monthRangeErr);
        return res.json({ ok:false });
      }
      getRangeStats(last30Start, now + 1, (last30RangeErr, last30Range) => {
        if (last30RangeErr) {
          logErr("dashboard last30 general revenue", last30RangeErr);
          return res.json({ ok:false });
        }

return res.json({

  ok:true,

  totalSessions: todayStats.totalSessions,
  avgMinutes: Number(todayStats.avgMinutes || 0),
  avgFee: Number(todayStats.avgFee || 0),
  totalRevenue: Number(todayStats.totalRevenue || 0),

  busiestTable: todayStats.busiestTable,
  busiestCount: todayStats.totalSessions,
  busiestMinutes: Number(todayStats.busiestMinutes || 0),

  bestRevenueTable: todayStats.bestRevenueTable,
  bestRevenue: Number(todayStats.bestRevenue || 0),

  // 👇 BURAYA EKLE
  allTimeSessions: stats.allTimeSessions || 0,
  allTimeRevenue: Number(allRange.genelGelir || 0),
  allTimeAvgFee: Number(stats.allTimeAvgFee || 0),
  allTimeAvgMinutes: Number(stats.allTimeAvgMinutes || 0),
  allTimeMaxFee: Number(stats.allTimeMaxFee || 0),
longestSessionMinutes: Number(stats.longestSessionMinutes || 0),
longestSessionTable: stats.longestSessionTable,

thisMonthRevenue: Number(monthRange.genelGelir || 0),
last30Revenue: Number(last30Range.genelGelir || 0),
bestDailyRevenue: Number(stats.bestDailyRevenue || 0),
bestDailyRevenueDate: stats.bestDailyRevenueDate,
avgLeaderTable: stats.avgLeaderTable,
avgLeaderMinutes: Number(stats.avgLeaderMinutes || 0),

  allTimeBusyTable,
  allTimeBusyCount,

  allTimeBestRevenueTable,
  allTimeBestRevenue,
  // 👆 BURAYA KADAR

onlineCount,
offlineCount,

onlineMasalar,
offlineMasalar,

freeCount,

});

      });
    });
  });

});

  }
);

    }
  );

});
app.get("/admin/session-history", (req, res) => {
  setNoStore(res);
  db.all(
    `
SELECT 
  id,
  masa,
  start_time,
  end_time,
  minutes,
  fee,
  adjustment,
  close_reason,
  COALESCE((
    SELECT SUM(p.total)
    FROM product_sales p
    WHERE p.masa=session_history.masa
      AND p.session_start=session_history.start_time
      AND p.sale_type='TABLE'
      AND p.voided=0
  ),0) AS product_total
FROM session_history
WHERE fee > 0
    ORDER BY id DESC
    LIMIT 100
    `,
    (err, rows) => {
      if (err) {
        logErr("session-history", err);
        return res.json({ ok: false });
      }
      res.json({ ok: true, list: rows || [] });
    }
  );
});

app.post("/admin/session-history/clear", (req, res) => {
  setNoStore(res);

  db.run("DELETE FROM session_history", (err) => {
    if (err) {
      logErr("/admin/session-history/clear", err);
      return res.json({ ok: false, error: String(err) });
    }

    return res.json({
      ok: true,
      msg: "Session geçmişi temizlendi"
    });
  });
});

app.post("/admin/session-history/delete", (req, res) => {
  setNoStore(res);

  const id = parseInt((req.body || {}).id, 10);

  if (!id) {
    return res.json({ ok: false, error: "Geçersiz id" });
  }

  db.run("DELETE FROM session_history WHERE id=?", [id], function (err) {
    if (err) {
      logErr("/admin/session-history/delete", err);
      return res.json({ ok: false, error: String(err) });
    }

    if ((this.changes || 0) === 0) {
      return res.json({ ok: false, error: "Kayıt bulunamadı" });
    }

    return res.json({
      ok: true,
      msg: "Session kaydı silindi"
    });
  });
});

app.get("/api/client-config", (req, res) => {
  setNoStore(res);

  const ip = getReqIp(req);

  const found = Object.entries(MASA_IPS).find(
    ([, masaIp]) => masaIp === ip
  );

  if (!found) {
    return res.json({
      ok: false,
      error: `Bu IP için masa tanımı yok: ${ip}`
    });
  }

  const masa = parseInt(found[0], 10);

  return res.json({
    ok: true,
    masa,
    token: MASA_TOKENS[masa],
    ip,
    spinEnabled: SPIN_ENABLED
  });
});
app.post("/api/ping", (req, res) => {
diagnostics.lastPing = Date.now();
  try {
    setNoStore(res);

    const masa = getMasaFromRequest(req);

    if (!masa) {
      return res.json({ ok: false, error: "Geçersiz masa, token veya IP" });
    }

    isBlockedMasa(masa, (blocked, untilTime) => {
      if (blocked) {
        return res.json({
          ok: false,
          error: "Masa geçici bloklu",
          blocked: true,
          until: untilTime
        });
      }

recordTokenHit(masa, req);

const now = Date.now();

const netSpeed =
  Number(req.body?.netSpeed || 0);

const prevPing = masaPingStats[masa]?.last || 0;


// 2 saniyeden sık ping gelirse ignore et
if (prevPing && now - prevPing < 2000) {
  return res.json({
    ok: true,
    masa,
    throttled: true
  });
}

if (isLocked(masa, now)) {
  return res.json({ ok: true, masa, locked: true });
}
if (masaCloseLocks[masa] && Date.now() < masaCloseLocks[masa]) {
    return res.json({
        ok: false,
        closing: true
    });
}

// Ping bekleme ekranında da gelir. EveryCafe masa henüz Windows'a geçmemiş
// diyorsa normal KafePin oturumu ve ücret başlatılmaz.
isEveryCafeClientWaiting(masa, (waitingErr, waiting) => {
  if (waitingErr) {
    logErr("/api/ping EveryCafe bekleme kontrolü", waitingErr);
  }
  if (!waitingErr && waiting) {
    return setEveryCafeWaitingMasa(masa, now, (setErr) => {
      if (setErr) return res.status(500).json({ ok: false, error: "Bekleme durumu kaydedilemedi" });
      return res.json({ ok: true, masa, waiting: true });
    });
  }

ensureSessionStarted(masa, now, (err, sessionResult) => {
  if (err) {
    return res.status(500).json({ ok: false, error: "Session başlatılamadı" });
  }

  // EveryCafe kapandıktan sonra istemci birkaç ping daha gönderebilir.
  // Bu pingler yalnızca ağ yaşam belirtisidir; yeni KafePin oturumu,
  // gelir veya admin panelinde sahte "Bağlı" masa yaratmaz.
  if (sessionResult && sessionResult.sourceManaged) {
    // EveryCafe'de aktif oturum yoksa bu ping eski müşteri/restart artığıdır.
    // Yeni KafePin oturumu veya "Bağlı" masa yaratamaz.
    if (!sessionResult.sourceActive) {
      delete aktifMasalar[masa];
      return res.json({ ok: true, masa, sourceManaged: true, sourceActive: false, closed: true });
    }
    // EveryCafe aktifken ping yalnız bağlantı/ağ bilgisini günceller.
    aktifMasalar[masa] = now;
    if (!masaPingStats[masa]) {
      masaPingStats[masa] = { last: 0, avg: PING_INTERVAL_MS, lastSeen: 0, netSpeed: 0, connectedLogged: false };
    }
    const sourcePrev = masaPingStats[masa].last || 0;
    if (sourcePrev > 0) {
      const diff = now - sourcePrev;
      masaPingStats[masa].avg = masaPingStats[masa].avg > 0
        ? (masaPingStats[masa].avg * 0.7 + diff * 0.3)
        : diff;
    } else {
      masaPingStats[masa].avg = PING_INTERVAL_MS;
    }
    masaPingStats[masa].last = now;
    masaPingStats[masa].lastSeen = now;
    masaPingStats[masa].netSpeed = Number(netSpeed || 0);
    return res.json({ ok: true, masa, sourceManaged: true });
  }

  // 🔥 Ping geldiyse masa aktiftir
  aktifMasalar[masa] = now;

  if (masaCloseLocks[masa] && now < masaCloseLocks[masa]) {
    return res.json({
      ok: false,
      locked: true
    });
  }

  if (!masaPingStats[masa]) {
    masaPingStats[masa] = {
      last: now,
      avg: PING_INTERVAL_MS,
      lastSeen: now,
      netSpeed: 0,
      connectedLogged: false
    };
  }

  const prev = masaPingStats[masa].last;

  if (prev > 0) {
    const diff = now - prev;

    masaPingStats[masa].avg =
      masaPingStats[masa].avg > 0
        ? (masaPingStats[masa].avg * 0.7 + diff * 0.3)
        : diff;
  } else {
    // İlk pingte önceki zaman yoktur. Date.now() - 0 hesabı çok büyük,
    // sahte bir ping değeri üretirdi; ilk örneği başlangıç olarak kabul et.
    masaPingStats[masa].avg = PING_INTERVAL_MS;
  }

const oldSpeed = Number(masaPingStats[masa].netSpeed || 0);
const newSpeed = Number(netSpeed || 0);

masaPingStats[masa].last = now;
masaPingStats[masa].lastSeen = now;
masaPingStats[masa].netSpeed = newSpeed;

if (!masaPingStats[masa].connectedLogged) {
  masaPingStats[masa].connectedLogged = true;

  addLiveLog(
    "connect",
    `🟢 Masa ${masa} bağlandı (${newSpeed} Mbps)`
  );
}

if (oldSpeed === 1000 && newSpeed === 100) {
  addLiveLog(
    "speed_100",
    `🐢 Masa ${masa} 100 Mbps'e düştü`
  );
}

if (oldSpeed === 100 && newSpeed === 1000) {
  addLiveLog(
    "speed_1000",
    `🚀 Masa ${masa} tekrar 1000 Mbps oldu`
  );
}

  return res.json({
    ok: true,
    masa,
    sessionStarted: true,
    startTime: now
  });

}); // ensureSessionStarted
}); // isEveryCafeClientWaiting
}); // isBlockedMasa


} catch (err) {
    logErr("/api/ping", err);
    return res.status(500).json({ ok: false });
  }
});
app.post("/api/status", (req, res) => {
console.log("STATUS BODY:", req.body);
  try {
    setNoStore(res);

    const masa = getMasaFromRequest(req);
console.log("STATUS MASA:", masa);

    if (!masa) {
      return res.json({ ok: false, error: "Geçersiz masa, token veya IP", kalan: 0 });
    }

    isBlockedMasa(masa, (blocked, untilTime) => {
      if (blocked) {
        return res.json({
          ok: false,
          error: "Masa geçici bloklu",
          kalan: 0,
          blocked: true,
          until: untilTime
        });
      }

recordTokenHit(masa, req);

const now = Date.now();

if (masaCloseLocks[masa] && now < masaCloseLocks[masa]) {
  return res.json({
    ok: true,
    masa,
    kalan: getSpinSureMs(),
    locked: true
  });
}

if (everyCafeWaitingMasalar.has(masa)) {
  return res.json({ ok: true, masa, kalan: 0, waiting: true });
}
   

const locked = isLocked(masa, now);

      const continueStatus = (sessionResult = null) => {
        const recordPageOpen = (done) => {
          if (!(sessionResult && sessionResult.sourceManaged && sessionResult.sourceActive && sessionResult.sourceSessionId)) {
            return done();
          }
          markEveryCafeSpinPageOpened(masa, sessionResult.sourceSessionId, now, (pageOpenErr) => {
            if (pageOpenErr) logErr("/api/status spin page open marker", pageOpenErr);
            done();
          });
        };
        db.get("SELECT * FROM masalar WHERE masa=?", [masa], (err, row) => {
          if (err) {
            logErr("/api/status SELECT masalar", err);
            return res.status(500).json({ ok: false, error: "DB status hata", kalan: 0 });
          }

          const SURE = getSpinSureMs();

          if (locked) {
            return res.json({ ok: true, masa, kalan: SURE, locked: true });
          }

          if (!row) {
  db.run(
    "INSERT INTO masalar (masa,start_time) VALUES (?,?) ON CONFLICT(masa) DO NOTHING",
    [masa, now],
    (e2) => {
      if (e2) {
        logErr("/api/status INSERT masalar", e2);
        return res.status(500).json({ ok: false, error: "DB insert hata", kalan: 0 });
      }
      return recordPageOpen(() => res.json({ ok: true, masa, kalan: SURE }));
    }
  );
  return;
}

          const kalan = getSpinReadyAt(row.start_time) - now;
          return recordPageOpen(() => res.json({ ok: true, masa, kalan: kalan > 0 ? kalan : 0 }));
        });
      };

      if (locked) return continueStatus();
      ensureSessionStarted(masa, now, (eStart, sessionResult) => {
        if (eStart) {
          logErr("/api/status ensureSessionStarted", eStart);
          return res.status(500).json({ ok: false, error: "Session kontrol edilemedi", kalan: 0 });
        }
        if (sessionResult && sessionResult.sourceManaged && !sessionResult.sourceActive) {
          delete aktifMasalar[masa];
          return db.run("DELETE FROM masalar WHERE masa=?", [masa], () => {
            return res.json({ ok: true, masa, kalan: 0, sourceManaged: true, sourceActive: false, closed: true });
          });
        }
        continueStatus(sessionResult);
      });
    });
  } catch (err) {
    logErr("/api/status", err);
    return res.status(500).json({ ok: false, error: "Status hata", kalan: 0 });
  }
});
app.post("/admin/set-start-time", (req, res) => {

    const { masa, saat } = req.body;

    if (!masa || !saat)
        return res.json({ ok:false, error:"Eksik bilgi" });

    const p = saat.split(":");

    if (p.length < 2)
        return res.json({ ok:false, error:"Saat hatalı" });

    db.get(
        "SELECT * FROM sessions WHERE masa=? AND end_time=0",
        [masa],
        (err,row)=>{

            if(err || !row)
                return res.json({ok:false,error:"Aktif oturum bulunamadı"});

            const d=new Date();

            d.setHours(
                Number(p[0]),
                Number(p[1]),
                Number(p[2]||0),
                0
            );

            // Gün değişmiş olmasın
            if(d.getTime()>Date.now())
                d.setDate(d.getDate()-1);

            const yeniStart=d.getTime();

            db.run(
                "UPDATE sessions SET start_time=? WHERE masa=? AND end_time=0",
                [yeniStart,masa],
                err2=>{

                    if(err2)
                        return res.json({ok:false,error:err2.message});

                    res.json({ok:true});

                });

        });

});
app.get("/api/rewards", (req, res) => {
  setNoStore(res);
  db.all("SELECT name, weight, active FROM rewards WHERE active=1 ORDER BY id ASC", (err, rows) => {
    if (err) {
      logErr("/api/rewards", err);
      return res.status(500).json([]);
    }
    res.json(rows || []);
  });
});

app.post("/api/spin", (req, res) => {
  if (!SPIN_ENABLED) { setNoStore(res); return res.json({ ok:false, error:"Bu kafede çark devre dışı." }); }
  try {
    setNoStore(res);

    const masa = getMasaFromRequest(req);

    if (!masa) {
      return res.json({ error: "Geçersiz masa, token veya IP" });
    }

    isBlockedMasa(masa, (blocked, untilTime) => {
      if (blocked) {
        return res.json({
          error: "Masa geçici bloklu",
          blocked: true,
          until: untilTime
        });
      }

      recordTokenHit(masa, req);

      const now = Date.now();
      aktifMasalar[masa] = now;

      if (isLocked(masa, now)) {
        return res.json({ error: "Masa hazırlanıyor" });
      }

      ensureSessionStarted(masa, now, (eStart, sessionResult) => {
        if (eStart) {
          return res.status(500).json({ error: "Session başlatılamadı" });
        }
        if (sessionResult && sessionResult.sourceManaged && !sessionResult.sourceActive) {
          delete aktifMasalar[masa];
          return db.run("DELETE FROM masalar WHERE masa=?", [masa], () => {
            return res.json({ error: "EveryCafe'de aktif müşteri oturumu yok" });
          });
        }

        db.serialize(() => {
         
db.run("BEGIN IMMEDIATE TRANSACTION", (e0) => {
            if (e0) {
              logErr("/api/spin BEGIN", e0);
              return res.status(500).json({ error: "DB hata (begin)" });
            }

            db.get("SELECT * FROM masalar WHERE masa=?", [masa], (errMasa, masaRow) => {
              if (errMasa) {
                logErr("/api/spin SELECT masalar", errMasa);
                return db.run("ROLLBACK", () => {
                  return res.status(500).json({ error: "DB hata (masa kontrol)" });
                });
              }

              const SURE = getSpinSureMs();

              if (!masaRow) {
                return db.run("ROLLBACK", () => {
                  return res.json({ error: "Çark sayfası açılmadı; süre başlamadı" });
                });
              }

              if (now < getSpinReadyAt(masaRow.start_time)) {
                return db.run("ROLLBACK", () => {
                  return res.json({ error: "Henüz hakkınız yok" });
                });
              }

              db.get(
                `SELECT COUNT(*) AS cnt
                 FROM spins
                 WHERE masa=?
                   AND time>=COALESCE(
                     (SELECT start_time FROM sessions
                      WHERE masa=? AND COALESCE(end_time,0)=0
                      LIMIT 1), 0)`,
                [masa, masa],
                (errCnt, rowCnt) => {
                  if (errCnt) {
                    logErr("/api/spin COUNT spins", errCnt);
                    return db.run("ROLLBACK", () => {
                      return res.status(500).json({ error: "DB hata (hak kontrol)" });
                    });
                  }

                  const usedThisSession = rowCnt && rowCnt.cnt ? rowCnt.cnt : 0;

                  if (usedThisSession >= GUNLUK_SPIN_LIMIT) {
                    return db.run("ROLLBACK", () => {
                      return res.json({ error: `Spin hakkınız bitti (${GUNLUK_SPIN_LIMIT})` });
                    });
                  }

                  db.all("SELECT * FROM rewards WHERE active=1", (errRewards, rewardRows) => {
                    if (errRewards) {
                      logErr("/api/spin SELECT rewards", errRewards);
                      return db.run("ROLLBACK", () => {
                        return res.status(500).json({ error: "DB hata (ödül liste)" });
                      });
                    }

                    if (!rewardRows || rewardRows.length === 0) {
                      return db.run("ROLLBACK", () => {
                        return res.json({ error: "Ödül yok" });
                      });
                    }

                    db.get(
                      "SELECT value FROM settings WHERE key='global_spin_count'",
                      (errGsc, gscRow) => {
                        if (errGsc) {
                          logErr("/api/spin SELECT global_spin_count", errGsc);
                          return db.run("ROLLBACK", () => {
                            return res.status(500).json({ error: "DB hata (global_spin_count read)" });
                          });
                        }

                        let dbGlobalSpinCount = 0;
                        if (gscRow) {
                          const parsed = parseInt(gscRow.value, 10);
                          dbGlobalSpinCount = !isNaN(parsed) && parsed >= 0 ? parsed : 0;
                        }

                        let selected = weightedRandom(rewardRows);

                        const isVipMasa = VIP_MASALAR.includes(masa);
                        const hedef = isVipMasa ? BUYUK_ODUL_HEDEF_VIP : BUYUK_ODUL_HEDEF;

                        let nextGlobalSpinCount = dbGlobalSpinCount;

                        if (nextGlobalSpinCount < hedef) {
                          if ((selected.name || "").toLowerCase().includes("60")) {
                            selected =
                              rewardRows.find(
                                (r) => !String(r.name || "").toLowerCase().includes("60")
                              ) || rewardRows[0];
                          }
                        } else {
                          nextGlobalSpinCount = 0;
                        }

nextGlobalSpinCount++;

latestRewardMap[masa] = selected.name;

db.run(
                          "INSERT INTO spins (masa,reward,time) VALUES (?,?,?)",
                          [masa, selected.name, Date.now()],
                          (e1) => {
                            if (e1) {
                              logErr("/api/spin INSERT spins", e1);
                              return db.run("ROLLBACK", () => {
                                return res.status(500).json({ error: "DB hata (spins)" });
                              });
                            }

                            db.run(
                              "INSERT INTO spins_log (masa,reward,time) VALUES (?,?,?)",
                              [masa, selected.name, Date.now()],
                              (e2) => {
                                if (e2) {
                                  logErr("/api/spin INSERT spins_log", e2);
                                  return db.run("ROLLBACK", () => {
                                    return res.status(500).json({ error: "DB hata (spins_log)" });
                                  });
                                }

                                db.run(
                                  "UPDATE masalar SET start_time=? WHERE masa=?",
                                  [Date.now(), masa],
                                  (e3) => {
                                    if (e3) {
                                      logErr("/api/spin UPDATE masalar", e3);
                                      return db.run("ROLLBACK", () => {
                                        return res.status(500).json({ error: "DB hata (masalar)" });
                                      });
                                    }

                                    db.run(
                                      "INSERT INTO settings(key,value) VALUES('global_spin_count',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                      [String(nextGlobalSpinCount)],
                                      (e4) => {
                                        if (e4) {
                                          logErr("/api/spin UPDATE global_spin_count", e4);
                                          return db.run("ROLLBACK", () => {
                                            return res.status(500).json({ error: "DB hata (global_spin_count write)" });
                                          });
                                        }

                                        db.run("COMMIT", (e5) => {
                                          if (e5) {
                                            logErr("/api/spin COMMIT", e5);
                                            return db.run("ROLLBACK", () => {
                                              return res.status(500).json({ error: "DB hata (commit)" });
                                            });
                                          }

                                          globalSpinCount = nextGlobalSpinCount;

                                          logInfo("SPIN_OK", {
                                            masa,
                                            reward: selected.name,
                                            time: Date.now(),
                                            nextGlobalSpinCount
                                          });
addLiveLog(
  "reward",
  `🎁 Masa ${masa} "${selected.name}" ödülünü kazandı`
);

                                          if (isBigReward(selected.name)) {
                                            sendBigRewardTelegram(masa, selected.name, Date.now());
                                          }

                                          return res.json({
                                            ok: true,
                                            reward: selected.name
                                          });
                                        });
                                      }
                                    );
                                  }
                                );
                              }
                            );
                          }
                        );
                      }
                    );
                  });
                }
              );
            });
          });
        });
      });
    });
  } catch (err) {
    logErr("/api/spin", err);
    return res.status(500).json({ error: "Spin genel hata" });
  }
});

app.get("/api/masalar", (req, res) => {
  setNoStore(res);

  const now = Date.now();

  const SURE = getSpinSureMs();

  db.all("SELECT * FROM masalar", (err, rows) => {
    if (err) {
      logErr("/api/masalar select masalar", err);
      return res.status(500).json([]);
    }

    const map = {};
    (rows || []).forEach((r) => (map[r.masa] = r));

    let done = 0;

    function stepDone() {
      done++;
      if (done !== MASA_SAYISI) return;

      const liste = [];

      for (let masa = 1; masa <= MASA_SAYISI; masa++) {
        const recentlyClosed = everyCafeRecentlyClosedMasalar.get(masa);
        // EveryCafe kapandığını kesin olarak bildirdikten sonra istemci kısa süre
        // "beklemede" pingleri gönderebilir. Bu pingleri yeni masa gibi göstermeyiz;
        // ancak EveryCafe gerçek bir yeni oturum gönderince aşağıdaki aktif senkron
        // bu kaydı siler.
        if (recentlyClosed) {
          liste.push({
            masa,
            online: false,
            durum: "kapali",
            kalan: 0,
            closedByEveryCafe: true,
            closedAt: Number(recentlyClosed.closedAt) || 0,
            freeClosed: recentlyClosed.free === true,
            everyCafeTimed: recentlyClosed.timed === true,
            closedTotal: Math.max(0, Number(recentlyClosed.total) || 0),
            closedComputerTotal: Math.max(0, Number(recentlyClosed.computerTotal) || 0),
            closedProductTotal: Math.max(0, Number(recentlyClosed.productTotal) || 0)
          });
          continue;
        }
        const everyCafeWaiting = everyCafeWaitingMasalar.get(masa);
        if (everyCafeWaiting) {
          liste.push({
            masa,
            online: true,
            durum: "everycafe_beklemede",
            waitingOnly: true,
            kalan: 0,
            netSpeed: 0,
            realFee: 0,
            everyCafeTimed: false,
            everyCafeGiftMinutes: 0
          });
          continue;
        }
        const lastSeen = aktifMasalar[masa] || 0;
        const online = !isActuallyOffline(masa, lastSeen, now);
        const everyCafeType = String(everyCafeSessionTypes.get(masa) || "");
        const everyCafeTimed = isEveryCafeTimedMasa(masa) || everyCafeType.toLocaleLowerCase("tr-TR").includes("süreli");
        const everyCafeGift = getEveryCafeGiftMinutes(masa);

        if (!online) {
          liste.push({
  masa,
  online: false,
  durum: "kapali",
  kalan: 0,
  netSpeed: Number(masaPingStats?.[masa]?.netSpeed || 0)
});
          continue;
        }

        const row = map[masa];
if (!row) {
  liste.push({
    masa,
    online: true,
    durum: "bagli",
    kalan: 0,
    netSpeed: Number(masaPingStats?.[masa]?.netSpeed || 0),
    everyCafeTimed,
    everyCafeGiftMinutes: everyCafeGift
  });
  continue;
}

        let kalan = getSpinReadyAt(row.start_time) - now;
        if (kalan < 0) kalan = 0;
const scheduledEnd = isEveryCafeTimedMasa(masa) ? getEveryCafeScheduledEnd(masa) : 0;
const realFee = isFreeMasa(masa) ? 0 : feeAtTime(
  masa,
  row.start_time,
  // Süreli EveryCafe oturumunda tam bitiş saniyesi ilk ek ücret basamağı
  // değildir. Örn. 60 dk normal=50 ₺, VIP=70 ₺ olarak kalır.
  scheduledEnd > Number(row.start_time) ? Math.min(now, scheduledEnd - 1) : now
);
if (kalan === 0)
  liste.push({
    masa,
    online: true,
    durum: "hazir",
    kalan: 0,
    netSpeed: masaPingStats[masa]?.netSpeed || 0,
    realFee,
    everyCafeTimed,
    everyCafeScheduledEnd: scheduledEnd,
    everyCafeGiftMinutes: everyCafeGift
  });

else liste.push({
  masa,
  online: true,
  durum: "bekliyor",
  kalan,
  netSpeed: masaPingStats[masa]?.netSpeed || 0,
  realFee,
  everyCafeTimed,
  everyCafeScheduledEnd: scheduledEnd,
  everyCafeGiftMinutes: everyCafeGift
});
      }

      res.json(liste);
    }

    for (let masa = 1; masa <= MASA_SAYISI; masa++) {
      closeSessionIfOffline(masa, now, () => {
        autoResetIfStale(masa, now, stepDone);
      });
    }
  });
});

app.get("/monitor/last", (req, res) => {
  setNoStore(res);
  const todayStart = dayStartTs(Date.now());
  db.get("SELECT * FROM spins_log WHERE time>=? ORDER BY id DESC LIMIT 1", [todayStart], (err, row) => {
    if (err) {
      logErr("/monitor/last", err);
      return res.json({});
    }
    res.json(row || {});
  });
});

app.get("/monitor/lucky", (req, res) => {
  setNoStore(res);
  const todayStart = dayStartTs(Date.now());

db.all(
  `
  SELECT masa, reward
  FROM spins_log
  WHERE time >= ?
  `,
  [todayStart],
    (err, rows) => {
      if (err) {
        logErr("/monitor/lucky", err);
        return res.json({ masa: "-", adet: 0 });
      }

      const filtered = (rows || []).filter((r) => {
        const reward = String(r.reward || "").trim().toLocaleLowerCase("tr-TR");
        return !BOS_ODULLER.includes(reward);
      });

      if (!filtered.length) {
        return res.json({ masa: "-", adet: 0 });
      }

      const count = {};
      filtered.forEach((r) => {
        count[r.masa] = (count[r.masa] || 0) + 1;
      });

      const masa = Object.keys(count).sort((a, b) => {
        if (count[b] !== count[a]) return count[b] - count[a];
        return Number(a) - Number(b);
      })[0];

      return res.json({ masa, adet: count[masa] || 0 });
    }
  );
});

app.get("/monitor/list", (req, res) => {
  setNoStore(res);
  const todayStart = dayStartTs(Date.now());
  db.all("SELECT * FROM spins_log WHERE time>=? ORDER BY id DESC LIMIT 200", [todayStart], (err, rows) => {
    if (err) {
      logErr("/monitor/list", err);
      return res.json([]);
    }
    res.json(rows || []);
  });
});

app.get("/admin/list", (req, res) => {
  setNoStore(res);

  const todayStart = dayStartTs(Date.now());

  db.all(
    "SELECT * FROM spins WHERE time>=? ORDER BY id DESC LIMIT 200",
    [todayStart],
    (err, rows) => {

      if (err) {
        logErr("/admin/list", err);
        return res.json([]);
      }

      res.json(rows || []);
    }
  );
});
function approveRewardById(id, options, cb) {
  const opts = options || {};
  const spinId = parseInt(id, 10);

  if (!spinId) {
    return cb(new Error("Geçersiz id"));
  }

  db.get("SELECT * FROM spins WHERE id=?", [spinId], (selectErr, row) => {
    if (selectErr) {
      logErr("approveRewardById select spins", selectErr);
      return cb(selectErr);
    }

    if (!row) {
      return cb(new Error("Ödül kaydı bulunamadı"));
    }

    if (row.used === 1) {
      return cb(null, { ok: true, alreadyUsed: true, row });
    }

    const rewardInfo = getRewardCostAndType(
      row.masa,
      row.reward,
      row.time || Date.now()
    );
    const now = Math.max(1, Number(opts.approvalTime) || Date.now());
    const dk = dayKey(now);

    db.serialize(() => {
      db.run("BEGIN IMMEDIATE TRANSACTION", (beginErr) => {
        if (beginErr) {
          logErr("approveRewardById begin", beginErr);
          return cb(new Error("DB hata (begin): " + String(beginErr)));
        }

        db.run(
          "UPDATE spins SET used=1 WHERE id=? AND used=0",
          [spinId],
          function (spinErr) {
            if (spinErr) {
              logErr("approveRewardById update spins", spinErr);
              return db.run("ROLLBACK", () => {
                cb(new Error("DB hata (spins): " + String(spinErr)));
              });
            }

            if ((this.changes || 0) === 0) {
              return db.run("ROLLBACK", () => {
                cb(null, { ok: true, alreadyUsed: true, row });
              });
            }

            db.run(
              `
              UPDATE spins_log
              SET used=1
              WHERE id = (
                SELECT id
                FROM spins_log
                WHERE masa=?
                  AND reward=?
                  AND used=0
                ORDER BY id DESC
                LIMIT 1
              )
              `,
              [row.masa, row.reward],
              (logErrValue) => {
                if (logErrValue) {
                  logErr("approveRewardById update spins_log", logErrValue);
                  return db.run("ROLLBACK", () => {
                    cb(new Error("DB hata (spins_log): " + String(logErrValue)));
                  });
                }

                const note =
                  rewardInfo.kind === "time"
                    ? `Masa ${row.masa} süre ödülü kullanıldı: ${row.reward}`
                    : `Masa ${row.masa} ürün ödülü onaylandı: ${row.reward}`;

                const commitApproval = () => {
                  db.run("COMMIT", (commitErr) => {
                    if (commitErr) {
                      logErr("approveRewardById commit", commitErr);
                      return db.run("ROLLBACK", () => {
                        cb(new Error("DB hata (commit): " + String(commitErr)));
                      });
                    }

                    if (rewardInfo.amount > 0) {
                      latestRewardMap[row.masa] =
                        rewardInfo.amount + " ₺ " + note;
                    }

                    const logText = opts.automatic
                      ? `🤖 Masa ${row.masa} "${row.reward}" ödülü ${opts.reason || "masa kapanışı"} sırasında otomatik onaylandı`
                      : `✅ Masa ${row.masa} "${row.reward}" ödülü onaylandı`;

                    addLiveLog(
                      opts.automatic ? "reward_auto_used" : "reward_used",
                      logText
                    );

                    return cb(null, {
                      ok: true,
                      reward: row.reward,
                      kind: rewardInfo.kind,
                      costApplied: rewardInfo.amount,
                      row
                    });
                  });
                };

                if (rewardInfo.amount <= 0) {
                  return commitApproval();
                }

                const adjustmentKind =
                  rewardInfo.kind === "time"
                    ? "SPIN_TIME_COST"
                    : "SPIN_ITEM_COST";

                db.run(
                  "INSERT INTO real_adjustments(time, day_key, masa, amount, kind, note, session_start) VALUES(?,?,?,?,?,?,?)",
                  [
                    now,
                    dk,
                    row.masa,
                    -rewardInfo.amount,
                    adjustmentKind,
                    note,
                    0
                  ],
                  (adjustmentErr) => {
                    if (adjustmentErr) {
                      logErr(
                        "approveRewardById insert real_adjustments",
                        adjustmentErr
                      );
                      return db.run("ROLLBACK", () => {
                        cb(
                          new Error(
                            "DB hata (real_adjustments): " +
                              String(adjustmentErr)
                          )
                        );
                      });
                    }

                    return commitApproval();
                  }
                );
              }
            );
          }
        );
      });
    });
  });
}

function autoApprovePendingRewardsForMasa(masa, reason, cb) {
  const todayStart = dayStartTs(Date.now());

  db.all(
    `
    SELECT id
    FROM spins
    WHERE masa=?
      AND used=0
      AND time>=?
    ORDER BY id ASC
    `,
    [masa, todayStart],
    (listErr, rows) => {
      if (listErr) {
        logErr("autoApprovePendingRewardsForMasa list", listErr);
        return cb(listErr);
      }

      const pending = rows || [];
      const approved = [];

      const approveNext = (index) => {
        if (index >= pending.length) {
          return cb(null, approved);
        }

        approveRewardById(
          pending[index].id,
          { automatic: true, reason },
          (approveErr, result) => {
            if (approveErr) return cb(approveErr);
            if (result && !result.alreadyUsed) approved.push(result);
            return approveNext(index + 1);
          }
        );
      };

      return approveNext(0);
    }
  );
}

// EveryCafe kapanışı doğrulandıysa o oturuma ait bekleyen çark ödülleri de
// kapanışın parçası olarak onaylanır. Ödül maliyeti kapanış zamanına yazılır.
function autoApproveEveryCafeClosedSessionRewards(masa, startTime, endTime, cb = () => {}) {
  db.all(
    `SELECT id FROM spins
     WHERE masa=? AND used=0 AND time>=? AND time<=?
     ORDER BY id ASC`,
    [masa, startTime, endTime],
    (err, rows) => {
      if (err) return cb(err);
      const ids = (rows || []).map((row) => Number(row.id)).filter(Boolean);
      const next = (index) => {
        if (index >= ids.length) return cb(null, { approved: ids.length });
        approveRewardById(
          ids[index],
          { automatic: true, reason: "EveryCafe kapanışı", approvalTime: endTime },
          (approveErr) => approveErr ? cb(approveErr) : next(index + 1)
        );
      };
      next(0);
    }
  );
}

// Önceki sürümde kapanmış EveryCafe oturumlarında kalmış bekleyen ödülleri de
// güvenli biçimde bir kez tamamlar. Başka kapanış türlerine hiç dokunmaz.
function reconcileEveryCafeClosedRewardApprovals(cb = () => {}) {
  db.all(
    `SELECT DISTINCT h.masa,h.start_time,h.end_time
     FROM session_history h
     JOIN spins s ON s.masa=h.masa AND s.time>=h.start_time AND s.time<=h.end_time
     WHERE h.close_reason='EVERYCAFE' AND s.used=0
     ORDER BY h.end_time ASC LIMIT 100`,
    (err, rows) => {
      if (err) return cb(err);
      let approved = 0;
      const next = (index) => {
        if (index >= (rows || []).length) return cb(null, { approved });
        const row = rows[index];
        autoApproveEveryCafeClosedSessionRewards(row.masa, row.start_time, row.end_time, (approveErr, result) => {
          if (approveErr) return cb(approveErr);
          approved += Number(result && result.approved) || 0;
          next(index + 1);
        });
      };
      next(0);
    }
  );
}

app.post("/admin/use", (req, res) => {
  setNoStore(res);

  const id = parseInt((req.body || {}).id, 10);

  approveRewardById(id, { automatic: false }, (err, result) => {
    if (err) {
      return res.json({ ok: false, error: String(err.message || err) });
    }

    return res.json(result);
  });
});

app.post("/admin/fee-adjust", (req, res) => {
  setNoStore(res);

  const masa = parseInt((req.body || {}).masa, 10);
  const amount = parseFloat((req.body || {}).amount);
  const now = Date.now();

  if (!masa || masa < 1 || masa > MASA_SAYISI) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

if (!Number.isFinite(amount)) {
  return res.json({ ok: false, error: "Geçersiz sayı" });
}

  if (isFreeMasa(masa)) {
    return res.json({ ok: false, error: "FREE masaya düzeltme uygulanmaz" });
  }

  const dk = dayKey(now);

  db.get("SELECT * FROM sessions WHERE masa=?", [masa], (err, s) => {
    if (err) return res.json({ ok: false, error: String(err) });
    if (!s) return res.json({ ok: false, error: "Aktif/geçerli session bulunamadı" });

    const note = `Masa ${masa} manuel ücret düzeltme ${amount > 0 ? "+" : ""}${amount} TL`;

db.run(
  "INSERT INTO real_adjustments(time, day_key, masa, amount, kind, note, session_start) VALUES(?,?,?,?,?,?,?)",
  [now, dk, masa, amount, "MANUAL_FEE_ADJUST", note, s.start_time || 0],
function (e2) {

  if (e2) {
    return res.json({ ok: false, error: String(e2) });
  }

  addLiveLog(
    "fee_adjust",
    `💰 Masa ${masa} manuel ücret düzeltildi (${amount > 0 ? "+" : ""}${amount} TL)`
  );

  return res.json({ ok: true });

}
    );

  }
);
  });


app.get("/admin/rewards", (req, res) => {
  setNoStore(res);
  db.all("SELECT * FROM rewards ORDER BY id ASC", (err, rows) => {
    if (err) {
      logErr("/admin/rewards", err);
      return res.json([]);
    }
    res.json(rows || []);
  });
});

app.post("/admin/reward/add", (req, res) => {
  setNoStore(res);

  const name = String((req.body || {}).name || "").trim();
  const weight = parseInt((req.body || {}).weight, 10);
  const active = (req.body || {}).active === 0 || (req.body || {}).active === false ? 0 : 1;

  if (!name) return res.json({ ok: false, error: "Ödül adı boş" });
  if (isNaN(weight) || weight < 1 || weight > 100000) return res.json({ ok: false, error: "Geçersiz ağırlık" });

  db.run("INSERT INTO rewards (name, weight, active) VALUES (?,?,?)", [name, weight, active], function (err) {
    if (err) return res.json({ ok: false, error: String(err) });
    return res.json({ ok: true, id: this.lastID });
  });
});

app.post("/admin/reward/delete", (req, res) => {
  setNoStore(res);

  const id = parseInt((req.body || {}).id, 10);
  if (!id) return res.json({ ok: false, error: "Geçersiz id" });

  db.run("DELETE FROM rewards WHERE id=?", [id], (err) => {
    if (err) return res.json({ ok: false, error: String(err) });
    return res.json({ ok: true });
  });
});

app.post("/admin/reward/update", (req, res) => {
  setNoStore(res);

  const id = parseInt((req.body || {}).id, 10);
  const name = String((req.body || {}).name || "").trim();
  const weight = parseInt((req.body || {}).weight, 10);
  const active = (req.body || {}).active === 0 || (req.body || {}).active === false ? 0 : 1;

  if (!id) return res.json({ ok: false, error: "Geçersiz id" });
  if (!name) return res.json({ ok: false, error: "Ödül adı boş" });
  if (isNaN(weight) || weight < 1 || weight > 100000) return res.json({ ok: false, error: "Geçersiz ağırlık" });

  db.run("UPDATE rewards SET name=?, weight=?, active=? WHERE id=?", [name, weight, active, id], (err) => {
    if (err) return res.json({ ok: false, error: String(err) });
    return res.json({ ok: true });
  });
});

app.get("/admin/today-spins", (req, res) => {
  setNoStore(res);
  const todayStart = dayStartTs(Date.now());

  // Hak aktif müşteri oturumunundur. Eski müşterinin spinleri günlük
  // istatistikte korunur; yeni oturum kendi 0/5 hakkıyla başlar.
  db.all(
    `SELECT s.masa, s.start_time, COUNT(sp.id) AS cnt
     FROM sessions s
     LEFT JOIN spins sp ON sp.masa=s.masa AND sp.time>=s.start_time
     WHERE COALESCE(s.end_time,0)=0
     GROUP BY s.masa,s.start_time`,
    [],
    (err, rows) => {
    if (err) {
      logErr("/admin/today-spins", err);
      return res.json({ start: todayStart, limit: GUNLUK_SPIN_LIMIT, list: [] });
    }

    const map = {};
    (rows || []).forEach((r) => {
      map[r.masa] = r.cnt;
    });

    const out = [];
    // Kapalı masalar listelenmez. Yeni müşteri açıldığında aktif session
    // oluşur ve önceki müşterinin haklarından bağımsız 5 hak gelir.
    for (const row of rows || []) {
      const masa = Number(row.masa);
      const used = map[masa] || 0;
      out.push({
        masa,
        used,
        limit: GUNLUK_SPIN_LIMIT,
        left: Math.max(GUNLUK_SPIN_LIMIT - used, 0),
        isVip: VIP_MASALAR.includes(masa) ? 1 : 0
      });
    }

    res.json({ start: todayStart, limit: GUNLUK_SPIN_LIMIT, list: out });
  });
});

app.get("/admin/today-given-rewards", (req, res) => {
  setNoStore(res);

  const todayStart = dayStartTs(Date.now());

  db.all(
    `
    SELECT reward, COUNT(*) as adet
    FROM spins_log
    WHERE time >= ?
      AND used = 1
    GROUP BY reward
    ORDER BY adet DESC, reward ASC
    `,
    [todayStart],
    (err, rows) => {
      if (err) return res.json({ ok: false, error: String(err), list: [] });

      const list = (rows || []).filter((x) => {
        const r = String(x.reward || "").trim().toLocaleLowerCase("tr-TR");
        return !BOS_ODULLER.includes(r);
      });

      return res.json({ ok: true, start: todayStart, list });
    }
  );
});

app.get("/admin/today-empty-rewards", (req, res) => {
  setNoStore(res);

  const todayStart = dayStartTs(Date.now());

  db.all(
    `
    SELECT reward, COUNT(*) as adet
    FROM spins_log
    WHERE time >= ?
    GROUP BY reward
    ORDER BY adet DESC, reward ASC
    `,
    [todayStart],
    (err, rows) => {
      if (err) return res.json({ ok: false, error: String(err), list: [] });

      const list = (rows || []).filter((x) => {
        const r = String(x.reward || "").trim().toLocaleLowerCase("tr-TR");
        return BOS_ODULLER.includes(r);
      });

      return res.json({ ok: true, start: todayStart, list });
    }
  );
});

const PRODUCT_CATEGORIES = [
  "Sıcak İçecekler",
  "Soğuk İçecekler",
  "Atıştırmalıklar",
  "Teknik Servis"
];

// Türkçe kategori adlarının geçmişte yanlış karakter kodlamasıyla oluşmuş
// kopyalarını tek bir doğru ada indirger. Bu eşleme yalnız bilinen KafePin
// ürün kategorilerine uygulanır; kullanıcı ürün adlarına dokunulmaz.
const PRODUCT_CATEGORY_ALIASES = new Map([
  ["SÄ±cak Ä°Ã§ecekler", "Sıcak İçecekler"],
  ["SoÄŸuk Ä°Ã§ecekler", "Soğuk İçecekler"],
  ["AtÄ±ÅŸtÄ±rmalÄ±klar", "Atıştırmalıklar"]
]);

// Windows-1252 olarak yanlış yorumlanmış UTF-8 metni güvenli biçimde geri çevirir.
// Sadece tipik mojibake işaretleri varsa çalışır; normal Türkçe metne dokunmaz.
const CP1252_REVERSE = new Map([
  ["€",0x80],["‚",0x82],["ƒ",0x83],["„",0x84],["…",0x85],["†",0x86],
  ["‡",0x87],["ˆ",0x88],["‰",0x89],["Š",0x8A],["‹",0x8B],["Œ",0x8C],
  ["Ž",0x8E],["‘",0x91],["’",0x92],["“",0x93],["”",0x94],["•",0x95],
  ["–",0x96],["—",0x97],["˜",0x98],["™",0x99],["š",0x9A],["›",0x9B],
  ["œ",0x9C],["ž",0x9E],["Ÿ",0x9F]
]);

function decodeCp1252MojibakeOnce(value) {
  const text = String(value || "");
  const bytes = [];

  for (const ch of text) {
    if (CP1252_REVERSE.has(ch)) {
      bytes.push(CP1252_REVERSE.get(ch));
      continue;
    }

    const code = ch.codePointAt(0);
    if (code >= 0 && code <= 255) {
      bytes.push(code);
      continue;
    }

    return null;
  }

  const decoded = Buffer.from(bytes).toString("utf8");
  if (!decoded || decoded.includes("\uFFFD")) return null;
  return decoded;
}

function normalizeTurkishText(value) {
  let current = String(value || "").trim();

  // Ã, Ä, Å, Â dizileri UTF-8/Windows-1252 bozulmasının tipik izleridir.
  for (let pass = 0; pass < 3; pass++) {
    if (!/[ÃÄÅÂ]/.test(current)) break;
    const decoded = decodeCp1252MojibakeOnce(current);
    if (!decoded || decoded === current) break;
    current = decoded;
  }

  return current;
}

function normalizeProductName(value) {
  return normalizeTurkishText(value).slice(0, 80);
}

function normalizeProductCategory(value) {
  const raw = normalizeTurkishText(value).slice(0, 50);
  return PRODUCT_CATEGORY_ALIASES.get(raw) || raw;
}

function getMergedCatalogValues(good, bad) {
  const rows = [good, bad];
  const positivePriceRows = rows
    .filter((r) => (Number(r.price) || 0) > 0)
    .sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0));

  const latest = rows
    .slice()
    .sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0))[0] || good;

  const priceSource = positivePriceRows[0] || latest;

  return {
    price: Number(priceSource.price) || 0,
    active: Number(latest.active) === 0 ? 0 : 1,
    sortOrder: Number(latest.sort_order) || Number(good.sort_order) || Number(bad.sort_order) || 0,
    createdAt: Math.min(
      Number(good.created_at) || Date.now(),
      Number(bad.created_at) || Date.now()
    ),
    updatedAt: Math.max(
      Number(good.updated_at) || 0,
      Number(bad.updated_at) || 0,
      Date.now()
    )
  };
}

function cleanupBrokenProductCatalog() {
  let catalogFixCount = 0;
  db.all(
    `SELECT id,name,category,price,active,sort_order,created_at,updated_at
     FROM product_catalog ORDER BY id`,
    (err, rows) => {
      if (err) {
        logErr("product mojibake repair select catalog", err);
        return;
      }

      const list = rows || [];
      const repairRow = (index) => {
        if (index >= list.length) {
          return cleanupBrokenProductSalesText((salesFixCount = 0) => {
            const totalFixCount = catalogFixCount + Number(salesFixCount || 0);
            if (totalFixCount > 0) {
              addLiveLog("system", `✅ Türkçe ürün kayıtları düzeltildi • ${totalFixCount} kayıt`);
            }
          });
        }

        const bad = list[index];
        const fixedName = normalizeProductName(bad.name);
        const fixedCategory = normalizeProductCategory(bad.category);

        if (fixedName === bad.name && fixedCategory === bad.category) {
          return repairRow(index + 1);
        }

        db.get(
          `SELECT id,name,category,price,active,sort_order,created_at,updated_at
           FROM product_catalog
           WHERE name=? AND category=? AND id<>?
           ORDER BY updated_at DESC,id ASC LIMIT 1`,
          [fixedName, fixedCategory, bad.id],
          (findErr, good) => {
            if (findErr) {
              logErr("product mojibake repair find duplicate", findErr);
              return repairRow(index + 1);
            }

            // Doğru karşılığı yoksa aynı kaydı yerinde düzelt; fiyat/id korunur.
            if (!good) {
              return db.run(
                `UPDATE product_catalog
                 SET name=?,category=?,updated_at=?
                 WHERE id=?`,
                [fixedName, fixedCategory, Math.max(Number(bad.updated_at)||0, Date.now()), bad.id],
                (updateErr) => {
                  if (updateErr) {
                    logErr("product mojibake repair rename catalog", updateErr);
                    return repairRow(index + 1);
                  }

                  catalogFixCount++;
                  db.run(
                    `UPDATE product_sales
                     SET product_name=?,category=?
                     WHERE product_id=?`,
                    [fixedName, fixedCategory, bad.id],
                    (salesErr) => {
                      if (salesErr) logErr("product mojibake repair sales rename", salesErr);
                      repairRow(index + 1);
                    }
                  );
                }
              );
            }

            // Doğru ve bozuk iki kayıt varsa tek kayda birleştir.
            const merged = getMergedCatalogValues(good, bad);
            db.run(
              `UPDATE product_catalog
               SET price=?,active=?,sort_order=?,created_at=?,updated_at=?
               WHERE id=?`,
              [
                merged.price,
                merged.active,
                merged.sortOrder,
                merged.createdAt,
                merged.updatedAt,
                good.id
              ],
              (mergeErr) => {
                if (mergeErr) {
                  logErr("product mojibake repair merge catalog", mergeErr);
                  return repairRow(index + 1);
                }

                // Eski satış kayıtlarını doğru ürün ID/ad/kategorisine bağla.
                db.run(
                  `UPDATE product_sales
                   SET product_id=?,product_name=?,category=?
                   WHERE product_id=?`,
                  [good.id, fixedName, fixedCategory, bad.id],
                  (salesErr) => {
                    if (salesErr) logErr("product mojibake repair sales relink", salesErr);

                    db.run(
                      "DELETE FROM product_catalog WHERE id=?",
                      [bad.id],
                      (deleteErr) => {
                        if (deleteErr) logErr("product mojibake repair delete duplicate", deleteErr);
                        else catalogFixCount++;
                        repairRow(index + 1);
                      }
                    );
                  }
                );
              }
            );
          }
        );
      };

      repairRow(0);
    }
  );
}

function cleanupBrokenProductSalesText(done) {
  db.all(
    `SELECT id,product_name,category FROM product_sales ORDER BY id`,
    (err, rows) => {
      if (err) {
        logErr("product mojibake repair select sales", err);
        return done && done(0);
      }

      const list = rows || [];
      let fixedCount = 0;
      const repairSale = (index) => {
        if (index >= list.length) return done && done(fixedCount);
        const sale = list[index];
        const fixedName = normalizeProductName(sale.product_name);
        const fixedCategory = normalizeProductCategory(sale.category);

        if (fixedName === sale.product_name && fixedCategory === sale.category) {
          return repairSale(index + 1);
        }

        db.run(
          "UPDATE product_sales SET product_name=?,category=? WHERE id=?",
          [fixedName, fixedCategory, sale.id],
          (updateErr) => {
            if (updateErr) logErr("product mojibake repair sale text", updateErr);
            else fixedCount++;
            repairSale(index + 1);
          }
        );
      };

      repairSale(0);
    }
  );
}

function normalizeAndDedupeProductRows(rows) {
  const chosen = new Map();

  (rows || []).forEach((source) => {
    const row = {
      ...source,
      name: normalizeProductName(source.name),
      category: normalizeProductCategory(source.category)
    };
    const key = `${row.name}\u0000${row.category}`;
    const previous = chosen.get(key);

    if (!previous) {
      chosen.set(key, row);
      return;
    }

    const rowPrice = Number(row.price) || 0;
    const prevPrice = Number(previous.price) || 0;
    const rowUpdated = Number(row.updated_at) || 0;
    const prevUpdated = Number(previous.updated_at) || 0;

    if (
      (rowPrice > 0 && prevPrice <= 0) ||
      (rowPrice > 0 && prevPrice > 0 && rowUpdated > prevUpdated) ||
      (rowPrice === prevPrice && rowUpdated > prevUpdated)
    ) {
      chosen.set(key, row);
    }
  });

  return Array.from(chosen.values());
}

// Sunucu tamamen ayağa kalktıktan sonra çalışır; açılışı bloke etmez.
setTimeout(() => {
  try {
    cleanupBrokenProductCatalog();
  } catch (err) {
    logErr("product mojibake repair startup", err);
  }
}, 2500);

app.get("/admin/products", (req, res) => {
  setNoStore(res);
  const showAll = String(req.query.all || "") === "1";
  db.all(
    `SELECT id,name,category,price,active,sort_order,created_at,updated_at,
            COALESCE(external_source,'') AS external_source,
            COALESCE(external_id,'') AS external_id
     FROM product_catalog
     ${showAll ? "" : "WHERE active=1"}
     ORDER BY price ASC, name COLLATE NOCASE ASC, id ASC`,
    (err, rows) => {
      if (err) return res.json({ ok: false, error: String(err) });
      const list = normalizeAndDedupeProductRows(rows || []).sort((a, b) => {
        const priceDiff = (Number(a.price) || 0) - (Number(b.price) || 0);
        if (Math.abs(priceDiff) > 0.000001) return priceDiff;
        return String(a.name || "").localeCompare(String(b.name || ""), "tr");
      });
      const categories = Array.from(new Set([
        ...PRODUCT_CATEGORIES,
        ...list.map((row) => String(row.category || "").trim()).filter(Boolean)
      ]));
      res.json({
        ok: true,
        categories,
        list: list.map((row) => ({
          ...row,
          managedByEveryCafe: String(row.external_source || "") === "EVERYCAFE_CATALOG"
        }))
      });
    }
  );
});

app.post("/admin/products/save", (req, res) => {
  setNoStore(res);
  const body = req.body || {};
  const id = parseInt(body.id, 10) || 0;
  const name = normalizeProductName(String(body.name || "").trim().slice(0, 80));
  const category = normalizeProductCategory(String(body.category || "").trim().slice(0, 50));
  const price = Number(body.price);
  const active = body.active === false || Number(body.active) === 0 ? 0 : 1;
  const sortOrder = parseInt(body.sortOrder, 10) || 0;
  const now = Date.now();

  if (!name) return res.json({ ok: false, error: "Ürün adı gerekli" });
  if (!category) return res.json({ ok: false, error: "Kategori gerekli" });
  if (!Number.isFinite(price) || price < 0) {
    return res.json({ ok: false, error: "Geçerli bir fiyat gir" });
  }

  // EveryCafe katalogu bir kez manuel senkronlandıktan sonra KafePin katalog
  // editörü yeni/ayrı kart üretemez. Ürün/fiyat/kategori EveryCafe'de değiştirilir
  // ve kullanıcı yeniden "Şimdi Senkronla" der. EveryCafe olmayan kafelerde
  // (last_success=0) eski manuel katalog özelliği kullanılabilir.
  db.get(
    `SELECT COALESCE(last_success,0) AS last_success
     FROM everycafe_catalog_sync_state WHERE id=1`,
    (modeErr, modeRow) => {
      if (modeErr) return res.json({ ok: false, error: String(modeErr) });
      if (Number(modeRow && modeRow.last_success) > 0) {
        return res.json({
          ok: false,
          code: "EVERYCAFE_CATALOG_MANAGED",
          error: "Bu katalog EveryCafe tarafından yönetiliyor. Ürünü/fiyatı EveryCafe'de değiştirip EveryCafe Senkron > Şimdi Senkronla kullan."
        });
      }

      if (id > 0) {
        return db.get(
          `SELECT COALESCE(external_source,'') AS external_source FROM product_catalog WHERE id=?`,
          [id],
          (sourceErr, sourceRow) => {
            if (sourceErr) return res.json({ ok: false, error: String(sourceErr) });
            if (!sourceRow) return res.json({ ok: false, error: "Ürün bulunamadı" });
            if (String(sourceRow.external_source || "") === "EVERYCAFE_CATALOG") {
              return res.json({
                ok: false,
                code: "EVERYCAFE_MANAGED_PRODUCT",
                error: "Bu ürün EveryCafe tarafından yönetiliyor. Ad, kategori ve fiyat değişikliğini EveryCafe'den yapın."
              });
            }
            db.run(
              `UPDATE product_catalog
               SET name=?,category=?,price=?,active=?,sort_order=?,updated_at=?
               WHERE id=?`,
              [name, category, price, active, sortOrder, now, id],
              function (err) {
                if (err) return res.json({ ok: false, error: String(err) });
                if (!this.changes) return res.json({ ok: false, error: "Ürün bulunamadı" });
                addLiveLog("product_update", `🧾 Ürün güncellendi • ${name} • ${price.toFixed(2)} ₺`);
                res.json({ ok: true, id });
              }
            );
          }
        );
      }

      db.run(
        `INSERT INTO product_catalog
         (name,category,price,active,sort_order,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
        [name, category, price, active, sortOrder, now, now],
        function (err) {
          if (err) return res.json({ ok: false, error: String(err) });
          addLiveLog("product_add", `➕ Ürün eklendi • ${name} • ${price.toFixed(2)} ₺`);
          res.json({ ok: true, id: this.lastID });
        }
      );
    }
  );
});

app.post("/admin/products/delete", (req, res) => {
  setNoStore(res);
  const id = parseInt((req.body || {}).id, 10) || 0;
  if (!id) return res.json({ ok: false, error: "Geçersiz ürün" });

  db.get(
    `SELECT name,COALESCE(external_source,'') AS external_source FROM product_catalog WHERE id=?`,
    [id],
    (selectErr, product) => {
      if (selectErr) return res.json({ ok: false, error: String(selectErr) });
      if (!product) return res.json({ ok: false, error: "Ürün bulunamadı" });
      if (String(product.external_source || "") === "EVERYCAFE_CATALOG") {
        return res.json({
          ok: false,
          code: "EVERYCAFE_MANAGED_PRODUCT",
          error: "Bu ürün EveryCafe tarafından yönetiliyor. Silme/pasif işlemini EveryCafe'den yapın."
        });
      }

      db.run("DELETE FROM product_catalog WHERE id=?", [id], (err) => {
        if (err) return res.json({ ok: false, error: String(err) });
        addLiveLog("product_delete", `🗑️ Ürün silindi • ${product.name}`);
        res.json({ ok: true });
      });
    }
  );
});

app.post("/admin/product-sales/add", (req, res) => {
  setNoStore(res);
  const body = req.body || {};
  const productId = parseInt(body.productId, 10) || 0;
  const quantity = Math.max(1, Math.min(parseInt(body.quantity, 10) || 1, 99));
  const direct = !!body.direct;
  const masa = direct ? 0 : (parseInt(body.masa, 10) || 0);
  const directPaymentMethod = normalizePaymentMethod(body.paymentMethod, "PENDING");
  const note = String(body.note || "").trim().slice(0, 160);

  if (!productId) return res.json({ ok: false, error: "Ürün seç" });
  if (!direct && (masa < 1 || masa > MASA_SAYISI)) {
    return res.json({ ok: false, error: "Masa 1-23 arasında olmalı" });
  }
  if (direct && !["CASH", "CARD"].includes(directPaymentMethod)) {
    return res.json({ ok: false, error: "Doğrudan satış için Nakit veya Kart seç" });
  }

  db.get(
    "SELECT * FROM product_catalog WHERE id=? AND active=1",
    [productId],
    (productErr, product) => {
      if (productErr) return res.json({ ok: false, error: String(productErr) });
      if (!product) return res.json({ ok: false, error: "Aktif ürün bulunamadı" });

      const unitPrice = Number(product.price) || 0;
      if (unitPrice <= 0) {
        return res.json({ ok: false, error: `${product.name} için önce fiyat gir` });
      }

      const saveSale = (sessionStart) => {
        const now = Date.now();
        const total = unitPrice * quantity;
        db.run(
          `INSERT INTO product_sales
           (time,masa,session_start,product_id,product_name,category,unit_price,
            quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)`,
          [
            now, masa, Number(sessionStart) || 0, product.id, normalizeProductName(product.name),
            normalizeProductCategory(product.category), unitPrice, quantity, total,
            direct ? "DIRECT" : "TABLE", note,
            direct ? "FINALIZED" : "OPEN", direct ? now : 0,
            direct ? directPaymentMethod : "PENDING"
          ],
          function (insertErr) {
            if (insertErr) return res.json({ ok: false, error: String(insertErr) });
            const saleId = this.lastID;

            const finishSale = () => {
            addLiveLog(
              "product_sale",
              `${direct ? "🧾 Doğrudan" : `☕ Masa ${masa}`} • ${quantity}x ${product.name} • ${total.toFixed(2)} ₺`
            );
            res.json({ ok: true, id: saleId, total });
            };

            if (!direct) return finishSale();
            db.run(
              `INSERT INTO payments
               (created_at,paid_at,masa,session_start,session_end,product_sale_id,
                computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at)
               VALUES (?,?,0,0,?,?,0,?,?,?,'DIRECT_PRODUCT','DIRECT_SALE','',0,0)`,
              [now, now, now, saleId, total, total, directPaymentMethod],
              (paymentErr) => {
                if (paymentErr) {
                  db.run("UPDATE product_sales SET voided=1,voided_at=? WHERE id=?", [Date.now(), saleId]);
                  return res.json({ ok: false, error: String(paymentErr) });
                }
                finishSale();
              }
            );
          }
        );
      };

      if (direct) return saveSale(0);

      db.get(
        "SELECT start_time FROM sessions WHERE masa=? AND (end_time=0 OR end_time IS NULL)",
        [masa],
        (sessionErr, sessionRow) => {
          if (sessionErr) return res.json({ ok: false, error: String(sessionErr) });
          const online = !isActuallyOffline(masa, aktifMasalar[masa] || 0, Date.now());
          if (!sessionRow && !isFreeMasa(masa) && !online) {
            return res.json({ ok: false, error: `Masa ${masa} aktif değil` });
          }
          saveSale(sessionRow ? sessionRow.start_time : (aktifMasalar[masa] || Date.now()));
        }
      );
    }
  );
});

app.post("/admin/product-sales/add-custom-direct", (req, res) => {
  setNoStore(res);
  const body = req.body || {};
  const name = String(body.name || "").trim().slice(0, 100);
  const unitPrice = Number(body.unitPrice);
  const quantity = Math.max(1, Math.min(parseInt(body.quantity, 10) || 1, 99));
  const paymentMethod = normalizePaymentMethod(body.paymentMethod, "PENDING");

  if (!name) return res.json({ ok: false, error: "Ürün/hizmet adı gir" });
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return res.json({ ok: false, error: "Geçerli bir birim fiyat gir" });
  }
  if (!['CASH', 'CARD'].includes(paymentMethod)) {
    return res.json({ ok: false, error: "Doğrudan satış için Nakit veya Kart seç" });
  }

  const now = Date.now();
  const total = unitPrice * quantity;
  db.run(
    `INSERT INTO product_sales
     (time,masa,session_start,product_id,product_name,category,unit_price,
      quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at)
     VALUES (?,0,0,0,?,'Liste Dışı',?,?,?,'DIRECT',?,'FINALIZED',?,?,0,0)`,
    [now, name, unitPrice, quantity, total, 'Serbest doğrudan satış', now, paymentMethod],
    function (insertErr) {
      if (insertErr) return res.json({ ok: false, error: String(insertErr) });
      const saleId = this.lastID;
      db.run(
        `INSERT INTO payments
         (created_at,paid_at,masa,session_start,session_end,product_sale_id,
          computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at)
         VALUES (?,?,0,0,?,?,0,?,?,?,'DIRECT_PRODUCT','DIRECT_SALE','Serbest doğrudan satış',0,0)`,
        [now, now, now, saleId, total, total, paymentMethod],
        (paymentErr) => {
          if (paymentErr) {
            db.run("UPDATE product_sales SET voided=1,voided_at=? WHERE id=?", [Date.now(), saleId]);
            return res.json({ ok: false, error: String(paymentErr) });
          }
          addLiveLog("product_sale", `🧾 Serbest doğrudan satış • ${quantity}x ${name} • ${total.toFixed(2)} ₺`);
          res.json({ ok: true, id: saleId, total });
        }
      );
    }
  );
});

// Eski EveryCafe "Üye Geliri" KafePin'e otomatik gelmez. Bir defalık
// geçmiş eşleştirme için tarihli nakit/kart doğrudan satış kaydı ekler.
app.post("/admin/product-sales/add-history-member-income", (req, res) => {
  setNoStore(res);
  const body = req.body || {};
  const rawDate = String(body.date || "");
  const amount = Number(body.amount);
  const paymentMethod = normalizePaymentMethod(body.paymentMethod, "CASH");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return res.json({ ok:false, error:"Geçerli tarih seç" });
  if (!Number.isFinite(amount) || amount <= 0) return res.json({ ok:false, error:"Geçerli tutar gir" });
  if (!['CASH', 'CARD'].includes(paymentMethod)) return res.json({ ok:false, error:"Nakit veya Kart seç" });
  const [year, month, day] = rawDate.split("-").map(Number);
  const saleTime = new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
  if (!Number.isFinite(saleTime)) return res.json({ ok:false, error:"Geçerli tarih seç" });
  const dayEnd = saleTime + (24 * 60 * 60 * 1000);
  const name = "EveryCafe Üye Geliri (geçmiş aktarım)";
  db.get(
    `SELECT id FROM product_sales
     WHERE voided=0 AND sale_type='DIRECT' AND product_name=? AND time>=? AND time<? LIMIT 1`,
    [name, saleTime, dayEnd],
    (existsErr, existing) => {
      if (existsErr) return res.json({ ok:false, error:String(existsErr) });
      if (existing) return res.json({ ok:false, error:"Bu tarih için Üye Geliri zaten eklenmiş" });
      db.run(
        `INSERT INTO product_sales
         (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at)
         VALUES (?,0,0,0,?,'EveryCafe Geçmiş Aktarım',?,1,?,'DIRECT',?,'FINALIZED',?,?,0,0)`,
        [saleTime, name, amount, amount, "EveryCafe Üye Geliri • geçmiş eşleştirme", saleTime, paymentMethod],
        function(insertErr) {
          if (insertErr) return res.json({ ok:false, error:String(insertErr) });
          const saleId = this.lastID;
          db.run(
            `INSERT INTO payments
             (created_at,paid_at,masa,session_start,session_end,product_sale_id,computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at)
             VALUES (?,?,0,0,?,?,0,?,?,?,'DIRECT_PRODUCT','DIRECT_SALE','EveryCafe Üye Geliri geçmiş aktarımı',0,0)`,
            [saleTime, saleTime, saleTime, saleId, amount, amount, paymentMethod],
            (paymentErr) => {
              if (paymentErr) {
                db.run("UPDATE product_sales SET voided=1,voided_at=? WHERE id=?", [Date.now(), saleId]);
                return res.json({ ok:false, error:String(paymentErr) });
              }
              addLiveLog("product_sale", `EveryCafe geçmiş üye geliri eklendi • ${rawDate} • ${amount.toFixed(2)} ₺ • ${paymentMethod}`);
              res.json({ ok:true, id:saleId, total:amount, date:rawDate });
            }
          );
        }
      );
    }
  );
});

app.post("/admin/product-sales/void", (req, res) => {
  setNoStore(res);
  const id = parseInt((req.body || {}).id, 10) || 0;
  if (!id) return res.json({ ok: false, error: "Geçersiz satış" });

  db.get("SELECT * FROM product_sales WHERE id=? AND voided=0", [id], (selectErr, sale) => {
    if (selectErr) return res.json({ ok: false, error: String(selectErr) });
    if (!sale) return res.json({ ok: false, error: "Satış bulunamadı veya zaten iptal" });
    db.run(
      "UPDATE product_sales SET voided=1,voided_at=? WHERE id=? AND voided=0",
      [Date.now(), id],
      function (err) {
        if (err) return res.json({ ok: false, error: String(err) });
        db.run(
          "UPDATE payments SET voided=1,voided_at=? WHERE product_sale_id=? AND voided=0",
          [Date.now(), id],
          (paymentVoidErr) => {
            if (paymentVoidErr) return res.json({ ok: false, error: String(paymentVoidErr) });
            addLiveLog("product_void", `↩️ Satış iptal • ${sale.product_name} • ${Number(sale.total).toFixed(2)} ₺`);
            res.json({ ok: true });
          }
        );
      }
    );
  });
});

// EveryCafe canlı entegrasyonu yalnızca kaynak veritabanını salt-okunur açar.
// Test başlatıldığı andan sonraki kapanan oturumlar SessionID ile bir defa içeri alınır.
function everyCafeTableNumber(clientName) {
  const match = String(clientName || "").match(/MASA\s*[-_]?\s*(\d+)/i);
  const masa = match ? Number(match[1]) : 0;
  return masa >= 1 && masa <= MASA_SAYISI ? masa : 0;
}

// EveryCafe'de yalnız doğrudan ürün/teknik servis tahsilatı için açılan
// "Doğrudan Satış" sipariş masası KafePin'de masa oturumu değildir. Ancak
// nakit/kart tahsilatı ve ürünleri, KafePin'in doğrudan satışına aktarılır.
function isEveryCafeDirectSaleClient(clientName) {
  const normalized = String(clientName || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .trim();
  return normalized === "dogrudan satis";
}

function isEveryCafeDirectSaleSession(session) {
  // EveryCafe'nin resmi Doğrudan Satış oturum tipi 26'dır. İsim alanı bazı
  // kurulumlarda özelleştirilebildiği için yalnız metne güvenmeyiz.
  return Number(session && session.SessionType) === 26
    || isEveryCafeDirectSaleClient(session && session.ClientName)
    || isEveryCafeDirectSaleClient(session && session.SessionTypeText);
}

function everyCafePaymentMethod(value) {
  // EveryCafe varsayılanında 1=Nakit, 2=Kart. Bilinmeyen tip güvenli olarak bekler.
  return Number(value) === 1 ? "CASH" : Number(value) === 2 ? "CARD" : "PENDING";
}

// v3.1.35: EveryCafe bilet satışı masa açmadan yapılabilir. Bazı EveryCafe
// sürümleri bu tahsilatı Sessions içindeki Ticket* alanlarında, bazıları ise
// aynı SessionID'ye bağlı Payments satırında tutar. İki biçimi de tek gelir
// olarak tanır; PaymentAmount zaten doluysa TicketOrderAmount ayrıca EKLENMEZ.
function isEveryCafeTicketSession(session) {
  const normalize = (value) => String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const text = `${normalize(session && session.ClientName)} ${normalize(session && session.SessionTypeText)} ${normalize(session && session.SessionDetailDataText)}`;
  return (Number(session && session.TicketID) || 0) > 0
    || (Number(session && session.TicketSetID) || 0) > 0
    || (Number(session && session.TicketOrderAmount) || 0) > 0
    || /(^|\s)(bilet|ticket)(\s|$)/.test(text);
}

function everyCafeSessionRevenueTotal(session) {
  const payment = Math.round((Number(session && session.PaymentAmount) || 0) * 100) / 100;
  const ticket = Math.round((Number(session && session.TicketOrderAmount) || 0) * 100) / 100;
  if (isEveryCafeTicketSession(session) && payment <= 0 && ticket > 0) return ticket;
  return payment;
}

function everyCafeLinkedSessionFromPayment(row) {
  if (!row || !String(row.LinkedSessionID || "").trim()) return null;
  return {
    SessionID: row.LinkedSessionID,
    ClientName: row.LinkedClientName,
    SessionType: row.LinkedSessionType,
    SessionTypeText: row.LinkedSessionTypeText,
    SessionDetailDataText: row.LinkedSessionDetailDataText,
    TicketID: row.LinkedTicketID,
    TicketSetID: row.LinkedTicketSetID,
    TicketOrder: row.LinkedTicketOrder,
    TicketOrderAmount: row.LinkedTicketOrderAmount,
    Deleted: row.LinkedDeleted
  };
}

function isEveryCafeOtherPaymentCandidate(row) {
  const linked = everyCafeLinkedSessionFromPayment(row);
  if (!linked) return true;
  if (Number(linked.Deleted) !== 0) return false;
  if (everyCafeTableNumber(linked.ClientName)) return false;
  if (isEveryCafeDirectSaleSession(linked)) return false;
  return true;
}

function findMatchingKafePinSession(masa, sourceStart, sourceEnd, cb) {
  const windowMs = 20 * 60 * 1000;
  const params = [masa, sourceStart - windowMs, sourceStart + windowMs];
  db.get(
    `SELECT masa,start_time,end_time,last_seen
     FROM sessions WHERE masa=? AND start_time BETWEEN ? AND ?`,
    params,
    (activeErr, activeRow) => {
      if (activeErr) return cb(activeErr);
      if (activeRow) return cb(null, activeRow);
      db.get(
        `SELECT masa,start_time,end_time,last_seen
         FROM session_history WHERE masa=? AND start_time BETWEEN ? AND ?
         ORDER BY end_time DESC LIMIT 1`,
        params,
        cb
      );
    }
  );
}

function getEveryCafeConfig(cb) {
  db.all(
    "SELECT key,value FROM settings WHERE key IN ('everycafe_sync_enabled','everycafe_sync_start_at','everycafe_sync_session_cursor','everycafe_sync_member_cursor','everycafe_sync_other_cursor','everycafe_sync_ticket_cursor')",
    (err, rows) => {
      if (err) return cb(err);
      const values = Object.fromEntries((rows || []).map((row) => [row.key, row.value]));
      const startAt = Number(values.everycafe_sync_start_at) || 0;
      const startSec = Math.floor(startAt / 1000);
      cb(null, {
        enabled: values.everycafe_sync_enabled === "1",
        startAt,
        sessionCursor: Math.max(startSec, Number(values.everycafe_sync_session_cursor) || startSec),
        memberCursor: Math.max(startSec, Number(values.everycafe_sync_member_cursor) || startSec),
        otherCursor: Math.max(startSec, Number(values.everycafe_sync_other_cursor) || startSec),
        ticketCursor: Math.max(startSec, Number(values.everycafe_sync_ticket_cursor) || startSec)
      });
    }
  );
}

function saveEveryCafeLiveCursor(key, sourceSeconds, cb = () => {}) {
  const allowed = new Set(['everycafe_sync_session_cursor','everycafe_sync_member_cursor','everycafe_sync_other_cursor','everycafe_sync_ticket_cursor']);
  if (!allowed.has(String(key || ''))) return cb(new Error('Geçersiz EveryCafe cursor anahtarı'));
  const value = String(Math.max(0, Math.floor(Number(sourceSeconds) || 0)));
  db.run(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [key, value],
    (err) => cb(err || null)
  );
}

function everyCafeLiveScanStart(config, cursorSeconds) {
  const startSec = Math.floor(Math.max(Number(config && config.startAt) || 0, 0) / 1000);
  const cursor = Math.max(startSec, Math.floor(Number(cursorSeconds) || startSec));
  // v3.1.37: startAt yalnız ilk cursor'u belirler; güvenli 24 saatlik tekrar taramayı
  // artık kesmez. Böylece güncelleme/restart sonrası entegrasyon yeniden açılmış olsa
  // bile aynı gün daha önce oluşan EveryCafe geliri kaynak ID dedup ile tamamlanır.
  return Math.max(0, cursor - EVERYCAFE_LIVE_RECHECK_SECONDS);
}

function normalizeEveryCafeCatalogText(value, maxLen = 100) {
  return normalizeTurkishText(String(value || "").trim()).slice(0, maxLen);
}

function getEveryCafeOrderCategory(order) {
  const sourceCategory = normalizeEveryCafeCatalogText(order && order.CategoryName, 80);
  if (sourceCategory) return sourceCategory;
  const stockId = Number(order && order.StockID) || 0;
  const cached = everyCafeCatalogByStockId.get(stockId);
  return cached && cached.categoryName ? cached.categoryName : "EveryCafe";
}

function refreshEveryCafeCatalogCache(cb = () => {}) {
  db.all(
    `SELECT stock_id,name,category_id,category_name,price,active
     FROM everycafe_catalog_products`,
    (err, rows) => {
      if (err) return cb(err);
      everyCafeCatalogByStockId.clear();
      (rows || []).forEach((row) => {
        const stockId = Number(row.stock_id) || 0;
        if (!stockId) return;
        everyCafeCatalogByStockId.set(stockId, {
          name: normalizeEveryCafeCatalogText(row.name, 100),
          categoryId: Number(row.category_id) || 0,
          categoryName: normalizeEveryCafeCatalogText(row.category_name, 80),
          price: Number(row.price) || 0,
          active: Number(row.active) !== 0
        });
      });
      cb(null, { count: everyCafeCatalogByStockId.size });
    }
  );
}

function readEveryCafeCatalog(cb) {
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    const close = () => source.close(() => {});
    source.all(
      `SELECT LookupValue1 AS CategoryID, LookupText1 AS CategoryName, LookupID AS SortOrder
       FROM LookupValues
       WHERE LookupKey='ProductCategories' AND TRIM(COALESCE(LookupText1,''))<>''
       ORDER BY LookupID ASC`,
      (categoryErr, categoryRows) => {
        if (categoryErr) { close(); return cb(categoryErr); }
        source.all(
          `SELECT s.StockID,s.StockName,s.CategoryID,s.SalesPrice,
                  COALESCE(s.SortOrder,s.StockID) AS SortOrder,
                  COALESCE(c.LookupText1,'') AS CategoryName
           FROM Stocks s
           LEFT JOIN LookupValues c
             ON c.LookupKey='ProductCategories' AND c.LookupValue1=s.CategoryID
           ORDER BY s.CategoryID,COALESCE(s.SortOrder,s.StockID),s.StockID`,
          (productErr, productRows) => {
            close();
            if (productErr) return cb(productErr);
            const categories = (categoryRows || []).map((row, index) => ({
              id: Number(row.CategoryID) || 0,
              name: normalizeEveryCafeCatalogText(row.CategoryName, 80),
              sortOrder: Number(row.SortOrder) || index + 1
            })).filter((row) => row.id && row.name);
            const products = (productRows || []).map((row, index) => ({
              stockId: Number(row.StockID) || 0,
              name: normalizeEveryCafeCatalogText(row.StockName, 100),
              categoryId: Number(row.CategoryID) || 0,
              categoryName: normalizeEveryCafeCatalogText(row.CategoryName, 80),
              price: Math.max(0, Number(row.SalesPrice) || 0),
              sortOrder: Number(row.SortOrder) || index + 1
            })).filter((row) => row.stockId && row.name);
            cb(null, { categories, products });
          }
        );
      }
    );
  });
}

const EVERYCAFE_DIRECT_CATALOG_SOURCE = "EVERYCAFE_CATALOG";

function everyCafeDirectCatalogKey(name, category) {
  const n = normalizeProductName(name).toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
  const c = normalizeProductCategory(category).toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
  return `${n}\u0000${c}`;
}

function everyCafeDirectCatalogNameKey(name) {
  return normalizeProductName(name).toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
}

// EveryCafe katalog ürünlerini KafePin Doğrudan Satış kataloğuna da aynalar.
// Buradaki kritik ayrım: katalog kaynağı EveryCafe olsa da bu ürün KafePin
// Doğrudan Satış ekranından satılırsa satış kaydı KafePin DIRECT olarak kalır;
// EveryCafe cirosuna / EveryCafe maliyetine geri yazılmaz.
function mirrorEveryCafeProductsToDirectCatalog(products, cb) {
  const now = Date.now();
  const sourceProducts = Array.isArray(products) ? products : [];

  db.all(
    `SELECT id,name,category,price,active,sort_order,created_at,updated_at,
            COALESCE(external_source,'') AS external_source,
            COALESCE(external_id,'') AS external_id
     FROM product_catalog
     ORDER BY id`,
    (readErr, rows) => {
      if (readErr) return cb(readErr);

      const catalogRows = rows || [];
      const externalById = new Map();
      const manualByFullKey = new Map();
      const manualByNameKey = new Map();
      const claimedManualIds = new Set();

      for (const row of catalogRows) {
        const source = String(row.external_source || "");
        const externalId = String(row.external_id || "");
        if (source === EVERYCAFE_DIRECT_CATALOG_SOURCE && externalId) {
          externalById.set(externalId, row);
          continue;
        }
        if (source) continue;

        const fullKey = everyCafeDirectCatalogKey(row.name, row.category);
        const nameKey = everyCafeDirectCatalogNameKey(row.name);
        if (!manualByFullKey.has(fullKey)) manualByFullKey.set(fullKey, []);
        if (!manualByNameKey.has(nameKey)) manualByNameKey.set(nameKey, []);
        manualByFullKey.get(fullKey).push(row);
        manualByNameKey.get(nameKey).push(row);
      }

      const seenExternalIds = new Set();
      let index = 0;
      let mirroredAdded = 0;
      let mirroredUpdated = 0;
      let adoptedExisting = 0;
      let mirroredDeactivated = 0;

      const nextProduct = (err) => {
        if (err) return cb(err);
        if (index >= sourceProducts.length) return deactivateMissing();

        const sourceRow = sourceProducts[index++];
        const stockId = Number(sourceRow.stockId) || 0;
        if (!stockId || !sourceRow.name) return nextProduct();

        const externalId = String(stockId);
        seenExternalIds.add(externalId);
        const desiredName = normalizeProductName(sourceRow.name);
        const sourceCategory = normalizeProductCategory(sourceRow.categoryName || "");
        const desiredPrice = Math.max(0, Number(sourceRow.price) || 0);
        const desiredSort = Number(sourceRow.sortOrder) || stockId;

        let target = externalById.get(externalId) || null;
        let adopted = false;

        if (!target) {
          const fullKey = everyCafeDirectCatalogKey(desiredName, sourceCategory);
          const exactCandidates = (manualByFullKey.get(fullKey) || [])
            .filter((row) => !claimedManualIds.has(Number(row.id)));
          if (exactCandidates.length) {
            target = exactCandidates[0];
            adopted = true;
          } else {
            const nameKey = everyCafeDirectCatalogNameKey(desiredName);
            const nameCandidates = (manualByNameKey.get(nameKey) || [])
              .filter((row) => !claimedManualIds.has(Number(row.id)));
            // Kategori geçmişte farklı girilmiş olsa bile isim tekilse mevcut
            // KafePin kartını sahipleniriz. Böylece Churchill 60 -> ChurChill 70
            // gibi ilk senkronda çift kart oluşmaz.
            if (nameCandidates.length === 1) {
              target = nameCandidates[0];
              adopted = true;
            }
          }
        }

        const desiredCategory = sourceCategory || normalizeProductCategory(target && target.category) || "EveryCafe";

        if (target) {
          claimedManualIds.add(Number(target.id));
          const changed = String(target.name || "") !== desiredName
            || String(target.category || "") !== desiredCategory
            || Math.abs((Number(target.price) || 0) - desiredPrice) > 0.001
            || Number(target.active) === 0
            || Number(target.sort_order) !== desiredSort
            || String(target.external_source || "") !== EVERYCAFE_DIRECT_CATALOG_SOURCE
            || String(target.external_id || "") !== externalId;

          if (!changed) return nextProduct();
          if (adopted) adoptedExisting += 1;
          else mirroredUpdated += 1;

          return db.run(
            `UPDATE product_catalog
             SET name=?,category=?,price=?,active=1,sort_order=?,updated_at=?,
                 external_source=?,external_id=?
             WHERE id=?`,
            [desiredName, desiredCategory, desiredPrice, desiredSort, now,
              EVERYCAFE_DIRECT_CATALOG_SOURCE, externalId, Number(target.id)],
            (updateErr) => {
              if (!updateErr) {
                target.name = desiredName;
                target.category = desiredCategory;
                target.price = desiredPrice;
                target.active = 1;
                target.sort_order = desiredSort;
                target.updated_at = now;
                target.external_source = EVERYCAFE_DIRECT_CATALOG_SOURCE;
                target.external_id = externalId;
                externalById.set(externalId, target);
              }
              nextProduct(updateErr || null);
            }
          );
        }

        db.run(
          `INSERT INTO product_catalog
           (name,category,price,active,sort_order,created_at,updated_at,external_source,external_id)
           VALUES(?,?,?,1,?,?,?,?,?)`,
          [desiredName, desiredCategory, desiredPrice, desiredSort, now, now,
            EVERYCAFE_DIRECT_CATALOG_SOURCE, externalId],
          function (insertErr) {
            if (!insertErr) {
              mirroredAdded += 1;
              externalById.set(externalId, {
                id: this.lastID,
                name: desiredName,
                category: desiredCategory,
                price: desiredPrice,
                active: 1,
                sort_order: desiredSort,
                updated_at: now,
                external_source: EVERYCAFE_DIRECT_CATALOG_SOURCE,
                external_id: externalId
              });
            }
            nextProduct(insertErr || null);
          }
        );
      };

      // v3.0.16 katı ayna:
      // Kullanıcı "Şimdi Senkronla" dediğinde aktif KafePin kataloğu,
      // EveryCafe kaynak listesiyle BİREBİR olur. Kaynakta olmayan eski
      // manuel/örnek kartlar silinmez (geçmiş satış bütünlüğü için), yalnız
      // pasife alınır. Böylece restart veya eski kayıtlar "Fiyat Gir" kartı
      // olarak geri dönemez.
      const staleRows = () => catalogRows.filter((row) => {
        if (Number(row.active) === 0) return false;
        const source = String(row.external_source || "");
        const externalId = String(row.external_id || "");
        if (source === EVERYCAFE_DIRECT_CATALOG_SOURCE) {
          return !externalId || !seenExternalIds.has(externalId);
        }
        // EveryCafe senkronu açıkça kullanıcı tarafından başlatıldıysa,
        // sahiplenilmeyen yerel katalog kartları da kaynakta yok demektir.
        return !claimedManualIds.has(Number(row.id));
      });

      const deactivateMissing = () => {
        const missing = staleRows();
        let i = 0;
        const next = (err) => {
          if (err) return cb(err);
          if (i >= missing.length) {
            return cb(null, {
              mirroredAdded,
              mirroredUpdated,
              adoptedExisting,
              mirroredDeactivated
            });
          }
          const row = missing[i++];
          db.run(
            `UPDATE product_catalog SET active=0,updated_at=? WHERE id=?`,
            [now, Number(row.id)],
            (updateErr) => {
              if (!updateErr) mirroredDeactivated += 1;
              next(updateErr || null);
            }
          );
        };
        next();
      };

      nextProduct();
    }
  );
}

function writeEveryCafeCatalogSyncFailure(err, cb = () => {}) {
  const now = Date.now();
  const message = String(err && (err.message || err) || "Bilinmeyen EveryCafe katalog hatası").slice(0, 500);
  addEveryCafeIntegrationLog({category:"CATALOG",level:"ERROR",event:"Manuel katalog senkronu başarısız",sourceDetail:message,action:"KafePin kataloğu değiştirilmedi",result:"Hata",dedupeKey:`catalog:${message}`,dedupeMs:30000});
  db.run(
    `INSERT INTO everycafe_catalog_sync_state(id,last_attempt,last_error)
     VALUES(1,?,?)
     ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,last_error=excluded.last_error`,
    [now, message],
    () => cb()
  );
}

function applyEveryCafeCatalogSnapshot(snapshot, cb) {
  const now = Date.now();
  const categories = Array.isArray(snapshot && snapshot.categories) ? snapshot.categories : [];
  const products = Array.isArray(snapshot && snapshot.products) ? snapshot.products : [];
  db.all(`SELECT * FROM everycafe_catalog_categories`, (categoryReadErr, existingCategoryRows) => {
    if (categoryReadErr) return cb(categoryReadErr);
    db.all(`SELECT * FROM everycafe_catalog_products`, (productReadErr, existingProductRows) => {
      if (productReadErr) return cb(productReadErr);
      const existingCategories = new Map((existingCategoryRows || []).map((row) => [Number(row.category_id), row]));
      const existingProducts = new Map((existingProductRows || []).map((row) => [Number(row.stock_id), row]));
      const categoryIds = new Set(categories.map((row) => Number(row.id)).filter(Boolean));
      const stockIds = new Set(products.map((row) => Number(row.stockId)).filter(Boolean));
      const stats = {
        sourceCategories: categories.length,
        sourceProducts: products.length,
        categoryAdded: 0,
        categoryUpdated: 0,
        categoryDeactivated: 0,
        productAdded: 0,
        productUpdated: 0,
        productDeactivated: 0,
        priceChanged: 0,
        nameChanged: 0,
        categoryMoved: 0
      };

      let categoryIndex = 0;
      const saveNextCategory = (err) => {
        if (err) return cb(err);
        if (categoryIndex >= categories.length) return deactivateMissingCategories();
        const row = categories[categoryIndex++];
        const old = existingCategories.get(Number(row.id));
        const categoryChanged = !old
          || String(old.name || "") !== row.name
          || Number(old.active) === 0
          || Number(old.sort_order) !== Number(row.sortOrder);
        if (!old) stats.categoryAdded += 1;
        else if (categoryChanged) stats.categoryUpdated += 1;
        if (!categoryChanged) return saveNextCategory();
        db.run(
          `INSERT INTO everycafe_catalog_categories(category_id,name,active,sort_order,first_seen_at,updated_at,last_seen_at)
           VALUES(?,?,1,?,?,?,?)
           ON CONFLICT(category_id) DO UPDATE SET
             name=excluded.name,active=1,sort_order=excluded.sort_order,
             updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`,
          [row.id, row.name, row.sortOrder, old ? Number(old.first_seen_at) || now : now, now, now],
          saveNextCategory
        );
      };

      const deactivateMissingCategories = () => {
        const missing = (existingCategoryRows || []).filter((row) => Number(row.active) !== 0 && !categoryIds.has(Number(row.category_id)));
        stats.categoryDeactivated = missing.length;
        let i = 0;
        const next = (err) => {
          if (err) return cb(err);
          if (i >= missing.length) return saveNextProduct();
          db.run(
            `UPDATE everycafe_catalog_categories SET active=0,updated_at=? WHERE category_id=?`,
            [now, Number(missing[i++].category_id)],
            next
          );
        };
        next();
      };

      let productIndex = 0;
      const saveNextProduct = (err) => {
        if (err) return cb(err);
        if (productIndex >= products.length) return deactivateMissingProducts();
        const row = products[productIndex++];
        const old = existingProducts.get(Number(row.stockId));
        let productChanged = !old;
        if (!old) {
          stats.productAdded += 1;
        } else {
          const oldName = String(old.name || "");
          const oldCategoryId = Number(old.category_id) || 0;
          const oldCategoryName = String(old.category_name || "");
          const oldPrice = Number(old.price) || 0;
          const nameChanged = oldName !== row.name;
          const categoryMoved = oldCategoryId !== Number(row.categoryId) || oldCategoryName !== row.categoryName;
          const priceChanged = Math.abs(oldPrice - Number(row.price)) > 0.001;
          if (nameChanged) stats.nameChanged += 1;
          if (categoryMoved) stats.categoryMoved += 1;
          if (priceChanged) stats.priceChanged += 1;
          productChanged = nameChanged || categoryMoved || priceChanged
            || Number(old.active) === 0 || Number(old.sort_order) !== Number(row.sortOrder);
          if (productChanged) stats.productUpdated += 1;
        }
        if (!productChanged) return saveNextProduct();
        db.run(
          `INSERT INTO everycafe_catalog_products
           (stock_id,name,category_id,category_name,price,active,sort_order,first_seen_at,updated_at,last_seen_at)
           VALUES(?,?,?,?,?,1,?,?,?,?)
           ON CONFLICT(stock_id) DO UPDATE SET
             name=excluded.name,category_id=excluded.category_id,category_name=excluded.category_name,
             price=excluded.price,active=1,sort_order=excluded.sort_order,
             updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`,
          [row.stockId, row.name, row.categoryId, row.categoryName, row.price, row.sortOrder, old ? Number(old.first_seen_at) || now : now, now, now],
          saveNextProduct
        );
      };

      const deactivateMissingProducts = () => {
        const missing = (existingProductRows || []).filter((row) => Number(row.active) !== 0 && !stockIds.has(Number(row.stock_id)));
        stats.productDeactivated = missing.length;
        let i = 0;
        const next = (err) => {
          if (err) return cb(err);
          if (i >= missing.length) return saveState();
          db.run(
            `UPDATE everycafe_catalog_products SET active=0,updated_at=? WHERE stock_id=?`,
            [now, Number(missing[i++].stock_id)],
            next
          );
        };
        next();
      };

      const saveState = () => {
        mirrorEveryCafeProductsToDirectCatalog(products, (mirrorErr, mirrorStats) => {
          if (mirrorErr) return cb(mirrorErr);
          db.run(
          `INSERT INTO everycafe_catalog_sync_state
           (id,last_attempt,last_success,last_error,source_categories,source_products,
            category_added,category_updated,category_deactivated,
            product_added,product_updated,product_deactivated,price_changed,name_changed,category_moved)
           VALUES(1,?,?, '',?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             last_attempt=excluded.last_attempt,last_success=excluded.last_success,last_error='',
             source_categories=excluded.source_categories,source_products=excluded.source_products,
             category_added=excluded.category_added,category_updated=excluded.category_updated,category_deactivated=excluded.category_deactivated,
             product_added=excluded.product_added,product_updated=excluded.product_updated,product_deactivated=excluded.product_deactivated,
             price_changed=excluded.price_changed,name_changed=excluded.name_changed,category_moved=excluded.category_moved`,
          [now, now, stats.sourceCategories, stats.sourceProducts,
            stats.categoryAdded, stats.categoryUpdated, stats.categoryDeactivated,
            stats.productAdded, stats.productUpdated, stats.productDeactivated,
            stats.priceChanged, stats.nameChanged, stats.categoryMoved],
          (stateErr) => {
            if (stateErr) return cb(stateErr);
            const combinedStats = {
              ...stats,
              mirroredAdded: Number(mirrorStats && mirrorStats.mirroredAdded) || 0,
              mirroredUpdated: Number(mirrorStats && mirrorStats.mirroredUpdated) || 0,
              adoptedExisting: Number(mirrorStats && mirrorStats.adoptedExisting) || 0,
              mirroredDeactivated: Number(mirrorStats && mirrorStats.mirroredDeactivated) || 0
            };
            refreshEveryCafeCatalogCache((cacheErr) => cb(cacheErr || null, combinedStats));
          }
        );
        });
      };

      saveNextCategory();
    });
  });
}

function syncEveryCafeCatalog(cb = () => {}) {
  // v3.0.16: Bu fonksiyon yalnız manuel endpoint'ten çağrılır. Canlı EveryCafe
  // oturum entegrasyonu açık/kapalı olsa da kullanıcı açıkça senkron istediğinde
  // kaynak ecmdata.ecm okunur. EveryCafe uygulamasının çalışıyor olması gerekmez.
  if (everyCafeCatalogSyncRunning) return cb(null, { skipped: true, reason: "busy" });
  everyCafeCatalogSyncRunning = true;
  readEveryCafeCatalog((readErr, snapshot) => {
    if (readErr) {
      everyCafeCatalogSyncRunning = false;
      return writeEveryCafeCatalogSyncFailure(readErr, () => cb(readErr));
    }
    applyEveryCafeCatalogSnapshot(snapshot, (applyErr, stats) => {
      everyCafeCatalogSyncRunning = false;
      if (applyErr) return writeEveryCafeCatalogSyncFailure(applyErr, () => cb(applyErr));
      const changed = Number(stats.productAdded) + Number(stats.productUpdated) + Number(stats.productDeactivated)
        + Number(stats.categoryAdded) + Number(stats.categoryUpdated) + Number(stats.categoryDeactivated)
        + Number(stats.mirroredAdded) + Number(stats.mirroredUpdated)
        + Number(stats.adoptedExisting) + Number(stats.mirroredDeactivated);
      if (changed > 0) {
        addLiveLog(
          "everycafe_catalog",
          `✅ EveryCafe katalog senkronu • ${stats.sourceCategories} kategori • ${stats.sourceProducts} ürün • ${changed} değişiklik`
        );
      }
      addEveryCafeIntegrationLog({category:"CATALOG",event:"Manuel katalog senkronu",sourceDetail:`EveryCafe ${stats.sourceCategories} kategori • ${stats.sourceProducts} ürün`,action:`KafePin katı aynada ${changed} değişiklik uyguladı`,result:changed?"Başarılı • katalog güncellendi":"Başarılı • değişiklik yok",details:stats||{}});
      cb(null, { ok: true, changed, ...(stats || {}) });
    });
  });
}

function getEveryCafeCatalogStatus(cb) {
  db.get(`SELECT * FROM everycafe_catalog_sync_state WHERE id=1`, (stateErr, state) => {
    if (stateErr) return cb(stateErr);
    db.all(
      `SELECT category_id,name,active,sort_order,first_seen_at,updated_at,last_seen_at
       FROM everycafe_catalog_categories
       ORDER BY active DESC,sort_order,name`,
      (categoryErr, categories) => {
        if (categoryErr) return cb(categoryErr);
        db.all(
          `SELECT stock_id,name,category_id,category_name,price,active,sort_order,first_seen_at,updated_at,last_seen_at
           FROM everycafe_catalog_products
           ORDER BY active DESC,category_name,sort_order,name`,
          (productErr, products) => {
            if (productErr) return cb(productErr);
            cb(null, {
              state: state || {},
              categories: categories || [],
              products: products || []
            });
          }
        );
      }
    );
  });
}

function getEveryCafeManualSafety(cb) {
  db.all(
    "SELECT key,value FROM settings WHERE key IN ('everycafe_sync_enabled','everycafe_maintenance_mode')",
    (err, rows) => {
      if (err) return cb(err);
      const values = Object.fromEntries((rows || []).map((row) => [row.key, row.value]));
      cb(null, {
        everyCafeEnabled: values.everycafe_sync_enabled === "1",
        maintenanceEnabled: values.everycafe_maintenance_mode === "1"
      });
    }
  );
}

function requireEveryCafeMaintenance(res, next) {
  getEveryCafeManualSafety((err, safety) => {
    if (err) return res.json({ ok: false, error: String(err) });
    if (safety.everyCafeEnabled && !safety.maintenanceEnabled) {
      return res.status(409).json({
        ok: false,
        code: "EVERYCAFE_MAINTENANCE_REQUIRED",
        error: "EveryCafe aktarımı açık. Bu işlem sadece Bakım Modu açıkken kullanılabilir."
      });
    }
    return next();
  });
}

app.get("/admin/maintenance-mode", (req, res) => {
  setNoStore(res);
  getEveryCafeManualSafety((err, safety) => {
    if (err) return res.json({ ok: false, error: String(err) });
    res.json({ ok: true, enabled: safety.maintenanceEnabled, everyCafeEnabled: safety.everyCafeEnabled });
  });
});

app.post("/admin/maintenance-mode", (req, res) => {
  setNoStore(res);
  const enabled = (req.body || {}).enabled ? 1 : 0;
  db.run(
    "INSERT INTO settings(key,value) VALUES('everycafe_maintenance_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [String(enabled)],
    (err) => {
      if (err) return res.json({ ok: false, error: String(err) });
      EVERYCAFE_MAINTENANCE_MODE = enabled;
      addLiveLog("everycafe_maintenance_mode", enabled ? "🛠️ EveryCafe bakım modu açıldı" : "🔒 EveryCafe bakım modu kapatıldı");
      getEveryCafeConfig((configErr, config) => {
        res.json({ ok: true, enabled: enabled === 1, everyCafeEnabled: !configErr && !!(config && config.enabled) });
      });
    }
  );
});

function readEveryCafeClosedSessions(sinceMs, limit, cb) {
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    const close = () => source.close(() => {});
    source.all(
      `SELECT s.SessionID,s.ClientName,s.StartDate,s.EndDate,s.PaymentMethod,s.PaymentAmount,
              s.SessionType,s.SessionTypeText,s.SessionDetailDataText,s.Price,
              s.TicketID,s.TicketSetID,s.TicketOrder,s.TicketOrderAmount,
              (SELECT COUNT(*) FROM Payments p
               WHERE COALESCE(p.Deleted,0)=0 AND COALESCE(p.IsMoneyChange,0)=0
                 AND CAST(COALESCE(p.SessionID,'') AS TEXT)=CAST(s.SessionID AS TEXT)
                 AND p.PaymentMethod IN (1,2) AND COALESCE(p.PaymentAmount,0)>0) AS LinkedPaymentCount
       FROM Sessions s
       WHERE COALESCE(s.Deleted,0)=0
         AND (COALESCE(s.IsPaid,0)=1 OR COALESCE(s.TicketOrderAmount,0)>0)
         AND COALESCE(s.EndDate,0)>?
       ORDER BY s.EndDate ASC, CAST(s.SessionID AS TEXT) ASC LIMIT ?`,
      [Math.floor(Math.max(Number(sinceMs) || 0, 0) / 1000), Math.max(1, Math.min(Number(limit) || 50, 1000))],
      (sessionErr, sessions) => {
        if (sessionErr) { close(); return cb(sessionErr); }
        if (!(sessions || []).length) { close(); return cb(null, []); }
        const ids = sessions.map((row) => row.SessionID);
        source.all(
          `SELECT o.OrderID,o.SessionID,o.StockID,o.StockName,o.Quantity,o.Price,o.AddDate,o.OrderIsActive,
                  COALESCE(c.LookupText1,'') AS CategoryName
           FROM Orders o
           LEFT JOIN Stocks s ON s.StockID=o.StockID
           LEFT JOIN LookupValues c ON c.LookupKey='ProductCategories' AND c.LookupValue1=s.CategoryID
           WHERE o.SessionID IN (${ids.map(() => "?").join(",")})
           ORDER BY o.AddDate ASC`,
          ids,
          (orderErr, orderRows) => {
            close();
            if (orderErr) return cb(orderErr);
            const ordersBySession = new Map();
            (orderRows || []).forEach((order) => {
              const list = ordersBySession.get(order.SessionID) || [];
              list.push(order);
              ordersBySession.set(order.SessionID, list);
            });
            cb(null, sessions.map((session) => ({ ...session, orders: ordersBySession.get(session.SessionID) || [] })));
          }
        );
      }
    );
  });
}

// v3.1.34: Canlı kapanış sayfalaması. SessionID aynı saniyede kapanan kayıtlar
// için ikinci sıralama anahtarıdır; böylece 100/200 sınırından dolayı kayıt kaybolmaz.
function readEveryCafeClosedSessionsPage(afterEndSeconds, afterSessionId, limit, cb) {
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    const close = () => source.close(() => {});
    const pageSize = Math.max(1, Math.min(Number(limit) || EVERYCAFE_LIVE_PAGE_SIZE, 1000));
    const endCursor = Math.max(0, Math.floor(Number(afterEndSeconds) || 0));
    const idCursor = String(afterSessionId || '');
    source.all(
      `SELECT s.SessionID,s.ClientName,s.StartDate,s.EndDate,s.PaymentMethod,s.PaymentAmount,
              s.SessionType,s.SessionTypeText,s.SessionDetailDataText,s.Price,
              s.TicketID,s.TicketSetID,s.TicketOrder,s.TicketOrderAmount,
              (SELECT COUNT(*) FROM Payments p
               WHERE COALESCE(p.Deleted,0)=0 AND COALESCE(p.IsMoneyChange,0)=0
                 AND CAST(COALESCE(p.SessionID,'') AS TEXT)=CAST(s.SessionID AS TEXT)
                 AND p.PaymentMethod IN (1,2) AND COALESCE(p.PaymentAmount,0)>0) AS LinkedPaymentCount
       FROM Sessions s
       WHERE COALESCE(s.Deleted,0)=0
         AND (COALESCE(s.IsPaid,0)=1 OR COALESCE(s.TicketOrderAmount,0)>0)
         AND (COALESCE(s.EndDate,0)>? OR (COALESCE(s.EndDate,0)=? AND CAST(s.SessionID AS TEXT)>?))
       ORDER BY s.EndDate ASC, CAST(s.SessionID AS TEXT) ASC LIMIT ?`,
      [endCursor, endCursor, idCursor, pageSize],
      (sessionErr, sessions) => {
        if (sessionErr) { close(); return cb(sessionErr); }
        const rows = sessions || [];
        if (!rows.length) { close(); return cb(null, { rows: [], rawCount: 0, cursorEnd: endCursor, cursorId: idCursor }); }
        const last = rows[rows.length - 1];
        const ids = rows.map((row) => row.SessionID);
        source.all(
          `SELECT o.OrderID,o.SessionID,o.StockID,o.StockName,o.Quantity,o.Price,o.AddDate,o.OrderIsActive,
                  COALESCE(c.LookupText1,'') AS CategoryName
           FROM Orders o
           LEFT JOIN Stocks s ON s.StockID=o.StockID
           LEFT JOIN LookupValues c ON c.LookupKey='ProductCategories' AND c.LookupValue1=s.CategoryID
           WHERE o.SessionID IN (${ids.map(() => "?").join(",")})
           ORDER BY o.AddDate ASC`,
          ids,
          (orderErr, orderRows) => {
            close();
            if (orderErr) return cb(orderErr);
            const ordersBySession = new Map();
            (orderRows || []).forEach((order) => {
              const list = ordersBySession.get(order.SessionID) || [];
              list.push(order);
              ordersBySession.set(order.SessionID, list);
            });
            cb(null, {
              rows: rows.map((session) => ({ ...session, orders: ordersBySession.get(session.SessionID) || [] })),
              rawCount: rows.length,
              cursorEnd: Number(last.EndDate) || endCursor,
              cursorId: String(last.SessionID || idCursor)
            });
          }
        );
      }
    );
  });
}

// Üye bakiyesi EveryCafe'de Sessions tablosunda değil MemberPaymentHistory'de
// yer alır. PaymentMethod 1=Nakit, 2=Kart; diğer teknik/hediye hareketleri
// tahsilat olmadığı için güvenle dışarıda bırakılır.
function readEveryCafeMemberPayments(sinceMs, limit, cb) {
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    source.all(
      `SELECT HistoryID,MemberID,PaymentAmount,PaymentMethod,IsActive,PaymentDate,PaymentKey,Note,CashierName
       FROM MemberPaymentHistory
       WHERE COALESCE(IsActive,1)<>0
         AND COALESCE(PaymentDate,0)>?
         AND PaymentMethod IN (1,2)
         AND COALESCE(PaymentAmount,0)>0
       ORDER BY PaymentDate ASC, HistoryID ASC LIMIT ?`,
      [Math.floor(Math.max(Number(sinceMs) || 0, 0) / 1000), Math.max(1, Math.min(Number(limit) || 100, 500))],
      (readErr, rows) => {
        source.close(() => {});
        if (readErr) return cb(readErr);
        cb(null, rows || []);
      }
    );
  });
}

// v3.1.34: Üye tahsilatında 500 kayıt tavanını kaldıran sayfalı okuyucu.
function readEveryCafeMemberPaymentsPage(afterTimeSeconds, afterHistoryId, limit, cb) {
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    const pageSize = Math.max(1, Math.min(Number(limit) || EVERYCAFE_LIVE_PAGE_SIZE, 1000));
    const timeCursor = Math.max(0, Math.floor(Number(afterTimeSeconds) || 0));
    const idCursor = Math.max(0, Number(afterHistoryId) || 0);
    source.all(
      `SELECT HistoryID,MemberID,PaymentAmount,PaymentMethod,IsActive,PaymentDate,PaymentKey,Note,CashierName
       FROM MemberPaymentHistory
       WHERE COALESCE(IsActive,1)<>0
         AND PaymentMethod IN (1,2)
         AND COALESCE(PaymentAmount,0)>0
         AND (COALESCE(PaymentDate,0)>? OR (COALESCE(PaymentDate,0)=? AND COALESCE(HistoryID,0)>?))
       ORDER BY PaymentDate ASC, HistoryID ASC LIMIT ?`,
      [timeCursor, timeCursor, idCursor, pageSize],
      (readErr, rows) => {
        source.close(() => {});
        if (readErr) return cb(readErr);
        const list = rows || [];
        const last = list[list.length - 1];
        cb(null, {
          rows: list, rawCount: list.length,
          cursorTime: last ? (Number(last.PaymentDate) || timeCursor) : timeCursor,
          cursorId: last ? (Number(last.HistoryID) || idCursor) : idCursor
        });
      }
    );
  });
}

function everyCafeOtherPaymentSourceTime(row) {
  return Number(row && row.AddDate) > 0 ? Number(row.AddDate) : Math.max(0, Number(row && row.UpdDate) || 0);
}

// Sessions'a bağlı ödeme teknik alt kayıttır ve ikinci kez gelir sayılmaz.
// SessionID'si olmayan/gerçek Sessions kaydı bulunmayan Payments satırı ise
// bilet, e-pin, teknik servis vb. bağımsız kasa tahsilatı olabilir.
function readEveryCafeOtherPaymentsPage(afterTimeSeconds, afterPaymentId, limit, cb) {
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    const pageSize = Math.max(1, Math.min(Number(limit) || EVERYCAFE_LIVE_PAGE_SIZE, 1000));
    const timeCursor = Math.max(0, Math.floor(Number(afterTimeSeconds) || 0));
    const idCursor = String(afterPaymentId || '');
    const sourceTimeSql = `(CASE WHEN COALESCE(p.AddDate,0)>0 THEN p.AddDate ELSE COALESCE(p.UpdDate,0) END)`;
    source.all(
      `SELECT p.PaymentID,p.SessionID,p.PaymentMethod,p.PaymentAmount,p.PaymentStatus,p.PaymentType,
              p.IsPrepaid,p.IsMoneyChange,p.MoneyChangeAmount,p.Notes,p.AddDate,p.UpdDate,p.MemberID,
              COALESCE(p.Deleted,0) AS Deleted,
              s.SessionID AS LinkedSessionID,s.ClientName AS LinkedClientName,
              s.SessionType AS LinkedSessionType,s.SessionTypeText AS LinkedSessionTypeText,
              s.SessionDetailDataText AS LinkedSessionDetailDataText,
              s.TicketID AS LinkedTicketID,s.TicketSetID AS LinkedTicketSetID,
              s.TicketOrder AS LinkedTicketOrder,s.TicketOrderAmount AS LinkedTicketOrderAmount,
              COALESCE(s.Deleted,0) AS LinkedDeleted
       FROM Payments p
       LEFT JOIN Sessions s ON COALESCE(CAST(p.SessionID AS TEXT),'')<>''
                            AND CAST(s.SessionID AS TEXT)=CAST(p.SessionID AS TEXT)
       WHERE COALESCE(p.Deleted,0)=0
         AND COALESCE(p.IsMoneyChange,0)=0
         AND p.PaymentMethod IN (1,2)
         AND COALESCE(p.PaymentAmount,0)>0
         AND (${sourceTimeSql}>? OR (${sourceTimeSql}=? AND CAST(COALESCE(p.PaymentID,'') AS TEXT)>?))
       ORDER BY ${sourceTimeSql} ASC, CAST(COALESCE(p.PaymentID,'') AS TEXT) ASC
       LIMIT ?`,
      [timeCursor, timeCursor, idCursor, pageSize],
      (readErr, rows) => {
        source.close(() => {});
        if (readErr) return cb(readErr);
        const list = rows || [];
        const last = list[list.length - 1];
        cb(null, {
          rows: list, rawCount: list.length,
          cursorTime: last ? everyCafeOtherPaymentSourceTime(last) : timeCursor,
          cursorId: last ? String(last.PaymentID || idCursor) : idCursor
        });
      }
    );
  });
}

// v3.1.37: Gerçek EveryCafe kurulumunda Expense tablosu yalnız "gider" değildir;
// Kasa Hareketleri kaynağıdır. Type=1 pozitif hareket GELİR (bilet, çıktı/baskı ve
// benzeri masadan bağımsız satış), Type=0 ise gider/iade tarafıdır.
// Kullanıcının istediği kapsam "gider hariç tam entegrasyon" olduğu için yalnız
// Type=1 + pozitif tutar + Nakit/Kart hareketleri gelir kabul edilir.
// Fonksiyon adı eski paketlerle uyumluluk için korunmuştur.
function isEveryCafeTicketCashMovement(row) {
  if (!row) return false;
  const expenseId = Number(row.ExpenseID) || 0;
  const price = Math.round((Number(row.Price) || 0) * 100) / 100;
  const type = Number(row.Type);
  const method = everyCafePaymentMethod(row.PaymentMethod);
  return Boolean(expenseId && type === 1 && price > 0 && (method === "CASH" || method === "CARD"));
}

function everyCafeTicketCashMovementTime(row) {
  return Math.max(0, Number(row && row.AddDate) || 0);
}

function everyCafeTicketCashMovementExternalId(row) {
  return `TICKET_EXPENSE:${Number(row && row.ExpenseID) || 0}`;
}

function readEveryCafeTicketSalesPage(afterTimeSeconds, afterExpenseId, limit, cb) {
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    const finish = (err, result) => source.close(() => cb(err || null, result));
    source.get("SELECT name FROM sqlite_master WHERE type='table' AND name='Expense'", (tableErr, tableRow) => {
      if (tableErr) return finish(tableErr);
      if (!tableRow) return finish(null, { rows: [], rawCount: 0, cursorTime: Math.max(0, Number(afterTimeSeconds)||0), cursorId: Math.max(0, Number(afterExpenseId)||0), supported: false });
      source.all("PRAGMA table_info('Expense')", (schemaErr, columns) => {
        if (schemaErr) return finish(schemaErr);
        const names = new Set((columns || []).map((c) => String(c.name || '')));
        const required = ['ExpenseID','Description','PaymentMethod','Type','Price','AddDate'];
        if (!required.every((name) => names.has(name))) {
          return finish(null, { rows: [], rawCount: 0, cursorTime: Math.max(0, Number(afterTimeSeconds)||0), cursorId: Math.max(0, Number(afterExpenseId)||0), supported: false });
        }
        const pageSize = Math.max(1, Math.min(Number(limit) || EVERYCAFE_LIVE_PAGE_SIZE, 1000));
        const timeCursor = Math.max(0, Math.floor(Number(afterTimeSeconds) || 0));
        const idCursor = Math.max(0, Number(afterExpenseId) || 0);
        const typeSelect = 'e.Type AS Type';
        const cashierSelect = names.has('CashierName') ? 'e.CashierName AS CashierName' : "'' AS CashierName";
        const currencySelect = names.has('CurrencyID') ? 'e.CurrencyID AS CurrencyID' : '1 AS CurrencyID';
        const ticketSelect = names.has('TicketID') ? 'e.TicketID AS TicketID' : 'NULL AS TicketID';
        const memberSelect = names.has('MemberID') ? 'e.MemberID AS MemberID' : 'NULL AS MemberID';
        const printSelect = names.has('PrintJobID') ? 'e.PrintJobID AS PrintJobID' : '0 AS PrintJobID';
        // EveryCafe Kasa Hareketleri: Type=1 gelir, Type=0 gider/iade.
        // Gider entegrasyonu yoktur; yalnız pozitif Nakit/Kart gelirleri taranır.
        source.all(
          `SELECT e.ExpenseID,e.Description,e.PaymentMethod,${typeSelect},e.Price,${cashierSelect},${currencySelect},e.AddDate,${ticketSelect},${memberSelect},${printSelect}
           FROM Expense e
           WHERE COALESCE(e.Type,0)=1
             AND COALESCE(e.Price,0)>0
             AND e.PaymentMethod IN (1,2)
             AND (COALESCE(e.AddDate,0)>? OR (COALESCE(e.AddDate,0)=? AND COALESCE(e.ExpenseID,0)>?))
           ORDER BY e.AddDate ASC,e.ExpenseID ASC LIMIT ?`,
          [timeCursor,timeCursor,idCursor,pageSize],
          (readErr, rows) => {
            if (readErr) return finish(readErr);
            const raw = rows || [];
            const last = raw[raw.length - 1];
            const list = raw.filter(isEveryCafeTicketCashMovement);
            finish(null, {
              rows: list, rawCount: raw.length, supported: true,
              cursorTime: last ? everyCafeTicketCashMovementTime(last) : timeCursor,
              cursorId: last ? (Number(last.ExpenseID) || idCursor) : idCursor
            });
          }
        );
      });
    });
  });
}

// Açık EveryCafe oturumlarının başlangıç anı KafePin'in tek ücret başlangıcıdır.
// Kaynak sadece okunur; burada EveryCafe'ye hiçbir veri yazılmaz.
function readEveryCafeActiveSessions(limit, cb) {
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    source.all(
      `SELECT s.SessionID,s.ClientName,s.StartDate,s.EndDate,s.SessionType,s.SessionTypeText,
              s.SessionDetailDataText,s.Price,s.PaymentAmount,s.GiftTime,
              COALESCE(c.ClientStatus,0) AS ClientStatus
       FROM Sessions s
       LEFT JOIN Clients c ON c.ClientGuid=s.ClientGuid
       WHERE COALESCE(s.Deleted,0)=0
         AND COALESCE(s.IsActive,0)=1
       ORDER BY StartDate ASC LIMIT ?`,
      [Math.max(1, Math.min(Number(limit) || 100, 200))],
      (readErr, rows) => {
        if (readErr) {
          source.close(() => {});
          return cb(readErr);
        }
        const sessions = (rows || []).map((row) => ({
          ...row,
          masa: everyCafeTableNumber(row.ClientName),
          start: Number(row.StartDate) * 1000,
          // EveryCafe sürümlerinde Windows'a geçmiş istemci 1, 4, 128 veya 1024
          // bayrağıyla gelebilir. 128 özellikle ücretsiz oturum açıldığında
          // görülür. Gerçek bekleme ekranı ise tam olarak 2'dir.
          // Aktif Session kaydı varken 1'i bekleme saymak masa ücretini ve
          // çarkı yanlışlıkla durduruyordu.
          isRunning: Number(row.ClientStatus) === 1
            || ((Number(row.ClientStatus) & 4) === 4)
            || ((Number(row.ClientStatus) & 128) === 128)
            || ((Number(row.ClientStatus) & 1024) === 1024)
        })).filter((row) => row.SessionID && row.masa && row.start);
        if (!sessions.length) {
          source.close(() => {});
          return cb(null, []);
        }
        const ids = sessions.map((row) => row.SessionID);
        source.all(
          `SELECT o.OrderID,o.SessionID,o.StockID,o.StockName,o.Quantity,o.Price,o.AddDate,o.OrderIsActive,
                  COALESCE(c.LookupText1,'') AS CategoryName
           FROM Orders o
           LEFT JOIN Stocks s ON s.StockID=o.StockID
           LEFT JOIN LookupValues c ON c.LookupKey='ProductCategories' AND c.LookupValue1=s.CategoryID
           WHERE o.SessionID IN (${ids.map(() => "?").join(",")})
           ORDER BY o.AddDate ASC`,
          ids,
          (orderErr, orderRows) => {
            source.close(() => {});
            if (orderErr) return cb(orderErr);
            const ordersBySession = new Map();
            (orderRows || []).forEach((order) => {
              const list = ordersBySession.get(order.SessionID) || [];
              list.push(order);
              ordersBySession.set(order.SessionID, list);
            });
            cb(null, sessions.map((session) => ({
              ...session,
              orders: ordersBySession.get(session.SessionID) || []
            })));
          }
        );
      }
    );
  });
}

function isEveryCafeFreeSession(session) {
  // EveryCafe'in metni Windows/SQLite kodlamasından farklı biçimde gelebilir.
  // Bu nedenle Türkçe karaktere doğrudan bağlı kalmadan hem oturum türünü hem
  // ayrıntı metnini ASCII'ye normalize ederek kontrol ederiz. SessionType=20,
  // hem baştan ücretsiz açılan hem de ücretli açılıp "Ücretsiz Kapat" yapılan
  // oturumun kaynak işaretidir. İkinci durumda PaymentAmount eski tahmini
  // ücret olarak sıfırlanmadan kalabilir; ücret kararı için kullanılmaz.
  const normalize = (value) => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const typeText = [session && session.SessionTypeText, session && session.SessionDetailDataText]
    .map(normalize)
    .join(" ");
  const explicitFreeText = /(^|\s)(ucretsiz|free|complimentary|gratis)(\s|$)/.test(typeText);
  const freeType = Number(session && session.SessionType) === 20;
  return explicitFreeText || freeType;
}

function importEveryCafeOpenOrders(sourceSession, localStart, cb) {
  const masa = Number(sourceSession.masa) || 0;
  const sourceSessionId = String(sourceSession.SessionID || "");
  const orders = (sourceSession.orders || []).map((order) => ({
    id: String(order.OrderID || "").trim(),
    stockId: Number(order.StockID) || 0,
    name: String(order.StockName || "EveryCafe Ürün").trim().slice(0, 100),
    category: getEveryCafeOrderCategory(order),
    quantity: Math.max(1, Number(order.Quantity) || 1),
    price: Math.max(0, Number(order.Price) || 0),
    time: (Number(order.AddDate) || Number(sourceSession.StartDate)) * 1000,
    active: Number(order.OrderIsActive) !== 0
  })).filter((order) => order.id);
  const activeForLog=orders.filter(o=>o.active);
  const fp=activeForLog.map(o=>`${o.id}:${o.stockId}:${o.name}:${o.quantity}:${Number(o.price).toFixed(2)}`).sort().join('|');
  const prevFp=everyCafeOpenOrderFingerprints.get(sourceSessionId);
  let index = 0;
  // EveryCafe bazı sürümlerde silinen siparişi hiç döndürmez, bazılarında
  // OrderIsActive=0 döndürür. Önce bu açık oturumun eski ürünlerini iptal
  // eder, aşağıda hâlâ aktif olanları tekrar etkinleştiririz; iki durumda da
  // KafePin canlı toplamı kaynakla aynı kalır.
  const clearRemovedOrders = (done) => db.run(
    "UPDATE product_sales SET voided=1,voided_at=? WHERE external_source='EVERYCAFE' AND masa=? AND session_start=? AND status='OPEN' AND voided=0",
    [Date.now(), masa, localStart],
    done
  );
  const finish=(err)=>{
    if(!err){
      everyCafeOpenOrderFingerprints.set(sourceSessionId,fp);
      if(prevFp!==undefined&&prevFp!==fp){
        const total=Math.round(activeForLog.reduce((a,o)=>a+o.quantity*o.price,0)*100)/100;
        addEveryCafeIntegrationLog({category:"PRODUCT",masa,sessionId:sourceSessionId,event:"Açık masadaki ürünler değişti",sourceDetail:`EveryCafe ${activeForLog.length} kalem • ${total.toFixed(2)} ₺`,action:"KafePin açık masa ürünlerini kaynakla eşitledi",result:"Başarılı",details:{products:activeForLog.map(o=>({id:o.id,name:o.name,quantity:o.quantity,price:o.price}))}});
      }
    }
    cb(err||null);
  };
  const next = (err) => {
    if (err || index >= orders.length) return finish(err || null);
    const order = orders[index++];
    const total = Math.round(order.quantity * order.price * 100) / 100;
    const externalId = `ORDER:${order.id}`;
    if (!order.active) {
      return db.run(
        "UPDATE product_sales SET voided=1,voided_at=? WHERE external_source='EVERYCAFE' AND external_id=? AND voided=0",
        [Date.now(), externalId],
        next
      );
    }
    db.run(
      `INSERT OR IGNORE INTO product_sales
       (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
       VALUES (?,?,?,?,?,?,?,? ,?,'TABLE',?,'OPEN',0,'PENDING',0,0,'EVERYCAFE',?)`,
      [order.time, masa, localStart, 0, order.name, order.category, order.price, order.quantity, total,
        `EveryCafe açık oturum: ${sourceSession.SessionID}`, `ORDER:${order.id}`],
      (insertErr) => {
        if (insertErr) return next(insertErr);
        db.run(
          `UPDATE product_sales
           SET time=?,masa=?,session_start=?,product_name=?,category=?,unit_price=?,quantity=?,total=?,status='OPEN',finalized_at=0,payment_method='PENDING',voided=0,voided_at=0
           WHERE external_source='EVERYCAFE' AND external_id=?`,
          [order.time, masa, localStart, order.name, order.category, order.price, order.quantity, total, externalId],
          next
        );
      }
    );
  };
  clearRemovedOrders((clearErr) => next(clearErr || null));
}

// EveryCafe aynı SessionID'yi başka masaya taşıdığında KafePin'deki açık
// müşteri kaydını da taşır. Süre, ürün ve kullanılmamış ödül aynı müşteride kalır.
function transferEveryCafeActiveSession(from, to, cb) {
  if (!from || !to || from === to) return cb(null, { skipped: true });
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { return err ? reject(err) : resolve(this.changes || 0); });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
  });
  (async () => {
    let transaction = false;
    setLock(from, Date.now() + LOCK_MS);
    setLock(to, Date.now() + LOCK_MS);
    try {
      const source = await get("SELECT * FROM sessions WHERE masa=? AND (end_time=0 OR end_time IS NULL)", [from]);
      const target = await get("SELECT masa FROM sessions WHERE masa=? AND (end_time=0 OR end_time IS NULL)", [to]);
      if (target) throw new Error(`Masa ${to} üzerinde zaten açık bir KafePin oturumu var`);
      if (!source) {
        // Ücretsiz EveryCafe oturumlarında KafePin `sessions` satırı oluşturmaz.
        // Buna rağmen müşteri masa değiştirirse index tarafından daha önce
        // başlatılmış çark sayacı/hakkı müşteriyi takip etmelidir.
        await run("BEGIN IMMEDIATE TRANSACTION");
        transaction = true;
        await run("DELETE FROM masalar WHERE masa=?", [to]);
        await run("DELETE FROM spin_page_sessions WHERE masa=?", [to]);
        await run("DELETE FROM spin_ready_notifications WHERE masa=?", [to]);
        await run("UPDATE masalar SET masa=? WHERE masa=?", [to, from]);
        await run("UPDATE spin_page_sessions SET masa=? WHERE masa=?", [to, from]);
        await run("UPDATE spin_ready_notifications SET masa=? WHERE masa=?", [to, from]);
        await run("UPDATE spins SET masa=? WHERE masa=? AND used=0", [to, from]);
        await run("UPDATE spins_log SET masa=? WHERE masa=? AND used=0", [to, from]);
        await run("UPDATE free_masalar SET enabled=0,set_time=? WHERE masa=? AND enabled=1", [Date.now(), from]);
        await run("COMMIT");
        transaction = false;

        freeMasalar.delete(from);
        delete aktifMasalar[from];

        masaPingStats[to] = masaPingStats[from] || masaPingStats[to];
        delete masaPingStats[from];
        latestRewardMap[to] = latestRewardMap[from] || latestRewardMap[to] || null;
        delete latestRewardMap[from];
        offlineCount[to] = offlineCount[from] || 0;
        offlineCount[from] = 0;
        lastOfflineState[to] = lastOfflineState[from] || false;
        lastOfflineState[from] = false;

        everyCafeSessionTypes.delete(from);
        everyCafeTimedSessions.delete(from);
        everyCafeScheduledEnds.delete(from);
        everyCafeGiftMinutes.delete(from);

        masaCloseLocks[from] = Date.now() + 30000;
        masaCloseLocks[to] = Date.now() + 10000;
        addLiveLog("everycafe_transfer", `🔄 EveryCafe ücretsiz masa aktarımı • Masa ${from} → ${to} • çark hakkı/süresi korundu`);
        addEveryCafeIntegrationLog({category:"TRANSFER",masa:to,event:`Masa taşıma • ${from} → ${to}`,sourceDetail:"EveryCafe aynı ücretsiz müşteriyi yeni masada bildirdi",action:"KafePin varsa çark sayacı + hazır/kullanılmamış hak + ödül durumunu taşıdı",result:"Başarılı • index kuralı korundu • yeni sayaç başlatılmadı",details:{from,to,free:true}});
        return cb(null, { moved: true, free: true });
      }
      await run("BEGIN IMMEDIATE TRANSACTION");
      transaction = true;
      const moved = await run("UPDATE sessions SET masa=? WHERE masa=? AND start_time=?", [to, from, source.start_time]);
      if (moved !== 1) throw new Error("Açık oturum yeni masaya taşınamadı");
      // Müşteri EveryCafe'de başka masaya taşındığında çark durumu da müşteriyi
      // takip eder: varsa kalan 45 dk sayacı, hazır hak ve kullanılmamış spin
      // yeni masaya aynen taşınır. Çark hiç açılmadıysa `masalar` satırı yoktur;
      // bu durumda hedef client index'i açana kadar sayaç yine başlamaz.
      await run("DELETE FROM masalar WHERE masa=?", [to]);
      await run("DELETE FROM spin_page_sessions WHERE masa=?", [to]);
      await run("DELETE FROM spin_ready_notifications WHERE masa=?", [to]);
      await run("UPDATE masalar SET masa=? WHERE masa=?", [to, from]);
      await run("UPDATE spin_page_sessions SET masa=? WHERE masa=?", [to, from]);
      await run("UPDATE spin_ready_notifications SET masa=? WHERE masa=?", [to, from]);
      await run("UPDATE spins SET masa=? WHERE masa=? AND used=0", [to, from]);
      await run("UPDATE spins_log SET masa=? WHERE masa=? AND used=0", [to, from]);
      await run("UPDATE real_adjustments SET masa=? WHERE masa=? AND session_start=?", [to, from, source.start_time]);
      await run("UPDATE product_sales SET masa=?,session_start=? WHERE masa=? AND session_start=? AND status='OPEN' AND voided=0", [to, source.start_time, from, source.start_time]);
      await run("COMMIT");
      transaction = false;
      aktifMasalar[to] = aktifMasalar[from] || source.last_seen || Date.now();
      delete aktifMasalar[from];
      everyCafeSessionTypes.set(to, String(everyCafeSessionTypes.get(from) || ""));
      everyCafeTimedSessions.set(to, isEveryCafeTimedMasa(from));
      everyCafeScheduledEnds.set(to, getEveryCafeScheduledEnd(from));
      everyCafeGiftMinutes.set(to, getEveryCafeGiftMinutes(from));
      everyCafeGiftMinutes.delete(from);
      everyCafeSessionTypes.delete(from);
      everyCafeTimedSessions.delete(from);
      everyCafeScheduledEnds.delete(from);
      masaPingStats[to] = masaPingStats[from] || masaPingStats[to];
      delete masaPingStats[from];
      latestRewardMap[to] = latestRewardMap[from] || latestRewardMap[to] || null;
      delete latestRewardMap[from];
      offlineCount[to] = offlineCount[from] || 0;
      offlineCount[from] = 0;
      lastOfflineState[to] = lastOfflineState[from] || false;
      lastOfflineState[from] = false;
      masaCloseLocks[from] = Date.now() + 30000;
      masaCloseLocks[to] = Date.now() + 10000;
      addLiveLog("everycafe_transfer", `🔄 EveryCafe masa aktarımı • Masa ${from} → ${to} • ürünler ve süre taşındı`);
      addEveryCafeIntegrationLog({category:"TRANSFER",masa:to,event:`Masa taşıma • ${from} → ${to}`,sourceDetail:`EveryCafe başlangıç korundu: ${everyCafeIntegrationTimeText(source.start_time)}`,action:"KafePin session + açık ürünler + kalan çark süresi + hazır/kullanılmamış hak + ödül durumunu taşıdı",result:"Başarılı • index/server çark kuralı korundu",details:{from,to,startTime:source.start_time}});
      cb(null, { moved: true, free: false });
    } catch (err) {
      if (transaction) { try { await run("ROLLBACK"); } catch (_rollbackErr) {} }
      cb(err);
    } finally {
      sessionLocks.delete(from);
      sessionLocks.delete(to);
      db.run("DELETE FROM session_locks WHERE masa IN (?,?)", [from, to], () => {});
    }
  })();
}

// Bekleme ekranındaki EveryCafe kaydı KafePin'de oturum, ücret veya ödeme yaratmaz.
// Eski sürümden kalmış aynı geçici kayıt varsa yalnızca o kaynak oturuma ait olanı temizler.
function clearEveryCafeWaitingSession(sourceSession, cb = () => {}) {
  const sessionId = String(sourceSession.SessionID || "");
  const masa = Number(sourceSession.masa) || 0;
  const start = Number(sourceSession.start) || 0;
  if (!sessionId || !masa || !start) return cb(null, { cleared: false });
  db.get(
    "SELECT masa,source_start FROM everycafe_active_sessions WHERE session_id=?",
    [sessionId],
    (mapErr, mapping) => {
      if (mapErr) return cb(mapErr);
      if (!mapping) return cb(null, { cleared: false });
      const mappedMasa = Number(mapping.masa) || masa;
      const mappedStart = Number(mapping.source_start) || start;
      db.serialize(() => {
        db.run("BEGIN IMMEDIATE", (beginErr) => {
          if (beginErr) return cb(beginErr);
          const rollback = (err) => db.run("ROLLBACK", () => cb(err));
          db.run(
            "DELETE FROM product_sales WHERE external_source='EVERYCAFE' AND masa=? AND session_start=? AND status='OPEN' AND voided=0",
            [mappedMasa, mappedStart],
            (productErr) => {
              if (productErr) return rollback(productErr);
              db.run(
                "DELETE FROM sessions WHERE masa=? AND start_time=?",
                [mappedMasa, mappedStart],
                (sessionErr) => {
                  if (sessionErr) return rollback(sessionErr);
                  db.run("DELETE FROM spin_page_sessions WHERE session_id=?", [sessionId], (pageResetErr) => {
                    if (pageResetErr) return rollback(pageResetErr);
                  db.run("DELETE FROM spin_ready_notifications WHERE session_id=?", [sessionId], (notifyResetErr) => {
                    if (notifyResetErr) return rollback(notifyResetErr);
                  db.run("DELETE FROM everycafe_active_sessions WHERE session_id=?", [sessionId], (deleteErr) => {
                    if (deleteErr) return rollback(deleteErr);
                    db.run("COMMIT", (commitErr) => {
                      if (commitErr) return rollback(commitErr);
                      delete aktifMasalar[mappedMasa];
                      everyCafeSessionTypes.delete(mappedMasa);
                      everyCafeTimedSessions.delete(mappedMasa);
                      everyCafeScheduledEnds.delete(mappedMasa);
                      everyCafeGiftMinutes.delete(mappedMasa);
                      addLiveLog("everycafe_waiting", `EveryCafe bekleme kaydı temizlendi • Masa ${mappedMasa}`);
                      addEveryCafeIntegrationLog({category:"WAITING",masa:mappedMasa,sessionId,event:"Masa Beklemede",sourceDetail:"EveryCafe istemci henüz aktif değil / artık aktif değil",action:"KafePin geçici ücret oturumunu ve açık EveryCafe ürünlerini temizledi",result:"Başarılı • çark sayacı/hakkı değiştirilmedi"});
                      cb(null, { cleared: true });
                    });
                  });
                  });
                  });
                }
              );
            }
          );
        });
      });
    }
  );
}

// Eski sürümde bekleme ekranı yanlışlıkla kısa bir offline oturumu gibi
// kapanmışsa ödeme bekliyor ve gelir kaydı bırakabiliyordu. Gerçek müşteri
// daha Windows'a geçmeden 2 dk altında biten bu kayıtlar ücretlendirilemez.
function clearInvalidShortOfflinePendingSessions(cb = () => {}) {
  const maxDuration = 2 * 60 * 1000;
  db.all(
    `SELECT id,masa,session_start
     FROM payments
     WHERE COALESCE(voided,0)=0 AND method='PENDING' AND source='SESSION'
       AND close_reason='OFFLINE_8_MIN' AND session_end>session_start
       AND session_end-session_start<?`,
    [maxDuration],
    (readErr, rows) => {
      if (readErr || !(rows || []).length) return cb(readErr || null, { cleared: 0 });
      let index = 0;
      let cleared = 0;
      const next = () => {
        if (index >= rows.length) return cb(null, { cleared });
        const row = rows[index++];
        db.serialize(() => {
          db.run("BEGIN IMMEDIATE", (beginErr) => {
            if (beginErr) return cb(beginErr);
            const rollback = (err) => db.run("ROLLBACK", () => cb(err));
            db.run("UPDATE payments SET voided=1,voided_at=? WHERE id=?", [Date.now(), row.id], (paymentErr) => {
              if (paymentErr) return rollback(paymentErr);
              db.run("DELETE FROM real_adjustments WHERE masa=? AND session_start=? AND kind='SESSION_FINALIZE'", [row.masa, row.session_start], (adjustErr) => {
                if (adjustErr) return rollback(adjustErr);
                db.run("DELETE FROM session_history WHERE masa=? AND start_time=?", [row.masa, row.session_start], (historyErr) => {
                  if (historyErr) return rollback(historyErr);
                  db.run("COMMIT", (commitErr) => {
                    if (commitErr) return rollback(commitErr);
                    cleared += 1;
                    addLiveLog("everycafe_waiting", `EveryCafe bekleme kaydındaki hatalı ödeme temizlendi • Masa ${row.masa}`);
                    next();
                  });
                });
              });
            });
          });
        });
      };
      next();
    }
  );
}

// EveryCafe bekleme ekranında henüz Sessions kaydı oluşmaz; istemci durumu
// 2'dir. Bu durumda KafePin'in normal ping mekanizmasının açtığı geçici
// oturumu temizler, fakat masa monitörde "Beklemede" olarak kalır.
function readEveryCafeWaitingTables(limit, cb) {
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    source.all(
      `SELECT ClientName,ClientStatus,ClientLastCheck
       FROM Clients
       WHERE COALESCE(ClientStatus,0)=2 AND COALESCE(ClientIsDeleted,0)=0
       ORDER BY ClientName ASC LIMIT ?`,
      [Math.max(1, Math.min(Number(limit) || 100, 200))],
      (readErr, rows) => {
        source.close(() => {});
        if (readErr) return cb(readErr);
        cb(null, (rows || [])
          .map((row) => ({ masa: everyCafeTableNumber(row.ClientName), name: row.ClientName }))
          .filter((row) => row.masa > 0));
      }
    );
  });
}

// Ping akışında EveryCafe dosyasını her seferinde okumamak için 3 sn
// önbellek kullanır. Bekleme ekranında ilk ping dahi oturum oluşturmaz.
function isEveryCafeClientWaiting(masa, cb) {
  const key = Number(masa);
  // Daha önce EveryCafe aktif oturumu eşlenmişse ClientStatus geçici olarak 2/0
  // olsa bile bu bir PC restartı/ağ kopması olabilir. Açık Session kaydı
  // kapanmadıkça bekleme kabul etmeyiz.
  db.get(
    "SELECT 1 AS ok FROM everycafe_active_sessions WHERE masa=? LIMIT 1",
    [key],
    (mapErr, mapping) => {
      if (mapErr) return cb(mapErr);
      if (mapping) return cb(null, false);
      const cached = everyCafeWaitingLookupCache.get(key);
      const now = Date.now();
      if (cached && now - cached.checkedAt < 3000) return cb(null, cached.waiting);
      readEveryCafeWaitingTables(100, (readErr, tables) => {
        if (readErr) return cb(readErr);
        const waitingSet = new Set((tables || []).map((row) => Number(row.masa)));
        everyCafeWaitingLookupCache.set(key, { checkedAt: now, waiting: waitingSet.has(key) });
        cb(null, waitingSet.has(key));
      });
    }
  );
}

function setEveryCafeWaitingMasa(masa, now, cb = () => {}) {
  const key = Number(masa) || 0;
  if (!key) return cb(null);
  // Aktif EveryCafe eşlemesi varsa ClientStatus değişimi müşteriyi kapatamaz.
  // Bu durum PC restart/donma/ağ kopması olarak değerlendirilir.
  db.get(
    "SELECT session_id,source_start FROM everycafe_active_sessions WHERE masa=? LIMIT 1",
    [key],
    (mapErr, mapping) => {
      if (mapErr) return cb(mapErr);
      if (mapping) {
        everyCafeWaitingMasalar.delete(key);
        return cb(null, { preservedActive: true });
      }
      everyCafeWaitingMasalar.set(key, { waitingAt: now, clientWaiting: true, cleaned: true });
      // Henüz aktif EveryCafe oturumu olmayan bekleme ekranı eski müşteriden
      // kalmış runtime/sayaç yaratamaz. Finans kaydına dokunmadan yalnız canlı
      // müşteri durumunu temizleriz.
      db.serialize(() => {
        db.run("BEGIN IMMEDIATE", (beginErr) => {
          if (beginErr) return cb(beginErr);
          const rollback = (err) => db.run("ROLLBACK", () => cb(err));
          db.run("DELETE FROM sessions WHERE masa=? AND COALESCE(end_time,0)=0", [key], (sessionErr) => {
            if (sessionErr) return rollback(sessionErr);
            db.run("DELETE FROM masalar WHERE masa=?", [key], (timerErr) => {
              if (timerErr) return rollback(timerErr);
              db.run("COMMIT", (commitErr) => {
                if (commitErr) return rollback(commitErr);
                delete aktifMasalar[key];
                delete latestRewardMap[key];
                return cb(null, { preservedActive: false });
              });
            });
          });
        });
      });
    }
  );
}

function syncEveryCafeWaitingTables(cb = () => {}) {
  readEveryCafeWaitingTables(100, (readErr, tables) => {
    if (readErr) return cb(readErr);
    const seen = new Set((tables || []).map((row) => Number(row.masa)));
    let index = 0;
    const next = () => {
      if (index >= tables.length) {
        for (const [masa, state] of everyCafeWaitingMasalar.entries()) {
          if (state && state.clientWaiting && !seen.has(masa)) everyCafeWaitingMasalar.delete(masa);
        }
        return cb(null, { waiting: seen.size });
      }
      setEveryCafeWaitingMasa(Number(tables[index++].masa), Date.now(), (setErr) => {
        if (setErr) return cb(setErr);
        next();
      });
    };
    next();
  });
}

// EveryCafe kaynak oturumu artık IsActive=1 listesinde değilse müşteri
// bitmiştir. Ücretli/ücretsiz fark etmez: KafePin canlı runtime'ı anında yeni
// müşteriye hazırlanır. Tahsilat/ücretsiz kapanışın kesin finans kaydı ayrı
// kapanış senkronunda salt-okunur kaynaktan birkaç saniye sonra doğrulanır.
function prepareEveryCafeClosedRuntime(mapping, cb = () => {}) {
  const sessionId = String(mapping && mapping.session_id || "");
  const masa = Number(mapping && mapping.masa) || 0;
  const sourceStart = Number(mapping && mapping.source_start) || 0;
  if (!sessionId || !masa) return cb(null, { skipped: true });
  const now = Date.now();
  db.serialize(() => {
    db.run("BEGIN IMMEDIATE", (beginErr) => {
      if (beginErr) return cb(beginErr);
      const rollback = (err) => db.run("ROLLBACK", () => cb(err));
      db.run("DELETE FROM everycafe_active_sessions WHERE session_id=?", [sessionId], (mapErr) => {
        if (mapErr) return rollback(mapErr);
        // Aktif satırı admin ekranından anında kaldırırken, birkaç saniye sonra
        // gelecek gerçek EveryCafe kapanışının aynı müşteriyi normal CLOSE olarak
        // eşleyebilmesi için 0 TL'lik geçici bir history işareti bırakırız.
        // Gerçek kapanış senkronu bu satırı silip kaynak süre/tutarıyla yeniden yazar.
        const pendingMinutes = sourceStart ? Math.max(0, Math.floor((now - sourceStart) / 60000)) : 0;
        const addPendingHistory = (done) => {
          if (!sourceStart) return done(null);
          db.run(
            `INSERT INTO session_history
             (masa,start_time,end_time,last_seen,minutes,fee,adjustment,close_reason,note,created_at)
             VALUES(?,?,?,?,?,0,0,'EVERYCAFE_PENDING','EveryCafe gerçek kapanış kaydı bekleniyor',?)`,
            [masa, sourceStart, now, now, pendingMinutes, now],
            done
          );
        };
        addPendingHistory((historyErr) => {
          if (historyErr) return rollback(historyErr);
          const deleteSessionSql = sourceStart
            ? "DELETE FROM sessions WHERE masa=? AND start_time=? AND COALESCE(end_time,0)=0"
            : "DELETE FROM sessions WHERE masa=? AND COALESCE(end_time,0)=0";
          const deleteSessionParams = sourceStart ? [masa, sourceStart] : [masa];
          db.run(deleteSessionSql, deleteSessionParams, (sessionErr) => {
            if (sessionErr) return rollback(sessionErr);
            db.run(
              "UPDATE product_sales SET voided=1,voided_at=? WHERE external_source='EVERYCAFE' AND masa=? AND session_start=? AND status='OPEN' AND voided=0",
              [now, masa, sourceStart],
              (productErr) => {
              if (productErr) return rollback(productErr);
              db.run("DELETE FROM masalar WHERE masa=?", [masa], (timerErr) => {
                if (timerErr) return rollback(timerErr);
                db.run("DELETE FROM spin_page_sessions WHERE session_id=?", [sessionId], (pageResetErr) => {
                  if (pageResetErr) return rollback(pageResetErr);
                db.run("DELETE FROM spin_ready_notifications WHERE session_id=?", [sessionId], (notifyResetErr) => {
                  if (notifyResetErr) return rollback(notifyResetErr);
                db.run("UPDATE free_masalar SET enabled=0,set_time=? WHERE masa=? AND enabled=1", [now, masa], (freeErr) => {
                  if (freeErr) return rollback(freeErr);
                  db.run("COMMIT", (commitErr) => {
                    if (commitErr) return rollback(commitErr);
                    freeMasalar.delete(masa);
                    delete aktifMasalar[masa];
                    delete latestRewardMap[masa];
                    delete offlineCount[masa];
                    delete lastOfflineState[masa];
                    delete tokenTracker[masa];
                    everyCafeWaitingMasalar.delete(masa);
                    everyCafeWaitingLookupCache.delete(masa);
                    everyCafeSessionTypes.delete(masa);
                    everyCafeTimedSessions.delete(masa);
                    everyCafeScheduledEnds.delete(masa);
                    everyCafeGiftMinutes.delete(masa);
                    everyCafeOpenOrderFingerprints.delete(sessionId);
                    delete masaCloseLocks[masa];
                    if (masaPingStats[masa]) {
                      masaPingStats[masa].last = 0;
                      masaPingStats[masa].avg = PING_INTERVAL_MS;
                      masaPingStats[masa].lastSeen = 0;
                      masaPingStats[masa].netSpeed = 0;
                      masaPingStats[masa].connectedLogged = false;
                    }
                    addLiveLog("everycafe_runtime_close", `🔴 EveryCafe kapandı • Masa ${masa} anında yeni müşteriye hazırlandı`);
                    addEveryCafeIntegrationLog({
                      category:"CLOSE", masa, sessionId, event:"EveryCafe aktif oturumu bitti",
                      sourceDetail:`IsActive listesinde yok • başlangıç ${everyCafeIntegrationTimeText(sourceStart)}`,
                      action:"KafePin runtime + çark sayacı + açık müşteri görünümü anında temizlendi",
                      result:"Yeni müşteriye hazır • finans kapanışı kaynak kayıttan ayrıca doğrulanacak",
                      details:{sourceStart,detectedAt:now}
                    });
                    cb(null, { closed: true, masa, sessionId });
                  });
                });
                });
              });
              });
              }
            );
          });
        });
      });
    });
  });
}

function syncEveryCafeActiveSessionsCore(cb = () => {}) {
  getEveryCafeConfig((configErr, config) => {
    if (configErr || !config.enabled || !config.startAt) {
      return cb(configErr || null, { skipped: true, reason: "disabled" });
    }
    readEveryCafeActiveSessions(100, (readErr, sessions) => {
      if (readErr) return cb(readErr);
      const now = Date.now();
      const sourceSessions = sessions || [];
      const sourceIds = new Set(sourceSessions.map((row) => String(row.SessionID || "")).filter(Boolean));

      // Önce kaynakta artık açık olmayan eski eşlemeleri temizle. Bu, EveryCafe
      // hesap kesildiğinde eski müşteriyi en geç bir 5 sn senkron turunda kaldırır.
      db.all(
        "SELECT session_id,masa,source_start,source_type FROM everycafe_active_sessions ORDER BY masa",
        (mapReadErr, mappings) => {
          if (mapReadErr) return cb(mapReadErr);
          const staleMappings = (mappings || []).filter((row) => !sourceIds.has(String(row.session_id || "")));
          let staleIndex = 0;
          const closeNextStale = () => {
            if (staleIndex >= staleMappings.length) return processSourceSessions();
            prepareEveryCafeClosedRuntime(staleMappings[staleIndex++], (closeErr) => {
              if (closeErr) return cb(closeErr);
              closeNextStale();
            });
          };

          const processSourceSessions = () => {
            let index = 0;
            let synced = 0;
            const waitingSeen = new Set();
            const next = () => {
              if (index >= sourceSessions.length) {
                for (const masa of everyCafeWaitingMasalar.keys()) {
                  const state = everyCafeWaitingMasalar.get(masa);
                  if (!waitingSeen.has(masa) && !(state && state.clientWaiting)) everyCafeWaitingMasalar.delete(masa);
                }
                return cb(null, { synced, checked: sourceSessions.length, waiting: waitingSeen.size, closed: staleMappings.length });
              }
              const sourceSession = sourceSessions[index++];
              const sessionId = String(sourceSession.SessionID);
              const masa = Number(sourceSession.masa);
              const start = Number(sourceSession.start);

              db.get(
                "SELECT masa,source_start FROM everycafe_active_sessions WHERE session_id=?",
                [sessionId],
                (existingMapErr, existingMap) => {
                  if (existingMapErr) return cb(existingMapErr);

                  // Session EveryCafe'de hâlâ IsActive=1 ise müşteri devam eder.
                  // ClientStatus geçici olarak running değilse ve bu Session daha
                  // önce eşlendiyse bunu PC restart/donma/ağ kopması kabul ederiz.
                  if (!sourceSession.isRunning && existingMap) {
                    everyCafeWaitingMasalar.delete(masa);
                    everyCafeWaitingLookupCache.delete(masa);
                    return db.run(
                      "UPDATE everycafe_active_sessions SET last_seen=?,source_type=? WHERE session_id=?",
                      [now, String(sourceSession.SessionTypeText || ""), sessionId],
                      (touchErr) => {
                        if (touchErr) return cb(touchErr);
                        everyCafeSessionTypes.set(masa, String(sourceSession.SessionTypeText || ""));
                        everyCafeTimedSessions.set(masa, Number(sourceSession.EndDate) > Number(sourceSession.StartDate));
                        everyCafeScheduledEnds.set(masa, Math.max(0, Number(sourceSession.EndDate) * 1000 || 0));
                        everyCafeGiftMinutes.set(masa, everyCafeGiftMinutesFromSource(sourceSession.GiftTime));
                        db.run(
                          "UPDATE sessions SET last_seen=CASE WHEN COALESCE(last_seen,0)>? THEN last_seen ELSE ? END WHERE masa=? AND start_time=? AND COALESCE(end_time,0)=0",
                          [now, now, masa, start],
                          (sessionTouchErr) => {
                            if (sessionTouchErr) return cb(sessionTouchErr);
                            synced += 1;
                            next();
                          }
                        );
                      }
                    );
                  }

                  // Henüz hiç aktifleşmemiş yeni EveryCafe bekleme kaydıdır;
                  // KafePin session/çark başlatmaz.
                  if (!sourceSession.isRunning) {
                    everyCafeWaitingMasalar.set(masa, { sessionId, start, waitingAt: now, clientWaiting: true, cleaned: true });
                    waitingSeen.add(masa);
                    return clearEveryCafeWaitingSession(sourceSession, (waitingErr) => {
                      if (waitingErr) return cb(waitingErr);
                      return next();
                    });
                  }

                  const saveMapping = (mappingState = {}) => db.run(
                    `INSERT OR REPLACE INTO everycafe_active_sessions(session_id,masa,source_start,last_seen,source_type)
                     VALUES(?,?,?,?,?)`,
                    [sessionId, masa, start, now, String(sourceSession.SessionTypeText || "")],
                    (mapErr) => {
                      if (mapErr) return cb(mapErr);
                      everyCafeSessionTypes.set(masa, String(sourceSession.SessionTypeText || ""));
                      everyCafeWaitingMasalar.delete(masa);
                      everyCafeWaitingLookupCache.delete(masa);
                      everyCafeRecentlyClosedMasalar.delete(masa);
                      everyCafeTimedSessions.set(masa, Number(sourceSession.EndDate) > Number(sourceSession.StartDate));
                      everyCafeScheduledEnds.set(masa, Math.max(0, Number(sourceSession.EndDate) * 1000 || 0));
                      everyCafeGiftMinutes.set(masa, everyCafeGiftMinutesFromSource(sourceSession.GiftTime));
                      if (isEveryCafeFreeSession(sourceSession)) {
                        return db.run(
                          "INSERT INTO free_masalar(masa,enabled,set_time) VALUES(?,?,?) ON CONFLICT(masa) DO UPDATE SET enabled=1,set_time=excluded.set_time",
                          [masa, 1, now],
                          (freeErr) => {
                            if (freeErr) return cb(freeErr);
                            freeMasalar.add(masa);
                            aktifMasalar[masa] = now;
                            db.run("DELETE FROM sessions WHERE masa=?", [masa], (deleteErr) => {
                              if (deleteErr) return cb(deleteErr);
                              if(mappingState.isNew)addEveryCafeIntegrationLog({category:"SESSION",masa,sessionId,event:"Ücretsiz masa açıldı",sourceDetail:`EveryCafe başlangıç: ${everyCafeIntegrationTimeText(start)} • ${String(sourceSession.SessionTypeText||"Ücretsiz")}`,action:"KafePin ücretsiz / 0 TL eşledi; ücret sessionı oluşturmadı",result:"Başarılı • çark/index alanına müdahale yok",details:{startTime:start}});
                              synced += 1;
                              next();
                            });
                          }
                        );
                      }
                      if (isFreeMasa(masa)) {
                        freeMasalar.delete(masa);
                        db.run("UPDATE free_masalar SET enabled=0,set_time=? WHERE masa=?", [now, masa], () => {});
                      }
                      db.get("SELECT masa,start_time,end_time FROM sessions WHERE masa=?", [masa], (sessionErr, local) => {
                        if (sessionErr) return cb(sessionErr);
                        const write = !local || Number(local.end_time) > 0
                          ? `INSERT INTO sessions (masa,start_time,last_seen,end_time,final_fee)
                             VALUES (?,?,?,0,0)
                             ON CONFLICT(masa) DO UPDATE SET start_time=excluded.start_time,last_seen=excluded.last_seen,end_time=0,final_fee=0`
                          : "UPDATE sessions SET start_time=?, last_seen=CASE WHEN COALESCE(last_seen,0)>? THEN last_seen ELSE ? END, end_time=0, final_fee=0 WHERE masa=?";
                        const params = !local || Number(local.end_time) > 0
                          ? [masa, start, now]
                          : [start, now, now, masa];
                        db.run(write, params, (writeErr) => {
                          if (writeErr) return cb(writeErr);
                          aktifMasalar[masa] = now;
                          importEveryCafeOpenOrders(sourceSession, start, (orderErr) => {
                            if (orderErr) return cb(orderErr);
                            if(mappingState.isNew){const oo=(sourceSession.orders||[]).filter(o=>Number(o.OrderIsActive)!==0);const pt=Math.round(oo.reduce((a,o)=>a+Math.max(1,Number(o.Quantity)||1)*Math.max(0,Number(o.Price)||0),0)*100)/100;addEveryCafeIntegrationLog({category:"SESSION",masa,sessionId,event:"Masa açıldı",sourceDetail:`EveryCafe başlangıç: ${everyCafeIntegrationTimeText(start)} • ${String(sourceSession.SessionTypeText||"Oturum")}`,action:`KafePin sessions.start_time uyguladı • ${oo.length} ürün / ${pt.toFixed(2)} ₺ eşlendi`,result:"Başarılı • masalar.start_time/çark sayacı değiştirilmedi",details:{startTime:start,products:oo.length,productTotal:pt}});}
                            synced += 1;
                            next();
                          });
                        });
                      });
                    }
                  );

                  const previousMasa = Number(existingMap && existingMap.masa) || 0;
                  if (!previousMasa || previousMasa === masa) return saveMapping({isNew:!previousMasa});
                  db.get(
                    "SELECT session_id FROM everycafe_active_sessions WHERE masa=? AND session_id<>?",
                    [masa, sessionId],
                    (targetMapErr, targetMap) => {
                      if (targetMapErr) return cb(targetMapErr);
                      if (targetMap) return cb(new Error(`EveryCafe hedef masa ${masa} için başka açık oturum bildiriyor`));
                      transferEveryCafeActiveSession(previousMasa, masa, (transferErr) => {
                        if (transferErr) return cb(transferErr);
                        saveMapping({transferredFrom:previousMasa});
                      });
                    }
                  );
                }
              );
            };
            next();
          };

          closeNextStale();
        }
      );
    });
  });
}

function syncEveryCafeActiveSessions(cb = () => {}) {
  if (everyCafeActiveSyncRunning) return cb(null, { skipped: true, reason: "busy" });
  everyCafeActiveSyncRunning = true;
  let finished = false;
  const finish = (err, result) => {
    if (finished) return;
    finished = true;
    everyCafeActiveSyncRunning = false;
    cb(err || null, result || {});
  };

  getEveryCafeConfig((configErr, config) => {
    if (configErr || !config.enabled || !config.startAt) {
      return finish(configErr || null, { skipped: true, reason: "disabled" });
    }
    syncEveryCafeWaitingTables((waitingErr) => {
      if (waitingErr) return finish(waitingErr);
      syncEveryCafeActiveSessionsCore(finish);
    });
  });
}

// EveryCafe kapanışında yalnız kapanmış eski oturuma ait çark zamanlayıcısını
// siler. Başka müşteri bu masayı bu arada yeniden açtıysa (start_time > end)
// onun yeni zamanlayıcısına dokunmaz.
function clearClosedEveryCafeMasaTimer(masa, endTime, cb = () => {}) {
  db.run(
    "DELETE FROM masalar WHERE masa=? AND COALESCE(start_time,0)<=?",
    [masa, endTime],
    (err) => {
      if (err) logErr("clearClosedEveryCafeMasaTimer", err);
      cb(err || null);
    }
  );
}

function everyCafeOtherIncomeName(value, fallback = "EveryCafe Bilet / Diğer Gelir") {
  const text = String(value || "").trim();
  const norm = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ç/g, "c").replace(/ö/g, "o").replace(/ü/g, "u");
  if (/bilet|ticket/.test(norm)) return "EveryCafe Bilet";
  if (/e[- ]?pin|epin/.test(norm)) return "EveryCafe E-Pin";
  if (/teknik|servis|service/.test(norm)) return "EveryCafe Teknik Servis";
  if (/cikti|print|baski/.test(norm)) return "EveryCafe Çıktı / Baskı";
  return text ? text.slice(0, 100) : fallback;
}

function importEveryCafeOtherIncome(data, cb) {
  const externalId = String(data && data.externalId || "").trim();
  const sourceTime = Math.max(0, Number(data && data.sourceTime) || 0);
  const total = Math.round((Number(data && data.total) || 0) * 100) / 100;
  const method = String(data && data.method || "PENDING");
  const sourceSessionId = String(data && data.sourceSessionId || "").trim();
  const name = everyCafeOtherIncomeName(data && data.name);
  const note = String(data && data.note || "").trim().slice(0, 180);
  if (!externalId || !sourceTime || total <= 0 || !["CASH","CARD"].includes(method)) {
    return cb(null, { skipped: true });
  }
  const checkExisting = sourceSessionId
    ? ["SELECT 1 AS ok FROM everycafe_imports WHERE session_id=?", [sourceSessionId]]
    : ["SELECT 1 AS ok FROM payments WHERE voided=0 AND external_source='EVERYCAFE_OTHER' AND external_id=?", [externalId]];
  db.get(checkExisting[0], checkExisting[1], (existingErr, existing) => {
    if (existingErr) return cb(existingErr);
    if (existing) return cb(null, { skipped: true });
    db.serialize(() => {
      db.run("BEGIN IMMEDIATE", (beginErr) => {
        if (beginErr) return cb(beginErr);
        let failed = false;
        const fail = (err) => {
          if (failed) return;
          failed = true;
          db.run("ROLLBACK", () => cb(err));
        };
        db.run(
          `INSERT INTO product_sales
           (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
           VALUES (?,0,0,0,?,'EveryCafe Diğer Gelir',?,1,?,'DIRECT',?,'FINALIZED',?,?,0,0,'EVERYCAFE_OTHER',?)`,
          [sourceTime, name, total, total, `EveryCafe canlı kasa geliri${note ? ` • ${note}` : ""}`, sourceTime, method, externalId],
          function (saleErr) {
            if (saleErr) return fail(saleErr);
            const saleId = this.lastID;
            db.run(
              `INSERT INTO payments
               (created_at,paid_at,masa,session_start,session_end,product_sale_id,computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at,external_source,external_id)
               VALUES (?,?,0,0,0,?,0,?,?,?,'EVERYCAFE_OTHER','EVERYCAFE_OTHER',?,0,0,'EVERYCAFE_OTHER',?)`,
              [sourceTime, sourceTime, saleId, total, total, method, `EveryCafe ${name}${note ? ` • ${note}` : ""}`, externalId],
              (paymentErr) => {
                if (paymentErr) return fail(paymentErr);
                const finishCommit = () => db.run("COMMIT", (commitErr) => {
                  if (commitErr) return fail(commitErr);
                  addLiveLog("everycafe_other_income", `🎫 EveryCafe ${name} aktarıldı • ${total.toFixed(2)} ₺ • ${method === "CASH" ? "Nakit" : "Kart"}`);
                  addEveryCafeIntegrationLog({category:"SALE",sessionId:sourceSessionId,event:"EveryCafe bilet / diğer gelir",sourceDetail:`${name} • ${total.toFixed(2)} ₺ • ${method}`,action:"KafePin bağımsız kasa geliri olarak aktardı",result:"Başarılı • kaynak ID çift kayıt koruması",details:{externalId,total,method,note}});
                  cb(null, { imported: true, other: true, total, method });
                });
                if (!sourceSessionId) return finishCommit();
                db.run(
                  "INSERT INTO everycafe_imports(session_id,masa,source_end,total,imported_at) VALUES(?,?,?,?,?)",
                  [sourceSessionId, 0, sourceTime, total, Date.now()],
                  (importErr) => importErr ? fail(importErr) : finishCommit()
                );
              }
            );
          }
        );
      });
    });
  });
}

function importEveryCafeOtherSession(session, cb) {
  const sessionId = String(session && session.SessionID || "").trim();
  const sourceTime = (Number(session && session.EndDate) || 0) * 1000;
  const total = everyCafeSessionRevenueTotal(session);
  const method = everyCafePaymentMethod(session && session.PaymentMethod);
  // Bilet/diğer oturuma bağlı gerçek Payments satırı varsa tahsilatın ödeme tipi
  // ve tutarı için Payments kaynağı daha kesindir. Session burada atlanır; ödeme
  // akışı aynı SessionID'yi OTHER olarak bir kez içeri alır.
  if (Number(session && session.LinkedPaymentCount) > 0) return cb(null, { skipped: true, reason: "linked_payment_authoritative" });
  if (!sessionId || !sourceTime || total <= 0 || isEveryCafeFreeSession(session)) return cb(null, { skipped: true });
  const name = everyCafeOtherIncomeName(
    String(session && session.ClientName || "").trim() || String(session && session.SessionTypeText || "").trim()
  );
  importEveryCafeOtherIncome({
    externalId: `OTHER_SESSION:${sessionId}`,
    sourceSessionId: sessionId,
    sourceTime,
    total,
    method,
    name,
    note: String(session && session.SessionTypeText || "").trim()
  }, cb);
}

function importEveryCafeOtherPayment(payment, cb) {
  const paymentId = String(payment && payment.PaymentID || "").trim();
  const sourceTime = everyCafeOtherPaymentSourceTime(payment) * 1000;
  const total = Math.round((Number(payment && payment.PaymentAmount) || 0) * 100) / 100;
  const method = everyCafePaymentMethod(payment && payment.PaymentMethod);
  const note = String(payment && payment.Notes || "").trim();
  if (!paymentId || !sourceTime || total <= 0 || !isEveryCafeOtherPaymentCandidate(payment)) {
    return cb(null, { skipped: true });
  }
  const linked = everyCafeLinkedSessionFromPayment(payment);
  const sourceSessionId = String(linked && linked.SessionID || payment && payment.SessionID || "").trim();
  const sourceName = note
    || String(linked && linked.ClientName || "").trim()
    || String(linked && linked.SessionTypeText || "").trim();
  const doImport = () => importEveryCafeOtherIncome({
    externalId: `PAYMENT:${paymentId}`,
    sourceSessionId,
    sourceTime,
    total,
    method,
    name: everyCafeOtherIncomeName(sourceName),
    note: note || (sourceSessionId ? `EveryCafe bağlı bilet/diğer SessionID ${sourceSessionId}` : "")
  }, cb);
  if (!sourceSessionId) return doImport();
  // Normal/Doğrudan oturum daha önce işlendi ve kaynak Sessions satırı artık
  // görünmüyorsa teknik Payment'ın yanlışlıkla OTHER gelire dönüşmesini önler.
  db.get("SELECT 1 AS ok FROM everycafe_imports WHERE session_id=?", [sourceSessionId], (markerErr, marker) => {
    if (markerErr) return cb(markerErr);
    if (marker) return cb(null, { skipped: true, reason: "session_already_imported" });
    doImport();
  });
}

function importEveryCafeTicketCashMovement(row, cb) {
  if (!isEveryCafeTicketCashMovement(row)) return cb(null, { skipped: true });
  const expenseId = Number(row.ExpenseID) || 0;
  const sourceTime = everyCafeTicketCashMovementTime(row) * 1000;
  const total = Math.round((Number(row.Price) || 0) * 100) / 100;
  const method = everyCafePaymentMethod(row.PaymentMethod);
  const ticketRef = String(row.TicketID == null ? "" : row.TicketID).trim();
  const description = String(row.Description || "").trim();
  if (!expenseId || !sourceTime || total <= 0 || !["CASH","CARD"].includes(method)) {
    return cb(null, { skipped: true });
  }
  importEveryCafeOtherIncome({
    // TICKET_EXPENSE kimliği v3.1.36 ile geriye dönük çift kayıt koruması için korunur.
    externalId: everyCafeTicketCashMovementExternalId(row),
    sourceSessionId: "",
    sourceTime,
    total,
    method,
    name: everyCafeOtherIncomeName(description, "EveryCafe Bilet / Diğer Gelir"),
    note: `${description}${ticketRef && ticketRef !== "0" ? ` • Bilet ${ticketRef}` : ""}`
  }, cb);
}

function importEveryCafeDirectSale(session, cb) {
  const sessionId = String(session && session.SessionID || "").trim();
  const end = (Number(session && session.EndDate) || 0) * 1000;
  const total = everyCafeSessionRevenueTotal(session);
  const method = everyCafePaymentMethod(session && session.PaymentMethod);
  const orders = (session && session.orders || []).map((order) => ({
    id: String(order.OrderID || "").trim(),
    name: String(order.StockName || "EveryCafe Doğrudan Satış").trim().slice(0, 100),
    quantity: Math.max(1, Number(order.Quantity) || 1),
    price: Math.max(0, Number(order.Price) || 0),
    time: (Number(order.AddDate) || Number(session.EndDate)) * 1000,
    active: Number(order.OrderIsActive) !== 0
  })).filter((order) => order.id && order.price > 0 && order.active);
  const productTotal = Math.round(orders.reduce((sum, order) => sum + order.quantity * order.price, 0) * 100) / 100;

  if (!sessionId || !end || total <= 0 || !["CASH", "CARD"].includes(method)) {
    return cb(null, { skipped: true });
  }
  // Ürün ayrıntısı tahsilattan büyükse indirim/iade gibi farklı bir kaynak akışı
  // vardır ve güvenli aktarım durur. Tahsilat daha büyükse eksik ayrıntı kalan tutar
  // olarak ayrıca yazılır; geçmiş aktarım motoruyla aynı davranıştır.
  if (productTotal > total + 0.01) {
    return cb(new Error(`EveryCafe Doğrudan Satış ürün toplamı (${productTotal.toFixed(2)} ₺) tahsilattan (${total.toFixed(2)} ₺) büyük`));
  }
  const remainder = Math.round((total - productTotal) * 100) / 100;

  db.get("SELECT 1 AS ok FROM everycafe_imports WHERE session_id=?", [sessionId], (existingErr, existing) => {
    if (existingErr) return cb(existingErr);
    if (existing) return cb(null, { skipped: true });
    db.serialize(() => {
      db.run("BEGIN IMMEDIATE", (beginErr) => {
        if (beginErr) return cb(beginErr);
        let failed = false;
        const fail = (err) => {
          if (failed) return;
          failed = true;
          db.run("ROLLBACK", () => cb(err));
        };
        let index = 0;
        const addPayment = () => db.run(
          `INSERT INTO payments
           (created_at,paid_at,masa,session_start,session_end,product_sale_id,computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at,external_source,external_id)
           VALUES (?,?,0,0,0,0,0,?,?,?,'EVERYCAFE_DIRECT','EVERYCAFE_DIRECT',?,0,0,'EVERYCAFE_DIRECT',?)`,
          [end, end, total, total, method, `EveryCafe Doğrudan Satış: ${session.ClientName}`, `DIRECT_SESSION:${sessionId}`],
          (paymentErr) => {
            if (paymentErr) return fail(paymentErr);
            db.run(
              "INSERT INTO everycafe_imports(session_id,masa,source_end,total,imported_at) VALUES(?,?,?,?,?)",
              [sessionId, 0, end, total, Date.now()],
              (importErr) => {
                if (importErr) return fail(importErr);
                db.run("COMMIT", (commitErr) => {
                  if (commitErr) return fail(commitErr);
                  addLiveLog("everycafe_direct_sale", `🧾 EveryCafe doğrudan satış aktarıldı • ${total.toFixed(2)} ₺ • ${method === "CASH" ? "Nakit" : "Kart"}`);
                  addEveryCafeIntegrationLog({category:"SALE",sessionId,event:"EveryCafe doğrudan satış",sourceDetail:`${total.toFixed(2)} ₺ • ${method} • ${orders.length} ürün${remainder > 0.01 ? ` • ${remainder.toFixed(2)} ₺ ayrıntısız kalan` : ""}`,action:"KafePin doğrudan satış/ödeme kaydına aktardı",result:"Başarılı • SessionType 26 + kaynak ID çift kayıt koruması"});
                  cb(null, { imported: true, direct: true, total, method });
                });
              }
            );
          }
        );
        const addRemainder = () => {
          if (remainder <= 0.01) return addPayment();
          db.run(
            `INSERT OR IGNORE INTO product_sales
             (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
             VALUES (?,0,0,0,'EveryCafe Diğer Doğrudan Gelir','EveryCafe Doğrudan Satış',?,1,?,'DIRECT',?,'FINALIZED',?,?,0,0,'EVERYCAFE_DIRECT',?)`,
            [end, remainder, remainder, `EveryCafe kaynakta ürün ayrıntısı olmayan doğrudan gelir: ${sessionId}`, end, method, `DIRECT_REMAINDER:${sessionId}`],
            (remainderErr) => remainderErr ? fail(remainderErr) : addPayment()
          );
        };
        const addOrders = () => {
          if (failed) return;
          if (index >= orders.length) return addRemainder();
          const order = orders[index++];
          const orderTotal = Math.round(order.quantity * order.price * 100) / 100;
          const externalId = `DIRECT_ORDER:${order.id}`;
          db.run(
            `INSERT OR IGNORE INTO product_sales
             (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
             VALUES (?,0,0,0,?,'EveryCafe Doğrudan Satış',?,?,?,'DIRECT',?,'FINALIZED',?,?,0,0,'EVERYCAFE_DIRECT',?)`,
            [order.time, order.name, order.price, order.quantity, orderTotal,
              `EveryCafe Doğrudan Satış: ${sessionId}`, end, method, externalId],
            (orderErr) => {
              if (orderErr) return fail(orderErr);
              db.run(
                `UPDATE product_sales
                 SET time=?,product_name=?,category='EveryCafe Doğrudan Satış',unit_price=?,quantity=?,total=?,status='FINALIZED',finalized_at=?,payment_method=?,voided=0,voided_at=0
                 WHERE external_source='EVERYCAFE_DIRECT' AND external_id=?`,
                [order.time, order.name, order.price, order.quantity, orderTotal, end, method, externalId],
                (updateErr) => updateErr ? fail(updateErr) : addOrders()
              );
            }
          );
        };
        addOrders();
      });
    });
  });
}

function canRecoverEveryCafeClosedSession(masa, start, sessionId, cb) {
  // KafePin kapalıyken başlayıp biten EveryCafe oturumunda yerel sessions/history
  // satırı bulunmaz. Yalnız aynı zamana ait başka bir yerel tahsilat YOKSA kaynak
  // SessionID + gerçek başlangıç/bitiş güvenle yeniden kurulabilir.
  const windowMs = 20 * 60 * 1000;
  db.get(
    `SELECT id,source,external_source,external_id,total_amount
     FROM payments
     WHERE voided=0 AND masa=? AND session_start BETWEEN ? AND ?
       AND NOT (external_source='EVERYCAFE' AND external_id=?)
     ORDER BY id DESC LIMIT 1`,
    [masa, start - windowMs, start + windowMs, `SESSION:${sessionId}`],
    (err, conflict) => {
      if (err) return cb(err);
      cb(null, !conflict, conflict || null);
    }
  );
}

function importEveryCafeSession(session, cb) {
  const sessionId = String(session.SessionID || "").trim();
  if (isEveryCafeDirectSaleSession(session)) {
    return importEveryCafeDirectSale(session, cb);
  }
  const masa = everyCafeTableNumber(session.ClientName);
  if (!masa) return importEveryCafeOtherSession(session, cb);
  const start = Number(session.StartDate) * 1000;
  const end = Number(session.EndDate) * 1000;
  const total = everyCafeSessionRevenueTotal(session);
  const sourceWasFree = isEveryCafeFreeSession(session);
  if (!sessionId || !masa || !start || !end || total < 0) return cb(null, { skipped: true });

  // Ücretsiz EveryCafe oturumu aktifken KafePin'de normal session
  // oluşturulmadığı için eşleşme aramayız. Kapanışta ücretsiz etiketi ve
  // varsa geçici canlı kaydı doğrudan temizlenir.
  if (sourceWasFree || total === 0) {
    return db.get("SELECT total FROM everycafe_imports WHERE session_id=?", [sessionId], (existingErr, existing) => {
      if (existingErr) return cb(existingErr);
      // Kaynakta saklanan ücretsiz kapanış yalnızca ilk defa temizlenir.
      // Eski kapanış, yeni açılan aynı masayı tekrar etkileyemez.
      if (sourceWasFree && existing && Number(existing.total) === 0) {
        return cb(null, { skipped: true, reason: "already_finalized_free" });
      }
      // Kaynak ücretsiz kapanışı sonradan güncellerse daha önce yanlışlıkla
      // yazılmış tahsilatı da temizle. İşlem idempotenttir: import kaydı zaten
      // 0 olsa bile eski sürümden kalmış history/payment satırları olabilir.
      db.serialize(() => {
        db.run("BEGIN IMMEDIATE", (beginErr) => {
          if (beginErr) return cb(beginErr);
        // Eski bir ücretsiz kapanış, aynı masada daha sonra açılmış aktif
        // oturumun durumunu silemez.
        let preserveNewerActiveMasa = false;
        const clearFreeStatus = (done) => {
          if (!sourceWasFree) return done(null);
          db.get(
            "SELECT session_id FROM everycafe_active_sessions WHERE masa=? AND source_start>? LIMIT 1",
            [masa, start],
            (newerErr, newerActive) => {
              if (newerErr) return done(newerErr);
              preserveNewerActiveMasa = Boolean(newerActive);
              if (preserveNewerActiveMasa) return done(null);
              db.run("UPDATE free_masalar SET enabled=0,set_time=? WHERE masa=?", [Date.now(), masa], done);
            }
          );
        };
        clearFreeStatus((freeErr) => {
          if (freeErr) return db.run("ROLLBACK", () => cb(freeErr));
          // Kaynak ücretsiz kapatmayı kesin kabul eder. Aynı oturum için daha
          // önce KafePin tarafından oluşturulmuş yerel SESSION ödemesi de varsa
          // onu kaldır; aksi halde kasa kontrolü sahte fark üretir.
          db.run(
            "DELETE FROM payments WHERE (external_source='EVERYCAFE' AND external_id=?) OR (source='SESSION' AND masa=? AND session_start BETWEEN ? AND ?)",
            [`SESSION:${sessionId}`, masa, start - 20 * 60 * 1000, start + 20 * 60 * 1000],
            (paymentErr) => {
            if (paymentErr) return db.run("ROLLBACK", () => cb(paymentErr));
          // EveryCafe'de Ücretsiz Kapat seçildiyse, açık oturumdayken
          // aktarılmış ürünler de satış/ciro kabul edilmeden tamamen silinir.
          db.run("DELETE FROM product_sales WHERE external_source='EVERYCAFE' AND masa=? AND session_start BETWEEN ? AND ?", [masa, start - 20 * 60 * 1000, start + 20 * 60 * 1000], (productErr) => {
            if (productErr) return db.run("ROLLBACK", () => cb(productErr));
            db.run("DELETE FROM sessions WHERE masa=? AND start_time BETWEEN ? AND ?", [masa, start - 20 * 60 * 1000, start + 20 * 60 * 1000], (sessionErr) => {
              if (sessionErr) return db.run("ROLLBACK", () => cb(sessionErr));
              // Eski sürümde yerel kapanış tamamlanmışsa session_history satırı
              // kalmış olabilir. EveryCafe ücretsiz kapatmayı kesin kaynak kabul
              // ettiğinden, aynı başlangıca ait geçmiş ve düzeltmeler de silinir.
              db.run("DELETE FROM session_history WHERE masa=? AND start_time BETWEEN ? AND ?", [masa, start - 20 * 60 * 1000, start + 20 * 60 * 1000], (historyErr) => {
                if (historyErr) return db.run("ROLLBACK", () => cb(historyErr));
                db.run("DELETE FROM real_adjustments WHERE masa=? AND session_start BETWEEN ? AND ?", [masa, start - 20 * 60 * 1000, start + 20 * 60 * 1000], (adjustmentErr) => {
                  if (adjustmentErr) return db.run("ROLLBACK", () => cb(adjustmentErr));
                  db.run("DELETE FROM spin_page_sessions WHERE session_id=?", [sessionId], (pageResetErr) => {
                    if (pageResetErr) return db.run("ROLLBACK", () => cb(pageResetErr));
                  db.run("DELETE FROM spin_ready_notifications WHERE session_id=?", [sessionId], (notifyResetErr) => {
                    if (notifyResetErr) return db.run("ROLLBACK", () => cb(notifyResetErr));
                  db.run("DELETE FROM everycafe_active_sessions WHERE session_id=?", [sessionId], (activeErr) => {
                    if (activeErr) return db.run("ROLLBACK", () => cb(activeErr));
                    if (!preserveNewerActiveMasa) {
                      everyCafeSessionTypes.delete(masa);
                      everyCafeTimedSessions.delete(masa);
                      everyCafeScheduledEnds.delete(masa);
                      everyCafeGiftMinutes.delete(masa);
                    }
                    // EveryCafe ücretsiz kapatılan kaydı kaynakta saklar. Daha
                    // önce 0 olarak işlenmiş kayıt, sunucu açılınca yeni kapanış
                    // gibi monitöre tekrar düşmez. Yalnız ilk gerçek kapanışta
                    // 40 saniyelik kart işareti oluşturulur.
                    const existingClosed = everyCafeRecentlyClosedMasalar.get(masa);
                    const alreadyImportedAsFree = existing && Number(existing.total) === 0;
                    if (!preserveNewerActiveMasa && !alreadyImportedAsFree && (!existingClosed || existingClosed.free !== true)) {
                      everyCafeRecentlyClosedMasalar.set(masa, {
                        closedAt: Date.now(), free: true, timed: false,
                        total: 0, computerTotal: 0, productTotal: 0
                      });
                    }
                    db.run("INSERT INTO everycafe_imports(session_id,masa,source_end,total,imported_at) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET masa=excluded.masa,source_end=excluded.source_end,total=0,imported_at=excluded.imported_at", [sessionId, masa, end, 0, Date.now()], (importErr) => {
                      if (importErr) return db.run("ROLLBACK", () => cb(importErr));
                      db.run("COMMIT", (commitErr) => {
                        if (commitErr) return db.run("ROLLBACK", () => cb(commitErr));
                        if (preserveNewerActiveMasa) {
                          aktifMasalar[masa] = Date.now();
                        } else {
                          if (sourceWasFree) freeMasalar.delete(masa);
                          delete aktifMasalar[masa];
                        }
                        addLiveLog("everycafe_import", `🖥️ EveryCafe ücretsiz kapanış • Masa ${masa} ücretsiz listeden çıkarıldı`);
                        everyCafeOpenOrderFingerprints.delete(sessionId);
                        addEveryCafeIntegrationLog({category:"CLOSE",masa,sessionId,event:"Ücretsiz masa kapandı",sourceDetail:`EveryCafe kapanış: ${everyCafeIntegrationTimeText(end)} • gelir 0 ₺`,action:"KafePin ödeme + bağlı ürün + geçmiş gelir kayıtlarını otomatik temizledi",result:"Başarılı • gelir yazılmadı • audit geçmişi tutuluyor"});
                        recordEveryCafeFreeCloseEvent(session, masa);
                        clearClosedEveryCafeMasaTimer(masa, end, () => cb(null, { imported: true, masa, total: 0 }));
                      });
                    });
                  });
                  });
                  });
                });
              });
            });
          });
          });
        });
      
        });
      });
    });
  }

  findMatchingKafePinSession(masa, start, end, (matchErr, matchedLocalSession) => {
    if (matchErr) return cb(matchErr);
    const continueWithLocalSession = (localSession, recoveredWithoutLocal = false) => {
    const localStart = Number(localSession && localSession.start_time) || start;
    db.get("SELECT 1 AS ok FROM everycafe_imports WHERE session_id=?", [sessionId], (existingErr, existing) => {
    if (existingErr) return cb(existingErr);
    if (existing) return cb(null, { skipped: true });

    const orders = (session.orders || []).map((order) => ({
      id: String(order.OrderID || "").trim(),
      stockId: Number(order.StockID) || 0,
      name: String(order.StockName || "EveryCafe Ürün").trim().slice(0, 100),
      category: getEveryCafeOrderCategory(order),
      quantity: Math.max(1, Number(order.Quantity) || 1),
      price: Math.max(0, Number(order.Price) || 0),
      time: (Number(order.AddDate) || Number(session.EndDate)) * 1000,
      active: Number(order.OrderIsActive) !== 0
    })).filter((order) => order.id && order.price > 0 && order.active);
    const rawProductTotal = orders.reduce((sum, order) => sum + order.quantity * order.price, 0);
    if (rawProductTotal > total + 0.01) {
      return cb(new Error(`EveryCafe ürün toplamı (${rawProductTotal.toFixed(2)} ₺) oturum tahsilatından büyük`));
    }
    const productTotal = Math.round(rawProductTotal * 100) / 100;
    const computerTotal = Math.round((total - productTotal) * 100) / 100;
    const method = everyCafePaymentMethod(session.PaymentMethod);

      db.serialize(() => {
        db.run("BEGIN IMMEDIATE", (beginErr) => {
          if (beginErr) return cb(beginErr);
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        db.run("ROLLBACK", () => cb(err));
      };
      let index = 0;
      const reconcileLocalSession = () => {
        db.run(
          "UPDATE product_sales SET voided=1,voided_at=? WHERE external_source='EVERYCAFE' AND masa=? AND session_start=? AND voided=0",
          [Date.now(), masa, localStart],
          (productVoidErr) => {
            if (productVoidErr) return fail(productVoidErr);
            db.run(
              "DELETE FROM real_adjustments WHERE masa=? AND session_start=? AND kind='SESSION_FINALIZE'",
              [masa, localStart],
              (adjustDeleteErr) => {
                if (adjustDeleteErr) return fail(adjustDeleteErr);
                db.run(
                  "DELETE FROM session_history WHERE masa=? AND start_time=?",
                  [masa, localStart],
                  (historyDeleteErr) => {
                    if (historyDeleteErr) return fail(historyDeleteErr);
                    db.run(
                      `INSERT INTO real_adjustments(time,day_key,masa,amount,kind,note,session_start)
                       VALUES(?,?,?,?,?,?,?)`,
                      [end, dayKey(end), masa, computerTotal, "SESSION_FINALIZE", "EveryCafe gerçek kapanış", localStart],
                      (adjustInsertErr) => adjustInsertErr ? fail(adjustInsertErr) : addLocalHistory()
                    );
                  }
                );
              }
            );
          }
        );
      };
      const addLocalHistory = () => {
        if (computerTotal <= 0) return addOrder();
        const minutes = Math.max(0, Math.floor((end - localStart) / 60000));
        db.run(
          `INSERT INTO session_history
           (masa,start_time,end_time,last_seen,minutes,fee,adjustment,close_reason,note,created_at)
           VALUES(?,?,?,?,?,?,0,'EVERYCAFE','EveryCafe gerçek kapanış',?)`,
          [masa, localStart, end, end, minutes, computerTotal, Date.now()],
          (historyInsertErr) => historyInsertErr ? fail(historyInsertErr) : addOrder()
        );
      };
      const addOrder = () => {
        if (failed) return;
        if (index >= orders.length) return addPayment();
        const order = orders[index++];
        const orderTotal = Math.round(order.quantity * order.price * 100) / 100;
        db.run(
          `INSERT OR IGNORE INTO product_sales
           (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
           VALUES (?,?,?,?,?,?,?,? ,?,'TABLE',?,'FINALIZED',?,?,0,0,'EVERYCAFE',?)`,
          [order.time, masa, localStart, 0, order.name, order.category, order.price, order.quantity, orderTotal,
            `EveryCafe oturum: ${sessionId}`, end, method, `ORDER:${order.id}`],
          (orderErr) => {
            if (orderErr) return fail(orderErr);
            db.run(
              `UPDATE product_sales
               SET time=?,masa=?,session_start=?,product_name=?,category=?,unit_price=?,quantity=?,total=?,status='FINALIZED',finalized_at=?,payment_method=?,voided=0,voided_at=0
               WHERE external_source='EVERYCAFE' AND external_id=?`,
              [order.time, masa, localStart, order.name, order.category, order.price, order.quantity, orderTotal, end, method, `ORDER:${order.id}`],
              (updateErr) => updateErr ? fail(updateErr) : addOrder()
            );
          }
        );
      };
      const addPayment = () => {
        db.run(
          `UPDATE product_sales
           SET status='FINALIZED', finalized_at=?, payment_method=?
           WHERE external_source='EVERYCAFE' AND masa=? AND session_start=? AND voided=0`,
          [end, method, masa, localStart],
          (finalizeProductsErr) => {
            if (finalizeProductsErr) return fail(finalizeProductsErr);
        db.run(
          `INSERT INTO payments
           (created_at,paid_at,masa,session_start,session_end,product_sale_id,computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at,external_source,external_id)
           VALUES (?,?,?,?,?,0,?,?,?,?, 'EVERYCAFE','EVERYCAFE_SYNC',?,0,0,'EVERYCAFE',?)`,
          [end, method === "PENDING" ? 0 : end, masa, localStart, end, computerTotal, productTotal, total, method,
            `EveryCafe: ${session.ClientName}`, `SESSION:${sessionId}`],
          (paymentErr) => {
            if (paymentErr) return fail(paymentErr);
            db.run(
              "INSERT INTO everycafe_imports(session_id,masa,source_end,total,imported_at) VALUES(?,?,?,?,?)",
              [sessionId, masa, end, total, Date.now()],
              (importErr) => {
                if (importErr) return fail(importErr);
                db.run("DELETE FROM sessions WHERE masa=? AND start_time=?", [masa, localStart], (sessionDeleteErr) => {
                  if (sessionDeleteErr) return fail(sessionDeleteErr);
                db.run("DELETE FROM spin_page_sessions WHERE session_id=?", [sessionId], (pageResetErr) => {
                  if (pageResetErr) return fail(pageResetErr);
                db.run("DELETE FROM spin_ready_notifications WHERE session_id=?", [sessionId], (notifyResetErr) => {
                  if (notifyResetErr) return fail(notifyResetErr);
                db.run("DELETE FROM everycafe_active_sessions WHERE session_id=?", [sessionId], (activeDeleteErr) => {
                  if (activeDeleteErr) return fail(activeDeleteErr);
                  // Aynı masa, eski kapanış içeri alınmadan önce EveryCafe'de tekrar
                  // açılmış olabilir. Eski kapanış yeni müşterinin canlı tip/süre/
                  // hediye bilgisini ve monitör kartını asla silemez.
                  db.get(
                    "SELECT session_id FROM everycafe_active_sessions WHERE masa=? AND source_start>? AND session_id<>? LIMIT 1",
                    [masa, start, sessionId],
                    (newerErr, newerActive) => {
                      if (newerErr) return fail(newerErr);
                      const preserveNewerActiveMasa = Boolean(newerActive);
                      const recentlyClosedTimed = preserveNewerActiveMasa ? false : isEveryCafeTimedMasa(masa);
                      if (!preserveNewerActiveMasa) {
                        everyCafeSessionTypes.delete(masa);
                        everyCafeTimedSessions.delete(masa);
                        everyCafeScheduledEnds.delete(masa);
                        everyCafeGiftMinutes.delete(masa);
                        // Monitör sayfası yenilense bile son kapanış tutarı 40 saniye
                        // görüntülenebilir. Sonra kart istemci tarafında tamamen gizlenir.
                        everyCafeRecentlyClosedMasalar.set(masa, {
                          closedAt: Date.now(),
                          free: false,
                          timed: recentlyClosedTimed,
                          total,
                          computerTotal,
                          productTotal
                        });
                      }
                      db.run("COMMIT", (commitErr) => {
                        if (commitErr) return fail(commitErr);
                        if (preserveNewerActiveMasa) aktifMasalar[masa] = Date.now();
                        addLiveLog("everycafe_import", `${recoveredWithoutLocal ? "🛟" : "🖥️"} EveryCafe ${recoveredWithoutLocal ? "kurtarıldı" : "doğrulandı ve aktarıldı"} • Masa ${masa} • ${total.toFixed(2)} ₺ • ${method}`);
                        everyCafeOpenOrderFingerprints.delete(sessionId);
                        addEveryCafeIntegrationLog({category:recoveredWithoutLocal?"RECOVERY":"CLOSE",masa,sessionId,event:recoveredWithoutLocal?"Kapalı oturum güvenli kurtarıldı":"Masa kapandı / tahsilat doğrulandı",sourceDetail:`EveryCafe kapanış: ${everyCafeIntegrationTimeText(end)} • ${total.toFixed(2)} ₺ • ${method}`,action:`KafePin finalize • bilgisayar ${computerTotal.toFixed(2)} ₺ + ürün ${productTotal.toFixed(2)} ₺`,result:recoveredWithoutLocal?"Başarılı • KafePin kapalıyken kaçan kayıt tamamlandı":(preserveNewerActiveMasa?"Başarılı • yeni aktif oturum korunarak eski tahsilat uygulandı":"Başarılı • EveryCafe gerçek tahsilatı uygulandı"),details:{startTime:localStart,endTime:end,total,computerTotal,productTotal,method,recoveredWithoutLocal,preserveNewerActiveMasa}});
                        clearClosedEveryCafeMasaTimer(masa, end, () => cb(null, { imported: true, masa, total, preservedNewerActive: preserveNewerActiveMasa }));
                      });
                    }
                  );
                });
                });
                });
                });
              }
            );
          }
        );
          }
        );
      };
      reconcileLocalSession();
    
        });
      });
    });
    };
    if (matchedLocalSession) return continueWithLocalSession(matchedLocalSession, false);
    // 24 saatlik güvenlik yeniden taramasında daha önce aktarılmış SessionID'ler
    // tekrar kurtarma akışına girmez; böylece gereksiz RECOVERY logu oluşmaz.
    db.get("SELECT 1 AS ok FROM everycafe_imports WHERE session_id=?", [sessionId], (importedErr, alreadyImported) => {
      if (importedErr) return cb(importedErr);
      if (alreadyImported) return cb(null, { skipped: true, reason: "already_imported" });
      canRecoverEveryCafeClosedSession(masa, start, sessionId, (recoveryErr, allowed, conflict) => {
        if (recoveryErr) return cb(recoveryErr);
        if (!allowed) {
          addEveryCafeIntegrationLog({category:"RECOVERY",level:"WARN",masa,sessionId,event:"Kapalı oturum kurtarma durduruldu",sourceDetail:`EveryCafe: ${total.toFixed(2)} ₺ • ${everyCafeIntegrationTimeText(end)}`,action:"Aynı başlangıç çevresinde mevcut KafePin tahsilatı bulundu; otomatik çift gelir yazılmadı",result:"Manuel kontrol gerekli",details:{conflict}});
          return cb(null, { skipped: true, reason: "recovery_conflict" });
        }
        addEveryCafeIntegrationLog({category:"RECOVERY",masa,sessionId,event:"KafePin kapalıyken biten oturum bulundu",sourceDetail:`Masa ${masa} • ${everyCafeIntegrationTimeText(start)} → ${everyCafeIntegrationTimeText(end)} • ${total.toFixed(2)} ₺`,action:"Kaynak SessionID ve gerçek süre ile eksik yerel kapanış yeniden kuruluyor",result:"Güvenli kurtarma başladı"});
        continueWithLocalSession({ start_time: start }, true);
      });
    });
  });
}

// EveryCafe'de "bakiye ekle" ile oluşan gerçek üye tahsilatını KafePin'de
// masası olmayan, tahsil edilmiş bir gelir olarak saklar. Oturum aktarımından
// bağımsızdır; böylece EveryCafe raporundaki Üye Gelirleri de toplamda eşleşir.
function importEveryCafeMemberPayment(payment, cb) {
  const historyId = Number(payment && payment.HistoryID) || 0;
  const sourceTime = (Number(payment && payment.PaymentDate) || 0) * 1000;
  const amount = Math.round((Number(payment && payment.PaymentAmount) || 0) * 100) / 100;
  const method = everyCafePaymentMethod(payment && payment.PaymentMethod);
  if (!historyId || !sourceTime || amount <= 0 || !['CASH', 'CARD'].includes(method)) {
    return cb(null, { skipped: true });
  }

  const externalId = `MEMBER_PAYMENT:${historyId}`;
  db.get("SELECT 1 AS ok FROM everycafe_member_imports WHERE history_id=?", [historyId], (existingErr, existing) => {
    if (existingErr) return cb(existingErr);
    if (existing) return cb(null, { skipped: true });
    const noteText = String(payment.Note || '').trim().slice(0, 120);
    const productName = 'EveryCafe Üye Geliri';
    const note = `EveryCafe üye bakiyesi${noteText ? ` • ${noteText}` : ''}`;
    db.serialize(() => {
      db.run("BEGIN IMMEDIATE", (beginErr) => {
        if (beginErr) return cb(beginErr);
        const rollback = (err) => db.run("ROLLBACK", () => cb(err));
        db.run(
          `INSERT INTO product_sales
           (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
           VALUES (?,0,0,0,?,'EveryCafe Üye',?,1,?,'DIRECT',?,'FINALIZED',?,?,0,0,'EVERYCAFE_MEMBER',?)`,
          [sourceTime, productName, amount, amount, note, sourceTime, method, externalId],
          function (saleErr) {
            if (saleErr) return rollback(saleErr);
            const saleId = this.lastID;
            db.run(
              `INSERT INTO payments
               (created_at,paid_at,masa,session_start,session_end,product_sale_id,computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at,external_source,external_id)
               VALUES (?,?,0,0,0,?,0,?,?,?,'EVERYCAFE_MEMBER','MEMBER_BALANCE',?,0,0,'EVERYCAFE_MEMBER',?)`,
              [sourceTime, sourceTime, saleId, amount, amount, method, note, externalId],
              (paymentErr) => {
                if (paymentErr) return rollback(paymentErr);
                db.run(
                  "INSERT INTO everycafe_member_imports(history_id,source_time,amount,imported_at) VALUES(?,?,?,?)",
                  [historyId, sourceTime, amount, Date.now()],
                  (importErr) => {
                    if (importErr) return rollback(importErr);
                    db.run("COMMIT", (commitErr) => {
                      if (commitErr) return rollback(commitErr);
                      addLiveLog("everycafe_member_income", `EveryCafe üye geliri aktarıldı • ${amount.toFixed(2)} ₺ • ${method === 'CASH' ? 'Nakit' : 'Kart'}`);
                      addEveryCafeIntegrationLog({category:"MEMBER",event:"EveryCafe üye ödemesi",sourceDetail:`${amount.toFixed(2)} ₺ • ${method}`,action:"KafePin üye geliri olarak aktardı",result:"Başarılı • HistoryID çift kayıt koruması",details:{historyId,amount,method}});
                      cb(null, { imported: true, amount, method });
                    });
                  }
                );
              }
            );
          }
        );
      });
    });
  });
}

function syncEveryCafeClosedSessionStream(config, cb) {
  const scanStart = everyCafeLiveScanStart(config, config.sessionCursor);
  let pageEnd = Math.max(0, scanStart - 1);
  let pageId = '';
  let maxSeen = Math.max(Number(config.sessionCursor) || 0, scanStart);
  let checked = 0;
  let imported = 0;
  const readNextPage = () => readEveryCafeClosedSessionsPage(pageEnd, pageId, EVERYCAFE_LIVE_PAGE_SIZE, (readErr, page) => {
    if (readErr) return cb(readErr);
    const rows = (page && page.rows) || [];
    if (!rows.length) {
      return saveEveryCafeLiveCursor('everycafe_sync_session_cursor', maxSeen, (saveErr) => cb(saveErr || null, { checked, imported, cursor: maxSeen }));
    }
    pageEnd = Number(page.cursorEnd) || pageEnd;
    pageId = String(page.cursorId || pageId);
    maxSeen = Math.max(maxSeen, pageEnd);
    let index = 0;
    const importNext = () => {
      if (index >= rows.length) return readNextPage();
      const row = rows[index++];
      checked += 1;
      importEveryCafeSession(row, (importErr, result) => {
        if (importErr) return cb(importErr);
        if (result && result.imported) imported += 1;
        importNext();
      });
    };
    importNext();
  });
  readNextPage();
}

function syncEveryCafeMemberPaymentStream(config, cb) {
  const scanStart = everyCafeLiveScanStart(config, config.memberCursor);
  let pageTime = Math.max(0, scanStart - 1);
  let pageId = 0;
  let maxSeen = Math.max(Number(config.memberCursor) || 0, scanStart);
  let checked = 0;
  let imported = 0;
  const readNextPage = () => readEveryCafeMemberPaymentsPage(pageTime, pageId, EVERYCAFE_LIVE_PAGE_SIZE, (readErr, page) => {
    if (readErr) return cb(readErr);
    const rows = (page && page.rows) || [];
    if (!rows.length) {
      return saveEveryCafeLiveCursor('everycafe_sync_member_cursor', maxSeen, (saveErr) => cb(saveErr || null, { checked, imported, cursor: maxSeen }));
    }
    pageTime = Number(page.cursorTime) || pageTime;
    pageId = Number(page.cursorId) || pageId;
    maxSeen = Math.max(maxSeen, pageTime);
    let index = 0;
    const importNext = () => {
      if (index >= rows.length) return readNextPage();
      checked += 1;
      importEveryCafeMemberPayment(rows[index++], (importErr, result) => {
        if (importErr) return cb(importErr);
        if (result && result.imported) imported += 1;
        importNext();
      });
    };
    importNext();
  });
  readNextPage();
}

function syncEveryCafeOtherPaymentStream(config, cb) {
  const scanStart = everyCafeLiveScanStart(config, config.otherCursor);
  let pageTime = Math.max(0, scanStart - 1);
  let pageId = '';
  let maxSeen = Math.max(Number(config.otherCursor) || 0, scanStart);
  let checked = 0;
  let imported = 0;
  const readNextPage = () => readEveryCafeOtherPaymentsPage(pageTime, pageId, EVERYCAFE_LIVE_PAGE_SIZE, (readErr, page) => {
    if (readErr) return cb(readErr);
    const rows = (page && page.rows) || [];
    if (!rows.length) {
      return saveEveryCafeLiveCursor('everycafe_sync_other_cursor', maxSeen, (saveErr) => cb(saveErr || null, { checked, imported, cursor: maxSeen }));
    }
    pageTime = Number(page.cursorTime) || pageTime;
    pageId = String(page.cursorId || pageId);
    maxSeen = Math.max(maxSeen, pageTime);
    let index = 0;
    const importNext = () => {
      if (index >= rows.length) return readNextPage();
      checked += 1;
      importEveryCafeOtherPayment(rows[index++], (importErr, result) => {
        if (importErr) return cb(importErr);
        if (result && result.imported) imported += 1;
        importNext();
      });
    };
    importNext();
  });
  readNextPage();
}

function syncEveryCafeTicketSaleStream(config, cb) {
  const scanStart = everyCafeLiveScanStart(config, config.ticketCursor);
  let pageTime = Math.max(0, scanStart - 1);
  let pageId = 0;
  let maxSeen = Math.max(Number(config.ticketCursor) || 0, scanStart);
  let checked = 0;
  let imported = 0;
  const readNextPage = () => readEveryCafeTicketSalesPage(pageTime, pageId, EVERYCAFE_LIVE_PAGE_SIZE, (readErr, page) => {
    if (readErr) return cb(readErr);
    const rows = (page && page.rows) || [];
    const rawCount = Number(page && page.rawCount) || 0;
    if (!rawCount) {
      return saveEveryCafeLiveCursor('everycafe_sync_ticket_cursor', maxSeen, (saveErr) => cb(saveErr || null, { checked, imported, cursor: maxSeen, supported: page ? page.supported !== false : true }));
    }
    pageTime = Number(page.cursorTime) || pageTime;
    pageId = Number(page.cursorId) || pageId;
    maxSeen = Math.max(maxSeen, pageTime);
    let index = 0;
    const importNext = () => {
      if (index >= rows.length) return readNextPage();
      checked += 1;
      importEveryCafeTicketCashMovement(rows[index++], (importErr, result) => {
        if (importErr) return cb(importErr);
        if (result && result.imported) imported += 1;
        importNext();
      });
    };
    importNext();
  });
  readNextPage();
}

function syncEveryCafeClosedSessions(cb = () => {}) {
  if (everyCafeSyncRunning) return cb(null, { skipped: true, reason: "busy" });
  everyCafeSyncRunning = true;
  const finish = (err, result) => {
    everyCafeSyncRunning = false;
    cb(err || null, result || {});
  };
  getEveryCafeConfig((configErr, config) => {
    if (configErr || !config.enabled || !config.startAt) return finish(configErr || null, { skipped: true, reason: "disabled" });
    syncEveryCafeClosedSessionStream(config, (sessionErr, sessionResult) => {
      if (sessionErr) return finish(sessionErr);
      syncEveryCafeMemberPaymentStream(config, (memberErr, memberResult) => {
        if (memberErr) return finish(memberErr);
        syncEveryCafeOtherPaymentStream(config, (otherErr, otherResult) => {
          if (otherErr) return finish(otherErr);
          syncEveryCafeTicketSaleStream(config, (ticketErr, ticketResult) => {
            if (ticketErr) return finish(ticketErr);
            reconcileEveryCafeClosedRewardApprovals((rewardErr, rewardResult) => {
              if (rewardErr) return finish(rewardErr);
              finish(null, {
                imported: Number(sessionResult && sessionResult.imported) || 0,
                checked: Number(sessionResult && sessionResult.checked) || 0,
                memberImported: Number(memberResult && memberResult.imported) || 0,
                memberChecked: Number(memberResult && memberResult.checked) || 0,
                otherImported: Number(otherResult && otherResult.imported) || 0,
                otherChecked: Number(otherResult && otherResult.checked) || 0,
                ticketImported: Number(ticketResult && ticketResult.imported) || 0,
                ticketChecked: Number(ticketResult && ticketResult.checked) || 0,
                autoApprovedRewards: Number(rewardResult && rewardResult.approved) || 0
              });
            });
          });
        });
      });
    });
  });
}



// -----------------------------------------------------------------------------
// v3.0.19 • EveryCafe Geçmiş Kayıt Aktarımı
// -----------------------------------------------------------------------------
// Kurallar:
// - Kaynak EveryCafe yalnız OPEN_READONLY açılır.
// - "Hesap Kesildi" gerçek tarih/saat ve tutarı esas alınır.
// - "Ücretsiz Kapatıldı" gelir değildir; parantezde eski/stale tutar görünse
//   bile ciroya yazılmaz. Bu, canlı EveryCafe entegrasyonundaki kuralla aynıdır.
// - Takvim günü Europe/Istanbul 00:00–23:59:59'dur; KafePin'in 20:00 iş günü
//   kaydırması burada KESİNLİKLE kullanılmaz.
// - Ön kontrol yapılmadan yazma yoktur. Ön kontrol tokenı KafePin kaynak durumu
//   değişirse geçersiz olur.
// - Geçmiş gelirler sale_type=HISTORY ile tutulur; KafePin DIRECT değildir ve
//   ödeme yöntemi arşivde bilinmediği için geçmiş kasa/banka bakiyesi uydurulmaz.
// -----------------------------------------------------------------------------

const EVERYCAFE_HISTORY_SOURCE = "EVERYCAFE_HISTORY";
const EVERYCAFE_HISTORY_MEMBER_SOURCE = "EVERYCAFE_HISTORY_MEMBER";
const EVERYCAFE_HISTORY_CATEGORY = "EveryCafe Geçmiş Ciro";
const EVERYCAFE_HISTORY_MEMBER_CATEGORY = "EveryCafe Geçmiş Üye";

const EVERYCAFE_CALENDAR_DAY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function everyCafeCalendarDayKey(ts) {
  const parts = EVERYCAFE_CALENDAR_DAY_FMT.formatToParts(new Date(Number(ts) || 0));
  const value = {};
  parts.forEach((part) => {
    if (part.type !== "literal") value[part.type] = part.value;
  });
  return `${value.year || "0000"}-${value.month || "00"}-${value.day || "00"}`;
}

function everyCafeCalendarDayStartTs(ts = Date.now()) {
  const key = everyCafeCalendarDayKey(ts);
  // Europe/Istanbul 2026'da sabit UTC+03:00. ISO offset kullanmak sunucu
  // Windows saat diliminden bağımsız olarak EveryCafe takvim gününü sabitler.
  const value = new Date(`${key}T00:00:00+03:00`).getTime();
  return Number.isFinite(value) ? value : 0;
}

function everyCafeCalendarDayEndTs(ts = Date.now()) {
  return everyCafeCalendarDayStartTs(ts) + 24 * 60 * 60 * 1000;
}

function kafePinDbAllP(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

function kafePinDbGetP(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
  });
}

function kafePinDbRunP(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: Number(this.lastID) || 0, changes: Number(this.changes) || 0 });
    });
  });
}

function sqliteAllP(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

function sqliteGetP(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
  });
}

function openEveryCafeReadOnlyP() {
  return new Promise((resolve, reject) => {
    const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      resolve(source);
    });
  });
}

function closeSqliteP(connection) {
  return new Promise((resolve) => {
    if (!connection) return resolve();
    connection.close(() => resolve());
  });
}

// -----------------------------------------------------------------------------
// v3.1.38 • EveryCafe İptal / Ücretsiz / Silinenler
// -----------------------------------------------------------------------------
const EVERYCAFE_RECONCILE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const EVERYCAFE_RECONCILE_SCAN_MS = 10 * 1000;
let everyCafeReconcileScanRunning = false;
let everyCafeReconcileLastScan = 0;

function everyCafeReconcileSourceDescriptor(payment) {
  const externalSource = String(payment && payment.external_source || '').trim();
  const externalId = String(payment && payment.external_id || '').trim();
  let match;
  if (externalSource === 'EVERYCAFE' && (match = externalId.match(/^SESSION:(.+)$/))) {
    return { type:'SESSION', id:match[1], kind:'TABLE', sourceKey:`SESSION:${match[1]}` };
  }
  if (externalSource === 'EVERYCAFE_DIRECT' && (match = externalId.match(/^DIRECT_SESSION:(.+)$/))) {
    return { type:'SESSION', id:match[1], kind:'DIRECT', sourceKey:`DIRECT_SESSION:${match[1]}` };
  }
  if (externalSource === 'EVERYCAFE_MEMBER' && (match = externalId.match(/^MEMBER_PAYMENT:(\d+)$/))) {
    return { type:'MEMBER', id:Number(match[1])||0, kind:'MEMBER', sourceKey:`MEMBER_PAYMENT:${match[1]}` };
  }
  if (externalSource === 'EVERYCAFE_OTHER' && (match = externalId.match(/^PAYMENT:(.+)$/))) {
    return { type:'PAYMENT', id:match[1], kind:'OTHER', sourceKey:`PAYMENT:${match[1]}` };
  }
  if (externalSource === 'EVERYCAFE_OTHER' && (match = externalId.match(/^TICKET_EXPENSE:(\d+)$/))) {
    return { type:'EXPENSE', id:Number(match[1])||0, kind:'OTHER', sourceKey:`TICKET_EXPENSE:${match[1]}` };
  }
  if (externalSource === 'EVERYCAFE_OTHER' && (match = externalId.match(/^OTHER_SESSION:(.+)$/))) {
    return { type:'SESSION', id:match[1], kind:'OTHER', sourceKey:`OTHER_SESSION:${match[1]}` };
  }
  return null;
}

function everyCafeReconcileKindLabel(kind, masa, fallback='') {
  if (kind === 'TABLE') return `Masa ${Number(masa)||0}`;
  if (kind === 'DIRECT') return 'EveryCafe Doğrudan Satış';
  if (kind === 'MEMBER') return 'EveryCafe Üye Geliri';
  return String(fallback || 'EveryCafe Bilet / Diğer Gelir').slice(0,120);
}

function chunkEveryCafeIds(values, size=180) {
  const out=[];
  for(let i=0;i<values.length;i+=size) out.push(values.slice(i,i+size));
  return out;
}

async function readEveryCafeReconcileSourceState(descriptors) {
  const state = new Map();
  if (!descriptors.length) return state;
  const source = await openEveryCafeReadOnlyP();
  try {
    const byType = { SESSION:[], MEMBER:[], PAYMENT:[], EXPENSE:[] };
    descriptors.forEach((d)=>{ if(d && byType[d.type]) byType[d.type].push(d); });

    const sessionIds=[...new Set(byType.SESSION.map(d=>String(d.id)))];
    for(const ids of chunkEveryCafeIds(sessionIds)){
      if(!ids.length) continue;
      const rows=await sqliteAllP(source,
        `SELECT SessionID,Deleted,SessionType,SessionTypeText,SessionDetailDataText,ClientName,PaymentAmount,PaymentMethod,StartDate,EndDate
         FROM Sessions WHERE CAST(SessionID AS TEXT) IN (${ids.map(()=>'?').join(',')})`, ids);
      rows.forEach(r=>state.set(`SESSION:${String(r.SessionID)}`,r));
    }

    const memberIds=[...new Set(byType.MEMBER.map(d=>Number(d.id)||0).filter(Boolean))];
    for(const ids of chunkEveryCafeIds(memberIds)){
      if(!ids.length) continue;
      const rows=await sqliteAllP(source,
        `SELECT HistoryID,PaymentAmount,PaymentMethod,IsActive,PaymentDate,Note
         FROM MemberPaymentHistory WHERE HistoryID IN (${ids.map(()=>'?').join(',')})`, ids);
      rows.forEach(r=>state.set(`MEMBER:${Number(r.HistoryID)||0}`,r));
    }

    const paymentIds=[...new Set(byType.PAYMENT.map(d=>String(d.id)))];
    for(const ids of chunkEveryCafeIds(paymentIds)){
      if(!ids.length) continue;
      const rows=await sqliteAllP(source,
        `SELECT PaymentID,SessionID,PaymentMethod,PaymentAmount,PaymentStatus,PaymentType,Notes,AddDate,UpdDate,Deleted
         FROM Payments WHERE CAST(PaymentID AS TEXT) IN (${ids.map(()=>'?').join(',')})`, ids);
      rows.forEach(r=>state.set(`PAYMENT:${String(r.PaymentID)}`,r));
    }

    const expenseIds=[...new Set(byType.EXPENSE.map(d=>Number(d.id)||0).filter(Boolean))];
    for(const ids of chunkEveryCafeIds(expenseIds)){
      if(!ids.length) continue;
      const rows=await sqliteAllP(source,
        `SELECT ExpenseID,Description,PaymentMethod,Type,Price,AddDate,TicketID,PrintJobID
         FROM Expense WHERE ExpenseID IN (${ids.map(()=>'?').join(',')})`, ids);
      rows.forEach(r=>state.set(`EXPENSE:${Number(r.ExpenseID)||0}`,r));
    }
  } finally {
    await closeSqliteP(source);
  }
  return state;
}

function everyCafeReconcileStateKey(descriptor) {
  if (!descriptor) return '';
  if (descriptor.type === 'SESSION') return `SESSION:${String(descriptor.id)}`;
  if (descriptor.type === 'MEMBER') return `MEMBER:${Number(descriptor.id)||0}`;
  if (descriptor.type === 'PAYMENT') return `PAYMENT:${String(descriptor.id)}`;
  if (descriptor.type === 'EXPENSE') return `EXPENSE:${Number(descriptor.id)||0}`;
  return '';
}

function isEveryCafeReconcileSourceActive(descriptor, row) {
  if (!descriptor || !row) return false;
  if (descriptor.type === 'SESSION') return Number(row.Deleted||0) === 0;
  if (descriptor.type === 'MEMBER') return Number(row.IsActive == null ? 1 : row.IsActive) !== 0 && Number(row.PaymentAmount||0) > 0;
  if (descriptor.type === 'PAYMENT') return Number(row.Deleted||0) === 0 && Number(row.PaymentAmount||0) > 0;
  if (descriptor.type === 'EXPENSE') return Number(row.Type||0) === 1 && Number(row.Price||0) > 0 && [1,2].includes(Number(row.PaymentMethod));
  return false;
}

async function getEveryCafeLocalRemovalSnapshot(payment, descriptor) {
  let products=[];
  if (descriptor.kind === 'TABLE') {
    products=await kafePinDbAllP(
      `SELECT id,product_name,quantity,unit_price,total,external_id
       FROM product_sales WHERE voided=0 AND external_source='EVERYCAFE' AND masa=? AND session_start=? ORDER BY id`,
      [Number(payment.masa)||0,Number(payment.session_start)||0]);
  } else if (descriptor.kind === 'DIRECT') {
    products=await kafePinDbAllP(
      `SELECT id,product_name,quantity,unit_price,total,external_id
       FROM product_sales WHERE voided=0 AND external_source='EVERYCAFE_DIRECT'
         AND (instr(COALESCE(note,''),?)>0 OR external_id=?) ORDER BY id`,
      [String(descriptor.id),`DIRECT_REMAINDER:${String(descriptor.id)}`]);
  } else if (Number(payment.product_sale_id)||0) {
    products=await kafePinDbAllP(
      `SELECT id,product_name,quantity,unit_price,total,external_id
       FROM product_sales WHERE id=? AND voided=0`,[Number(payment.product_sale_id)||0]);
  } else {
    products=await kafePinDbAllP(
      `SELECT id,product_name,quantity,unit_price,total,external_id
       FROM product_sales WHERE voided=0 AND external_source=? AND external_id=? ORDER BY id`,
      [String(payment.external_source||''),String(payment.external_id||'')]);
  }
  const productTotal=Math.round(products.reduce((sum,p)=>sum+(Number(p.total)||0),0)*100)/100;
  const fallbackName=products[0] && products[0].product_name ? products[0].product_name : '';
  return {
    products:products.map(p=>({id:Number(p.id)||0,name:String(p.product_name||''),quantity:Number(p.quantity)||0,unitPrice:Number(p.unit_price)||0,total:Number(p.total)||0,externalId:String(p.external_id||'')})),
    productTotal,
    name:everyCafeReconcileKindLabel(descriptor.kind,payment.masa,fallbackName),
    computerTotal:Number(payment.computer_amount)||0,
    paymentProductTotal:Number(payment.product_amount)||productTotal
  };
}

async function markEveryCafeSourceDeleted(payment, descriptor) {
  const existing=await kafePinDbGetP(`SELECT * FROM everycafe_reconcile_events WHERE source_key=?`,[descriptor.sourceKey]);
  const now=Date.now();
  if (existing) {
    if (String(existing.status)==='WAITING') {
      await kafePinDbRunP(`UPDATE everycafe_reconcile_events SET last_seen_at=?,local_payment_id=? WHERE id=?`,[now,Number(payment.id)||0,Number(existing.id)||0]);
    }
    return {created:false,id:Number(existing.id)||0};
  }
  const snap=await getEveryCafeLocalRemovalSnapshot(payment,descriptor);
  const details={
    externalSource:String(payment.external_source||''), externalId:String(payment.external_id||''),
    source:String(payment.source||''), closeReason:String(payment.close_reason||''), note:String(payment.note||''),
    sessionStart:Number(payment.session_start)||0, sessionEnd:Number(payment.session_end)||0,
    products:snap.products
  };
  const result=await kafePinDbRunP(
    `INSERT INTO everycafe_reconcile_events
     (source_key,event_type,kind,status,first_detected_at,last_seen_at,source_time,source_id,source_name,masa,total,computer_total,product_total,method,local_payment_id,resolved_at,details_json)
     VALUES(?, 'SOURCE_DELETED', ?, 'WAITING', ?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    [descriptor.sourceKey,descriptor.kind,now,now,Number(payment.created_at)||now,String(descriptor.id),snap.name,Number(payment.masa)||0,
     Number(payment.total_amount)||0,snap.computerTotal,snap.paymentProductTotal,String(payment.method||''),Number(payment.id)||0,JSON.stringify(details)]);
  addEveryCafeIntegrationLog({
    category:'DELETE',level:'WARN',masa:Number(payment.masa)||0,sessionId:descriptor.type==='SESSION'?String(descriptor.id):'',
    event:'EveryCafe kaynak kaydı silindi',
    sourceDetail:`${snap.name} • ${(Number(payment.total_amount)||0).toFixed(2)} ₺ • ${String(payment.method||'')}`,
    action:'KafePin geliri otomatik silmedi • İptal / Ücretsiz / Silinenler sayfasında onay bekliyor',
    result:'KafePin’den kaldırma bekliyor',
    details:{eventId:result.lastID,sourceKey:descriptor.sourceKey,products:snap.products,localPaymentId:Number(payment.id)||0}
  });
  addLiveLog('everycafe_source_deleted',`⚠️ EveryCafe kaynakta silindi • ${snap.name} • ${(Number(payment.total_amount)||0).toFixed(2)} ₺ • KafePin onayı bekliyor`);
  return {created:true,id:result.lastID};
}

async function markEveryCafeSourceRestored(sourceKey) {
  const row=await kafePinDbGetP(`SELECT * FROM everycafe_reconcile_events WHERE source_key=? AND status='WAITING'`,[sourceKey]);
  if(!row) return false;
  const now=Date.now();
  await kafePinDbRunP(`UPDATE everycafe_reconcile_events SET status='RESTORED',last_seen_at=?,resolved_at=? WHERE id=?`,[now,now,Number(row.id)||0]);
  addEveryCafeIntegrationLog({category:'DELETE',level:'INFO',masa:Number(row.masa)||0,event:'EveryCafe kaynak kaydı yeniden göründü',sourceDetail:`${String(row.source_name||'Kayıt')} • ${(Number(row.total)||0).toFixed(2)} ₺`,action:'Bekleyen silme uyarısı otomatik kapatıldı',result:'Kaynak yeniden mevcut',details:{eventId:Number(row.id)||0,sourceKey}});
  return true;
}

async function scanEveryCafeSourceReconciliation(options={}) {
  const force=!!options.force;
  const now=Date.now();
  if (everyCafeReconcileScanRunning) return {skipped:true,reason:'busy'};
  if (!force && everyCafeReconcileLastScan && now-everyCafeReconcileLastScan<EVERYCAFE_RECONCILE_SCAN_MS) return {skipped:true,reason:'throttled'};
  everyCafeReconcileScanRunning=true;
  try {
    const config=await getEveryCafeConfigP();
    if(!config.enabled) return {skipped:true,reason:'disabled'};
    const payments=await kafePinDbAllP(
      `SELECT id,created_at,paid_at,masa,session_start,session_end,product_sale_id,computer_amount,product_amount,total_amount,method,source,close_reason,note,external_source,external_id
       FROM payments
       WHERE voided=0 AND created_at>=? AND external_source IN ('EVERYCAFE','EVERYCAFE_DIRECT','EVERYCAFE_MEMBER','EVERYCAFE_OTHER') AND COALESCE(external_id,'')<>''
       ORDER BY id DESC LIMIT 2000`,[now-EVERYCAFE_RECONCILE_LOOKBACK_MS]);
    const items=payments.map(payment=>({payment,descriptor:everyCafeReconcileSourceDescriptor(payment)})).filter(x=>x.descriptor);
    const states=await readEveryCafeReconcileSourceState(items.map(x=>x.descriptor));
    let detected=0,restored=0,checked=0;
    for(const item of items){
      checked++;
      const key=everyCafeReconcileStateKey(item.descriptor);
      const sourceRow=states.get(key)||null;
      if(isEveryCafeReconcileSourceActive(item.descriptor,sourceRow)){
        if(await markEveryCafeSourceRestored(item.descriptor.sourceKey)) restored++;
        continue;
      }
      const r=await markEveryCafeSourceDeleted(item.payment,item.descriptor);
      if(r && r.created) detected++;
    }
    everyCafeReconcileLastScan=Date.now();
    return {ok:true,checked,detected,restored};
  } finally {
    everyCafeReconcileScanRunning=false;
  }
}

async function recordEveryCafeFreeCloseEvent(session, masa) {
  try {
    const sessionId=String(session && session.SessionID||'').trim();
    if(!sessionId) return;
    const now=Date.now();
    const end=(Number(session && session.EndDate)||0)*1000 || now;
    const rawTotal=Math.round((Number(session && session.PaymentAmount)||0)*100)/100;
    const products=(session && session.orders||[]).filter(o=>Number(o.OrderIsActive)!==0 && Number(o.Price)>0).map(o=>({
      id:String(o.OrderID||''),name:String(o.StockName||'EveryCafe Ürün'),quantity:Math.max(1,Number(o.Quantity)||1),unitPrice:Number(o.Price)||0,total:Math.round(Math.max(1,Number(o.Quantity)||1)*(Number(o.Price)||0)*100)/100
    }));
    const productTotal=Math.round(products.reduce((sum,p)=>sum+p.total,0)*100)/100;
    const result=await kafePinDbRunP(
      `INSERT OR IGNORE INTO everycafe_reconcile_events
       (source_key,event_type,kind,status,first_detected_at,last_seen_at,source_time,source_id,source_name,masa,total,computer_total,product_total,method,local_payment_id,resolved_at,details_json)
       VALUES(?, 'FREE_CLOSE','FREE','AUTO_CLEARED',?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      [`FREE_SESSION:${sessionId}`,now,now,end,sessionId,`Masa ${Number(masa)||0}`,Number(masa)||0,rawTotal,Math.max(rawTotal-productTotal,0),productTotal,everyCafePaymentMethod(session && session.PaymentMethod),now,JSON.stringify({products,sessionType:Number(session&&session.SessionType)||0,sessionTypeText:String(session&&session.SessionTypeText||''),detail:String(session&&session.SessionDetailDataText||'')})]);
    if(result.changes>0){
      addEveryCafeIntegrationLog({category:'FREE',masa:Number(masa)||0,sessionId,event:'Ücretsiz kapatma audit kaydı',sourceDetail:`EveryCafe ücretsiz kapattı • kaynakta görünen ${(rawTotal||0).toFixed(2)} ₺ • ürün ${productTotal.toFixed(2)} ₺`,action:'KafePin ödeme/ürün/geçmiş gelirlerini otomatik temizledi',result:'Gelir yazılmadı • İptal / Ücretsiz / Silinenler geçmişine eklendi',details:{eventId:result.lastID,products}});
    }
  }catch(err){logErr('recordEveryCafeFreeCloseEvent',err);}
}

function removeEveryCafeReconcileEvent(eventId, cb) {
  db.get(`SELECT * FROM everycafe_reconcile_events WHERE id=?`,[eventId],(eventErr,event)=>{
    if(eventErr) return cb(eventErr);
    if(!event) return cb(new Error('Silinen EveryCafe kaydı bulunamadı'));
    if(String(event.status)!=='WAITING') return cb(new Error('Bu kayıt artık kaldırma beklemiyor'));
    const paymentId=Number(event.local_payment_id)||0;
    db.get(`SELECT * FROM payments WHERE id=? AND voided=0`,[paymentId],(paymentErr,payment)=>{
      if(paymentErr) return cb(paymentErr);
      if(!payment){
        const now=Date.now();
        return db.run(`UPDATE everycafe_reconcile_events SET status='KAFEPIN_REMOVED',resolved_at=?,last_seen_at=? WHERE id=?`,[now,now,eventId],(markErr)=>{
          if(markErr) return cb(markErr);
          cb(null,{alreadyRemoved:true,removed:Number(event.total)||0,event});
        });
      }
      const now=Date.now();
      const details=(()=>{try{return JSON.parse(event.details_json||'{}')}catch(_e){return {}}})();
      const descriptor=everyCafeReconcileSourceDescriptor(payment);
      if(!descriptor) return cb(new Error('EveryCafe kaynak kimliği çözülemedi'));
      db.serialize(()=>{
        db.run('BEGIN IMMEDIATE',(beginErr)=>{
          if(beginErr) return cb(beginErr);
          let finished=false;
          const fail=(err)=>{if(finished)return;finished=true;db.run('ROLLBACK',()=>cb(err));};
          const finishProducts=()=>{
            const afterProducts=()=>{
              if(descriptor.kind!=='TABLE') return finishEvent();
              db.run(`DELETE FROM real_adjustments WHERE masa=? AND session_start=? AND kind='SESSION_FINALIZE'`,[Number(payment.masa)||0,Number(payment.session_start)||0],(adjErr)=>{
                if(adjErr)return fail(adjErr);
                db.run(`DELETE FROM session_history WHERE masa=? AND start_time=?`,[Number(payment.masa)||0,Number(payment.session_start)||0],(histErr)=>histErr?fail(histErr):finishEvent());
              });
            };
            if(descriptor.kind==='TABLE'){
              return db.run(`UPDATE product_sales SET voided=1,voided_at=? WHERE external_source='EVERYCAFE' AND masa=? AND session_start=? AND voided=0`,[now,Number(payment.masa)||0,Number(payment.session_start)||0],(err)=>err?fail(err):afterProducts());
            }
            if(descriptor.kind==='DIRECT'){
              return db.run(`UPDATE product_sales SET voided=1,voided_at=? WHERE external_source='EVERYCAFE_DIRECT' AND voided=0 AND (instr(COALESCE(note,''),?)>0 OR external_id=?)`,[now,String(descriptor.id),`DIRECT_REMAINDER:${String(descriptor.id)}`],(err)=>err?fail(err):afterProducts());
            }
            return db.run(`UPDATE product_sales SET voided=1,voided_at=? WHERE voided=0 AND ((id=? AND ?>0) OR (external_source=? AND external_id=?))`,[now,Number(payment.product_sale_id)||0,Number(payment.product_sale_id)||0,String(payment.external_source||''),String(payment.external_id||'')],(err)=>err?fail(err):afterProducts());
          };
          const finishEvent=()=>{
            db.run(`UPDATE everycafe_reconcile_events SET status='KAFEPIN_REMOVED',resolved_at=?,last_seen_at=? WHERE id=? AND status='WAITING'`,[now,now,eventId],function(eventUpdateErr){
              if(eventUpdateErr)return fail(eventUpdateErr);
              if(!this.changes)return fail(new Error('Kayıt durumu değişti; yeniden kontrol et'));
              db.run('COMMIT',(commitErr)=>{
                if(commitErr)return fail(commitErr);
                finished=true;
                const removed=Number(payment.total_amount)||0;
                addLiveLog('everycafe_void',`↩️ EveryCafe kaynakta silinen kayıt KafePin’den kaldırıldı • ${String(event.source_name||descriptor.kind)} • ${removed.toFixed(2)} ₺`);
                addEveryCafeIntegrationLog({category:'DELETE',level:'INFO',masa:Number(payment.masa)||0,sessionId:descriptor.type==='SESSION'?String(descriptor.id):'',event:'KafePin’den de kaldırıldı',sourceDetail:`EveryCafe kaynakta silinmiş • ${String(event.source_name||'Kayıt')} • ${removed.toFixed(2)} ₺ • ${String(payment.method||'')}`,action:`Ödeme + bağlı ürünler${descriptor.kind==='TABLE'?' + session history + finalize kaydı':''} KafePin gelirinden çıkarıldı`,result:'Kullanıcı onayıyla tamamlandı • audit kaydı korundu',details:{eventId,sourceKey:String(event.source_key||''),localPaymentId:paymentId,products:details.products||[]}});
                cb(null,{removed,eventId,kind:descriptor.kind,masa:Number(payment.masa)||0,products:details.products||[]});
              });
            });
          };
          db.run(`UPDATE payments SET voided=1,voided_at=? WHERE id=? AND voided=0`,[now,paymentId],function(payVoidErr){
            if(payVoidErr)return fail(payVoidErr);
            if(!this.changes)return fail(new Error('KafePin ödeme kaydı zaten kaldırılmış'));
            finishProducts();
          });
        });
      });
    });
  });
}

function parseEveryCafeHistoryClosure(activityText) {
  const raw = normalizeTurkishText(String(activityText || "")).trim();
  // Örnekler:
  // MASA-03: Hesap Kesildi. (240.00 TL)
  // MASA-20: Ücretsiz Kapatıldı. (55.00 TL)
  const match = raw.match(/^(.*?):\s*(Hesap Kesildi|Ücretsiz Kapatıldı)\.\s*\(\s*(-?\d+(?:[.,]\d+)?)\s*TL\s*\)/i);
  if (!match) return null;
  const clientName = String(match[1] || "").trim();
  const actionText = String(match[2] || "");
  const amount = Math.round((Number(String(match[3] || "0").replace(",", ".")) || 0) * 100) / 100;
  return {
    clientName,
    action: /ücretsiz/i.test(actionText) ? "FREE" : "PAID",
    actionText,
    amount
  };
}

function everyCafeHistoryKind(clientName) {
  const name = String(clientName || "").trim();
  const masa = everyCafeTableNumber(name);
  if (masa) return { kind: "TABLE", masa };
  if (isEveryCafeDirectSaleClient(name)) return { kind: "DIRECT", masa: 0 };
  if (/^\d+\s*masa$/i.test(name)) return { kind: "GROUP", masa: 0 };
  return { kind: "OTHER", masa: 0 };
}

function normalizeEveryCafeHistoryOptions(raw = {}) {
  return {
    includeTables: raw.includeTables !== false,
    includeDirect: raw.includeDirect !== false,
    includeMembers: raw.includeMembers !== false
  };
}

function everyCafeHistoryItemSelected(item, options) {
  if (item.kind === "MEMBER") return !!options.includeMembers;
  if (item.kind === "DIRECT") return !!options.includeDirect;
  return !!options.includeTables;
}

function everyCafeHistorySourceHash(sessionRows, orderRows, memberRows, otherPaymentRows, ticketSaleRows) {
  const data = {
    sessions: (sessionRows || []).map((row) => [
      String(row.SessionID || ""), String(row.ClientName || ""),
      Number(row.StartDate) || 0, Number(row.EndDate) || 0,
      Number(row.PaymentMethod) || 0, Number(row.PaymentAmount) || 0,
      Number(row.SessionType) || 0, String(row.SessionTypeText || ""),
      Number(row.Deleted) || 0, Number(row.TicketID) || 0,
      Number(row.TicketSetID) || 0, Number(row.TicketOrder) || 0,
      Number(row.TicketOrderAmount) || 0
    ]),
    orders: (orderRows || []).map((row) => [
      String(row.OrderID || ""), String(row.SessionID || ""), Number(row.StockID) || 0,
      String(row.StockName || ""), Number(row.Quantity) || 0, Number(row.Price) || 0,
      Number(row.AddDate) || 0, Number(row.OrderIsActive) || 0, String(row.CategoryName || "")
    ]),
    members: (memberRows || []).map((row) => [
      Number(row.HistoryID) || 0, Number(row.PaymentAmount) || 0,
      Number(row.PaymentMethod) || 0, Number(row.IsActive) || 0,
      Number(row.PaymentDate) || 0, String(row.PaymentKey || ""), String(row.Note || "")
    ]),
    otherPayments: (otherPaymentRows || []).map((row) => [
      String(row.PaymentID || ""), String(row.SessionID || ""),
      Number(row.PaymentMethod) || 0, Number(row.PaymentAmount) || 0,
      Number(row.PaymentStatus) || 0, Number(row.PaymentType) || 0,
      Number(row.AddDate) || 0, Number(row.Deleted) || 0, String(row.Notes || "")
    ]),
    ticketSales: (ticketSaleRows || []).map((row) => [
      Number(row.ExpenseID) || 0, String(row.Description || ""), String(row.PaymentMethod || ""),
      Number(row.Type) || 0, Number(row.Price) || 0, Number(row.AddDate) || 0, String(row.TicketID || "")
    ])
  };
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

async function readEveryCafeHistorySource() {
  let source = null;
  try {
    source = await openEveryCafeReadOnlyP();

    // v3.0.19 STABIL: Activity kapanış logları gelir kaynağı değildir.
    // Gelir yalnız EveryCafe'nin halen aktif rapor/veri tablolarında duran
    // gerçek kayıtlarından alınır. Böylece rapordan silinen eski kayıtlar
    // Activity'de kalsa bile tekrar ciroya dönmez.
    const sessionRows = await sqliteAllP(
      source,
      `SELECT SessionID,ClientName,StartDate,EndDate,PaymentMethod,PaymentAmount,
              SessionType,SessionTypeText,SessionDetailDataText,Price,
              TicketID,TicketSetID,TicketOrder,TicketOrderAmount,
              HasRefund,RefundAmount,Deleted,CashierName,IsPaid,IsActive
       FROM Sessions
       WHERE COALESCE(Deleted,0)=0
         AND (COALESCE(IsPaid,0)=1 OR COALESCE(TicketOrderAmount,0)>0)
         AND COALESCE(EndDate,0)>0
       ORDER BY EndDate ASC,SessionID ASC`
    );

    const sessionIds = sessionRows.map((row) => String(row.SessionID || "")).filter(Boolean);
    let orderRows = [];
    if (sessionIds.length) {
      orderRows = await sqliteAllP(
        source,
        `SELECT o.OrderID,o.SessionID,o.StockID,o.StockName,o.Quantity,o.Price,o.AddDate,o.OrderIsActive,
                COALESCE(c.LookupText1,'') AS CategoryName
         FROM Orders o
         LEFT JOIN Stocks st ON st.StockID=o.StockID
         LEFT JOIN LookupValues c ON c.LookupKey='ProductCategories' AND c.LookupValue1=st.CategoryID
         WHERE o.SessionID IN (${sessionIds.map(() => "?").join(",")})
         ORDER BY o.AddDate ASC,o.OrderID ASC`,
        sessionIds
      );
    }

    const memberRows = await sqliteAllP(
      source,
      `SELECT HistoryID,MemberID,PaymentAmount,PaymentMethod,IsActive,PaymentDate,
              PaymentKey,Note,CashierName,HideFromReport
       FROM MemberPaymentHistory
       WHERE COALESCE(IsActive,1)<>0
         AND PaymentMethod IN (1,2)
         AND COALESCE(PaymentAmount,0)>0
       ORDER BY PaymentDate ASC,HistoryID ASC`
    );

    // Bazı EveryCafe sürümleri bilet/epin/teknik vb. kasa gelirlerini Sessions
    // yerine Payments tablosunda tutabilir. Sessions'a bağlı ödeme burada tekrar
    // sayılmaz; yalnız bağımsız gerçek tahsilatlar ek kaynak olur.
    const otherPaymentRows = await sqliteAllP(
      source,
      `SELECT PaymentID,SessionID,PaymentMethod,PaymentAmount,PaymentStatus,PaymentType,
              IsPrepaid,IsMoneyChange,MoneyChangeAmount,Notes,AddDate,UpdDate,MemberID,
              COALESCE(Deleted,0) AS Deleted
       FROM Payments
       WHERE COALESCE(Deleted,0)=0
         AND COALESCE(IsMoneyChange,0)=0
         AND PaymentMethod IN (1,2)
         AND COALESCE(PaymentAmount,0)>0
       ORDER BY AddDate ASC,PaymentID ASC`
    );

    // v3.1.37: Expense = EveryCafe Kasa Hareketleri. Type=1 pozitif satırlar gelir,
    // Type=0 gider/iade tarafıdır. Gider entegrasyonu yapılmaz; yalnız gelir hareketleri
    // kaynak ciroya ve Bilet / Diğer Gelir akışına dahil edilir.
    let ticketSaleRows = [];
    const expenseTable = await sqliteGetP(source, "SELECT name FROM sqlite_master WHERE type='table' AND name='Expense'");
    if (expenseTable) {
      const expenseColumns = await sqliteAllP(source, "PRAGMA table_info('Expense')");
      const expenseNames = new Set((expenseColumns || []).map((c) => String(c.name || '')));
      if (['ExpenseID','Description','PaymentMethod','Type','Price','AddDate'].every((name) => expenseNames.has(name))) {
        const cashierSelect = expenseNames.has('CashierName') ? 'e.CashierName AS CashierName' : "'' AS CashierName";
        const ticketSelect = expenseNames.has('TicketID') ? 'e.TicketID AS TicketID' : 'NULL AS TicketID';
        ticketSaleRows = (await sqliteAllP(
          source,
          `SELECT e.ExpenseID,e.Description,e.PaymentMethod,e.Type AS Type,e.Price,${cashierSelect},e.AddDate,${ticketSelect}
           FROM Expense e
           WHERE COALESCE(e.Type,0)=1
             AND COALESCE(e.Price,0)>0
             AND e.PaymentMethod IN (1,2)
           ORDER BY e.AddDate ASC,e.ExpenseID ASC`
        )).filter(isEveryCafeTicketCashMovement);
      }
    }

    // Sadece bilgi amaçlıdır. Bu kayıtların hiçbiri gelir/aktarım kaynağı olmaz.
    const deletionAuditRows = await sqliteAllP(
      source,
      `SELECT ActivityID,Activity,Cashier,Date,SessionID
       FROM Activity
       WHERE Activity LIKE '%Kasa Raporundan%kayıt silindi%'
          OR Activity LIKE '%Filtreli Tüm Rapor Silindi%'
          OR Activity LIKE '%bilet(ler) silindi%'
       ORDER BY Date DESC,ActivityID DESC`
    );

    return {
      sessionRows, orderRows, memberRows, otherPaymentRows, ticketSaleRows, deletionAuditRows,
      signature: everyCafeHistorySourceHash(sessionRows, orderRows, memberRows, otherPaymentRows, ticketSaleRows)
    };
  } finally {
    await closeSqliteP(source);
  }
}


function summarizeEveryCafeHistorySource(source, rangeStart, rangeEnd) {
  const start=Math.max(0,Number(rangeStart)||0), end=Math.max(start,Number(rangeEnd)||Number.MAX_SAFE_INTEGER);
  const round=(v)=>Math.round((Number(v)||0)*100)/100;
  const sessionById=new Map((source.sessionRows||[]).map((r)=>[String(r.SessionID||"").trim(),r]));
  const paymentsBySession=new Map();
  (source.otherPaymentRows||[]).forEach((p)=>{
    const sid=String(p.SessionID||"").trim(); if(!sid)return;
    if(!paymentsBySession.has(sid))paymentsBySession.set(sid,[]);
    paymentsBySession.get(sid).push(p);
  });
  const ordersBySession=new Map();
  (source.orderRows||[]).forEach((o)=>{const sid=String(o.SessionID||"").trim();if(!ordersBySession.has(sid))ordersBySession.set(sid,[]);ordersBySession.get(sid).push(o);});
  let sessionTotal=0,memberTotal=0,otherTotal=0,productTotal=0,productQuantity=0;
  (source.sessionRows||[]).forEach((row)=>{
    const ts=(Number(row.EndDate)||0)*1000; if(ts<start||ts>=end||isEveryCafeFreeSession(row))return;
    const sid=String(row.SessionID||"").trim(), direct=isEveryCafeDirectSaleSession(row), masa=everyCafeTableNumber(row.ClientName), other=!direct&&!masa;
    if(other&&(paymentsBySession.get(sid)||[]).some((p)=>Number(p.Deleted||0)===0&&Number(p.IsMoneyChange||0)===0&&[1,2].includes(Number(p.PaymentMethod))&&Number(p.PaymentAmount)>0))return;
    const total=everyCafeSessionRevenueTotal(row); if(total<=0)return;
    sessionTotal+=total;
    if(masa||direct){
      (ordersBySession.get(sid)||[]).forEach((o)=>{if(Number(o.OrderIsActive)===0)return;const price=Number(o.Price)||0,qty=Math.max(0,Number(o.Quantity)||0);if(price<=0||qty<=0)return;productTotal+=qty*price;productQuantity+=qty;});
    }
  });
  (source.memberRows||[]).forEach((row)=>{const ts=(Number(row.PaymentDate)||0)*1000;if(ts>=start&&ts<end)memberTotal+=Math.max(0,Number(row.PaymentAmount)||0);});
  (source.otherPaymentRows||[]).forEach((row)=>{
    if(Number(row.Deleted||0)!==0||Number(row.IsMoneyChange||0)!==0||![1,2].includes(Number(row.PaymentMethod))||Number(row.PaymentAmount)<=0)return;
    const ts=(Number(row.AddDate)||Number(row.UpdDate)||0)*1000;if(ts<start||ts>=end)return;
    const sid=String(row.SessionID||"").trim();
    if(sid&&sessionById.has(sid)){
      const linked=sessionById.get(sid);
      if(everyCafeTableNumber(linked.ClientName)||isEveryCafeDirectSaleSession(linked))return;
    }
    otherTotal+=Number(row.PaymentAmount)||0;
  });
  (source.ticketSaleRows||[]).forEach((row)=>{
    if(!isEveryCafeTicketCashMovement(row))return;
    const ts=everyCafeTicketCashMovementTime(row)*1000;if(ts<start||ts>=end)return;
    otherTotal+=Number(row.Price)||0;
  });
  return {sessionTotal:round(sessionTotal),memberTotal:round(memberTotal),otherTotal:round(otherTotal),productTotal:round(productTotal),productQuantity, total:round(sessionTotal+memberTotal+otherTotal)};
}

async function getEveryCafeHistoryTrackingState() {
  const [historyRows, sessionRows, memberRows, externalRows, localHistoryRows, localProductRows, localPaymentRows, comparableRow] = await Promise.all([
    kafePinDbAllP(`SELECT * FROM everycafe_history_imports ORDER BY source_key`),
    kafePinDbAllP(`SELECT session_id,masa,source_end,total FROM everycafe_imports ORDER BY session_id`),
    kafePinDbAllP(`SELECT history_id,source_time,amount FROM everycafe_member_imports ORDER BY history_id`),
    kafePinDbAllP(
      `SELECT id,time,masa,session_start,total,sale_type,category,product_name,
              COALESCE(external_source,'') AS external_source,
              COALESCE(external_id,'') AS external_id,COALESCE(note,'') AS note
       FROM product_sales
       WHERE voided=0 AND COALESCE(external_source,'') LIKE 'EVERYCAFE%'
       ORDER BY id`
    ),
    kafePinDbAllP(
      `SELECT id,masa,start_time,end_time,fee,COALESCE(close_reason,'') AS close_reason,
              COALESCE(note,'') AS note
       FROM session_history
       WHERE COALESCE(end_time,0)>0
       ORDER BY end_time,id`
    ),
    kafePinDbAllP(
      `SELECT id,time,masa,session_start,total,sale_type,category,product_name,
              COALESCE(external_source,'') AS external_source,
              COALESCE(external_id,'') AS external_id,COALESCE(note,'') AS note
       FROM product_sales WHERE voided=0 ORDER BY time,id`
    ),
    kafePinDbAllP(
      `SELECT id,created_at,paid_at,masa,session_start,session_end,total_amount,
              computer_amount,product_amount,COALESCE(source,'') AS source,
              COALESCE(external_source,'') AS external_source,
              COALESCE(external_id,'') AS external_id,COALESCE(note,'') AS note
       FROM payments WHERE voided=0 ORDER BY created_at,id`
    ),
    kafePinDbGetP(
      `SELECT
         COALESCE((SELECT SUM(fee) FROM session_history WHERE COALESCE(end_time,0)>0),0)
         + COALESCE((SELECT SUM(total) FROM product_sales WHERE voided=0 AND sale_type='TABLE' AND status='FINALIZED'),0)
         + COALESCE((SELECT SUM(total) FROM product_sales WHERE voided=0 AND sale_type='DIRECT'
                     AND (external_source IN ('EVERYCAFE_DIRECT','EVERYCAFE_MEMBER','EVERYCAFE_OTHER')
                          OR ${LEGACY_EVERYCAFE_MEMBER_SQL})),0)
         + COALESCE((SELECT SUM(total) FROM product_sales WHERE voided=0 AND sale_type='HISTORY'
                     AND external_source IN ('EVERYCAFE_HISTORY','EVERYCAFE_HISTORY_MEMBER')),0) AS total`
    )
  ]);

  const historyByKey = new Map(historyRows.map((row) => [String(row.source_key || ""), row]));
  const sessionsById = new Map(sessionRows.map((row) => [String(row.session_id || ""), row]));
  const membersById = new Map(memberRows.map((row) => [Number(row.history_id) || 0, row]));
  const externalByKey = new Map();
  externalRows.forEach((row) => {
    const source = String(row.external_source || "");
    const externalId = String(row.external_id || "");
    if (source && externalId) externalByKey.set(`${source}:${externalId}`, row);
  });

  const signaturePayload = {
    history: historyRows.map((r) => [r.source_key,r.source_session_id,Number(r.total)||0]),
    sessions: sessionRows.map((r) => [r.session_id,Number(r.source_end)||0,Number(r.total)||0]),
    members: memberRows.map((r) => [Number(r.history_id)||0,Number(r.source_time)||0,Number(r.amount)||0]),
    external: externalRows.map((r) => [Number(r.id)||0,String(r.external_source||""),String(r.external_id||""),Number(r.total)||0]),
    localHistory: localHistoryRows.map((r) => [Number(r.id)||0,Number(r.masa)||0,Number(r.start_time)||0,Number(r.end_time)||0,Number(r.fee)||0]),
    localProducts: localProductRows.map((r) => [Number(r.id)||0,Number(r.time)||0,Number(r.masa)||0,Number(r.session_start)||0,Number(r.total)||0,String(r.external_source||"")]),
    localPayments: localPaymentRows.map((r) => [Number(r.id)||0,Number(r.created_at)||0,Number(r.masa)||0,Number(r.session_start)||0,Number(r.total_amount)||0,String(r.source||""),String(r.external_source||"")])
  };
  const signature = crypto.createHash("sha256").update(JSON.stringify(signaturePayload)).digest("hex");
  return { historyByKey,sessionsById,membersById,externalByKey,localHistoryRows,localProductRows,localPaymentRows,localComparableTotal: Math.round((Number(comparableRow && comparableRow.total)||0)*100)/100,signature };
}

function findLegacyEveryCafeHistoryMatches(item, tracking) {
  const amount = Math.round((Number(item.total)||0)*100)/100;
  const sourceTime = Number(item.sourceTime)||0;
  const sourceStart = Number(item.sourceStart)||0;
  const masa = Number(item.masa)||0;
  const matches=[];
  const sameCalendarDay = (ts) => Boolean(ts) && everyCafeCalendarDayKey(Number(ts)) === item.calendarDay;

  if (item.kind === "MEMBER") {
    // Eski otomatik üye aktarımı zaten kaynak etiketi taşıyorsa doğrudan eşleştir.
    (tracking.localPaymentRows||[]).forEach((row) => {
      const source = `${row.source||""} ${row.external_source||""}`.toUpperCase();
      if (!source.includes("EVERYCAFE_MEMBER")) return;
      if (Math.abs((Number(row.total_amount)||0)-amount)>0.01) return;
      const t=Number(row.paid_at)||Number(row.created_at)||0;
      if (Math.abs(t-sourceTime)<=10*60*1000) matches.push({via:"legacy_member_payment",id:Number(row.id)||0});
    });

    // v3.0.18 öncesinde kullanıcı "EveryCafe Üye Geliri"ni tarihli olarak
    // elle eklemiş olabilir. Bu kayıt yeni para değildir: aynı takvim günü +
    // aynı tutar + açık üye-geliri işareti varsa mevcut kabul edilir.
    if (!matches.length) {
      (tracking.localProductRows||[]).forEach((row) => {
        if (!isLegacyEveryCafeManualMemberSale(row)) return;
        if (Math.abs((Number(row.total)||0)-amount)>0.01) return;
        if (!sameCalendarDay(Number(row.time)||0)) return;
        matches.push({via:"legacy_manual_member_income",id:Number(row.id)||0});
      });
    }
  } else if (item.kind === "DIRECT") {
    (tracking.localPaymentRows||[]).forEach((row) => {
      const source = `${row.source||""} ${row.external_source||""}`.toUpperCase();
      if (!source.includes("EVERYCAFE_DIRECT")) return;
      if (Math.abs((Number(row.total_amount)||0)-amount)>0.01) return;
      const t=Number(row.paid_at)||Number(row.created_at)||0;
      if (Math.abs(t-sourceTime)<=10*60*1000) matches.push({via:"legacy_direct_payment",id:Number(row.id)||0});
    });
  } else if (item.kind === "OTHER") {
    (tracking.localPaymentRows||[]).forEach((row) => {
      const source = `${row.source||""} ${row.external_source||""}`.toUpperCase();
      if (!source.includes("EVERYCAFE")) return;
      if (Math.abs((Number(row.total_amount)||0)-amount)>0.01) return;
      const t=Number(row.paid_at)||Number(row.created_at)||0;
      if (Math.abs(t-sourceTime)<=5*60*1000) matches.push({via:"legacy_other_payment",id:Number(row.id)||0});
    });
  } else if (masa>0 && sourceStart>0) {
    // Önce güçlü eşleşme: masa + tutar + gerçek kapanış saati. Eski KafePin
    // sürümleri session_start'ı istemci başlangıcından üretmiş olabildiği için
    // başlangıcın birebir olması artık zorunlu değildir.
    (tracking.localPaymentRows||[]).forEach((row) => {
      if ((Number(row.masa)||0)!==masa) return;
      if (Math.abs((Number(row.total_amount)||0)-amount)>0.01) return;
      const end=Number(row.session_end)||Number(row.paid_at)||Number(row.created_at)||0;
      if (Math.abs(end-sourceTime)>15*60*1000) return;
      matches.push({via:"legacy_table_payment_close",id:Number(row.id)||0});
    });

    // Ödeme satırı eski sürümde yoksa session_history + ürün toplamını aynı
    // masa ve kapanış gününde karşılaştır. Tek eşleşme varsa ikinci kez yazma.
    if (!matches.length) {
      (tracking.localHistoryRows||[]).forEach((row) => {
        if ((Number(row.masa)||0)!==masa) return;
        const st=Number(row.start_time)||0, en=Number(row.end_time)||0;
        if (!sameCalendarDay(en)) return;
        const products=(tracking.localProductRows||[]).filter((p) =>
          (Number(p.masa)||0)===masa && Math.abs((Number(p.session_start)||0)-st)<=1000 && Number(p.total)>0
        );
        const productTotal=products.reduce((sum,p)=>sum+(Number(p.total)||0),0);
        const localTotal=Math.round(((Number(row.fee)||0)+productTotal)*100)/100;
        if (Math.abs(localTotal-amount)<=0.01) matches.push({via:"legacy_table_day_accounting",id:Number(row.id)||0});
      });
    }

    // Son güvenli köprü: aynı gün + aynı masa + aynı toplam tek ödeme ise
    // mevcut kabul edilir. Birden fazla aday varsa aşağıda conflict olur.
    if (!matches.length) {
      (tracking.localPaymentRows||[]).forEach((row) => {
        if ((Number(row.masa)||0)!==masa) return;
        if (Math.abs((Number(row.total_amount)||0)-amount)>0.01) return;
        const t=Number(row.session_end)||Number(row.paid_at)||Number(row.created_at)||0;
        if (!sameCalendarDay(t)) return;
        matches.push({via:"legacy_table_day_payment",id:Number(row.id)||0});
      });
    }
  }

  // Aynı tablo satırını aynı yöntem içinde iki kez sayma.
  const uniq=new Map(); matches.forEach((m)=>uniq.set(`${m.via}:${m.id}`,m));
  return Array.from(uniq.values());
}

function summarizeEveryCafeHistoryDaily(items) {
  const map = new Map();
  (items || []).forEach((item) => {
    const day = item.calendarDay;
    if (!day) return;
    const row = map.get(day) || {
      day,
      sourceCount: 0,
      sourceTotal: 0,
      existingCount: 0,
      existingTotal: 0,
      newCount: 0,
      newTotal: 0,
      directTotal: 0,
      memberTotal: 0
    };
    row.sourceCount += 1;
    row.sourceTotal += Number(item.total) || 0;
    if (item.status === "existing") {
      row.existingCount += 1;
      row.existingTotal += Number(item.total) || 0;
    } else if (item.status === "new") {
      row.newCount += 1;
      row.newTotal += Number(item.total) || 0;
    }
    if (item.kind === "DIRECT") row.directTotal += Number(item.total) || 0;
    if (item.kind === "MEMBER") row.memberTotal += Number(item.total) || 0;
    map.set(day, row);
  });
  return Array.from(map.values())
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((row) => ({
      ...row,
      sourceTotal: Math.round(row.sourceTotal * 100) / 100,
      existingTotal: Math.round(row.existingTotal * 100) / 100,
      newTotal: Math.round(row.newTotal * 100) / 100,
      directTotal: Math.round(row.directTotal * 100) / 100,
      memberTotal: Math.round(row.memberTotal * 100) / 100
    }));
}

async function analyzeEveryCafeHistory(rawOptions = {}) {
  const options = normalizeEveryCafeHistoryOptions(rawOptions);
  const source = await readEveryCafeHistorySource();
  const tracking = await getEveryCafeHistoryTrackingState();

  const warnings=[];
  const conflicts=[];
  const informational=[];
  const sessionItems=[];
  let freeSessions=0, freeDisplayedTotal=0, zeroSessions=0;
  let tableComputerTotal=0, tableProductTotal=0, directTotal=0, memberTotal=0, otherTotal=0;

  const ordersBySession=new Map();
  (source.orderRows||[]).forEach((row)=>{
    const sid=String(row.SessionID||"");
    if (!ordersBySession.has(sid)) ordersBySession.set(sid,[]);
    ordersBySession.get(sid).push(row);
  });

  // Payments tablosundaki bir satır herhangi bir Sessions kaydına bağlıysa
  // (ücretsiz/test dahil) aynı fiziksel işlemdir; OTHER olarak yeniden sayılmaz.
  const knownSessionIds=new Set((source.sessionRows||[]).map((r)=>String(r.SessionID||"").trim()).filter(Boolean));
  const paymentsBySession=new Map();
  (source.otherPaymentRows||[]).forEach((p)=>{
    const sid=String(p.SessionID||"").trim();
    if(!sid) return;
    if(!paymentsBySession.has(sid)) paymentsBySession.set(sid,[]);
    paymentsBySession.get(sid).push(p);
  });
  const selectedSessionIds=new Set();
  for (const row of source.sessionRows||[]) {
    const sessionId=String(row.SessionID||"").trim();
    const sourceStart=(Number(row.StartDate)||0)*1000;
    const sourceTime=(Number(row.EndDate)||0)*1000;
    const total=everyCafeSessionRevenueTotal(row);
    const clientName=String(row.ClientName||"").trim();
    if (!sessionId || !sourceTime) {
      warnings.push({code:"SESSION_SOURCE",text:"EveryCafe aktif raporunda SessionID veya kapanış tarihi eksik bir kayıt bulundu; aktarılmadı."});
      continue;
    }
    if (isEveryCafeFreeSession(row)) {
      freeSessions+=1; freeDisplayedTotal+=Math.max(total,0); continue;
    }
    if (Math.abs(total)<0.0001) { zeroSessions+=1; continue; }
    if (total<0) {
      conflicts.push({code:"NEGATIVE_CURRENT_SESSION",sourceKey:`SESSION:${sessionId}`,text:`${clientName||"EveryCafe"} aktif raporunda negatif tahsilat (${total.toFixed(2)} ₺) var; otomatik aktarım durduruldu.`});
      continue;
    }

    const rawOrders=(ordersBySession.get(sessionId)||[]).map((order)=>({
      id:String(order.OrderID||"").trim(),
      stockId:Number(order.StockID)||0,
      name:String(order.StockName||"EveryCafe Ürün").trim().slice(0,100),
      category:getEveryCafeOrderCategory(order),
      quantity:Math.max(1,Number(order.Quantity)||1),
      price:Math.max(0,Number(order.Price)||0),
      time:(Number(order.AddDate)||Number(row.EndDate))*1000,
      active:Number(order.OrderIsActive)!==0
    })).filter((o)=>o.id && o.active && o.price>0);
    const productTotal=Math.round(rawOrders.reduce((sum,o)=>sum+o.quantity*o.price,0)*100)/100;
    if (productTotal>total+0.01) {
      conflicts.push({code:"DETAIL_TOTAL_MISMATCH",sourceKey:`SESSION:${sessionId}`,text:`${clientName||"EveryCafe"}: ürün/içecek detayı ${productTotal.toFixed(2)} ₺, tahsilat ${total.toFixed(2)} ₺. Kaynak ayrıntısı tutarsız olduğu için otomatik aktarım durduruldu.`});
      continue;
    }

    const direct=isEveryCafeDirectSaleSession(row);
    const type=everyCafeHistoryKind(clientName);
    const linkedPaymentAuthoritative = !direct && type.masa===0 && (paymentsBySession.get(sessionId)||[]).some((p)=>
      Number(p.Deleted||0)===0 && Number(p.IsMoneyChange||0)===0 && [1,2].includes(Number(p.PaymentMethod)) && Number(p.PaymentAmount)>0
    );
    // Bilet/diğer gelir bir Payments satırına bağlıysa source totalı oradan
    // hesaplanır; Session satırı ikinci kez ciroya girmez.
    if (linkedPaymentAuthoritative) continue;
    const computerTotal=direct ? 0 : Math.round((total-productTotal)*100)/100;
    const unclassifiedDirect=direct ? Math.round((total-productTotal)*100)/100 : 0;
    const kind=direct ? "DIRECT" : (type.masa>0 ? "TABLE" : "OTHER");
    if (kind==="TABLE") { tableComputerTotal+=computerTotal; tableProductTotal+=productTotal; }
    else if (kind==="DIRECT") directTotal+=total;
    else otherTotal+=total;

    selectedSessionIds.add(sessionId);
    sessionItems.push({
      sourceKey:`SESSION:${sessionId}`, sourceSessionId:sessionId, sourceActivityId:0,
      sourceStart, sourceTime, calendarDay:everyCafeCalendarDayKey(sourceTime),
      clientName, masa:type.masa, kind, sourceAction:direct?"Doğrudan Satış":"EveryCafe Oturum Geliri",
      total, computerTotal, productTotal, unclassifiedDirect,
      method:everyCafePaymentMethod(row.PaymentMethod), orders:rawOrders,
      sessionType:Number(row.SessionType)||0, sessionTypeText:String(row.SessionTypeText||""),
      status:"new"
    });
  }

  const memberItems=[];
  for (const row of source.memberRows||[]) {
    const historyId=Number(row.HistoryID)||0;
    const sourceTime=(Number(row.PaymentDate)||0)*1000;
    const total=Math.round((Number(row.PaymentAmount)||0)*100)/100;
    if (!historyId || !sourceTime || total<=0) continue;
    memberTotal+=total;
    memberItems.push({
      sourceKey:`MEMBER:${historyId}`, memberHistoryId:historyId, sourceSessionId:"", sourceActivityId:0,
      sourceStart:0, sourceTime, calendarDay:everyCafeCalendarDayKey(sourceTime),
      clientName:"EveryCafe Üye Geliri", masa:0, kind:"MEMBER", sourceAction:"Üye Ödemesi",
      total, computerTotal:0, productTotal:total, method:everyCafePaymentMethod(row.PaymentMethod),
      note:String(row.Note||"").trim().slice(0,160), status:"new"
    });
  }

  // Sessions'a zaten bağlı ödemeler aynı tahsilatın teknik alt kaydıdır ve
  // ikinci kez alınmaz. Bağımsız Payments satırları ise bilet/epin/teknik vb.
  // liste dışı gerçek gelirleri kaçırmamak için OTHER olarak dahil edilir.
  const otherItems=[];
  for (const row of source.otherPaymentRows||[]) {
    const paymentId=String(row.PaymentID||"").trim();
    const sessionId=String(row.SessionID||"").trim();
    if (!paymentId) continue;
    if (sessionId && knownSessionIds.has(sessionId)) {
      const linkedSession=(source.sessionRows||[]).find((r)=>String(r.SessionID||"").trim()===sessionId);
      if (linkedSession && (everyCafeTableNumber(linkedSession.ClientName) || isEveryCafeDirectSaleSession(linkedSession))) continue;
    }
    const sourceTime=(Number(row.AddDate)||Number(row.UpdDate)||0)*1000;
    const total=Math.round((Number(row.PaymentAmount)||0)*100)/100;
    if (!sourceTime || total<=0) continue;
    otherTotal+=total;
    otherItems.push({
      sourceKey:`PAYMENT:${paymentId}`, sourcePaymentId:paymentId, sourceSessionId:sessionId,
      sourceActivityId:0, sourceStart:0, sourceTime, calendarDay:everyCafeCalendarDayKey(sourceTime),
      clientName:"EveryCafe Diğer Gelir", masa:0, kind:"OTHER", sourceAction:"EveryCafe Kasa Geliri",
      total, computerTotal:0, productTotal:total, method:everyCafePaymentMethod(row.PaymentMethod),
      note:String(row.Notes||"").trim().slice(0,160), status:"new"
    });
  }

  for (const row of source.ticketSaleRows||[]) {
    if (!isEveryCafeTicketCashMovement(row)) continue;
    const expenseId=Number(row.ExpenseID)||0;
    const sourceTime=everyCafeTicketCashMovementTime(row)*1000;
    const total=Math.round((Number(row.Price)||0)*100)/100;
    if(!expenseId||!sourceTime||total<=0) continue;
    otherTotal+=total;
    const incomeName=everyCafeOtherIncomeName(row.Description,"EveryCafe Bilet / Diğer Gelir");
    otherItems.push({
      sourceKey:everyCafeTicketCashMovementExternalId(row), sourcePaymentId:`EXPENSE:${expenseId}`, sourceSessionId:"",
      sourceActivityId:0, sourceStart:0, sourceTime, calendarDay:everyCafeCalendarDayKey(sourceTime),
      clientName:incomeName, masa:0, kind:"OTHER", sourceAction:"EveryCafe Kasa Geliri",
      total, computerTotal:0, productTotal:total, method:everyCafePaymentMethod(row.PaymentMethod),
      note:String(row.Description||"").trim().slice(0,160), status:"new"
    });
  }

  const selectedItems=[...sessionItems,...memberItems,...otherItems]
    .filter((item)=>everyCafeHistoryItemSelected(item,options))
    .sort((a,b)=>a.sourceTime-b.sourceTime || a.sourceKey.localeCompare(b.sourceKey));

  for (const item of selectedItems) {
    const existingHistory=tracking.historyByKey.get(item.sourceKey);
    if (existingHistory) {
      if (Math.abs((Number(existingHistory.total)||0)-item.total)>0.01) {
        item.status="conflict";
        conflicts.push({code:"HISTORY_TOTAL_MISMATCH",sourceKey:item.sourceKey,text:`${item.sourceKey} daha önce farklı tutarla aktarılmış.`});
      } else { item.status="existing"; item.existingVia="history"; }
      continue;
    }

    if (item.kind==="MEMBER") {
      const old=tracking.membersById.get(Number(item.memberHistoryId)||0);
      if (old) {
        if (Math.abs((Number(old.amount)||0)-item.total)>0.01) {
          item.status="conflict"; conflicts.push({code:"MEMBER_TOTAL_MISMATCH",sourceKey:item.sourceKey,text:`EveryCafe üye kaydı #${item.memberHistoryId} KafePin'de farklı tutarda.`});
        } else { item.status="existing"; item.existingVia="member_import"; }
      }
    } else if (item.sourceSessionId) {
      const old=tracking.sessionsById.get(item.sourceSessionId);
      if (old) {
        if (Math.abs((Number(old.total)||0)-item.total)>0.01) {
          item.status="conflict"; conflicts.push({code:"SESSION_TOTAL_MISMATCH",sourceKey:item.sourceKey,text:`${item.clientName}: aynı SessionID KafePin'de var fakat tutar farklı (EveryCafe ${item.total.toFixed(2)} ₺ / KafePin ${(Number(old.total)||0).toFixed(2)} ₺).`});
        } else { item.status="existing"; item.existingVia="session_import"; }
      }
    } else if (item.kind==="OTHER") {
      const ext=tracking.externalByKey.get(`EVERYCAFE_OTHER:${item.sourceKey}`);
      if (ext) { item.status="existing"; item.existingVia="external"; }
    }

    if (item.status==="new") {
      const legacy=findLegacyEveryCafeHistoryMatches(item,tracking);
      if (legacy.length===1) { item.status="existing"; item.existingVia=legacy[0].via; item.legacyMatchId=legacy[0].id; }
      else if (legacy.length>1) {
        item.status="conflict";
        conflicts.push({code:"LEGACY_MATCH_AMBIGUOUS",sourceKey:item.sourceKey,text:`${item.clientName||item.kind} • ${item.total.toFixed(2)} ₺ için KafePin'de birden fazla eski eşleşme bulundu; otomatik aktarım durduruldu.`});
      }
    }
  }

  const sourceItems=selectedItems.filter((i)=>i.status!=="conflict");
  const newItems=selectedItems.filter((i)=>i.status==="new");
  const existingItems=selectedItems.filter((i)=>i.status==="existing");
  const sourceTotal=Math.round(sourceItems.reduce((sum,i)=>sum+i.total,0)*100)/100;
  const newTotal=Math.round(newItems.reduce((sum,i)=>sum+i.total,0)*100)/100;
  const existingTotal=Math.round(existingItems.reduce((sum,i)=>sum+i.total,0)*100)/100;
  const times=sourceItems.map((i)=>i.sourceTime).filter(Boolean);
  const dateFrom=times.length?Math.min(...times):0, dateTo=times.length?Math.max(...times):0;
  const localComparableTotal=Math.round((Number(tracking.localComparableTotal)||0)*100)/100;
  const fullSelection=Boolean(options.includeTables && options.includeDirect && options.includeMembers);

  // Son muhasebe emniyeti: tüm gelir türleri seçiliyken KafePin karşılaştırma
  // toplamı EveryCafe kaynak toplamını zaten karşılıyorsa, kimliği eşleşmeyen
  // bir satırı yeni gelir diye yazmak yerine otomatik aktarımı kilitle.
  if (fullSelection && newItems.length>0 && localComparableTotal >= sourceTotal-0.01) {
    conflicts.push({
      code:"LOCAL_TOTAL_ALREADY_COVERS_SOURCE",
      sourceKey:"ACCOUNTING_TOTAL",
      text:`KafePin mevcut gerçek gelir toplamı (${localComparableTotal.toFixed(2)} ₺) EveryCafe toplamını (${sourceTotal.toFixed(2)} ₺) zaten karşılıyor. ${newItems.length} kayıt kimlik olarak eşleşmediği için çift gelir riskine karşı aktarım kilitlendi.`
    });
    newItems.forEach((item)=>{ if(item.status==="new") item.status="conflict"; });
  }

  const finalSourceItems=selectedItems.filter((i)=>i.status!=="conflict");
  const finalNewItems=selectedItems.filter((i)=>i.status==="new");
  const finalExistingItems=selectedItems.filter((i)=>i.status==="existing");
  const finalSourceTotal=Math.round(finalSourceItems.reduce((sum,i)=>sum+i.total,0)*100)/100;
  const finalNewTotal=Math.round(finalNewItems.reduce((sum,i)=>sum+i.total,0)*100)/100;
  const finalExistingTotal=Math.round(finalExistingItems.reduce((sum,i)=>sum+i.total,0)*100)/100;
  const legacyMatchedItems=finalExistingItems.filter((i)=>String(i.existingVia||"").startsWith("legacy_"));
  const legacyMatchedCount=legacyMatchedItems.length;
  const legacyMatchPreview=legacyMatchedItems.slice(0,50).map((i)=>({
    sourceKey:String(i.sourceKey||""),
    day:String(i.calendarDay||""),
    time:Number(i.sourceTime)||0,
    clientName:String(i.clientName||i.sourceAction||i.kind||"EveryCafe"),
    kind:String(i.kind||""),
    total:Math.round((Number(i.total)||0)*100)/100,
    via:String(i.existingVia||""),
    localId:Number(i.legacyMatchId)||0
  }));

  informational.push({code:"CURRENT_REPORT_ONLY",text:"Kaynak yalnız EveryCafe'nin halen mevcut gerçek rapor/veri kayıtlarıdır. Activity denetim/arşiv kapanışları ve rapordan silinmiş eski gelirler aktarılmaz."});
  informational.push({code:"DETAIL_BREAKDOWN",text:`Gelir ayrımı: masa/bilgisayar ${Math.round(tableComputerTotal*100)/100} ₺ • masaya bağlı ürün/içecek ${Math.round(tableProductTotal*100)/100} ₺ • doğrudan satış ${Math.round(directTotal*100)/100} ₺ • üye ${Math.round(memberTotal*100)/100} ₺ • diğer kasa geliri ${Math.round(otherTotal*100)/100} ₺.`});
  if (freeSessions>0) informational.push({code:"FREE_IGNORED",text:`${freeSessions} ücretsiz/test oturumu tamamen hariç tutuldu. İçlerinde görünen ${Math.round(freeDisplayedTotal*100)/100} ₺ dahil hiçbir tutar ciroya eklenmedi.`});
  if ((source.deletionAuditRows||[]).length>0) informational.push({code:"DELETED_AUDIT",text:`EveryCafe denetim günlüğünde ${(source.deletionAuditRows||[]).length} silme işlemi görünüyor. Bunlar yalnız bilgi amaçlıdır; gelire ve aktarıma dahil edilmez.`});
  if (legacyMatchedCount>0) informational.push({code:"LEGACY_RECONCILED",text:`ID dışı eşleşme: ${legacyMatchedCount} EveryCafe geliri, eski KafePin kaydında kaynak ID'si bulunmasa da tarih/masa/tutar ve gelir türüyle güvenli biçimde "zaten var" kabul edildi; tekrar yazılmayacak.`});
  if (fullSelection) informational.push({code:"ACCOUNTING_GUARD",text:`Muhasebe emniyet kontrolü: KafePin karşılaştırılabilir mevcut gelir ${localComparableTotal.toFixed(2)} ₺ • EveryCafe kaynak ${sourceTotal.toFixed(2)} ₺. Kaynak kimliği eksik eski kayıtlar bu toplam kontrolünden de geçmeden aktarılamaz.`});

  const token=crypto.createHash("sha256").update(`${source.signature}|${tracking.signature}|${JSON.stringify(options)}`).digest("hex");
  return {
    ok:true,options,token,sourceSignature:source.signature,stateSignature:tracking.signature,
    safe:conflicts.length===0,doubleRecordRisk:conflicts.length===0?0:conflicts.length,
    sourceSessionRows:(source.sessionRows||[]).length,sourceMemberRows:(source.memberRows||[]).length,
    sourceOtherPaymentRows:(source.otherPaymentRows||[]).length,sourceTicketSaleRows:(source.ticketSaleRows||[]).length,sourceRecords:finalSourceItems.length,sourceTotal:finalSourceTotal,
    existingRecords:finalExistingItems.length,existingTotal:finalExistingTotal,newRecords:finalNewItems.length,newTotal:finalNewTotal,
    conflictRecords:conflicts.length,warningRecords:warnings.length,
    ignoredFreeRecords:freeSessions,ignoredFreeDisplayedTotal:Math.round(freeDisplayedTotal*100)/100,
    ignoredZeroRecords:zeroSessions,ignoredNegativeRecords:0,parseSkipped:0,duplicateResolved:0,
    deletedAuditEvents:(source.deletionAuditRows||[]).length,
    deletionAuditPreview:(source.deletionAuditRows||[]).slice(0,30).map((r)=>({activityId:Number(r.ActivityID)||0,time:(Number(r.Date)||0)*1000,cashier:String(r.Cashier||""),text:String(r.Activity||"")})),
    breakdown:{tableComputerTotal:Math.round(tableComputerTotal*100)/100,tableProductTotal:Math.round(tableProductTotal*100)/100,directTotal:Math.round(directTotal*100)/100,memberTotal:Math.round(memberTotal*100)/100,otherTotal:Math.round(otherTotal*100)/100},
    localComparableTotal,legacyMatchedCount,legacyMatchPreview,
    dateFrom,dateTo,calendarDayRule:"Europe/Istanbul 00:00–23:59:59",warnings,conflicts,informational,
    daily:summarizeEveryCafeHistoryDaily(selectedItems.filter((i)=>i.status!=="conflict")),newItems:finalNewItems,selectedItems
  };
}

async function insertEveryCafeHistoryItem(item) {
  const now=Date.now();
  const sourceKey=String(item.sourceKey||"");
  const sourceSessionId=String(item.sourceSessionId||"");
  const sourceTime=Number(item.sourceTime)||0;
  const sourceStart=Number(item.sourceStart)||0;
  const total=Math.round((Number(item.total)||0)*100)/100;
  const masa=Number(item.masa)||0;
  const method=String(item.method||"PENDING");
  if (!sourceKey || !sourceTime || total<=0) throw new Error(`Geçersiz geçmiş kayıt: ${sourceKey||"?"}`);
  if (!["CASH","CARD"].includes(method)) throw new Error(`${sourceKey}: ödeme yöntemi bilinmiyor; güvenli aktarım durduruldu.`);

  let markerSaleId=0;
  const details={computerTotal:Number(item.computerTotal)||0,productTotal:Number(item.productTotal)||0,orders:item.orders||[],kind:item.kind};

  if (item.kind==="MEMBER") {
    const externalId=`MEMBER_PAYMENT:${Number(item.memberHistoryId)||0}`;
    const sale=await kafePinDbRunP(
      `INSERT INTO product_sales
       (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
       VALUES (?,0,0,0,'EveryCafe Üye Geliri','EveryCafe Üye',?,1,?,'DIRECT',?,'FINALIZED',?,?,0,0,'EVERYCAFE_MEMBER',?)`,
      [sourceTime,total,total,`EveryCafe geçmiş üye bakiyesi${item.note?` • ${item.note}`:""}`,sourceTime,method,externalId]
    );
    markerSaleId=sale.lastID;
    await kafePinDbRunP(
      `INSERT INTO payments
       (created_at,paid_at,masa,session_start,session_end,product_sale_id,computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at,external_source,external_id)
       VALUES (?,?,0,0,0,?,0,?,?,?,'EVERYCAFE_MEMBER','MEMBER_BALANCE',?,0,0,'EVERYCAFE_MEMBER',?)`,
      [sourceTime,sourceTime,sale.lastID,total,total,method,`EveryCafe geçmiş üye geliri`,externalId]
    );
    await kafePinDbRunP(`INSERT INTO everycafe_member_imports(history_id,source_time,amount,imported_at) VALUES(?,?,?,?)`,[Number(item.memberHistoryId)||0,sourceTime,total,now]);
  } else if (item.kind==="DIRECT") {
    let productTotal=0;
    for (const order of item.orders||[]) {
      const orderTotal=Math.round((Number(order.quantity)||0)*(Number(order.price)||0)*100)/100;
      if (orderTotal<=0) continue;
      const sale=await kafePinDbRunP(
        `INSERT INTO product_sales
         (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
         VALUES (?,0,0,0,?,'EveryCafe Doğrudan Satış',?,?,?,'DIRECT',?,'FINALIZED',?,?,0,0,'EVERYCAFE_DIRECT',?)`,
        [Number(order.time)||sourceTime,String(order.name||"EveryCafe Doğrudan Satış"),Number(order.price)||0,Number(order.quantity)||1,orderTotal,`EveryCafe geçmiş doğrudan satış: ${sourceSessionId}`,sourceTime,method,`DIRECT_ORDER:${order.id}`]
      );
      if (!markerSaleId) markerSaleId=sale.lastID;
      productTotal+=orderTotal;
    }
    productTotal=Math.round(productTotal*100)/100;
    const remainder=Math.round((total-productTotal)*100)/100;
    if (remainder>0.01) {
      const sale=await kafePinDbRunP(
        `INSERT INTO product_sales
         (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
         VALUES (?,0,0,0,'EveryCafe Diğer Doğrudan Gelir','EveryCafe Doğrudan Satış',?,1,?,'DIRECT',?,'FINALIZED',?,?,0,0,'EVERYCAFE_DIRECT',?)`,
        [sourceTime,remainder,remainder,`EveryCafe kaynakta ürün ayrıntısı olmayan doğrudan gelir: ${sourceSessionId}`,sourceTime,method,`DIRECT_REMAINDER:${sourceSessionId}`]
      );
      if (!markerSaleId) markerSaleId=sale.lastID;
    }
    await kafePinDbRunP(
      `INSERT INTO payments
       (created_at,paid_at,masa,session_start,session_end,product_sale_id,computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at,external_source,external_id)
       VALUES (?,?,0,0,0,0,0,?,?,?,'EVERYCAFE_DIRECT','EVERYCAFE_DIRECT',?,0,0,'EVERYCAFE_DIRECT',?)`,
      [sourceTime,sourceTime,total,total,method,`EveryCafe geçmiş doğrudan satış: ${item.clientName||""}`,`DIRECT_SESSION:${sourceSessionId}`]
    );
    await kafePinDbRunP(`INSERT INTO everycafe_imports(session_id,masa,source_end,total,imported_at) VALUES(?,?,?,?,?)`,[sourceSessionId,0,sourceTime,total,now]);
  } else if (item.kind==="TABLE" && masa>0) {
    const computerTotal=Math.round((Number(item.computerTotal)||0)*100)/100;
    const productTotal=Math.round((Number(item.productTotal)||0)*100)/100;
    if (computerTotal>0) {
      await kafePinDbRunP(
        `INSERT INTO real_adjustments(time,day_key,masa,amount,kind,note,session_start) VALUES(?,?,?,?,?,?,?)`,
        [sourceTime,dayKey(sourceTime),masa,computerTotal,"SESSION_FINALIZE","EveryCafe geçmiş gerçek kapanış",sourceStart]
      );
      const minutes=Math.max(0,Math.floor((sourceTime-sourceStart)/60000));
      await kafePinDbRunP(
        `INSERT INTO session_history(masa,start_time,end_time,last_seen,minutes,fee,adjustment,close_reason,note,created_at)
         VALUES(?,?,?,?,?,?,0,'EVERYCAFE','EveryCafe geçmiş gerçek kapanış',?)`,
        [masa,sourceStart,sourceTime,sourceTime,minutes,computerTotal,now]
      );
    }
    for (const order of item.orders||[]) {
      const orderTotal=Math.round((Number(order.quantity)||0)*(Number(order.price)||0)*100)/100;
      if (orderTotal<=0) continue;
      const sale=await kafePinDbRunP(
        `INSERT INTO product_sales
         (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
         VALUES (?,?,?,?,?,?,?,?,?,'TABLE',?,'FINALIZED',?,?,0,0,'EVERYCAFE',?)`,
        [Number(order.time)||sourceTime,masa,sourceStart,0,String(order.name||"EveryCafe Ürün"),String(order.category||"EveryCafe"),Number(order.price)||0,Number(order.quantity)||1,orderTotal,`EveryCafe geçmiş oturum: ${sourceSessionId}`,sourceTime,method,`ORDER:${order.id}`]
      );
      if (!markerSaleId) markerSaleId=sale.lastID;
    }
    await kafePinDbRunP(
      `INSERT INTO payments
       (created_at,paid_at,masa,session_start,session_end,product_sale_id,computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at,external_source,external_id)
       VALUES (?,?,?,?,?,0,?,?,?,?, 'EVERYCAFE','EVERYCAFE_HISTORY',?,0,0,'EVERYCAFE',?)`,
      [sourceTime,sourceTime,masa,sourceStart,sourceTime,computerTotal,productTotal,total,method,`EveryCafe geçmiş: ${item.clientName||""}`,`SESSION:${sourceSessionId}`]
    );
    await kafePinDbRunP(`INSERT INTO everycafe_imports(session_id,masa,source_end,total,imported_at) VALUES(?,?,?,?,?)`,[sourceSessionId,masa,sourceTime,total,now]);
  } else {
    // Masa numarası olmayan ama EveryCafe Payments tablosunda gerçek tahsilat
    // olarak duran bilet/epin/teknik/listedışı vb. gelir.
    const sale=await kafePinDbRunP(
      `INSERT INTO product_sales
       (time,masa,session_start,product_id,product_name,category,unit_price,quantity,total,sale_type,note,status,finalized_at,payment_method,voided,voided_at,external_source,external_id)
       VALUES (?,0,0,0,?,'EveryCafe Diğer Gelir',?,1,?,'DIRECT',?,'FINALIZED',?,?,0,0,'EVERYCAFE_OTHER',?)`,
      [sourceTime,String(item.clientName||"EveryCafe Diğer Gelir"),total,total,`EveryCafe gerçek kasa geliri${item.note?` • ${item.note}`:""}`,sourceTime,method,sourceKey]
    );
    markerSaleId=sale.lastID;
    await kafePinDbRunP(
      `INSERT INTO payments
       (created_at,paid_at,masa,session_start,session_end,product_sale_id,computer_amount,product_amount,total_amount,method,source,close_reason,note,voided,voided_at,external_source,external_id)
       VALUES (?,?,0,0,0,?,0,?,?,?,'EVERYCAFE_OTHER','EVERYCAFE_OTHER',?,0,0,'EVERYCAFE_OTHER',?)`,
      [sourceTime,sourceTime,sale.lastID,total,total,method,`EveryCafe diğer gelir`,sourceKey]
    );
  }

  await kafePinDbRunP(
    `INSERT INTO everycafe_history_imports
     (source_key,source_session_id,source_activity_id,source_time,calendar_day,client_name,masa,kind,source_action,total,imported_at,product_sale_id,
      source_start,computer_total,product_total,payment_method,details_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [sourceKey,sourceSessionId,0,sourceTime,item.calendarDay||everyCafeCalendarDayKey(sourceTime),String(item.clientName||"").slice(0,120),masa,String(item.kind||"OTHER"),String(item.sourceAction||""),total,now,markerSaleId,sourceStart,Number(item.computerTotal)||0,Number(item.productTotal)||0,method,JSON.stringify(details).slice(0,12000)]
  );
  return {saleId:markerSaleId};
}

async function recordEveryCafeHistoryRun(data) {
  const details = JSON.stringify({
    options: data.options || {},
    conflicts: data.conflicts || [],
    warnings: data.warnings || [],
    remainingNew: Number(data.remainingNew) || 0
  }).slice(0, 20000);
  await kafePinDbRunP(
    `INSERT INTO everycafe_history_runs
     (run_time,source_signature,source_records,source_total,existing_records,new_records,
      imported_records,skipped_records,warning_records,status,backup_path,details_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      Date.now(), String(data.sourceSignature || ""), Number(data.sourceRecords) || 0,
      Number(data.sourceTotal) || 0, Number(data.existingRecords) || 0,
      Number(data.newRecords) || 0, Number(data.importedRecords) || 0,
      Number(data.skippedRecords) || 0, Number(data.warningRecords) || 0,
      String(data.status || ""), String(data.backupPath || ""), details
    ]
  );
}

function createFullProjectBackupP() {
  return new Promise((resolve, reject) => {
    createFullProjectBackup((err, result) => err ? reject(err) : resolve(result));
  });
}

app.post("/admin/everycafe/history/precheck", async (req, res) => {
  setNoStore(res);
  try {
    const analysis = await analyzeEveryCafeHistory((req.body || {}).options || {});
    addEveryCafeIntegrationLog({category:"HISTORY",event:"Geçmiş aktarım Ön Kontrol",sourceDetail:`EveryCafe ${Number(analysis.sourceRecords)||0} kayıt • ${(Number(analysis.sourceTotal)||0).toFixed(2)} ₺`,action:`KafePin karşılaştırdı • mevcut ${Number(analysis.existingRecords)||0} • yeni ${Number(analysis.newRecords)||0}`,result:analysis.safe?"Güvenli • henüz kayıt yazılmadı":`Durduruldu • ${(analysis.conflicts||[]).length} çakışma`,level:analysis.safe?"INFO":"WARN",details:{sourceRecords:analysis.sourceRecords,sourceTotal:analysis.sourceTotal,existingRecords:analysis.existingRecords,newRecords:analysis.newRecords,safe:analysis.safe}});
    res.json({
      ...analysis,
      // İstemciye binlerce ham kayıt göndermeyiz; aktarım tokenı sunucuda aynı
      // analizi tekrar üretip güvenli biçimde doğrular.
      newItems: undefined,
      selectedItems: undefined
    });
  } catch (err) {
    logErr("EveryCafe history precheck", err);
    res.status(500).json({ ok: false, error: `EveryCafe geçmişi okunamadı: ${String(err.message || err)}` });
  }
});

app.post("/admin/everycafe/history/import", async (req, res) => {
  setNoStore(res);
  const body = req.body || {};
  const token = String(body.token || "").trim();
  const options = normalizeEveryCafeHistoryOptions(body.options || {});
  if (!token) return res.status(400).json({ ok: false, error: "Ön kontrol yapılmadan aktarım başlatılamaz." });

  let analysis;
  try {
    analysis = await analyzeEveryCafeHistory(options);
    if (analysis.token !== token) {
      return res.status(409).json({
        ok: false,
        stale: true,
        error: "EveryCafe veya KafePin kayıtları ön kontrolden sonra değişti. Güvenlik için aktarım durduruldu; Ön Kontrol Yap'a tekrar bas."
      });
    }
    if (!analysis.safe) {
      return res.status(409).json({ ok: false, error: "Çakışmalı kayıtlar var. Otomatik aktarım yapılmadı.", conflicts: analysis.conflicts });
    }
    if (!analysis.newRecords) {
      addEveryCafeIntegrationLog({category:"HISTORY",event:"Geçmiş aktarım isteği",sourceDetail:`${analysis.sourceRecords} kaynak kayıt • ${Number(analysis.sourceTotal||0).toFixed(2)} ₺`,action:"KafePin karşılaştırması tamamlandı",result:"Yeni kayıt yok • aktarım yapılmadı"});
      return res.json({
        ok: true,
        alreadyComplete: true,
        importedRecords: 0,
        sourceRecords: analysis.sourceRecords,
        sourceTotal: analysis.sourceTotal,
        message: "Tüm seçili EveryCafe geçmiş kayıtları zaten KafePin'de. İşlem yapılmadı."
      });
    }

    // Bodoslama yazma yok: önce yalnız KafePin tam yedeği.
    const backup = await createFullProjectBackupP();

    // Yedek sürerken canlı senkron kayıt eklemiş olabilir. Yedekten sonra tekrar
    // kontrol et; değişiklik varsa hiçbir kayıt yazmadan dur.
    const afterBackup = await analyzeEveryCafeHistory(options);
    if (afterBackup.token !== token) {
      return res.status(409).json({
        ok: false,
        stale: true,
        backupTaken: true,
        backup,
        error: "Yedekleme sırasında kaynak/KafePin kayıtları değişti. Hiçbir geçmiş kayıt yazılmadı; Ön Kontrol Yap'a tekrar bas."
      });
    }

    await kafePinDbRunP("BEGIN IMMEDIATE");
    let committed = false;
    try {
      // BEGIN IMMEDIATE sonrası KafePin takip durumunu bir kez daha doğrula.
      // Bu imza değişmemişse canlı senkron aynı anda araya kayıt sıkıştıramaz.
      const lockedTracking = await getEveryCafeHistoryTrackingState();
      if (lockedTracking.signature !== analysis.stateSignature) {
        throw Object.assign(new Error("KafePin takip durumu değişti; aktarım güvenlik için durduruldu."), { code: "STALE_STATE" });
      }

      let importedRecords = 0;
      let importedTotal = 0;
      for (const item of analysis.newItems) {
        await insertEveryCafeHistoryItem(item);
        importedRecords += 1;
        importedTotal += Number(item.total) || 0;
      }
      await kafePinDbRunP("COMMIT");
      committed = true;

      importedTotal = Math.round(importedTotal * 100) / 100;
      let remainingNew = 0;
      let finalCheck = null;
      try {
        finalCheck = await analyzeEveryCafeHistory(options);
        remainingNew = Number(finalCheck.newRecords) || 0;
      } catch (verifyErr) {
        logErr("EveryCafe history final verify", verifyErr);
      }

      await recordEveryCafeHistoryRun({
        ...analysis,
        importedRecords,
        skippedRecords: analysis.existingRecords,
        warningRecords: analysis.warningRecords,
        status: remainingNew === 0 ? "success" : "success_new_source_after_import",
        backupPath: backup && backup.path,
        remainingNew
      });

      addLiveLog(
        "everycafe_history",
        `✅ EveryCafe geçmiş aktarımı • ${importedRecords} kayıt • ${importedTotal.toFixed(2)} ₺ • çift kayıt 0`
      );
      addEveryCafeIntegrationLog({category:"HISTORY",event:"Geçmiş aktarım tamamlandı",sourceDetail:`EveryCafe ${analysis.sourceRecords} kaynak • ${Number(analysis.sourceTotal||0).toFixed(2)} ₺`,action:`KafePin ${importedRecords} yeni kayıt / ${importedTotal.toFixed(2)} ₺ aktardı`,result:remainingNew===0?"Başarılı • son doğrulama 0 yeni":"Başarılı • yeni kaynak oluştu",details:{importedRecords,importedTotal,remainingNew,backup:backup&&backup.path}});

      return res.json({
        ok: true,
        importedRecords,
        importedTotal,
        sourceRecords: analysis.sourceRecords,
        sourceTotal: analysis.sourceTotal,
        existingBefore: analysis.existingRecords,
        remainingNew,
        doubleRecordRisk: 0,
        backup,
        verified: remainingNew === 0,
        message: remainingNew === 0
          ? "EveryCafe geçmiş aktarımı ve son doğrulama başarılı."
          : "Aktarım başarılı; işlem sırasında EveryCafe'ye yeni kayıt geldi. Yeni kayıt için tekrar Ön Kontrol yap."
      });
    } catch (writeErr) {
      if (!committed) {
        try { await kafePinDbRunP("ROLLBACK"); } catch (_rollbackErr) {}
      }
      if (writeErr && writeErr.code === "STALE_STATE") {
        return res.status(409).json({
          ok: false,
          stale: true,
          backupTaken: true,
          backup,
          error: `${writeErr.message} Hiçbir geçmiş kayıt yazılmadı; Ön Kontrol Yap'a tekrar bas.`
        });
      }
      throw writeErr;
    }
  } catch (err) {
    logErr("EveryCafe history import", err);
    res.status(500).json({ ok: false, error: `Geçmiş aktarım tamamlanamadı: ${String(err.message || err)}` });
  }
});

app.get("/admin/everycafe/integration-summary", (req,res)=>{
  setNoStore(res);
  getEveryCafeConfig((ce,config)=>{if(ce)return res.json({ok:false,error:String(ce)});
    db.get(`SELECT COUNT(*) count FROM everycafe_active_sessions`,(e,a)=>{if(e)return res.json({ok:false,error:String(e)});
      db.get(`SELECT COUNT(*) count FROM everycafe_integration_logs WHERE time>=? AND level IN ('WARN','ERROR')`,[Date.now()-86400000],(e2,w)=>{if(e2)return res.json({ok:false,error:String(e2)});
        db.get(`SELECT MAX(time) last_change,COUNT(*) total FROM everycafe_integration_logs`,(e3,l)=>{if(e3)return res.json({ok:false,error:String(e3)});
          db.get(`SELECT last_success,last_error,source_products,source_categories FROM everycafe_catalog_sync_state WHERE id=1`,(e4,c)=>{if(e4)return res.json({ok:false,error:String(e4)});
            res.json({ok:true,enabled:!!config.enabled,startAt:Number(config.startAt)||0,sourceDb:EVERYCAFE_DB_PATH,readOnly:true,connected:!everyCafeHealth.lastError&&Number(everyCafeHealth.lastSuccess)>0,lastSuccess:Number(everyCafeHealth.lastSuccess)||0,lastError:String(everyCafeHealth.lastError||''),activeEveryCafe:Number(a&&a.count)||0,mappedKafePin:Number(a&&a.count)||0,waitingEveryCafe:everyCafeWaitingMasalar.size,warning24h:Number(w&&w.count)||0,lastChange:Number(l&&l.last_change)||0,totalLogs:Number(l&&l.total)||0,catalogLastSuccess:Number(c&&c.last_success)||0,catalogLastError:String(c&&c.last_error||''),catalogProducts:Number(c&&c.source_products)||0,catalogCategories:Number(c&&c.source_categories)||0,spinIsolation:true,spinPolicy:"EveryCafe sessions.start_time, masa/ürün/durum verisini sağlar; masalar.start_time, spin, token ve index çark kurallarına müdahale etmez."});
          });
        });
      });
    });
  });
});

app.get("/admin/everycafe/integration-logs",(req,res)=>{
  setNoStore(res);const limit=Math.max(1,Math.min(500,Number(req.query.limit)||200));const cat=String(req.query.category||'').toUpperCase();const masa=Math.max(0,Number(req.query.masa)||0);const q=String(req.query.q||'').trim().slice(0,80);const where=[],params=[];
  if(cat&&cat!=='ALL'){where.push('category=?');params.push(cat)} if(masa){where.push('masa=?');params.push(masa)} if(q){const x=`%${q}%`;where.push('(event LIKE ? OR source_detail LIKE ? OR kafepin_action LIKE ? OR result LIKE ? OR session_id LIKE ?)');params.push(x,x,x,x,x)}
  const sql=`SELECT id,time,category,level,masa,session_id,event,source_detail,kafepin_action,result,details_json FROM everycafe_integration_logs ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id DESC LIMIT ?`;params.push(limit);
  db.all(sql,params,(e,rows)=>e?res.json({ok:false,error:String(e)}):res.json({ok:true,count:(rows||[]).length,rows:rows||[]}));
});

app.post("/admin/everycafe/integration-log-test",(req,res)=>{setNoStore(res);addEveryCafeIntegrationLog({category:"SYSTEM",event:"Entegrasyon günlüğü test kaydı",sourceDetail:"Yerel tanılama",action:"Günlük yazımı doğrulandı",result:"Başarılı"});res.json({ok:true})});

app.get("/admin/everycafe/history/last", (req, res) => {
  setNoStore(res);
  db.get(
    `SELECT * FROM everycafe_history_runs ORDER BY id DESC LIMIT 1`,
    (err, row) => {
      if (err) return res.json({ ok: false, error: String(err) });
      res.json({ ok: true, last: row || null });
    }
  );
});

app.get("/admin/everycafe/catalog-status", (req, res) => {
  setNoStore(res);
  getEveryCafeConfig((configErr, config) => {
    if (configErr) return res.json({ ok: false, error: String(configErr) });
    getEveryCafeCatalogStatus((statusErr, catalog) => {
      if (statusErr) return res.json({ ok: false, error: String(statusErr) });
      const state = catalog.state || {};
      const products = catalog.products || [];
      const categories = catalog.categories || [];
      res.json({
        ok: true,
        path: EVERYCAFE_DB_PATH,
        enabled: !!config.enabled,
        running: everyCafeCatalogSyncRunning,
        connected: !String(state.last_error || "") && Number(state.last_success) > 0,
        lastAttempt: Number(state.last_attempt) || 0,
        lastSuccess: Number(state.last_success) || 0,
        lastError: String(state.last_error || ""),
        sourceCategories: Number(state.source_categories) || 0,
        sourceProducts: Number(state.source_products) || 0,
        activeCategories: categories.filter((row) => Number(row.active) !== 0).length,
        inactiveCategories: categories.filter((row) => Number(row.active) === 0).length,
        activeProducts: products.filter((row) => Number(row.active) !== 0).length,
        inactiveProducts: products.filter((row) => Number(row.active) === 0).length,
        lastChanges: {
          categoryAdded: Number(state.category_added) || 0,
          categoryUpdated: Number(state.category_updated) || 0,
          categoryDeactivated: Number(state.category_deactivated) || 0,
          productAdded: Number(state.product_added) || 0,
          productUpdated: Number(state.product_updated) || 0,
          productDeactivated: Number(state.product_deactivated) || 0,
          priceChanged: Number(state.price_changed) || 0,
          nameChanged: Number(state.name_changed) || 0,
          categoryMoved: Number(state.category_moved) || 0
        },
        categories,
        products
      });
    });
  });
});

app.post("/admin/everycafe/catalog-sync-now", (req, res) => {
  setNoStore(res);
  syncEveryCafeCatalog((err, result) => {
    if (err) return res.json({ ok: false, error: String(err.message || err) });
    res.json({ ok: true, checkedAt: Date.now(), ...(result || {}) });
  });
});

app.get("/admin/everycafe/status", (req, res) => {
  setNoStore(res);
  getEveryCafeConfig((configErr, config) => {
    if (configErr) return res.json({ ok: false, error: String(configErr) });
    readEveryCafeClosedSessions(Math.max(config.startAt - 24 * 60 * 60 * 1000, 0), 10, (readErr, sessions) => {
      if (readErr) return res.json({ ok: false, error: `EveryCafe okunamadı: ${readErr.message || readErr}` });
      readEveryCafeActiveSessions(100, (activeErr, activeSessions) => {
        if (activeErr) return res.json({ ok: false, error: `EveryCafe aktif masa okunamadı: ${activeErr.message || activeErr}` });
        const todayStart = dayStartTs(Date.now());
        db.get("SELECT COUNT(*) AS count, MAX(imported_at) AS last_import FROM everycafe_imports", (importErr, imported) => {
          if (importErr) return res.json({ ok: false, error: String(importErr) });
          db.all(
            `SELECT id,time,total,payment_method,note
             FROM product_sales
             WHERE voided=0
               AND (external_source='EVERYCAFE_MEMBER' OR category='EveryCafe Geçmiş Aktarım')
             ORDER BY time DESC,id DESC`,
            (memberErr, memberRows) => {
              if (memberErr) return res.json({ ok: false, error: String(memberErr) });
              const memberList = memberRows || [];
              const memberToday = memberList.filter((row) => Number(row.time) >= todayStart);
              const calendarNow = new Date();
              const memberMonthStart = new Date(calendarNow.getFullYear(), calendarNow.getMonth(), 1, 0, 0, 0, 0).getTime();
              const memberMonth = memberList.filter((row) => Number(row.time) >= memberMonthStart);
              const memberStats = (rows) => ({
                count: rows.length,
                total: Math.round(rows.reduce((sum, row) => sum + (Number(row.total) || 0), 0) * 100) / 100,
                cash: Math.round(rows.filter((row) => String(row.payment_method) === 'CASH').reduce((sum, row) => sum + (Number(row.total) || 0), 0) * 100) / 100,
                card: Math.round(rows.filter((row) => String(row.payment_method) === 'CARD').reduce((sum, row) => sum + (Number(row.total) || 0), 0) * 100) / 100
              });
          db.get(
            `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount),0) AS total,
                    COALESCE(SUM(CASE WHEN method='CASH' THEN total_amount ELSE 0 END),0) AS cash,
                    COALESCE(SUM(CASE WHEN method='CARD' THEN total_amount ELSE 0 END),0) AS card,
                    COALESCE(SUM(product_amount),0) AS product
             FROM payments
             WHERE voided=0 AND created_at>=?
               AND source='EVERYCAFE' AND external_source='EVERYCAFE'`,
            [todayStart],
            (todayErr, today) => {
              if (todayErr) return res.json({ ok: false, error: String(todayErr) });
              db.get(
                `SELECT
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_DIRECT' AND created_at>=? THEN total_amount ELSE 0 END),0) AS today_total,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_DIRECT' AND created_at>=? AND method='CASH' THEN total_amount ELSE 0 END),0) AS today_cash,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_DIRECT' AND created_at>=? AND method='CARD' THEN total_amount ELSE 0 END),0) AS today_card,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_DIRECT' AND created_at>=? THEN 1 ELSE 0 END),0) AS today_count,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_DIRECT' THEN total_amount ELSE 0 END),0) AS all_time_total,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_DIRECT' AND method='CASH' THEN total_amount ELSE 0 END),0) AS all_time_cash,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_DIRECT' AND method='CARD' THEN total_amount ELSE 0 END),0) AS all_time_card,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_DIRECT' THEN 1 ELSE 0 END),0) AS all_time_count,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_OTHER' AND created_at>=? THEN total_amount ELSE 0 END),0) AS other_today_total,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_OTHER' AND created_at>=? AND method='CASH' THEN total_amount ELSE 0 END),0) AS other_today_cash,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_OTHER' AND created_at>=? AND method='CARD' THEN total_amount ELSE 0 END),0) AS other_today_card,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_OTHER' AND created_at>=? THEN 1 ELSE 0 END),0) AS other_today_count,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_OTHER' THEN total_amount ELSE 0 END),0) AS other_all_time_total,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_OTHER' AND method='CASH' THEN total_amount ELSE 0 END),0) AS other_all_time_cash,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_OTHER' AND method='CARD' THEN total_amount ELSE 0 END),0) AS other_all_time_card,
                   COALESCE(SUM(CASE WHEN external_source='EVERYCAFE_OTHER' THEN 1 ELSE 0 END),0) AS other_all_time_count
                 FROM payments
                 WHERE voided=0 AND external_source IN ('EVERYCAFE_DIRECT','EVERYCAFE_OTHER')`,
                [todayStart, todayStart, todayStart, todayStart, todayStart, todayStart, todayStart, todayStart],
                (directErr, directRow) => {
                  if (directErr) return res.json({ ok: false, error: String(directErr) });
              const statusNow = Date.now();
              const active = (activeSessions || []).map((row) => {
                const masa = everyCafeTableNumber(row.ClientName);
                const start = Number(row.StartDate) * 1000;
                const end = Number(row.EndDate) * 1000;
                const giftMinutes = everyCafeGiftMinutesFromSource(row.GiftTime);
                const productTotal = (row.orders || []).reduce((sum, order) => {
                  if (Number(order.OrderIsActive) === 0) return sum;
                  return sum + (Number(order.Quantity) || 0) * (Number(order.Price) || 0);
                }, 0);
                // Bitiş anında tarifeyi bir sonraki 30 dakikalık basamağa
                // taşımayız. Uzatma varsa EveryCafe EndDate'i büyütür.
                const billedUntil = end > start ? Math.min(statusNow, end - 1) : statusNow;
                // EveryCafe'nin ücretsiz açtığı masa için aktif kartta da
                // bilgisayar ücreti hesaplanmaz. Ürün varsa yalnızca ürün
                // toplamı görünür; kapanış tahsilatı yine EveryCafe kaynağıdır.
                const computerTotal = masa && start && !isEveryCafeFreeSession(row)
                  ? Math.max(feeAtTime(masa, start, billedUntil), 0)
                  : 0;
                return {
                  masa,
                  start,
                  end,
                  free: isEveryCafeFreeSession(row),
                  giftMinutes,
                  computerTotal,
                  productTotal,
                  total: Math.round((computerTotal + productTotal) * 100) / 100,
                  endingSoon: end > statusNow && end - statusNow <= 10 * 60 * 1000
                };
              });
              const activeLiveTotal = Math.round(active.reduce((sum, row) => sum + row.total, 0) * 100) / 100;
              res.json({
                ok: true,
                path: EVERYCAFE_DB_PATH,
                enabled: config.enabled,
                startAt: config.startAt,
                health: {
                  lastSuccess: everyCafeHealth.lastSuccess,
                  lastError: everyCafeHealth.lastError,
                  failureSince: everyCafeHealth.failureSince,
                  warningActive: everyCafeHealth.warningActive,
                  staleSeconds: everyCafeHealth.failureSince
                    ? Math.floor((Date.now() - everyCafeHealth.failureSince) / 1000)
                    : 0
                },
                lastCheck: everyCafeHealth.lastSuccess,
                dailyAudit: lastEveryCafeDailyAudit,
                importedCount: Number(imported && imported.count) || 0,
                lastImport: Number(imported && imported.last_import) || 0,
                activeCount: (activeSessions || []).length,
                today: {
                  count: (Number(today && today.count) || 0) + (Number(directRow && directRow.today_count) || 0) + memberStats(memberToday).count + (Number(directRow && directRow.other_today_count) || 0),
                  total: (Number(today && today.total) || 0) + (Number(directRow && directRow.today_total) || 0) + memberStats(memberToday).total + (Number(directRow && directRow.other_today_total) || 0),
                  cash: (Number(today && today.cash) || 0) + (Number(directRow && directRow.today_cash) || 0) + memberStats(memberToday).cash + (Number(directRow && directRow.other_today_cash) || 0),
                  card: (Number(today && today.card) || 0) + (Number(directRow && directRow.today_card) || 0) + memberStats(memberToday).card + (Number(directRow && directRow.other_today_card) || 0),
                  product: Number(today && today.product) || 0,
                  sessionTotal: Number(today && today.total) || 0,
                  sessionCash: Number(today && today.cash) || 0,
                  sessionCard: Number(today && today.card) || 0
                },
                directSales: {
                  today: {
                    count: Number(directRow && directRow.today_count) || 0,
                    total: Number(directRow && directRow.today_total) || 0,
                    cash: Number(directRow && directRow.today_cash) || 0,
                    card: Number(directRow && directRow.today_card) || 0
                  },
                  allTime: {
                    count: Number(directRow && directRow.all_time_count) || 0,
                    total: Number(directRow && directRow.all_time_total) || 0,
                    cash: Number(directRow && directRow.all_time_cash) || 0,
                    card: Number(directRow && directRow.all_time_card) || 0
                  }
                },
                memberIncome: {
                  today: memberStats(memberToday),
                  month: memberStats(memberMonth),
                  allTime: memberStats(memberList),
                  recent: memberList.slice(0, 12)
                },
                otherIncome: {
                  today: {
                    count: Number(directRow && directRow.other_today_count) || 0,
                    total: Number(directRow && directRow.other_today_total) || 0,
                    cash: Number(directRow && directRow.other_today_cash) || 0,
                    card: Number(directRow && directRow.other_today_card) || 0
                  },
                  allTime: {
                    count: Number(directRow && directRow.other_all_time_count) || 0,
                    total: Number(directRow && directRow.other_all_time_total) || 0,
                    cash: Number(directRow && directRow.other_all_time_cash) || 0,
                    card: Number(directRow && directRow.other_all_time_card) || 0
                  }
                },
                active: {
                  liveTotal: activeLiveTotal,
                  endingSoonCount: active.filter((row) => row.endingSoon).length,
                  giftedCount: active.filter((row) => row.giftMinutes > 0).length,
                  rows: active
                },
                recent: sessions.map((row) => {
                  const masa = everyCafeTableNumber(row.ClientName);
                  const direct = isEveryCafeDirectSaleSession(row);
                  return {
                    sessionId: row.SessionID,
                    masa,
                    kind: direct ? "DIRECT" : (masa ? "TABLE" : "OTHER"),
                    clientName: String(row.ClientName || row.SessionTypeText || "").trim(),
                    end: Number(row.EndDate) * 1000,
                    method: everyCafePaymentMethod(row.PaymentMethod),
                    freeClosed: isEveryCafeFreeSession(row),
                    total: isEveryCafeFreeSession(row) ? 0 : everyCafeSessionRevenueTotal(row),
                    productTotal: isEveryCafeFreeSession(row) ? 0 : (row.orders || []).reduce((sum, order) => sum + (Number(order.Quantity) || 0) * (Number(order.Price) || 0), 0)
                  };
                })
              });
                }
              );
            }
          );
            }
          );
        });
      });
    });
  });
});

app.post("/admin/everycafe/start-test", (req, res) => {
  setNoStore(res);
  const startAt = Date.now();
  const startSec = Math.floor(startAt / 1000);
  db.serialize(() => {
    db.run("INSERT INTO settings(key,value) VALUES('everycafe_sync_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'");
    db.run("INSERT INTO settings(key,value) VALUES('everycafe_sync_start_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(startAt)]);
    db.run("INSERT INTO settings(key,value) VALUES('everycafe_sync_session_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(startSec)]);
    db.run("INSERT INTO settings(key,value) VALUES('everycafe_sync_member_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(startSec)]);
    db.run("INSERT INTO settings(key,value) VALUES('everycafe_sync_other_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(startSec)]);
    db.run("INSERT INTO settings(key,value) VALUES('everycafe_sync_ticket_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(startSec)], (err) => {
      if (err) return res.json({ ok: false, error: String(err) });
      addLiveLog("everycafe_test_started", "🧪 EveryCafe canlı test başladı • yalnız bu andan sonraki kapanışlar aktarılacak");
      addEveryCafeIntegrationLog({category:"SYSTEM",event:"EveryCafe canlı entegrasyon açıldı",sourceDetail:`Başlangıç: ${everyCafeIntegrationTimeText(startAt)}`,action:"KafePin salt-okunur canlı okumaya başladı • sayfalı cursor aktif",result:"Aktif • SessionType 26 adı değişse de Doğrudan Satış tanınır"});
      syncEveryCafeActiveSessions((syncErr, result) => {
        if (syncErr) return res.json({ ok: false, error: `EveryCafe aktif masa okunamadı: ${syncErr.message || syncErr}` });
        res.json({ ok: true, startAt, activeSynced: Number(result && result.synced) || 0 });
      });
    });
  });
});

app.post("/admin/everycafe/stop", (req, res) => {
  setNoStore(res);
  db.run("INSERT INTO settings(key,value) VALUES('everycafe_sync_enabled','0') ON CONFLICT(key) DO UPDATE SET value='0'", (err) => {
    if (err) return res.json({ ok: false, error: String(err) });
    addLiveLog("everycafe_test_stopped", "⏸️ EveryCafe canlı aktarımı durduruldu");
    addEveryCafeIntegrationLog({category:"SYSTEM",event:"EveryCafe canlı entegrasyon durduruldu",sourceDetail:"Kullanıcı işlemi",action:"KafePin canlı kaynak uygulamasını durdurdu",result:"Durduruldu"});
    res.json({ ok: true });
  });
});

app.post("/admin/everycafe/sync-now", (req, res) => {
  setNoStore(res);
  syncEveryCafeClosedSessions((err, result) => {
    if (err) return res.json({ ok: false, error: String(err) });
    syncEveryCafeActiveSessions((activeErr, activeResult) => {
      if (activeErr) return res.json({ ok: false, error: String(activeErr) });
      // Elle yapılan kontrol de bağlantının sağlıklı olduğunu görünür biçimde
      // kaydeder. Böylece arayüzde "son kontrol" anı hemen güncellenir.
      if (!((result && result.reason === "disabled") || (activeResult && activeResult.reason === "disabled"))) {
        recordEveryCafeSyncSuccess();
      }
      addEveryCafeIntegrationLog({category:"SYSTEM",event:"Manuel EveryCafe kontrolü",sourceDetail:`Aktif ${Number(activeResult&&activeResult.synced)||0} masa işlendi`,action:"Kapanış + aktif masa senkronu çalıştı",result:"Kontrol tamamlandı"});
      scanEveryCafeSourceReconciliation({force:true}).then((reconcileResult)=>{
        res.json({ ok: true, checkedAt: Date.now(), activeSynced: Number(activeResult && activeResult.synced) || 0, reconcile: reconcileResult || {}, ...(result || {}) });
      }).catch((reconcileErr)=>{
        res.json({ ok: false, error: `EveryCafe silinen kayıt kontrolü: ${String(reconcileErr&&reconcileErr.message||reconcileErr)}` });
      });
    });
  });
});

// v3.1.35: Entegrasyon denetimi günlük kaynak toplamı + OrderID ürün kontrolü yapar.
// Sessions + Üye + bilet/diğer Payments tek salt-okunur snapshot ile karşılaştırılır.
// Gider verisine dokunulmaz.
function readEveryCafePaymentAuditSnapshot(sinceMs, cb) {
  const sinceSec = Math.floor(Math.max(0, Number(sinceMs) || 0) / 1000);
  const source = new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) return cb(openErr);
    const close = () => source.close(() => {});
    source.all(
      `SELECT s.SessionID,s.ClientName,s.StartDate,s.EndDate,s.PaymentMethod,s.PaymentAmount,
              s.SessionType,s.SessionTypeText,s.SessionDetailDataText,s.Price,
              s.TicketID,s.TicketSetID,s.TicketOrder,s.TicketOrderAmount,
              (SELECT COUNT(*) FROM Payments px
               WHERE COALESCE(px.Deleted,0)=0 AND COALESCE(px.IsMoneyChange,0)=0
                 AND CAST(COALESCE(px.SessionID,'') AS TEXT)=CAST(s.SessionID AS TEXT)
                 AND px.PaymentMethod IN (1,2) AND COALESCE(px.PaymentAmount,0)>0) AS LinkedPaymentCount
       FROM Sessions s
       WHERE COALESCE(s.Deleted,0)=0
         AND (COALESCE(s.IsPaid,0)=1 OR COALESCE(s.TicketOrderAmount,0)>0)
         AND COALESCE(s.EndDate,0)>?
       ORDER BY s.EndDate ASC, CAST(s.SessionID AS TEXT) ASC`,
      [sinceSec],
      (sessionErr, sessions) => {
        if (sessionErr) { close(); return cb(sessionErr); }
        const sessionRows = sessions || [];
        const ids = sessionRows.map((row) => row.SessionID).filter((id) => String(id || '').trim());
        const readOrders = (next) => {
          if (!ids.length) return next(null, []);
          source.all(
            `SELECT o.OrderID,o.SessionID,o.StockID,o.StockName,o.Quantity,o.Price,o.AddDate,o.OrderIsActive,
                    COALESCE(c.LookupText1,'') AS CategoryName
             FROM Orders o
             LEFT JOIN Stocks st ON st.StockID=o.StockID
             LEFT JOIN LookupValues c ON c.LookupKey='ProductCategories' AND c.LookupValue1=st.CategoryID
             WHERE o.SessionID IN (${ids.map(() => '?').join(',')})
             ORDER BY o.AddDate ASC,o.OrderID ASC`,
            ids,
            next
          );
        };
        readOrders((orderErr, orders) => {
          if (orderErr) { close(); return cb(orderErr); }
          source.all(
            `SELECT HistoryID,PaymentAmount,PaymentMethod,PaymentDate,Note
             FROM MemberPaymentHistory
             WHERE COALESCE(IsActive,1)<>0 AND PaymentMethod IN (1,2)
               AND COALESCE(PaymentAmount,0)>0 AND COALESCE(PaymentDate,0)>?
             ORDER BY PaymentDate ASC, HistoryID ASC`,
            [sinceSec],
            (memberErr, members) => {
              if (memberErr) { close(); return cb(memberErr); }
              const sourceTimeSql = `(CASE WHEN COALESCE(p.AddDate,0)>0 THEN p.AddDate ELSE COALESCE(p.UpdDate,0) END)`;
              source.all(
                `SELECT p.PaymentID,p.SessionID,p.PaymentMethod,p.PaymentAmount,p.PaymentStatus,p.PaymentType,
                        p.IsPrepaid,p.IsMoneyChange,p.MoneyChangeAmount,p.Notes,p.AddDate,p.UpdDate,p.MemberID,
                        COALESCE(p.Deleted,0) AS Deleted,
                        s.SessionID AS LinkedSessionID,s.ClientName AS LinkedClientName,
                        s.SessionType AS LinkedSessionType,s.SessionTypeText AS LinkedSessionTypeText,
                        s.SessionDetailDataText AS LinkedSessionDetailDataText,
                        s.TicketID AS LinkedTicketID,s.TicketSetID AS LinkedTicketSetID,
                        s.TicketOrder AS LinkedTicketOrder,s.TicketOrderAmount AS LinkedTicketOrderAmount,
                        COALESCE(s.Deleted,0) AS LinkedDeleted
                 FROM Payments p
                 LEFT JOIN Sessions s ON COALESCE(CAST(p.SessionID AS TEXT),'')<>''
                                      AND CAST(s.SessionID AS TEXT)=CAST(p.SessionID AS TEXT)
                 WHERE COALESCE(p.Deleted,0)=0 AND COALESCE(p.IsMoneyChange,0)=0
                   AND p.PaymentMethod IN (1,2) AND COALESCE(p.PaymentAmount,0)>0
                   AND ${sourceTimeSql}>?
                 ORDER BY ${sourceTimeSql} ASC, CAST(COALESCE(p.PaymentID,'') AS TEXT) ASC`,
                [sinceSec],
                (otherErr, others) => {
                  if (otherErr) { close(); return cb(otherErr); }
                  source.get("SELECT name FROM sqlite_master WHERE type='table' AND name='Expense'", (expenseTableErr, expenseTable) => {
                    if (expenseTableErr) { close(); return cb(expenseTableErr); }
                    const finishSnapshot = (tickets) => {
                      close();
                      const ordersBySession = new Map();
                      (orders || []).forEach((order) => {
                        const sid = String(order.SessionID || '');
                        if (!ordersBySession.has(sid)) ordersBySession.set(sid, []);
                        ordersBySession.get(sid).push(order);
                      });
                      cb(null, {
                        sessions: sessionRows.map((row) => ({ ...row, orders: ordersBySession.get(String(row.SessionID || '')) || [] })),
                        orders: orders || [],
                        members: members || [],
                        others: others || [],
                        tickets: (tickets || []).filter(isEveryCafeTicketCashMovement)
                      });
                    };
                    if (!expenseTable) return finishSnapshot([]);
                    source.all("PRAGMA table_info('Expense')", (expenseSchemaErr, columns) => {
                      if (expenseSchemaErr) { close(); return cb(expenseSchemaErr); }
                      const names = new Set((columns || []).map((c) => String(c.name || '')));
                      if (!['ExpenseID','Description','PaymentMethod','Type','Price','AddDate'].every((name) => names.has(name))) return finishSnapshot([]);
                      const ticketSelect = names.has('TicketID') ? 'e.TicketID AS TicketID' : 'NULL AS TicketID';
                      source.all(
                        `SELECT e.ExpenseID,e.Description,e.PaymentMethod,e.Type AS Type,e.Price,e.AddDate,${ticketSelect}
                         FROM Expense e
                         WHERE COALESCE(e.Type,0)=1
                           AND COALESCE(e.Price,0)>0
                           AND e.PaymentMethod IN (1,2)
                           AND COALESCE(e.AddDate,0)>?
                         ORDER BY e.AddDate ASC,e.ExpenseID ASC`,
                        [sinceSec],
                        (ticketErr, tickets) => ticketErr ? (close(), cb(ticketErr)) : finishSnapshot(tickets)
                      );
                    });
                  });
                }
              );
            }
          );
        });
      }
    );
  });
}

function summarizeEveryCafeSourceSnapshot(snapshot, rangeStart, rangeEnd) {
  const start = Math.max(0, Number(rangeStart) || 0);
  const end = Math.max(start, Number(rangeEnd) || Number.MAX_SAFE_INTEGER);
  const out = {
    count: 0, total: 0, cash: 0, card: 0,
    product: 0, productQuantity: 0, productOrderCount: 0,
    tableProduct: 0, tableProductQuantity: 0,
    directProduct: 0, directProductQuantity: 0,
    tableTotal: 0, directTotal: 0, memberTotal: 0, otherTotal: 0,
    directCount: 0, directCash: 0, directCard: 0,
    memberCount: 0, memberCash: 0, memberCard: 0,
    otherCount: 0, otherCash: 0, otherCard: 0
  };
  const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
  const addMethod = (method, amount, cashKey='cash', cardKey='card') => {
    if (method === 'CASH') out[cashKey] += amount;
    else if (method === 'CARD') out[cardKey] += amount;
  };

  (snapshot && snapshot.sessions || []).forEach((session) => {
    const ts = (Number(session.EndDate) || 0) * 1000;
    if (ts < start || ts >= end || isEveryCafeFreeSession(session)) return;
    const direct = isEveryCafeDirectSaleSession(session);
    const masa = everyCafeTableNumber(session.ClientName);
    const other = !direct && !masa;
    // Bilet/diğer oturumun bağlı Payments tahsilatı varsa ödeme kaynağı aşağıda
    // sayılır. Session toplamını burada tekrar eklemeyiz.
    if (other && Number(session.LinkedPaymentCount) > 0) return;
    const total = everyCafeSessionRevenueTotal(session);
    if (total <= 0) return;
    const method = everyCafePaymentMethod(session.PaymentMethod);
    out.count += 1;
    out.total += total;
    addMethod(method, total);

    const activeOrders = (session.orders || []).filter((order) => Number(order.OrderIsActive) !== 0 && (Number(order.Price) || 0) > 0);
    const productTotal = round(activeOrders.reduce((sum, order) => sum + (Number(order.Quantity) || 0) * (Number(order.Price) || 0), 0));
    const productQty = activeOrders.reduce((sum, order) => sum + Math.max(0, Number(order.Quantity) || 0), 0);
    if (masa || direct) {
      out.product += productTotal;
      out.productQuantity += productQty;
      out.productOrderCount += activeOrders.length;
    }
    if (direct) {
      out.directProduct += productTotal; out.directProductQuantity += productQty;
      out.directTotal += total; out.directCount += 1;
      addMethod(method, total, 'directCash', 'directCard');
    } else if (masa) {
      out.tableProduct += productTotal; out.tableProductQuantity += productQty;
      out.tableTotal += total;
    } else {
      out.otherTotal += total; out.otherCount += 1;
      addMethod(method, total, 'otherCash', 'otherCard');
    }
  });

  (snapshot && snapshot.members || []).forEach((row) => {
    const ts = (Number(row.PaymentDate) || 0) * 1000;
    if (ts < start || ts >= end) return;
    const total = round(row.PaymentAmount);
    if (total <= 0) return;
    const method = everyCafePaymentMethod(row.PaymentMethod);
    out.count += 1; out.total += total; out.memberTotal += total; out.memberCount += 1;
    addMethod(method, total); addMethod(method, total, 'memberCash', 'memberCard');
  });

  (snapshot && snapshot.others || []).forEach((row) => {
    if (!isEveryCafeOtherPaymentCandidate(row)) return;
    const ts = everyCafeOtherPaymentSourceTime(row) * 1000;
    if (ts < start || ts >= end) return;
    const total = round(row.PaymentAmount);
    if (total <= 0) return;
    const method = everyCafePaymentMethod(row.PaymentMethod);
    out.count += 1; out.total += total; out.otherTotal += total; out.otherCount += 1;
    addMethod(method, total); addMethod(method, total, 'otherCash', 'otherCard');
  });

  (snapshot && snapshot.tickets || []).forEach((row) => {
    if (!isEveryCafeTicketCashMovement(row)) return;
    const ts = everyCafeTicketCashMovementTime(row) * 1000;
    if (ts < start || ts >= end) return;
    const total = round(row.Price);
    if (total <= 0) return;
    const method = everyCafePaymentMethod(row.PaymentMethod);
    out.count += 1; out.total += total; out.otherTotal += total; out.otherCount += 1;
    addMethod(method, total); addMethod(method, total, 'otherCash', 'otherCard');
  });

  Object.keys(out).forEach((key) => {
    if (typeof out[key] === 'number' && !Number.isInteger(out[key])) out[key] = round(out[key]);
  });
  return out;
}

// KafePin "bugün" finansı 20:00-20:00 kafe günüdür. EveryCafe bir masa
// oturumunu 20:00 öncesinde açıp sonrasında kapatırsa kaynak Session tek kapanış
// toplamı taşır. Mevcut devir kuralımızla bu tek toplamı sınırın iki tarafına
// ayırır; yeni güne yalnız 20:00 sonrası bölümünü yazarız.
function summarizeEveryCafeBusinessDaySnapshot(snapshot, rangeStart, rangeEnd) {
  const start = Math.max(0, Number(rangeStart) || 0);
  const end = Math.max(start, Number(rangeEnd) || Number.MAX_SAFE_INTEGER);
  const out = summarizeEveryCafeSourceSnapshot(snapshot, start, end);
  const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
  let rolloverTotal = 0;
  let rolloverCount = 0;
  const rolloverMasalar = [];

  (snapshot && snapshot.sessions || []).forEach((session) => {
    if (isEveryCafeFreeSession(session) || isEveryCafeDirectSaleSession(session)) return;
    const masa = everyCafeTableNumber(session.ClientName);
    if (!masa) return;

    const sessionStart = (Number(session.StartDate) || 0) * 1000;
    const sessionEnd = (Number(session.EndDate) || 0) * 1000;
    if (!(sessionStart < start && sessionEnd >= start && sessionEnd < end)) return;

    const total = Math.max(0, Number(everyCafeSessionRevenueTotal(session)) || 0);
    if (total <= 0) return;
    const method = everyCafePaymentMethod(session.PaymentMethod);
    const activeOrders = (session.orders || []).filter((order) =>
      Number(order.OrderIsActive) !== 0 && (Number(order.Price) || 0) > 0
    );

    let productTotal = 0;
    let beforeProduct = 0;
    let beforeProductQty = 0;
    let beforeProductOrders = 0;
    activeOrders.forEach((order) => {
      const qty = Math.max(0, Number(order.Quantity) || 0);
      const line = qty * Math.max(0, Number(order.Price) || 0);
      const orderTs = (Number(order.AddDate) || Number(session.EndDate) || 0) * 1000;
      productTotal += line;
      if (orderTs < start) {
        beforeProduct += line;
        beforeProductQty += qty;
        beforeProductOrders += 1;
      }
    });

    productTotal = round(productTotal);
    beforeProduct = round(beforeProduct);
    const computerTotal = Math.max(round(total - productTotal), 0);
    const beforeComputer = Math.min(
      computerTotal,
      Math.max(Number(feeAtTime(masa, sessionStart, start)) || 0, 0)
    );
    const beforeTotal = Math.min(total, Math.max(round(beforeComputer + beforeProduct), 0));
    const afterTotal = Math.max(round(total - beforeTotal), 0);

    out.total = round((Number(out.total) || 0) - beforeTotal);
    out.tableTotal = round((Number(out.tableTotal) || 0) - beforeTotal);
    out.product = round(Math.max(0, (Number(out.product) || 0) - beforeProduct));
    out.tableProduct = round(Math.max(0, (Number(out.tableProduct) || 0) - beforeProduct));
    out.productQuantity = Math.max(0, (Number(out.productQuantity) || 0) - beforeProductQty);
    out.tableProductQuantity = Math.max(0, (Number(out.tableProductQuantity) || 0) - beforeProductQty);
    out.productOrderCount = Math.max(0, (Number(out.productOrderCount) || 0) - beforeProductOrders);
    if (method === 'CASH') out.cash = round((Number(out.cash) || 0) - beforeTotal);
    else if (method === 'CARD') out.card = round((Number(out.card) || 0) - beforeTotal);

    rolloverTotal = round(rolloverTotal + afterTotal);
    rolloverCount += 1;
    if (!rolloverMasalar.includes(masa)) rolloverMasalar.push(masa);
  });

  out.total = Math.max(0, round(out.total));
  out.tableTotal = Math.max(0, round(out.tableTotal));
  out.cash = Math.max(0, round(out.cash));
  out.card = Math.max(0, round(out.card));
  out.rolloverTotal = Math.max(0, round(rolloverTotal));
  out.rolloverCount = rolloverCount;
  out.rolloverMasalar = rolloverMasalar.sort((a, b) => a - b);
  return out;
}

function readEveryCafePaymentAuditSnapshotP(sinceMs) {
  return new Promise((resolve, reject) => {
    readEveryCafePaymentAuditSnapshot(sinceMs, (err, snapshot) => err ? reject(err) : resolve(snapshot));
  });
}

function getEveryCafeConfigP() {
  return new Promise((resolve, reject) => {
    getEveryCafeConfig((err, config) => err ? reject(err) : resolve(config));
  });
}

// v3.1.38: Ayrı İptal / Ücretsiz / Silinenler sayfasının salt-okunur listesi.
app.get('/admin/everycafe/reconcile-events', async (req,res)=>{
  setNoStore(res);
  try{
    const days=Math.max(1,Math.min(parseInt(req.query.days,10)||30,180));
    const since=Date.now()-days*24*60*60*1000;
    const rows=await kafePinDbAllP(`SELECT * FROM everycafe_reconcile_events WHERE first_detected_at>=? ORDER BY id DESC LIMIT 1000`,[since]);
    const todayStart=everyCafeCalendarDayStartTs(Date.now());
    const today=rows.filter(r=>Number(r.first_detected_at)>=todayStart);
    const parseDetails=(value)=>{try{return JSON.parse(value||'{}')}catch(_e){return {}}};
    const normalized=rows.map(r=>({...r,details:parseDetails(r.details_json),details_json:undefined}));
    res.json({ok:true,days,rows:normalized,summary:{
      todayFree:today.filter(r=>String(r.event_type)==='FREE_CLOSE').length,
      todayDeleted:today.filter(r=>String(r.event_type)==='SOURCE_DELETED').length,
      waiting:rows.filter(r=>String(r.status)==='WAITING').length,
      removed:rows.filter(r=>String(r.status)==='KAFEPIN_REMOVED').length,
      autoCleared:rows.filter(r=>String(r.status)==='AUTO_CLEARED').length,
      restored:rows.filter(r=>String(r.status)==='RESTORED').length
    }});
  }catch(err){res.json({ok:false,error:String(err&&err.message||err)});}
});

app.post('/admin/everycafe/reconcile-scan-now', async (req,res)=>{
  setNoStore(res);
  try{
    const result=await scanEveryCafeSourceReconciliation({force:true});
    res.json({ok:true,...(result||{})});
  }catch(err){res.json({ok:false,error:String(err&&err.message||err)});}
});

app.post('/admin/everycafe/reconcile-remove',(req,res)=>{
  setNoStore(res);
  const eventId=parseInt((req.body||{}).eventId,10)||0;
  if(!eventId)return res.json({ok:false,error:'Geçersiz silinen kayıt'});
  removeEveryCafeReconcileEvent(eventId,(err,result)=>{
    if(err)return res.json({ok:false,error:String(err&&err.message||err)});
    res.json({ok:true,...(result||{})});
  });
});

// v3.1.35: EveryCafe panelindeki BUGÜN rakamları artık KafePin'e aktarılmış
// yerel toplamdan değil doğrudan salt-okunur EveryCafe kaynağından hesaplanır.
// Böylece kaynak 80 ₺ / KafePin 55 ₺ ise panel 80 ₺ gösterir ve denetim -25 ₺ fark verir.
app.get("/admin/everycafe/source-today", async (req, res) => {
  setNoStore(res);
  try {
    const config = await getEveryCafeConfigP();
    const comparisonStart = dayStartTs(Date.now());
    const comparisonEnd = comparisonStart + 24 * 60 * 60 * 1000;
    // v3.1.42: "Bugün" KafePin'in 20:00-20:00 kafe günüdür. 20:00'dan
    // sonra eski takvim günü cirosu yeni güne taşınmaz; devirli masa kapanışında
    // yalnız 20:00 sonrası bölüm yeni günün EveryCafe gerçek gelirine girer.
    const snapshot = await readEveryCafePaymentAuditSnapshotP(Math.max(0, comparisonStart - 1000));
    const summary = summarizeEveryCafeBusinessDaySnapshot(snapshot, comparisonStart, comparisonEnd);
    const lastHour = summarizeEveryCafeSourceSnapshot(snapshot, Math.max(comparisonStart, Date.now() - 60 * 60 * 1000), comparisonEnd);
    res.json({
      ok: true,
      start: comparisonStart,
      end: comparisonEnd,
      // Eski panel alanlarının anlamını koru: today.product yalnız MASA ürünüdür.
      // Genel ürün doğrulaması için summary.product ayrıca productAll olarak döner.
      today: { ...summary, productAll: summary.product, product: summary.tableProduct, sessionTotal: summary.tableTotal },
      lastHour: { ...lastHour, productAll: lastHour.product, product: lastHour.tableProduct, sessionTotal: lastHour.tableTotal },
      directSales: {
        count: summary.directCount, total: summary.directTotal, cash: summary.directCash, card: summary.directCard
      },
      memberIncome: {
        count: summary.memberCount, total: summary.memberTotal, cash: summary.memberCash, card: summary.memberCard
      },
      otherIncome: {
        count: summary.otherCount, total: summary.otherTotal, cash: summary.otherCash, card: summary.otherCard
      },
      rollover: {
        count: Number(summary.rolloverCount) || 0,
        total: Number(summary.rolloverTotal) || 0,
        masalar: Array.isArray(summary.rolloverMasalar) ? summary.rolloverMasalar : []
      }
    });
  } catch (err) {
    res.json({ ok: false, error: String(err && (err.message || err) || err) });
  }
});

// EveryCafe'deki nakit/kart seçimi ve tahsilat tutarı, KafePin'e aktarılmış
// ödeme ile karşılaştırılır. Fark varsa kasa uyarısında görünür.
app.get("/admin/everycafe/payment-audit", async (req, res) => {
  setNoStore(res);
  try {
    const config = await getEveryCafeConfigP();
    if (!config.enabled || !config.startAt) {
      return res.json({ ok: true, issues: [], daily: { sourceTotal:0, kafePinTotal:0, difference:0, sourceProductTotal:0, kafePinProductTotal:0, productDifference:0 } });
    }
    // v3.1.37: Kullanıcının istediği kontrol EveryCafe'nin BUGÜN kaynak cirosudur.
    // Entegrasyon gün içinde yeniden başlasa bile 00:00'dan sonraki gerçek kaynak gelir
    // tamamı okunur; böylece 80 ₺ kaynak / 55 ₺ KafePin durumu +25 ₺ eksik olarak görünür.
    const auditStart = everyCafeCalendarDayStartTs(Date.now());
    const auditEnd = everyCafeCalendarDayEndTs(Date.now());
    const snapshot = await readEveryCafePaymentAuditSnapshotP(Math.max(0, auditStart - 1000));
    const [paymentRows, importRows, memberImportRows, localOrderRows] = await Promise.all([
      kafePinDbAllP(`SELECT id,created_at,masa,session_start,session_end,total_amount,method,external_id,external_source,source,voided
                     FROM payments
                     WHERE (source='EVERYCAFE' AND external_source='EVERYCAFE')
                        OR (source='EVERYCAFE_DIRECT' AND external_source='EVERYCAFE_DIRECT')
                        OR (source='EVERYCAFE_MEMBER' AND external_source='EVERYCAFE_MEMBER')
                        OR (source='EVERYCAFE_OTHER' AND external_source='EVERYCAFE_OTHER')`),
      kafePinDbAllP("SELECT session_id FROM everycafe_imports"),
      kafePinDbAllP("SELECT history_id FROM everycafe_member_imports"),
      kafePinDbAllP(`SELECT id,time,masa,session_start,product_name,unit_price,quantity,total,external_source,external_id,voided
                     FROM product_sales
                     WHERE external_source IN ('EVERYCAFE','EVERYCAFE_DIRECT')`)
    ]);

    const activePayments = paymentRows.filter((row) => Number(row.voided) === 0);
    const activePaymentByExternalId = new Map(activePayments.map((row) => [String(row.external_id || ""), row]));
    const anyPaymentExternalIds = new Set(paymentRows.map((row) => String(row.external_id || "")));
    const importedIds = new Set(importRows.map((row) => String(row.session_id || "")));
    const importedMemberIds = new Set(memberImportRows.map((row) => Number(row.history_id) || 0));
    const activeOrdersByExternalId = new Map(localOrderRows.filter((row)=>Number(row.voided)===0).map((row)=>[String(row.external_id||""),row]));
    const issues = [];
    const now = Date.now();
    const round = (value) => Math.round((Number(value) || 0) * 100) / 100;

    const sourceSummary = summarizeEveryCafeSourceSnapshot(snapshot, auditStart, auditEnd);
    const kafePinTotal = round(activePayments
      .filter((row) => Number(row.created_at) >= auditStart && Number(row.created_at) < auditEnd)
      .reduce((sum, row) => sum + (Number(row.total_amount) || 0), 0));
    const dailyDifference = round(kafePinTotal - sourceSummary.total);

    if (Math.abs(dailyDifference) > 0.01) {
      issues.push({
        code: "EVERYCAFE_DAILY_TOTAL_MISMATCH",
        time: now,
        everyCafePaymentId: 0,
        text: `BUGÜN EveryCafe ${sourceSummary.total.toFixed(2)} ₺, KafePin aktarımı ${kafePinTotal.toFixed(2)} ₺ • Fark ${dailyDifference >= 0 ? "+" : ""}${dailyDifference.toFixed(2)} ₺`
      });
    }

    (snapshot.sessions || []).forEach((session) => {
      const sessionId = String(session.SessionID || "");
      const directSale = isEveryCafeDirectSaleSession(session);
      const sourceMasa = everyCafeTableNumber(session.ClientName);
      const otherSession = !directSale && !sourceMasa;
      if (isEveryCafeFreeSession(session)) return;
      // Bilet/diğer oturumda bağlı Payment asıl tahsilattır; Session'ı ayrıca denetleme.
      if (otherSession && Number(session.LinkedPaymentCount) > 0) return;
      const externalId = directSale
        ? `DIRECT_SESSION:${sessionId}`
        : otherSession ? `OTHER_SESSION:${sessionId}` : `SESSION:${sessionId}`;
      const local = activePaymentByExternalId.get(externalId);
      if (!local && (importedIds.has(sessionId) || anyPaymentExternalIds.has(externalId))) return;
      if (!local) {
        if (now - Number(session.EndDate || 0) * 1000 < 10 * 1000) return;
        issues.push({
          code: "EVERYCAFE_MISSING_IMPORT",
          time: Number(session.EndDate) * 1000,
          everyCafePaymentId: 0,
          text: directSale
            ? "EveryCafe Doğrudan Satış tahsilatı KafePin'e aktarılmamış"
            : otherSession
              ? `EveryCafe ${String(session.ClientName || session.SessionTypeText || "bilet/diğer gelir")} tahsilatı KafePin'e aktarılmamış`
              : `EveryCafe Masa ${sourceMasa} kapanışı KafePin'e aktarılmamış`
        });
        return;
      }
      const sourceTotal = everyCafeSessionRevenueTotal(session);
      const localTotal = round(local.total_amount);
      const sourceMethod = everyCafePaymentMethod(session.PaymentMethod);
      if (Math.abs(sourceTotal - localTotal) > 0.01) {
        issues.push({ code:"EVERYCAFE_TOTAL_MISMATCH", time:Number(session.EndDate)*1000, everyCafePaymentId:Number(local.id)||0,
          text:`EveryCafe ${directSale?"Doğrudan Satış":otherSession?"bilet/diğer gelir":`Masa ${sourceMasa}`}: tahsilat ${sourceTotal.toFixed(2)} ₺, KafePin ${localTotal.toFixed(2)} ₺` });
      }
      if (sourceMethod !== "PENDING" && String(local.method) !== sourceMethod) {
        issues.push({ code:"EVERYCAFE_METHOD_MISMATCH", time:Number(session.EndDate)*1000, everyCafePaymentId:Number(local.id)||0,
          text:`EveryCafe ${directSale?"Doğrudan Satış":otherSession?"bilet/diğer gelir":`Masa ${sourceMasa}`}: ödeme tipi KafePin ile farklı` });
      }
    });

    (snapshot.members || []).forEach((row) => {
      const historyId = Number(row.HistoryID) || 0;
      const sourceTime = Number(row.PaymentDate || 0) * 1000;
      const externalId = `MEMBER_PAYMENT:${historyId}`;
      const local = activePaymentByExternalId.get(externalId);
      if (!local && (importedMemberIds.has(historyId) || anyPaymentExternalIds.has(externalId))) return;
      if (!local) {
        if (now - sourceTime < 10 * 1000) return;
        issues.push({ code:"EVERYCAFE_MEMBER_MISSING_IMPORT", time:sourceTime, everyCafePaymentId:0, text:`EveryCafe üye tahsilatı #${historyId} KafePin'e aktarılmamış` });
        return;
      }
      const sourceTotal = round(row.PaymentAmount);
      const localTotal = round(local.total_amount);
      const sourceMethod = everyCafePaymentMethod(row.PaymentMethod);
      if (Math.abs(sourceTotal-localTotal)>0.01) issues.push({code:"EVERYCAFE_MEMBER_TOTAL_MISMATCH",time:sourceTime,everyCafePaymentId:Number(local.id)||0,text:`EveryCafe üye tahsilatı #${historyId}: kaynak ${sourceTotal.toFixed(2)} ₺, KafePin ${localTotal.toFixed(2)} ₺`});
      if (sourceMethod!=="PENDING" && String(local.method)!==sourceMethod) issues.push({code:"EVERYCAFE_MEMBER_METHOD_MISMATCH",time:sourceTime,everyCafePaymentId:Number(local.id)||0,text:`EveryCafe üye tahsilatı #${historyId}: ödeme tipi KafePin ile farklı`});
    });

    (snapshot.others || []).forEach((row) => {
      if (!isEveryCafeOtherPaymentCandidate(row)) return;
      const paymentId = String(row.PaymentID || "").trim();
      if (!paymentId) return;
      const sourceTime = everyCafeOtherPaymentSourceTime(row) * 1000;
      const externalId = `PAYMENT:${paymentId}`;
      const local = activePaymentByExternalId.get(externalId);
      if (!local && anyPaymentExternalIds.has(externalId)) return;
      if (!local) {
        if (now - sourceTime < 10 * 1000) return;
        const linked = everyCafeLinkedSessionFromPayment(row);
        const name = everyCafeOtherIncomeName(String(row.Notes||"") || String(linked&&linked.ClientName||"") || String(linked&&linked.SessionTypeText||""));
        issues.push({ code:"EVERYCAFE_OTHER_MISSING_IMPORT", time:sourceTime, everyCafePaymentId:0, text:`EveryCafe ${name} ${round(row.PaymentAmount).toFixed(2)} ₺ KafePin'e aktarılmamış` });
        return;
      }
      const sourceTotal=round(row.PaymentAmount), localTotal=round(local.total_amount), sourceMethod=everyCafePaymentMethod(row.PaymentMethod);
      if(Math.abs(sourceTotal-localTotal)>0.01) issues.push({code:"EVERYCAFE_OTHER_TOTAL_MISMATCH",time:sourceTime,everyCafePaymentId:Number(local.id)||0,text:`EveryCafe bilet/diğer #${paymentId}: kaynak ${sourceTotal.toFixed(2)} ₺, KafePin ${localTotal.toFixed(2)} ₺`});
      if(sourceMethod!=="PENDING"&&String(local.method)!==sourceMethod) issues.push({code:"EVERYCAFE_OTHER_METHOD_MISMATCH",time:sourceTime,everyCafePaymentId:Number(local.id)||0,text:`EveryCafe bilet/diğer #${paymentId}: ödeme tipi KafePin ile farklı`});
    });

    (snapshot.tickets || []).forEach((row) => {
      if (!isEveryCafeTicketCashMovement(row)) return;
      const expenseId = Number(row.ExpenseID) || 0;
      const sourceTime = everyCafeTicketCashMovementTime(row) * 1000;
      const externalId = everyCafeTicketCashMovementExternalId(row);
      const local = activePaymentByExternalId.get(externalId);
      if (!local && anyPaymentExternalIds.has(externalId)) return;
      const sourceTotal = round(row.Price);
      const incomeName = everyCafeOtherIncomeName(row.Description, "EveryCafe Bilet / Diğer Gelir");
      if (!local) {
        if (now - sourceTime < 10 * 1000) return;
        issues.push({ code:"EVERYCAFE_OTHER_CASH_MISSING_IMPORT", time:sourceTime, everyCafePaymentId:0, text:`${incomeName} ${sourceTotal.toFixed(2)} ₺ KafePin'e aktarılmamış` });
        return;
      }
      const localTotal = round(local.total_amount);
      const sourceMethod = everyCafePaymentMethod(row.PaymentMethod);
      if (Math.abs(sourceTotal-localTotal)>0.01) issues.push({code:"EVERYCAFE_OTHER_CASH_TOTAL_MISMATCH",time:sourceTime,everyCafePaymentId:Number(local.id)||0,text:`${incomeName} #${expenseId}: kaynak ${sourceTotal.toFixed(2)} ₺, KafePin ${localTotal.toFixed(2)} ₺`});
      if (sourceMethod!=="PENDING" && String(local.method)!==sourceMethod) issues.push({code:"EVERYCAFE_OTHER_CASH_METHOD_MISMATCH",time:sourceTime,everyCafePaymentId:Number(local.id)||0,text:`${incomeName} #${expenseId}: ödeme tipi KafePin ile farklı`});
    });

    // Ürün kontrolü artık yalnız toplam ciroya bakmaz; EveryCafe OrderID'nin
    // KafePin'de aynı adet/fiyat/tutarla bulunmasını tek tek doğrular.
    let kafePinProductTotal = 0;
    (snapshot.sessions || []).forEach((session) => {
      const ts=(Number(session.EndDate)||0)*1000;
      if(ts<auditStart||ts>=auditEnd||isEveryCafeFreeSession(session)) return;
      const direct=isEveryCafeDirectSaleSession(session);
      const masa=everyCafeTableNumber(session.ClientName);
      if(!direct&&!masa) return;
      (session.orders||[]).forEach((order)=>{
        if(Number(order.OrderIsActive)===0 || (Number(order.Price)||0)<=0) return;
        const orderId=String(order.OrderID||"").trim();
        if(!orderId) return;
        const externalId=direct ? `DIRECT_ORDER:${orderId}` : `ORDER:${orderId}`;
        const sourceQty=Math.max(1,Number(order.Quantity)||1);
        const sourcePrice=round(order.Price);
        const sourceTotal=round(sourceQty*sourcePrice);
        const local=activeOrdersByExternalId.get(externalId);
        if(!local){
          issues.push({code:"EVERYCAFE_ORDER_MISSING",time:(Number(order.AddDate)||Number(session.EndDate)||0)*1000,everyCafePaymentId:0,text:`EveryCafe ürün eksik: ${sourceQty}x ${String(order.StockName||"Ürün")} • ${sourceTotal.toFixed(2)} ₺ KafePin'e gelmemiş`});
          return;
        }
        kafePinProductTotal += Number(local.total)||0;
        const localQty=Number(local.quantity)||0, localPrice=round(local.unit_price), localTotal=round(local.total);
        if(Math.abs(localQty-sourceQty)>0.0001 || Math.abs(localPrice-sourcePrice)>0.01 || Math.abs(localTotal-sourceTotal)>0.01){
          issues.push({code:"EVERYCAFE_ORDER_MISMATCH",time:(Number(order.AddDate)||Number(session.EndDate)||0)*1000,everyCafePaymentId:0,text:`EveryCafe ürün uyuşmaz: ${String(order.StockName||"Ürün")} • kaynak ${sourceQty}x ${sourcePrice.toFixed(2)} ₺ / KafePin ${localQty}x ${localPrice.toFixed(2)} ₺`});
        }
      });
    });
    kafePinProductTotal=round(kafePinProductTotal);
    const productDifference=round(kafePinProductTotal-sourceSummary.product);
    if(Math.abs(productDifference)>0.01){
      issues.push({code:"EVERYCAFE_PRODUCT_DAILY_MISMATCH",time:now,everyCafePaymentId:0,text:`BUGÜN EveryCafe ürün ${sourceSummary.product.toFixed(2)} ₺, KafePin ürün aktarımı ${kafePinProductTotal.toFixed(2)} ₺ • Fark ${productDifference>=0?"+":""}${productDifference.toFixed(2)} ₺`});
    }

    issues.sort((a,b)=>(Number(b.time)||0)-(Number(a.time)||0));
    res.json({
      ok:true,
      auditStart,
      auditEnd,
      issueCount:issues.length,
      status:issues.length?"PROBLEM":"OK",
      daily:{
        sourceTotal:sourceSummary.total,
        kafePinTotal,
        difference:dailyDifference,
        sourceProductTotal:sourceSummary.product,
        kafePinProductTotal,
        productDifference
      },
      issues:issues.slice(0,100)
    });
  } catch (err) {
    res.json({ ok:false, error:String(err && (err.message || err) || err) });
  }
});

// 20:00 kafe günü sınırını geçen EveryCafe kapanışlarını bilgi amaçlı
// bölümlendirir. Tahsilat kaydını bölmez; öncesi + sonrası her zaman
// EveryCafe'nin tek gerçek toplamına eşittir.
app.get("/admin/everycafe/day-splits", (req, res) => {
  setNoStore(res);
  const earliest = Date.now() - (14 * 24 * 60 * 60 * 1000);
  db.all(
    `SELECT id,masa,session_start,session_end,computer_amount,product_amount,total_amount,method
     FROM payments
     WHERE voided=0 AND source='EVERYCAFE' AND external_source='EVERYCAFE'
       AND session_start>0 AND session_end>? 
     ORDER BY session_end DESC LIMIT 30`,
    [earliest],
    (paymentErr, payments) => {
      if (paymentErr) return res.json({ ok: false, error: String(paymentErr) });
      const candidates = (payments || []).filter((payment) => {
        const boundary = dayStartTs(Number(payment.session_end) || 0);
        return Number(payment.session_start) < boundary && boundary < Number(payment.session_end);
      });
      let index = 0;
      const rows = [];
      const next = () => {
        if (index >= candidates.length) return res.json({ ok: true, rows });
        const payment = candidates[index++];
        const masa = Number(payment.masa) || 0;
        const start = Number(payment.session_start) || 0;
        const end = Number(payment.session_end) || 0;
        const boundary = dayStartTs(end);
        const computerTotal = Math.max(Number(payment.computer_amount) || 0, 0);
        // Açılış ücreti sınır öncesine, sonradan gelen basamaklar doğru güne gider.
        const beforeComputer = Math.min(computerTotal, Math.max(feeAtTime(masa, start, boundary), 0));
        const afterComputer = Math.max(computerTotal - beforeComputer, 0);
        db.all(
          `SELECT time,total FROM product_sales
           WHERE voided=0 AND external_source='EVERYCAFE' AND masa=? AND session_start=?`,
          [masa, start],
          (productErr, productRows) => {
            if (productErr) return res.json({ ok: false, error: String(productErr) });
            let beforeProduct = 0;
            let afterProduct = 0;
            (productRows || []).forEach((sale) => {
              if (Number(sale.time) < boundary) beforeProduct += Number(sale.total) || 0;
              else afterProduct += Number(sale.total) || 0;
            });
            // Ürün aktarımının gecikmesi/iptali olsa bile toplamı tahsilatla eşit tut.
            const recordedProduct = Math.max(Number(payment.product_amount) || 0, 0);
            const observedProduct = beforeProduct + afterProduct;
            if (Math.abs(recordedProduct - observedProduct) > 0.01) afterProduct += recordedProduct - observedProduct;
            const before = Math.round((beforeComputer + beforeProduct) * 100) / 100;
            const total = Math.round((Number(payment.total_amount) || 0) * 100) / 100;
            rows.push({
              masa, start, end, boundary,
              before,
              after: Math.round((total - before) * 100) / 100,
              total,
              method: String(payment.method || "PENDING")
            });
            next();
          }
        );
      };
      next();
    }
  );
});

app.get("/admin/product-sales/summary", (req, res) => {
  setNoStore(res);
  const now = Date.now();
  const start = dayStartTs(now);
  const end = start + 24 * 60 * 60 * 1000;
  const yesterdayStart = start - 24 * 60 * 60 * 1000;
  const monthDate = new Date(now);
  monthDate.setDate(1);
  monthDate.setHours(20, 0, 0, 0);
  const monthStart = monthDate.getTime() > now
    ? new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1, 20, 0, 0, 0).getTime()
    : monthDate.getTime();

  db.all(
    `SELECT id,time,masa,session_start,product_id,product_name,category,
            unit_price,quantity,total,sale_type,note,status,payment_method,external_source
     FROM product_sales
     WHERE time>=? AND time<? AND voided=0
     ORDER BY id DESC`,
    [start, end],
    (err, rows) => {
      if (err) return res.json({ ok: false, error: String(err) });
      const list = rows || [];
      const categoryTotals = {};
      const tableTotals = {};
      let total = 0;
      let directTotal = 0;
      let directCash = 0;
      let directCard = 0;
      let directCount = 0;
      let directQuantity = 0;
      let directLastHourTotal = 0;
      let everyCafeDirectTotal = 0;
      let everyCafeOtherTotal = 0;
      let everyCafeMemberTotal = 0;
      let todayQuantity = 0;

      list.forEach((sale) => {
        const amount = Number(sale.total) || 0;
        total += amount;
        todayQuantity += Number(sale.quantity) || 0;
        categoryTotals[sale.category] = (Number(categoryTotals[sale.category]) || 0) + amount;
        if (sale.sale_type === "DIRECT") {
          if (sale.external_source === "EVERYCAFE_DIRECT") everyCafeDirectTotal += amount;
          else if (sale.external_source === "EVERYCAFE_OTHER") everyCafeOtherTotal += amount;
          else if (isLegacyEveryCafeManualMemberSale(sale)) everyCafeMemberTotal += amount;
          else {
            directTotal += amount;
            directCount += 1;
            directQuantity += Math.max(0, Number(sale.quantity) || 0);
            if (sale.payment_method === "CASH") directCash += amount;
            else if (sale.payment_method === "CARD") directCard += amount;
            if ((Number(sale.time) || 0) >= now - 60 * 60 * 1000) directLastHourTotal += amount;
          }
        }
        if (sale.masa > 0 && sale.status === "OPEN") {
          tableTotals[sale.masa] = (Number(tableTotals[sale.masa]) || 0) + amount;
        }
      });

      // Oturum hizmetini ürün ve doğrudan satıştan ayrı tutuyoruz.
      db.get(
        `SELECT COALESCE(SUM(fee),0) AS total
         FROM session_history
         WHERE end_time>=? AND end_time<?`,
        [start, end],
        (sessionErr, sessionRow) => {
          if (sessionErr) return res.json({ ok: false, error: String(sessionErr) });
          const sessionTotal = Number(sessionRow && sessionRow.total) || 0;
      db.all(
        `SELECT masa, COALESCE(SUM(total),0) AS total
         FROM product_sales
         WHERE voided=0 AND sale_type='TABLE' AND status='OPEN' AND masa>0
         GROUP BY masa`,
        (openErr, openRows) => {
          if (openErr) return res.json({ ok: false, error: String(openErr) });

          Object.keys(tableTotals).forEach((masa) => delete tableTotals[masa]);
          (openRows || []).forEach((row) => {
            tableTotals[row.masa] = Number(row.total) || 0;
          });

          // Açık masanın bilgisayar ücreti yalnızca ürün ekranındaki canlı
          // bilgi içindir; kapanmamış oturum kesin gelire dahil edilmez.
          db.all(
            "SELECT masa,start_time FROM sessions WHERE COALESCE(end_time,0)=0",
            (openSessionErr, openSessionRows) => {
              if (openSessionErr) return res.json({ ok: false, error: String(openSessionErr) });
              const openSessionDetails = (openSessionRows || [])
                .map((row) => {
                  const masa = Number(row.masa) || 0;
                  const scheduledEnd = isEveryCafeTimedMasa(masa) ? getEveryCafeScheduledEnd(masa) : 0;
                  const billedUntil = scheduledEnd > Number(row.start_time)
                    ? Math.min(now, scheduledEnd - 1)
                    : now;
                  return {
                    masa,
                    fee: masa > 0 && !isFreeMasa(masa) && !everyCafeWaitingMasalar.has(masa)
                      ? Math.max(0, feeAtTime(masa, row.start_time, billedUntil))
                      : 0
                  };
                })
                .filter((row) => row.masa > 0 && row.fee > 0)
                .sort((a, b) => a.masa - b.masa);
              const openSessionTotal = openSessionDetails.reduce((sum, row) => sum + row.fee, 0);

          db.get(
            `SELECT COALESCE(SUM(total),0) AS total,
                    COALESCE(SUM(quantity),0) AS quantity,
                    COALESCE(SUM(CASE WHEN sale_type='DIRECT' AND COALESCE(external_source,'') NOT IN ('EVERYCAFE_DIRECT','EVERYCAFE_MEMBER','EVERYCAFE_OTHER') AND NOT ${LEGACY_EVERYCAFE_MEMBER_SQL} THEN total ELSE 0 END),0) AS all_time_direct_total,
                    COALESCE(SUM(CASE WHEN sale_type='DIRECT' AND COALESCE(external_source,'') NOT IN ('EVERYCAFE_DIRECT','EVERYCAFE_MEMBER','EVERYCAFE_OTHER') AND NOT ${LEGACY_EVERYCAFE_MEMBER_SQL} AND time>=? THEN total ELSE 0 END),0) AS month_direct_total,
                    COALESCE(SUM(CASE WHEN sale_type='DIRECT' AND COALESCE(external_source,'') NOT IN ('EVERYCAFE_DIRECT','EVERYCAFE_MEMBER','EVERYCAFE_OTHER') AND NOT ${LEGACY_EVERYCAFE_MEMBER_SQL} AND time>=? AND time<? THEN total ELSE 0 END),0) AS yesterday_direct_total,
                    COALESCE(SUM(CASE WHEN sale_type='DIRECT' AND external_source='EVERYCAFE_DIRECT' THEN total ELSE 0 END),0) AS all_time_everycafe_direct_total,
                    COALESCE(SUM(CASE WHEN sale_type='DIRECT' AND external_source='EVERYCAFE_DIRECT' AND time>=? THEN total ELSE 0 END),0) AS month_everycafe_direct_total,
                    COALESCE(SUM(CASE WHEN sale_type='DIRECT' AND external_source='EVERYCAFE_OTHER' THEN total ELSE 0 END),0) AS all_time_everycafe_other_total,
                    COALESCE(SUM(CASE WHEN sale_type='DIRECT' AND external_source='EVERYCAFE_OTHER' AND time>=? THEN total ELSE 0 END),0) AS month_everycafe_other_total
             FROM product_sales
             WHERE voided=0`,
            [monthStart, yesterdayStart, start, monthStart, monthStart],
            (allTimeErr, allTimeRow) => {
              if (allTimeErr) return res.json({ ok: false, error: String(allTimeErr) });
              res.json({
                ok: true,
                start,
                end,
                total,
                sessionTotal,
                todayQuantity,
                allTimeTotal: Number(allTimeRow && allTimeRow.total) || 0,
                allTimeQuantity: Number(allTimeRow && allTimeRow.quantity) || 0,
                directTotal,
                directCash,
                directCard,
                directCount,
                directQuantity,
                directLastHourTotal,
                everyCafeDirectTotal,
                everyCafeOtherTotal,
                everyCafeMemberTotal,
                yesterdayDirectTotal: Number(allTimeRow && allTimeRow.yesterday_direct_total) || 0,
                monthDirectTotal: Number(allTimeRow && allTimeRow.month_direct_total) || 0,
                allTimeDirectTotal: Number(allTimeRow && allTimeRow.all_time_direct_total) || 0,
                monthEveryCafeDirectTotal: Number(allTimeRow && allTimeRow.month_everycafe_direct_total) || 0,
                allTimeEveryCafeDirectTotal: Number(allTimeRow && allTimeRow.all_time_everycafe_direct_total) || 0,
                monthEveryCafeOtherTotal: Number(allTimeRow && allTimeRow.month_everycafe_other_total) || 0,
                allTimeEveryCafeOtherTotal: Number(allTimeRow && allTimeRow.all_time_everycafe_other_total) || 0,
                tableTotals,
                openSessionTotal,
                openSessionDetails,
                categoryTotals,
                list: list.slice(0, 100)
              });
            }
          );
            }
          );
        }
      );
        }
      );
    }
  );
});

app.get("/admin/product-sales/list", async (req, res) => {
  setNoStore(res);
  const now = Date.now();
  const todayStart = dayStartTs(now);
  const period = String(req.query.period || "today").toLowerCase();
  const rawDate = String(req.query.date || "");
  const rawMonth = String(req.query.month || "");
  // Satış geçmişi kullanıcıya takvim günüyle gösterilir; 20:00 kafe günü
  // sadece gelir raporlarında kullanılır. Böylece 12 Ağustos seçilince
  // 13 Ağustos öğleden sonraki satış yanlışlıkla listeye gelmez.
  const todayCalendarStart = new Date(now);
  todayCalendarStart.setHours(0, 0, 0, 0);
  let start = period === "yesterday"
    ? todayCalendarStart.getTime() - (24 * 60 * 60 * 1000)
    : todayCalendarStart.getTime();
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    const [year, month, day] = rawDate.split("-").map(Number);
    const selected = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    if (Number.isFinite(selected)) start = selected;
  }
  const end = start + (24 * 60 * 60 * 1000);
  let monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1, 0, 0, 0, 0).getTime();
  if (/^\d{4}-\d{2}$/.test(rawMonth)) {
    const [year, month] = rawMonth.split("-").map(Number);
    monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0).getTime();
  }
  const monthEndDate = new Date(monthStart);
  monthEndDate.setMonth(monthEndDate.getMonth() + 1);
  const monthEnd = monthEndDate.getTime();
  // v3.0.19: Karşılaştırma da geçmiş aktarım ile AYNI tam kaynak motorunu
  // kullanır. Böylece 200 kayıt limiti, bağımsız bilet/diğer Payments geliri
  // veya manuel eski üye kaydı yüzünden sahte fark oluşmaz.
  let historySource;
  try {
    historySource = await readEveryCafeHistorySource();
  } catch (sourceErr) {
    return res.json({ ok:false, error:`EveryCafe okunamadı: ${sourceErr.message||sourceErr}` });
  }
  const sourceSummaryFor = (rangeStart, rangeEnd) => summarizeEveryCafeHistorySource(historySource, rangeStart, rangeEnd);
  const sourceSessionTotalFor = (rangeStart, rangeEnd) => sourceSummaryFor(rangeStart, rangeEnd).sessionTotal;
  const sourceMemberTotalFor = (rangeStart, rangeEnd) => sourceSummaryFor(rangeStart, rangeEnd).memberTotal;
  const sourceOtherTotalFor = (rangeStart, rangeEnd) => sourceSummaryFor(rangeStart, rangeEnd).otherTotal;
  const sourceProductTotalFor = (rangeStart, rangeEnd) => sourceSummaryFor(rangeStart, rangeEnd).productTotal;
  const sourceProductQuantityFor = (rangeStart, rangeEnd) => sourceSummaryFor(rangeStart, rangeEnd).productQuantity;
  const sourceTotalFor = (rangeStart, rangeEnd) => sourceSummaryFor(rangeStart, rangeEnd).total;
  db.all(
    `SELECT id,time,masa,product_name,quantity,total,sale_type,payment_method,external_source,external_id
     FROM product_sales
     WHERE time>=? AND time<? AND voided=0
     ORDER BY time DESC,id DESC`,
    [start, end],
    (err, rows) => {
      if (err) return res.json({ ok: false, error: String(err) });
      db.get(
        `SELECT COALESCE(SUM(total_amount),0) AS total
         FROM payments
         WHERE voided=0
           AND ((source='EVERYCAFE' AND external_source='EVERYCAFE')
             OR (source='EVERYCAFE_DIRECT' AND external_source='EVERYCAFE_DIRECT'))
           AND created_at>=? AND created_at<?`,
        [start, end],
        (everyErr, everyRow) => {
          if (everyErr) return res.json({ ok: false, error: String(everyErr) });
          db.get(
            `SELECT
              COALESCE((SELECT SUM(fee) FROM session_history WHERE end_time>=? AND end_time<?),0)
              + COALESCE((SELECT SUM(total) FROM product_sales WHERE voided=0 AND sale_type='TABLE' AND status='FINALIZED' AND time>=? AND time<?),0)
              + COALESCE((SELECT SUM(total) FROM product_sales
                          WHERE voided=0 AND sale_type='DIRECT'
                            AND (external_source IN ('EVERYCAFE_MEMBER','EVERYCAFE_DIRECT','EVERYCAFE_OTHER') OR ${LEGACY_EVERYCAFE_MEMBER_SQL})
                            AND time>=? AND time<?),0)
              + COALESCE((SELECT SUM(total) FROM product_sales
                          WHERE voided=0 AND sale_type='HISTORY'
                            AND external_source IN ('EVERYCAFE_HISTORY','EVERYCAFE_HISTORY_MEMBER')
                            AND time>=? AND time<?),0)
              AS total`,
            [start, end, start, end, start, end, start, end],
            (kafePinErr, kafePinRow) => {
              if (kafePinErr) return res.json({ ok: false, error: String(kafePinErr) });
              const queryEveryCafeTotal = (rangeStart, rangeEnd, cb) => cb(null, { total: sourceTotalFor(rangeStart, rangeEnd) });
              const queryKafePinTotal = (rangeStart, rangeEnd, cb) => db.get(
                `SELECT COALESCE((SELECT SUM(fee) FROM session_history WHERE end_time>=? AND end_time<?),0)
                    + COALESCE((SELECT SUM(total) FROM product_sales WHERE voided=0 AND sale_type='TABLE' AND status='FINALIZED' AND time>=? AND time<?),0)
                    + COALESCE((SELECT SUM(total) FROM product_sales
                                WHERE voided=0 AND sale_type='DIRECT'
                                  AND (external_source IN ('EVERYCAFE_MEMBER','EVERYCAFE_DIRECT','EVERYCAFE_OTHER') OR ${LEGACY_EVERYCAFE_MEMBER_SQL})
                                  AND time>=? AND time<?),0)
                    + COALESCE((SELECT SUM(total) FROM product_sales
                                WHERE voided=0 AND sale_type='HISTORY'
                                  AND external_source IN ('EVERYCAFE_HISTORY','EVERYCAFE_HISTORY_MEMBER')
                                  AND time>=? AND time<?),0) AS total`,
                [rangeStart, rangeEnd, rangeStart, rangeEnd, rangeStart, rangeEnd, rangeStart, rangeEnd], cb);
              queryEveryCafeTotal(monthStart, monthEnd, (monthEveryErr, monthEveryRow) => {
                if (monthEveryErr) return res.json({ ok:false, error:String(monthEveryErr) });
                queryKafePinTotal(monthStart, monthEnd, (monthKafeErr, monthKafeRow) => {
                  if (monthKafeErr) return res.json({ ok:false, error:String(monthKafeErr) });
                  queryEveryCafeTotal(0, Number.MAX_SAFE_INTEGER, (allEveryErr, allEveryRow) => {
                    if (allEveryErr) return res.json({ ok:false, error:String(allEveryErr) });
                    queryKafePinTotal(0, Number.MAX_SAFE_INTEGER, (allKafeErr, allKafeRow) => {
                      if (allKafeErr) return res.json({ ok:false, error:String(allKafeErr) });
                      res.json({
                        ok: true, period, date: rawDate, month: rawMonth, start, end, list: rows || [],
                        everyCafeTotal: sourceTotalFor(start, end),
                        everyCafeSessionTotal: sourceSessionTotalFor(start, end),
                        everyCafeMemberTotal: sourceMemberTotalFor(start, end),
                        everyCafeOtherTotal: sourceOtherTotalFor(start, end),
                        everyCafeProductTotal: sourceProductTotalFor(start, end),
                        everyCafeProductQuantity: sourceProductQuantityFor(start, end),
                        kafePinEveryCafeProductTotal: Math.round((rows || []).filter((sale)=>["EVERYCAFE","EVERYCAFE_DIRECT"].includes(String(sale.external_source||"")) && (/^ORDER:/.test(String(sale.external_id||"")) || /^DIRECT_ORDER:/.test(String(sale.external_id||"")))).reduce((sum,sale)=>sum+(Number(sale.total)||0),0)*100)/100,
                        kafePinEveryCafeProductQuantity: (rows || []).filter((sale)=>["EVERYCAFE","EVERYCAFE_DIRECT"].includes(String(sale.external_source||"")) && (/^ORDER:/.test(String(sale.external_id||"")) || /^DIRECT_ORDER:/.test(String(sale.external_id||"")))).reduce((sum,sale)=>sum+(Number(sale.quantity)||0),0),
                        kafePinTableTotal: Number(kafePinRow && kafePinRow.total) || 0,
                        monthEveryCafeTotal: Number(monthEveryRow && monthEveryRow.total) || 0,
                        monthKafePinTableTotal: Number(monthKafeRow && monthKafeRow.total) || 0,
                        allTimeEveryCafeTotal: Number(allEveryRow && allEveryRow.total) || 0,
                        allTimeKafePinTableTotal: Number(allKafeRow && allKafeRow.total) || 0
                      });
                    });
                  });
                });
              });
            }
          );
        }
      );
    }
  );
});

app.get("/admin/payment-preview", (req, res) => {
  setNoStore(res);
  const masa = parseInt(req.query.masa, 10) || 0;
  if (masa < 1 || masa > MASA_SAYISI) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

  db.get(
    "SELECT * FROM sessions WHERE masa=? AND (end_time=0 OR end_time IS NULL)",
    [masa],
    (sessionErr, session) => {
      if (sessionErr) return res.json({ ok: false, error: String(sessionErr) });
      const now = Date.now();
      const sessionStart = Number(session && session.start_time) || 0;
      const sessionLastSeen = Number(session && session.last_seen) || now;
      const previewEnd = Math.min(now, sessionLastSeen + 15000);
      const baseFee = sessionStart && !isFreeMasa(masa)
        ? Math.max(feeAtTime(masa, sessionStart, previewEnd), 0)
        : 0;

      const loadProducts = (computerAmount) => {
        db.get(
          `SELECT COALESCE(SUM(total),0) AS total
           FROM product_sales
           WHERE masa=? AND sale_type='TABLE' AND status='OPEN' AND voided=0`,
          [masa],
          (productErr, productRow) => {
            if (productErr) return res.json({ ok: false, error: String(productErr) });
            const productAmount = Number(productRow && productRow.total) || 0;
            res.json({
              ok: true,
              masa,
              computerAmount,
              productAmount,
              total: Math.max(computerAmount + productAmount, 0)
            });
          }
        );
      };

      if (!sessionStart || isFreeMasa(masa)) return loadProducts(0);
      db.get(
        `SELECT COALESCE(SUM(amount),0) AS adj
         FROM real_adjustments
         WHERE masa=? AND session_start=?
           AND kind IN ('MANUAL_FEE_ADJUST','ZERO_FEE')`,
        [masa, sessionStart],
        (adjustErr, adjustRow) => {
          if (adjustErr) return res.json({ ok: false, error: String(adjustErr) });
          loadProducts(Math.max(baseFee + (Number(adjustRow && adjustRow.adj) || 0), 0));
        }
      );
    }
  );
});

app.get("/admin/payments/summary", (req, res) => {
  setNoStore(res);
  // Kasa/tahsilat, kullanıcının bankada gördüğü takvim gününü izler.
  // Gelir ve gün sonu raporları ayrı olarak 20:00 kafe günüyle devam eder.
  const currentDate = new Date();
  const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()).getTime();
  const end = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + 1).getTime();
  db.all(
    `SELECT * FROM payments
     WHERE voided=0
     ORDER BY id DESC`,
    (err, rows) => {
      if (err) return res.json({ ok: false, error: String(err) });
      const list = rows || [];
      getCardSettlementGroupsFromDb(list, Date.now(), (settlementErr, cardSettlements) => {
        if (settlementErr) return res.json({ ok: false, error: String(settlementErr) });
      const sumMethod = (source, method) => source
        .filter(row => row.method === method)
        .reduce((sum, row) => sum + (Number(row.total_amount) || 0), 0);
      const todayPaid = list.filter(row => {
        const paidTs = Number(row.paid_at) || Number(row.created_at) || 0;
        return row.method !== "PENDING" && paidTs >= start && paidTs < end;
      });
      const todayPendingRows = list.filter(row => {
        const createdTs = Number(row.created_at) || 0;
        return row.method === "PENDING" && createdTs >= start && createdTs < end;
      });
      const pending = list.filter(row => row.method === "PENDING");
      const todayCash = sumMethod(todayPaid, "CASH");
      const todayCard = sumMethod(todayPaid, "CARD");
      const todayPending = sumMethod(todayPendingRows, "PENDING");
      const todayCardCommission = Math.round(
        actualCardCommissionForRange(list, cardSettlements, start, end) * 100
      ) / 100;

      res.json({
        ok: true,
        start,
        end,
        todayCash,
        todayCard,
        todayPending,
        todayCardCommission,
        todayTotal: todayCash + todayCard + todayPending,
        allTimeCash: sumMethod(list, "CASH"),
        allTimeCard: sumMethod(list, "CARD"),
        allTimePending: sumMethod(list, "PENDING"),
        allTimeTotal: list.reduce((sum,row) => sum + (Number(row.total_amount) || 0), 0),
        pendingCount: pending.length,
        pending: pending.slice(0,100),
        recent: list.slice(0,100)
      });
      });
    }
  );
});

app.get("/admin/payments/reconciliation", (req, res) => {
  setNoStore(res);
  const auditStart = dayStartTs(Date.now()) - (6 * 24 * 60 * 60 * 1000);

  db.all(
    `SELECT * FROM payments
     WHERE voided=0 AND created_at>=?
     ORDER BY id DESC`,
    [auditStart],
    (paymentErr, paymentRows) => {
      if (paymentErr) return res.json({ ok: false, error: String(paymentErr) });
      db.all(
        `SELECT * FROM product_sales
         WHERE voided=0 AND time>=?
         ORDER BY id DESC`,
        [auditStart],
        (productErr, productRows) => {
          if (productErr) return res.json({ ok: false, error: String(productErr) });

          const payments = paymentRows || [];
          const sales = productRows || [];
          const issues = [];
          const moneyText = (value) => `${(Number(value) || 0).toFixed(2)} ₺`;
          const directPayments = new Map();
          const everyCafeDirectPayments = new Map();
          const sessionPayments = new Map();
          const everyCafePaymentsBySession = new Map();
          const everyCafePaymentsByEnd = new Map();

          payments.forEach((payment) => {
            const expected = (Number(payment.computer_amount) || 0) + (Number(payment.product_amount) || 0);
            const actual = Number(payment.total_amount) || 0;
            if (Math.abs(expected - actual) > 0.01) {
              issues.push({
                code: "PAYMENT_TOTAL",
                time: Number(payment.created_at) || 0,
                text: `Ödeme #${payment.id} toplamı uyuşmuyor: beklenen ${moneyText(expected)}, kayıt ${moneyText(actual)}`
              });
            }
            if (payment.source === "DIRECT_PRODUCT" && payment.product_sale_id) {
              directPayments.set(Number(payment.product_sale_id), payment);
            }
            if (payment.source === "EVERYCAFE_DIRECT" && payment.external_source === "EVERYCAFE_DIRECT") {
              everyCafeDirectPayments.set(String(payment.external_id || ""), payment);
            }
            if (payment.source === "SESSION") {
              sessionPayments.set(`${Number(payment.masa)}:${Number(payment.session_end)}`, payment);
            }
            if (payment.source === "EVERYCAFE" && Number(payment.masa) > 0) {
              everyCafePaymentsBySession.set(`${Number(payment.masa)}:${Number(payment.session_start)}:${Number(payment.session_end)}`, payment);
              everyCafePaymentsByEnd.set(`${Number(payment.masa)}:${Number(payment.session_end)}`, payment);
            }
          });

          sales.filter((sale) => sale.sale_type === "DIRECT").forEach((sale) => {
            const isEveryCafeManaged = String(sale.external_source || "").startsWith("EVERYCAFE") ||
              String(sale.category || "").toLocaleLowerCase("tr-TR").includes("everycafe doğrudan") ||
              String(sale.note || "").toLocaleLowerCase("tr-TR").includes("everycafe doğrudan");
            if (isEveryCafeManaged) {
              // EveryCafe doğrudan satışında tek tahsilat birden fazla ürün
              // satırını kapsayabilir. Buradaki ürün bazlı kasa denetimi yerine,
              // payment-audit SessionID üzerinden kaynak tahsilatını denetler.
              // Böylece doğru kayıt için sahte "ödeme yok" uyarısı oluşmaz.
              return;
            }
            const payment = directPayments.get(Number(sale.id));
            if (!payment) {
              const importedEveryCafePayment = payments.find((row) =>
                row.source === "EVERYCAFE_DIRECT" &&
                row.external_source === "EVERYCAFE_DIRECT" &&
                String(row.method) === String(sale.payment_method) &&
                Math.abs((Number(row.product_amount) || 0) - (Number(sale.total) || 0)) <= 0.01 &&
                Math.abs((Number(row.created_at) || 0) - (Number(sale.time) || 0)) <= 10 * 60 * 1000
              );
              if (importedEveryCafePayment) return;
              issues.push({ code: "DIRECT_MISSING", time: Number(sale.time) || 0, text: `${sale.product_name} doğrudan satışı için ödeme kaydı yok` });
              return;
            }
            if (Math.abs((Number(payment.product_amount) || 0) - (Number(sale.total) || 0)) > 0.01) {
              issues.push({ code: "DIRECT_AMOUNT", time: Number(sale.time) || 0, text: `${sale.product_name} satış tutarı ile ödeme tutarı uyuşmuyor` });
            }
            if (String(payment.method) !== String(sale.payment_method)) {
              issues.push({ code: "DIRECT_METHOD", time: Number(sale.time) || 0, text: `${sale.product_name} satışında nakit/kart kaydı uyuşmuyor` });
            }
          });

          const finalizedGroups = new Map();
          sales
            .filter((sale) => sale.sale_type === "TABLE" && sale.status === "FINALIZED" && Number(sale.finalized_at) > 0)
            .forEach((sale) => {
              const key = `${Number(sale.masa)}:${Number(sale.finalized_at)}`;
              const group = finalizedGroups.get(key) || { masa: Number(sale.masa), finalizedAt: Number(sale.finalized_at), total: 0, methods: new Set() };
              group.total += Number(sale.total) || 0;
              group.methods.add(String(sale.payment_method || "PENDING"));
              finalizedGroups.set(key, group);
            });

          finalizedGroups.forEach((group, key) => {
            const payment = sessionPayments.get(key) || everyCafePaymentsByEnd.get(key);
            if (!payment) {
              const everyCafePayment = everyCafePaymentsByEnd.get(key);
              issues.push({
                code: "SESSION_MISSING",
                time: group.finalizedAt,
                text: `Masa ${group.masa} kapanan ürün hesabı için ödeme kaydı yok`,
                everyCafePaymentId: everyCafePayment ? Number(everyCafePayment.id) : 0
              });
              return;
            }
            if (Math.abs((Number(payment.product_amount) || 0) - group.total) > 0.01) {
              issues.push({ code: "SESSION_PRODUCT_AMOUNT", time: group.finalizedAt, text: `Masa ${group.masa} ürün toplamı ile ödeme kaydı uyuşmuyor` });
            }
            if (group.methods.size !== 1 || !group.methods.has(String(payment.method))) {
              issues.push({ code: "SESSION_METHOD", time: group.finalizedAt, text: `Masa ${group.masa} ürünlerinde nakit/kart kaydı uyuşmuyor` });
            }
          });

          db.all(
            `SELECT sh.masa,sh.start_time,sh.end_time,sh.fee
             FROM session_history sh
             WHERE sh.end_time>=? AND sh.fee>0
               -- EveryCafe'in son kapanış kaydı ücretsiz/0 ise, eski yerel
               -- history satırı uyarı üretmez: kaynak sistem kesin doğrudur.
               AND NOT EXISTS (
                 SELECT 1 FROM everycafe_imports ei
                 WHERE ei.masa=sh.masa AND COALESCE(ei.total,0)=0
                   AND ABS(COALESCE(ei.source_end,0)-sh.end_time)<=120000
               )`,
            [auditStart],
            (historyErr, historyRows) => {
              if (historyErr) return res.json({ ok: false, error: String(historyErr) });
              const histories = historyRows || [];
              const sessionPaymentByExactKey = new Map();
              payments.filter(row => row.source === "SESSION").forEach(row => {
                sessionPaymentByExactKey.set(
                  `${Number(row.masa)}:${Number(row.session_start)}:${Number(row.session_end)}`,
                  row
                );
              });

              histories.forEach(history => {
                const key = `${Number(history.masa)}:${Number(history.start_time)}:${Number(history.end_time)}`;
                const payment = sessionPaymentByExactKey.get(key) || everyCafePaymentsBySession.get(key);
                const expected = Math.max(Number(history.fee) || 0, 0);
                if (!payment) {
                  const everyCafePayment = everyCafePaymentsBySession.get(key);
                  issues.push({
                    code: "SESSION_REVENUE_MISSING_PAYMENT",
                    time: Number(history.end_time) || 0,
                    text: `Masa ${history.masa} kapanış geliri ${moneyText(expected)} fakat buna ait ödeme kaydı yok`,
                    everyCafePaymentId: everyCafePayment ? Number(everyCafePayment.id) : 0
                  });
                  return;
                }
                const paidComputer = Number(payment.computer_amount) || 0;
                if (Math.abs(expected - paidComputer) > 0.01) {
                  issues.push({
                    code: "SESSION_REVENUE_AMOUNT",
                    time: Number(history.end_time) || 0,
                    text: `Masa ${history.masa} kapanış geliri ${moneyText(expected)}, ödeme kaydındaki masa geliri ${moneyText(paidComputer)}`
                  });
                }
              });

              const historyKeys = new Set(histories.map(row => `${Number(row.masa)}:${Number(row.start_time)}:${Number(row.end_time)}`));
              payments.filter(row => row.source === "SESSION" && (Number(row.computer_amount) || 0) > 0).forEach(payment => {
                const key = `${Number(payment.masa)}:${Number(payment.session_start)}:${Number(payment.session_end)}`;
                if (!historyKeys.has(key)) {
                  issues.push({
                    code: "PAYMENT_MISSING_SESSION_REVENUE",
                    time: Number(payment.created_at) || 0,
                    text: `Masa ${payment.masa} ödeme kaydında ${moneyText(payment.computer_amount)} masa geliri var fakat eşleşen kapanış kaydı yok`
                  });
                }
              });

              issues.sort((a, b) => b.time - a.time);
              res.json({
                ok: true,
                auditStart,
                checkedPayments: payments.length,
                checkedSales: sales.length,
                checkedSessions: histories.length,
                issueCount: issues.length,
                status: issues.length ? "PROBLEM" : "OK",
                issues: issues.slice(0, 50)
              });
            }
          );
        }
      );
    }
  );
});

// EveryCafe kendi raporunda görünmeyen istisnai bir kapanışı admin onayıyla
// KafePin'den kaldırır. Kaynak EveryCafe veritabanına hiçbir şey yazılmaz.
app.post("/admin/everycafe/void-import", (req, res) => {
  setNoStore(res);
  const paymentId = parseInt((req.body || {}).paymentId, 10) || 0;
  if (!paymentId) return res.json({ ok: false, error: "Geçersiz EveryCafe ödeme kaydı" });
  db.get(
    "SELECT * FROM payments WHERE id=? AND voided=0 AND source='EVERYCAFE' AND external_source='EVERYCAFE'",
    [paymentId],
    (selectErr, payment) => {
      if (selectErr) return res.json({ ok: false, error: String(selectErr) });
      if (!payment) return res.json({ ok: false, error: "EveryCafe aktarım kaydı bulunamadı veya zaten silinmiş" });
      const masa = Number(payment.masa) || 0;
      const sessionStart = Number(payment.session_start) || 0;
      const now = Date.now();
      db.serialize(() => {
        db.run("BEGIN IMMEDIATE", (beginErr) => {
          if (beginErr) return res.json({ ok: false, error: String(beginErr) });
        const fail = (err) => db.run("ROLLBACK", () => res.json({ ok: false, error: String(err) }));
        db.run("UPDATE payments SET voided=1,voided_at=? WHERE id=? AND voided=0", [now, paymentId], (paymentErr) => {
          if (paymentErr) return fail(paymentErr);
          db.run("UPDATE product_sales SET voided=1,voided_at=? WHERE external_source='EVERYCAFE' AND masa=? AND session_start=? AND voided=0", [now, masa, sessionStart], (productErr) => {
            if (productErr) return fail(productErr);
            db.run("DELETE FROM real_adjustments WHERE masa=? AND session_start=? AND kind='SESSION_FINALIZE'", [masa, sessionStart], (adjustErr) => {
              if (adjustErr) return fail(adjustErr);
              db.run("DELETE FROM session_history WHERE masa=? AND start_time=?", [masa, sessionStart], (historyErr) => {
                if (historyErr) return fail(historyErr);
                db.run("COMMIT", (commitErr) => {
                  if (commitErr) return fail(commitErr);
                  addLiveLog("everycafe_void", `↩️ EveryCafe uyumsuz aktarım silindi • Masa ${masa} • ${Number(payment.total_amount || 0).toFixed(2)} ₺`);
                  res.json({ ok: true, masa, removed: Number(payment.total_amount) || 0 });
                });
              });
            });
          });
        });
      
        });
      });
    }
  );
});

app.get("/admin/payments/daily-comparison", (req, res) => {
  setNoStore(res);
  const requestedDays = parseInt(req.query.days, 10) || 7;
  const days = Math.max(1, Math.min(requestedDays, 31));
  const dayMs = 24 * 60 * 60 * 1000;
  const currentStart = dayStartTs(Date.now());
  const rangeStart = currentStart - ((days - 1) * dayMs);
  const rangeEnd = currentStart + dayMs;
  const rowsByStart = new Map();

  for (let index = 0; index < days; index += 1) {
    const start = rangeStart + (index * dayMs);
    rowsByStart.set(start, {
      start,
      end: start + dayMs,
      dateLabel: new Date(start).toLocaleDateString("tr-TR", {
        timeZone: "Europe/Istanbul",
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
      }),
      productRevenue: 0,
      productQuantity: 0,
      cash: 0,
      card: 0,
      pending: 0,
      pendingCount: 0,
      collected: 0,
      totalPayments: 0
    });
  }

  db.all(
    `SELECT time, quantity, total
     FROM product_sales
     WHERE voided=0 AND time>=? AND time<?`,
    [rangeStart, rangeEnd],
    (productErr, productRows) => {
      if (productErr) return res.json({ ok: false, error: String(productErr) });
      (productRows || []).forEach((sale) => {
        const row = rowsByStart.get(dayStartTs(Number(sale.time) || 0));
        if (!row) return;
        row.productRevenue += Number(sale.total) || 0;
        row.productQuantity += Number(sale.quantity) || 0;
      });

      db.all(
        `SELECT created_at, paid_at, total_amount, method
         FROM payments
         WHERE voided=0 AND created_at>=? AND created_at<?`,
        [rangeStart, rangeEnd],
        (paymentErr, paymentRows) => {
          if (paymentErr) return res.json({ ok: false, error: String(paymentErr) });
          (paymentRows || []).forEach((payment) => {
            const accountingTs = payment.method === "PENDING"
              ? (Number(payment.created_at) || 0)
              : (Number(payment.paid_at) || Number(payment.created_at) || 0);
            const row = rowsByStart.get(dayStartTs(accountingTs));
            if (!row) return;
            const amount = Number(payment.total_amount) || 0;
            row.totalPayments += amount;
            if (payment.method === "CASH") row.cash += amount;
            else if (payment.method === "CARD") row.card += amount;
            else {
              row.pending += amount;
              row.pendingCount += 1;
            }
          });

          const rows = Array.from(rowsByStart.values())
            .map((row) => ({ ...row, collected: row.cash + row.card }))
            .sort((a, b) => b.start - a.start);
          res.json({ ok: true, days, rows });
        }
      );
    }
  );
});

app.post("/admin/accounting/add", (req, res) => {
  setNoStore(res);
  const body = req.body || {};
  const type = String(body.type || "").trim().toUpperCase();
  const account = String(body.account || "").trim().toUpperCase();
  const method = account === "CASH" ? "CASH" : "CARD";
  const category = String(body.category || "").trim().slice(0, 60);
  const note = String(body.note || "").trim().slice(0, 180);
  const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
  if (!['EXPENSE', 'CAPITAL_IN', 'CAPITAL_OUT'].includes(type)) {
    return res.json({ ok: false, error: "Geçersiz muhasebe kayıt türü" });
  }
  if (!['CASH', 'MAIN_BANK', 'POS_BANK', 'PERSONAL_CARD'].includes(account)) {
    return res.json({ ok: false, error: "Nakit Kasa, Ana Banka veya POS Bankası seç" });
  }
  if (account === 'PERSONAL_CARD' && type !== 'EXPENSE') {
    return res.json({ ok: false, error: "Kişisel Kart Borcu yalnızca gider kaydında kullanılır" });
  }
  if (amount <= 0) return res.json({ ok: false, error: "Tutar 0'dan büyük olmalı" });
  if (!category) return res.json({ ok: false, error: "Kategori yaz" });

  const now = Date.now();
  db.run(
    `INSERT INTO accounting_entries(time,type,category,amount,method,account,note,voided,voided_at)
     VALUES(?,?,?,?,?,?,?,0,0)`,
    [now, type, category, amount, method, account, note],
    function (err) {
      if (err) return res.json({ ok: false, error: String(err) });
      addLiveLog(
        "accounting_entry",
        `${type === 'EXPENSE' ? '🧾 Gider' : type === 'CAPITAL_IN' ? '💼 Sermaye girişi' : '🏦 Sermaye çekişi'} • ${category} • ${amount.toFixed(2)} ₺ • ${account === 'CASH' ? 'Nakit Kasa' : account === 'MAIN_BANK' ? 'Ana Banka' : account === 'POS_BANK' ? 'POS Bankası' : 'Kişisel Kart Borcu'}`
      );
      res.json({ ok: true, id: this.lastID, time: now });
    }
  );
});

app.post("/admin/accounting/void", (req, res) => {
  setNoStore(res);
  const id = parseInt((req.body || {}).id, 10) || 0;
  if (!id) return res.json({ ok: false, error: "Geçersiz kayıt" });
  db.run(
    "UPDATE accounting_entries SET voided=1,voided_at=? WHERE id=? AND voided=0",
    [Date.now(), id],
    function (err) {
      if (err) return res.json({ ok: false, error: String(err) });
      res.json({ ok: this.changes > 0 });
    }
  );
});

app.post("/admin/accounting/update", (req, res) => {
  setNoStore(res);
  const body = req.body || {};
  const id = parseInt(body.id, 10) || 0;
  const type = String(body.type || "").trim().toUpperCase();
  const account = String(body.account || "").trim().toUpperCase();
  const method = account === "CASH" ? "CASH" : "CARD";
  const category = String(body.category || "").trim().slice(0, 60);
  const note = String(body.note || "").trim().slice(0, 180);
  const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
  if (!id) return res.json({ ok: false, error: "Geçersiz kayıt" });
  if (!['EXPENSE', 'CAPITAL_IN', 'CAPITAL_OUT'].includes(type)) {
    return res.json({ ok: false, error: "Geçersiz muhasebe kayıt türü" });
  }
  if (!['CASH', 'MAIN_BANK', 'POS_BANK', 'PERSONAL_CARD'].includes(account)) {
    return res.json({ ok: false, error: "Geçersiz hesap" });
  }
  if (account === 'PERSONAL_CARD' && type !== 'EXPENSE') {
    return res.json({ ok: false, error: "Kişisel Kart Borcu yalnızca gider kaydında kullanılır" });
  }
  if (amount <= 0 || !category) return res.json({ ok: false, error: "Kategori ve geçerli tutar gir" });
  db.run(
    `UPDATE accounting_entries
     SET type=?,category=?,amount=?,method=?,account=?,note=?
     WHERE id=? AND voided=0`,
    [type, category, amount, method, account, note, id],
    function (err) {
      if (err) return res.json({ ok: false, error: String(err) });
      if (!this.changes) return res.json({ ok: false, error: "Kayıt bulunamadı" });
      addLiveLog("accounting_update", `✏️ Muhasebe kaydı #${id} düzenlendi • ${amount.toFixed(2)} ₺`);
      res.json({ ok: true, id });
    }
  );
});

// v3.1.31: Salt-okunur kasa sayım yardımcısı.
// Muhasebe formüllerini değiştirmez; son 7 gündeki nakit kasayı etkileyen kayıtları
// yalnızca olası fark araştırması için Admin'e döndürür.
app.get("/admin/cash-check/candidates", (req, res) => {
  setNoStore(res);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();

  db.all(
    `SELECT * FROM payments
     WHERE voided=0 AND method='CASH'
       AND COALESCE(NULLIF(paid_at,0),created_at)>=?
     ORDER BY id DESC`,
    [rangeStart],
    (paymentErr, paymentRows) => {
      if (paymentErr) return res.json({ ok:false, error:String(paymentErr) });
      db.all(
        `SELECT * FROM accounting_entries
         WHERE voided=0 AND time>=?
         ORDER BY id DESC`,
        [rangeStart],
        (entryErr, entryRows) => {
          if (entryErr) return res.json({ ok:false, error:String(entryErr) });
          db.all(
            `SELECT * FROM account_transfers
             WHERE voided=0 AND time>=? AND (from_account='CASH' OR to_account='CASH')
             ORDER BY id DESC`,
            [rangeStart],
            (transferErr, transferRows) => {
              if (transferErr) return res.json({ ok:false, error:String(transferErr) });
              const rows = [];
              (paymentRows || []).forEach(row => {
                const amount = Number(row.total_amount) || 0;
                const source = String(row.source || "");
                let label = Number(row.masa) > 0 ? `Masa ${Number(row.masa)} nakit tahsilat` : "Nakit tahsilat";
                if (source === "DIRECT_PRODUCT") label = "KafePin doğrudan satış • nakit";
                else if (source === "EVERYCAFE_DIRECT") label = "EveryCafe doğrudan satış • nakit";
                else if (source === "EVERYCAFE" && Number(row.masa) > 0) label = `EveryCafe Masa ${Number(row.masa)} • nakit`;
                rows.push({
                  kind:"PAYMENT",
                  id:Number(row.id)||0,
                  time:Number(row.paid_at)||Number(row.created_at)||0,
                  amount,
                  signedAmount:amount,
                  label
                });
              });
              (entryRows || []).forEach(row => {
                const account = String(row.account || "").trim() || (row.method === "CASH" ? "CASH" : "MAIN_BANK");
                if (account !== "CASH") return;
                const amount = Number(row.amount) || 0;
                let signedAmount = 0;
                let prefix = "Nakit muhasebe hareketi";
                if (row.type === "EXPENSE") { signedAmount = -amount; prefix = "Nakit gider"; }
                else if (row.type === "CAPITAL_IN") { signedAmount = amount; prefix = "Nakit bakiye girişi"; }
                else if (row.type === "CAPITAL_OUT") { signedAmount = -amount; prefix = "Nakit bakiye düşürme"; }
                else return;
                const detail = String(row.category || row.note || "").trim();
                rows.push({
                  kind:"ACCOUNTING",
                  id:Number(row.id)||0,
                  time:Number(row.time)||0,
                  amount,
                  signedAmount,
                  label:detail ? `${prefix} • ${detail}` : prefix
                });
              });
              const accountText = value => ({
                CASH:"Nakit Kasa",
                MAIN_BANK:"Ana Banka",
                POS_BANK:"POS Bankası",
                PERSONAL_CARD:"Şahsi Kart Borcu"
              }[String(value || "")] || String(value || "Hesap"));
              (transferRows || []).forEach(row => {
                const amount = Number(row.amount) || 0;
                const from = String(row.from_account || "");
                const to = String(row.to_account || "");
                const signedAmount = to === "CASH" ? amount : -amount;
                rows.push({
                  kind:"TRANSFER",
                  id:Number(row.id)||0,
                  time:Number(row.time)||0,
                  amount,
                  signedAmount,
                  label:`Virman • ${accountText(from)} → ${accountText(to)}`
                });
              });
              rows.sort((a,b) => (Number(b.time)||0) - (Number(a.time)||0));
              res.json({ ok:true, todayStart, rangeStart, rows:rows.slice(0,1000) });
            }
          );
        }
      );
    }
  );
});

app.get("/admin/accounting/summary", (req, res) => {
  setNoStore(res);
  const now = Date.now();
  const todayStart = dayStartTs(now);
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  const monthDate = new Date(now);
  monthDate.setDate(1);
  monthDate.setHours(20, 0, 0, 0);
  const monthStart = monthDate.getTime() > now
    ? new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1, 20, 0, 0, 0).getTime()
    : monthDate.getTime();

  db.all(
    "SELECT * FROM accounting_entries WHERE voided=0 ORDER BY id DESC",
    (entryErr, entryRows) => {
      if (entryErr) return res.json({ ok: false, error: String(entryErr) });
      db.all(
        "SELECT * FROM payments WHERE voided=0 ORDER BY id DESC",
        (paymentErr, paymentRows) => {
          if (paymentErr) return res.json({ ok: false, error: String(paymentErr) });
          getCardSettlementGroupsFromDb(paymentRows || [], now, (settlementErr, cardSettlements) => {
            if (settlementErr) return res.json({ ok: false, error: String(settlementErr) });
          db.all(
            "SELECT * FROM account_transfers WHERE voided=0 ORDER BY id DESC",
            (transferErr, transferRows) => {
          if (transferErr) return res.json({ ok: false, error: String(transferErr) });
          const entries = entryRows || [];
          const payments = paymentRows || [];
          const transfers = transferRows || [];
          const entryAccount = row => String(row.account || "").trim() || (row.method === "CASH" ? "CASH" : "MAIN_BANK");
          const sumEntries = (type, account, start = 0, end = Infinity) => entries
            .filter(row => row.type === type && (!account || entryAccount(row) === account) && Number(row.time) >= start && Number(row.time) < end)
            .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

          let cashReceipts = 0;
          let settledCardGross = 0;
          let settledCardNet = 0;
          let unsettledCardGross = 0;
          let unsettledCardNet = 0;
          let totalCardCommission = 0;
          let nextSettlementAt = 0;
          payments.forEach(payment => {
            const amount = Number(payment.total_amount) || 0;
            if (payment.method === "CASH") cashReceipts += amount;
          });
          cardSettlements.forEach(group => {
            totalCardCommission += Number(group.commission) || 0;
            if (group.settled) {
              settledCardGross += Number(group.gross) || 0;
              settledCardNet += group.confirmed
                ? (Number(group.actualNet) || 0)
                : (Number(group.expectedNet) || 0);
            } else {
              unsettledCardGross += Number(group.gross) || 0;
              unsettledCardNet += Number(group.expectedNet) || 0;
              if (!nextSettlementAt || group.settlementAt < nextSettlementAt) nextSettlementAt = group.settlementAt;
            }
          });

          const capitalCash = sumEntries("CAPITAL_IN", "CASH") - sumEntries("CAPITAL_OUT", "CASH");
          const capitalMainBank = sumEntries("CAPITAL_IN", "MAIN_BANK") - sumEntries("CAPITAL_OUT", "MAIN_BANK");
          const capitalPosBank = sumEntries("CAPITAL_IN", "POS_BANK") - sumEntries("CAPITAL_OUT", "POS_BANK");
          const cashExpenses = sumEntries("EXPENSE", "CASH");
          const mainBankExpenses = sumEntries("EXPENSE", "MAIN_BANK");
          const posBankExpenses = sumEntries("EXPENSE", "POS_BANK");
          const personalCardExpenses = sumEntries("EXPENSE", "PERSONAL_CARD");
          const transferBalance = account => transfers.reduce((sum, row) => {
            const amount = Number(row.amount) || 0;
            if (row.to_account === account) sum += amount;
            if (row.from_account === account) sum -= amount;
            return sum;
          }, 0);
          const cashTransfers = transferBalance("CASH");
          const mainBankTransfers = transferBalance("MAIN_BANK");
          const posBankTransfers = transferBalance("POS_BANK");
          const personalCardRepayments = transferBalance("PERSONAL_CARD");
          const personalCardDebt = Math.max(personalCardExpenses - personalCardRepayments, 0);

          const loadPeriods = () => {
            getRangeStats(todayStart, todayEnd, (todayErr, today) => {
              if (todayErr) return res.json({ ok: false, error: String(todayErr) });
              getRangeStats(monthStart, now + 1, (monthErr, month) => {
                if (monthErr) return res.json({ ok: false, error: String(monthErr) });
                getRangeStats(0, now + 1, (allErr, allTime) => {
                  if (allErr) return res.json({ ok: false, error: String(allErr) });
                  const applyActualCardCommission = (stats, start, end) => {
                    const commission = Math.round(
                      actualCardCommissionForRange(payments, cardSettlements, start, end) * 100
                    ) / 100;
                    stats.kartKomisyonu = commission;
                    stats.netIsletmeSonucu =
                      (Number(stats.genelGelir) || 0) -
                      (Number(stats.giderler) || 0) -
                      commission -
                      (Number(stats.spinMaliyeti) || 0);
                  };
                  applyActualCardCommission(today, todayStart, todayEnd);
                  applyActualCardCommission(month, monthStart, now + 1);
                  applyActualCardCommission(allTime, 0, now + 1);
                  res.json({
                    ok: true,
                    cardCommissionRate: CARD_COMMISSION_RATE,
                    cardSettlementDelayHours: CARD_SETTLEMENT_DELAY_MS / 3600000,
                    today,
                    month,
                    allTime,
                    balances: {
                      cash: capitalCash + cashReceipts - cashExpenses + cashTransfers,
                      mainBank: capitalMainBank - mainBankExpenses + mainBankTransfers,
                      posBank: capitalPosBank + settledCardNet - posBankExpenses + posBankTransfers,
                      personalCardDebt,
                      totalAssets:
                        capitalCash + cashReceipts - cashExpenses + cashTransfers +
                        capitalMainBank - mainBankExpenses + mainBankTransfers +
                        capitalPosBank + settledCardNet - posBankExpenses + posBankTransfers +
                        unsettledCardNet,
                      card: capitalMainBank + capitalPosBank + settledCardNet - mainBankExpenses - posBankExpenses,
                      capitalCash,
                      capitalMainBank,
                      capitalPosBank,
                      capitalCard: capitalMainBank + capitalPosBank,
                      cashReceipts,
                      settledCardGross,
                      settledCardNet,
                      unsettledCardGross,
                      unsettledCardNet,
                      totalCardCommission,
                      cashExpenses,
                      mainBankExpenses,
                      posBankExpenses,
                      personalCardExpenses,
                      personalCardRepayments,
                      cashTransfers,
                      mainBankTransfers,
                      posBankTransfers,
                      cardExpenses: mainBankExpenses + posBankExpenses,
                      nextSettlementAt
                    },
                    recent: entries.slice(0, 100),
                    recentTransfers: transfers.slice(0, 100),
                    cardSettlements
                  });
                });
              });
            });
          };
          loadPeriods();
            }
          );
          });
        }
      );
    }
  );
});

app.post("/admin/card-settlements/confirm", (req, res) => {
  setNoStore(res);
  const body = req.body || {};
  const key = String(body.settlementKey || "").trim();
  const actualNet = Math.round((Number(body.actualNet) || 0) * 100) / 100;
  const note = String(body.note || "").trim().slice(0, 160);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return res.json({ ok: false, error: "Geçersiz kart grubu" });
  }
  if (actualNet <= 0) return res.json({ ok: false, error: "Bankaya geçen net tutarı gir" });

  db.all("SELECT * FROM payments WHERE voided=0 AND method='CARD'", (paymentErr, paymentRows) => {
    if (paymentErr) return res.json({ ok: false, error: String(paymentErr) });
    getCardSettlementGroupsFromDb(paymentRows || [], Date.now(), (groupErr, groups) => {
      if (groupErr) return res.json({ ok: false, error: String(groupErr) });
      const group = (groups || []).find((item) => item.key === key);
      if (!group) return res.json({ ok: false, error: "Kart grubu bulunamadı" });
      if (actualNet > Number(group.gross) + 0.001) {
        return res.json({ ok: false, error: "Net tutar kart toplamından büyük olamaz" });
      }
      const confirmedAt = Date.now();
      db.run(
        `INSERT INTO card_settlements(settlement_key,actual_net,confirmed_at,note)
         VALUES(?,?,?,?)
         ON CONFLICT(settlement_key) DO UPDATE SET
           actual_net=excluded.actual_net, confirmed_at=excluded.confirmed_at, note=excluded.note`,
        [key, actualNet, confirmedAt, note],
        (saveErr) => {
          if (saveErr) return res.json({ ok: false, error: String(saveErr) });
          const commission = Math.max(Number(group.gross) - actualNet, 0);
          addLiveLog("card_settlement_confirmed", `🏦 Kart yatırımı doğrulandı • ${key} • Net ${actualNet.toFixed(2)} ₺ • Komisyon ${commission.toFixed(2)} ₺`);
          res.json({ ok: true, key, gross: group.gross, actualNet, commission, confirmedAt });
        }
      );
    });
  });
});

app.post("/admin/card-settlements/clear", (req, res) => {
  setNoStore(res);
  const key = String((req.body || {}).settlementKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return res.json({ ok: false, error: "Geçersiz kart grubu" });
  db.run("DELETE FROM card_settlements WHERE settlement_key=?", [key], (err) => {
    if (err) return res.json({ ok: false, error: String(err) });
    addLiveLog("card_settlement_cleared", `🏦 Kart yatırımı doğrulaması kaldırıldı • ${key}`);
    res.json({ ok: true });
  });
});

function getLiquidAccountBalances(cb) {
  db.all("SELECT * FROM accounting_entries WHERE voided=0", (entryErr, entryRows) => {
    if (entryErr) return cb(entryErr);
    db.all("SELECT * FROM payments WHERE voided=0", (paymentErr, paymentRows) => {
      if (paymentErr) return cb(paymentErr);
      getCardSettlementGroupsFromDb(paymentRows || [], Date.now(), (settlementErr, cardSettlements) => {
        if (settlementErr) return cb(settlementErr);
      db.all("SELECT * FROM account_transfers WHERE voided=0", (transferErr, transferRows) => {
        if (transferErr) return cb(transferErr);
        const entries = entryRows || [];
        const payments = paymentRows || [];
        const transfers = transferRows || [];
        const entryAccount = row => String(row.account || "").trim() || (row.method === "CASH" ? "CASH" : "MAIN_BANK");
        const entryEffect = account => entries.reduce((sum, row) => {
          if (entryAccount(row) !== account) return sum;
          const value = Number(row.amount) || 0;
          if (row.type === "CAPITAL_IN") return sum + value;
          if (row.type === "CAPITAL_OUT" || row.type === "EXPENSE") return sum - value;
          return sum;
        }, 0);
        const transferEffect = account => transfers.reduce((sum, row) => {
          const value = Number(row.amount) || 0;
          if (row.to_account === account) sum += value;
          if (row.from_account === account) sum -= value;
          return sum;
        }, 0);
        let cashReceipts = 0;
        let settledCardNet = 0;
        const now = Date.now();
        payments.forEach(row => {
          const value = Number(row.total_amount) || 0;
          if (row.method === "CASH") cashReceipts += value;
        });
        cardSettlements.forEach(group => {
          if (group.settled) {
            settledCardNet += group.confirmed
              ? (Number(group.actualNet) || 0)
              : (Number(group.expectedNet) || 0);
          }
        });
        cb(null, {
          CASH: entryEffect("CASH") + transferEffect("CASH") + cashReceipts,
          MAIN_BANK: entryEffect("MAIN_BANK") + transferEffect("MAIN_BANK"),
          POS_BANK: entryEffect("POS_BANK") + transferEffect("POS_BANK") + settledCardNet,
          PERSONAL_CARD: Math.max(-(entryEffect("PERSONAL_CARD") + transferEffect("PERSONAL_CARD")), 0)
        });
      });
      });
    });
  });
}

app.post("/admin/accounting/transfer", (req, res) => {
  setNoStore(res);
  const body = req.body || {};
  const fromAccount = String(body.fromAccount || "").trim().toUpperCase();
  const toAccount = String(body.toAccount || "").trim().toUpperCase();
  const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
  const note = String(body.note || "").trim().slice(0, 180);
  const liquidAccounts = ["CASH", "MAIN_BANK", "POS_BANK"];
  const targetAccounts = [...liquidAccounts, "PERSONAL_CARD"];
  if (!liquidAccounts.includes(fromAccount) || !targetAccounts.includes(toAccount)) return res.json({ ok: false, error: "Geçerli kaynak ve hedef hesap seç" });
  if (fromAccount === toAccount) return res.json({ ok: false, error: "Kaynak ve hedef hesap aynı olamaz" });
  if (amount <= 0) return res.json({ ok: false, error: "Tutar 0'dan büyük olmalı" });
  getLiquidAccountBalances((balanceErr, balances) => {
    if (balanceErr) return res.json({ ok: false, error: String(balanceErr) });
    const available = Math.round((Number(balances[fromAccount]) || 0) * 100) / 100;
    if (amount > available + 0.001) {
      const accountName = fromAccount === "CASH" ? "Nakit Kasa" : fromAccount === "MAIN_BANK" ? "Ana Banka" : "POS Bankası";
      return res.json({ ok: false, code: "INSUFFICIENT_BALANCE", available, error: `${accountName} bakiyesi yetersiz. Kullanılabilir: ${available.toFixed(2)} ₺` });
    }
    if (toAccount === "PERSONAL_CARD" && amount > (Number(balances.PERSONAL_CARD) || 0) + 0.001) {
      return res.json({ ok: false, error: `Kişisel kart borcu yetersiz. Kapatılabilecek: ${(Number(balances.PERSONAL_CARD) || 0).toFixed(2)} ₺` });
    }
    const now = Date.now();
    db.run(
      `INSERT INTO account_transfers(time,from_account,to_account,amount,note,voided,voided_at) VALUES(?,?,?,?,?,0,0)`,
      [now, fromAccount, toAccount, amount, note],
      function (err) {
        if (err) return res.json({ ok: false, error: String(err) });
        addLiveLog("account_transfer", `🔁 Virman • ${amount.toFixed(2)} ₺ • ${fromAccount} → ${toAccount}`);
        res.json({ ok: true, id: this.lastID, time: now, remaining: available - amount });
      }
    );
  });
});

app.post("/admin/accounting/transfer-void", (req, res) => {
  setNoStore(res);
  const id = parseInt((req.body || {}).id, 10) || 0;
  if (!id) return res.json({ ok: false, error: "Geçersiz virman kaydı" });
  db.run(
    "UPDATE account_transfers SET voided=1,voided_at=? WHERE id=? AND voided=0",
    [Date.now(), id],
    function (err) {
      if (err) return res.json({ ok: false, error: String(err) });
      res.json({ ok: true, changed: this.changes || 0 });
    }
  );
});

app.get("/admin/preferences/collapsed-sections", (req, res) => {
  setNoStore(res);
  db.get(
    "SELECT pref_value FROM admin_preferences WHERE pref_key='collapsed_sections'",
    (err, row) => {
      if (err) return res.json({ ok: false, error: String(err) });
      let sections = [];
      try {
        const parsed = JSON.parse((row && row.pref_value) || "[]");
        if (Array.isArray(parsed)) sections = parsed.map(String).slice(0, 100);
      } catch (_err) {}
      res.json({ ok: true, saved: Boolean(row), sections });
    }
  );
});

function backupFileStamp(now = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function cleanupOldFullBackups(keep = 30) {
  const resolvedDir = path.resolve(FULL_BACKUP_DIR);
  const expectedDir = path.resolve(FULL_BACKUP_DIR);
  if (resolvedDir.toUpperCase() !== expectedDir.toUpperCase()) {
    throw new Error("Yedek temizleme klasörü güvenlik kontrolünden geçmedi");
  }
  const files = fs.readdirSync(resolvedDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^KafePin_.*\.zip$/i.test(entry.name))
    .map(entry => {
      const fullPath = path.join(resolvedDir, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const remove = files.slice(Math.max(1, Number(keep) || 30));
  remove.forEach(item => fs.unlinkSync(item.fullPath));
  return remove.length;
}

function createFullProjectBackup(cb) {
  if (fullBackupRunning) return cb(new Error("Yedekleme zaten devam ediyor"));
  fullBackupRunning = true;
  const startedAt = Date.now();
  let tempDir = "";
  let finished = false;
  const finish = (err, result) => {
    if (finished) return;
    finished = true;
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_err) {}
    }
    fullBackupRunning = false;
    if (err) {
      lastFullBackup = { ok: false, time: Date.now(), error: String(err.message || err) };
      return cb(err);
    }
    lastFullBackup = { ok: true, ...result };
    cb(null, result);
  };

  try {
    fs.mkdirSync(FULL_BACKUP_DIR, { recursive: true });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kafepin-full-backup-"));
  } catch (err) {
    return finish(err);
  }

  const snapshotDir = path.join(tempDir, "snapshots");
  const stageDir = path.join(tempDir, "archive-stage");
  try {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.mkdirSync(stageDir, { recursive: true });
  } catch (err) {
    return finish(err);
  }

  // v3.0.47: FULL ZIP yalniz KafePin'e aittir. EveryCafe kendi yedegini
  // kendi sisteminde alir; KafePin bu akista ecmdata.ecm dosyasini okumaz,
  // kopyalamaz, dogrulamaz ve EveryCafe kaynakli bir hata yedegi durduramaz.
  const snapshotDb = path.join(snapshotDir, "database.db");
  createVerifiedKafePinSnapshot(snapshotDb, (snapshotErr) => {
    if (snapshotErr) return finish(snapshotErr);

    // v3.1.23: snapshot bu fonksiyona gelmeden once SQLite header + quick_check +
    // KafePin tablo yapisindan zaten gecmistir. Stage kopyasini ikinci/ucuncu kez
    // quick_check ile taramak yerine son ZIP icinden hedefli database.db cikarilip
    // ayni guclu dogrulama bir kez daha yapilir.
    try {
      const sourceRoot = path.resolve(__dirname);
      const excludedRootFiles = new Set([
        "database.db", "database.db-wal", "database.db-shm", ".kafepin-pro-window"
      ]);
      fs.cpSync(sourceRoot, stageDir, {
        recursive: true,
        force: true,
        errorOnExist: false,
        filter: (srcPath) => {
          const rel = path.relative(sourceRoot, srcPath);
          if (!rel) return true;
          if (!rel.includes(path.sep) && excludedRootFiles.has(rel)) return false;
          return true;
        }
      });
      // Canli database dosyasi ASLA arsivlenmez. SQLite'in tutarli snapshot'i
      // her zaman stage kokune database.db adiyla yerlestirilir.
      fs.copyFileSync(snapshotDb, path.join(stageDir, "database.db"));
    } catch (stageErr) {
      return finish(new Error(`FULL ZIP staging basarisiz: ${stageErr.message || stageErr}`));
    }

    const backupStem = `KafePin_${backupFileStamp()}`;
    let fileName = `${backupStem}.zip`;
    let zipPath = path.join(FULL_BACKUP_DIR, fileName);
    for (let suffix = 1; fs.existsSync(zipPath); suffix++) {
      fileName = `${backupStem}_${String(suffix).padStart(2, "0")}.zip`;
      zipPath = path.join(FULL_BACKUP_DIR, fileName);
    }

    const completeArchive = (err) => {
      if (err) return finish(err);
      // Arsiv GERCEK geri yukleme yoluyla test edilir. v3.1.23 hizli yolda
      // arsivin tamamini acmak yerine yalniz database.db cikarilir; eski ZIP'ler
      // hedefli cikarma uygun degilse otomatik olarak tam tarama fallback'ine duser.
      verifyFullBackupArchive(zipPath, (verifyErr, verifyInfo) => {
        if (verifyErr) {
          try { fs.unlinkSync(zipPath); } catch (_err) {}
          return finish(new Error(`FULL ZIP geri-yukleme testi basarisiz: ${verifyErr.message || verifyErr}`));
        }
        try {
          const stat = fs.statSync(zipPath);
          let cleanedCount = 0;
          try { cleanedCount = cleanupOldFullBackups(30); } catch (cleanupErr) { logErr("full backup cleanup", cleanupErr); }
          addLiveLog("full_backup", `💾 Tam yedek alındı ve hedefli DB doğrulaması geçti • yalnız KafePin • ${fileName} • ${(stat.size / 1048576).toFixed(2)} MB`);
          finish(null, {
            time: Date.now(), startedAt, fileName, path: zipPath, size: stat.size,
            scope: "KAFEPIN_ONLY", cleanedCount, durationMs: Date.now() - startedAt,
            verified: true, restoreTested: true,
            verifyMode: verifyInfo && verifyInfo.fastPath ? "targeted_db" : "legacy_full_scan",
            databaseSize: Number(verifyInfo && verifyInfo.size) || 0
          });
        } catch (statErr) {
          finish(statErr);
        }
      });
    };

    if (process.platform === "win32") {
      const archive = spawn("tar.exe", ["-a", "-cf", zipPath, "-C", stageDir, "."], {
        windowsHide: true, stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      archive.stderr.on("data", chunk => { stderr += String(chunk || "").slice(0, 4000); });
      archive.on("error", completeArchive);
      archive.on("close", code => completeArchive(code === 0 ? null : new Error(stderr.trim() || `ZIP oluşturulamadı (kod ${code})`)));
      return;
    }

    const zip = spawn("zip", ["-q", "-r", zipPath, "."], { cwd: stageDir, stdio: ["ignore", "ignore", "pipe"] });
    let zipErr = "";
    zip.stderr.on("data", c => { zipErr += String(c || ""); });
    zip.on("error", completeArchive);
    zip.on("close", code => completeArchive(code === 0 ? null : new Error(zipErr.trim() || `ZIP oluşturulamadı (${code})`)));
  });

}

app.get("/admin/backup/status", (req, res) => {
  setNoStore(res);
  let last = lastFullBackup;
  if (!last && !fullBackupRunning) {
    try {
      const latest = fs.readdirSync(FULL_BACKUP_DIR, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
        .map(entry => {
          const fullPath = path.join(FULL_BACKUP_DIR, entry.name);
          const stat = fs.statSync(fullPath);
          return { ok: true, time: stat.mtimeMs, fileName: entry.name, path: fullPath, size: stat.size, existing: true };
        })
        .sort((a, b) => b.time - a.time)[0];
      if (latest) last = latest;
    } catch (_err) {}
  }
  res.json({ ok: true, running: fullBackupRunning, destination: FULL_BACKUP_DIR, last });
});

app.post("/admin/backup/full", (req, res) => {
  setNoStore(res);
  if (fullBackupRunning) return res.status(409).json({ ok: false, running: true, error: "Yedekleme zaten devam ediyor" });
  addLiveLog("full_backup", "💾 Tam yedekleme başlatıldı • yalnız KafePin");
  createFullProjectBackup((err, result) => {
    if (err) {
      addLiveLog("full_backup", `⚠️ Tam yedekleme basarisiz: ${String(err.message || err).slice(0, 180)}`);
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
    res.json({ ok: true, ...result });
  });
});

app.post("/admin/preferences/collapsed-sections", (req, res) => {
  setNoStore(res);
  const raw = Array.isArray((req.body || {}).sections) ? req.body.sections : [];
  const sections = [...new Set(raw.map(value => String(value || "").trim()).filter(Boolean))].slice(0, 100);
  const value = JSON.stringify(sections);
  db.run(
    `INSERT INTO admin_preferences(pref_key,pref_value,updated_at) VALUES('collapsed_sections',?,?)
     ON CONFLICT(pref_key) DO UPDATE SET pref_value=excluded.pref_value,updated_at=excluded.updated_at`,
    [value, Date.now()],
    function (err) {
      if (err) return res.json({ ok: false, error: String(err) });
      res.json({ ok: true, sections });
    }
  );
});

app.post("/admin/payments/set-method", (req, res) => {
  setNoStore(res);
  const id = parseInt((req.body || {}).id, 10) || 0;
  const method = normalizePaymentMethod((req.body || {}).method, "");
  if (!id || !["CASH", "CARD"].includes(method)) {
    return res.json({ ok: false, error: "Nakit veya Kart seç" });
  }

  db.get("SELECT * FROM payments WHERE id=? AND voided=0", [id], (selectErr, payment) => {
    if (selectErr) return res.json({ ok: false, error: String(selectErr) });
    if (!payment) return res.json({ ok: false, error: "Ödeme bulunamadı" });
    db.run(
      "UPDATE payments SET method=?,paid_at=? WHERE id=? AND voided=0",
      [method, Date.now(), id],
      (err) => {
        if (err) return res.json({ ok: false, error: String(err) });
        if (payment.source === "SESSION") {
          db.run(
            `UPDATE product_sales SET payment_method=?
             WHERE masa=? AND finalized_at=? AND voided=0`,
            [method, payment.masa, payment.session_end],
            (productErr) => logErr("set payment method product_sales", productErr)
          );
        } else if (payment.source === "DIRECT_PRODUCT" && payment.product_sale_id) {
          db.run(
            `UPDATE product_sales SET payment_method=?
             WHERE id=? AND voided=0`,
            [method, payment.product_sale_id],
            (productErr) => logErr("set direct payment method product_sales", productErr)
          );
        }
        addLiveLog(
          "payment_method",
          `💳 Masa ${payment.masa || "-"} ödeme ${method === "CASH" ? "NAKİT" : "KART"} yapıldı • ${Number(payment.total_amount).toFixed(2)} ₺`
        );
        res.json({ ok: true, id, method });
      }
    );
  });
});

app.get("/admin/free-masalar", (req, res) => {
  setNoStore(res);
  res.json({ ok: true, list: Array.from(freeMasalar) });
});

app.post("/admin/free-masa", (req, res) => {
  setNoStore(res);

  const masa = parseInt((req.body || {}).masa, 10);
  const enabled = (req.body || {}).enabled ? 1 : 0;

  if (!masa || masa < 1 || masa > MASA_SAYISI) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

  const now = Date.now();

  const saveFreeState = () => {
    db.run(
      "INSERT INTO free_masalar(masa,enabled,set_time) VALUES(?,?,?) ON CONFLICT(masa) DO UPDATE SET enabled=excluded.enabled, set_time=excluded.set_time",
      [masa, enabled, now],
      (err) => {
        if (err) return res.json({ ok: false, error: String(err) });

        if (enabled === 1) {
          freeMasalar.add(masa);
          addLiveLog("free_on", `🟢 Masa ${masa} ücretsiz yapıldı`);
        } else {
          freeMasalar.delete(masa);
          addLiveLog("free_off", `🟠 Masa ${masa} ücretsiz kaldırıldı`);
        }

        return res.json({ ok: true, masa, enabled: enabled === 1 });
      }
    );
  };

  // Ücretli aktif oturumu, masa FREE olarak işaretlenmeden önce kapat.
  if (enabled === 1 && !isFreeMasa(masa)) {
    return db.get("SELECT * FROM sessions WHERE masa=?", [masa], (selectErr, row) => {
      if (selectErr) {
        return res.json({ ok: false, error: String(selectErr) });
      }

      if (row && (!row.end_time || row.end_time === 0)) {
        return finalizeEndedSessionToAdjustments(
          { ...row, end_time: now },
          now,
          (finalizeErr) => {
            if (finalizeErr) {
              return res.json({ ok: false, error: String(finalizeErr) });
            }
            return saveFreeState();
          }
        );
      }

      return saveFreeState();
    });
  }

  return saveFreeState();
});

app.post("/admin/fee-zero", (req, res) => {
  setNoStore(res);

  const masa = parseInt((req.body || {}).masa, 10);
  if (!masa || masa < 1 || masa > MASA_SAYISI) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

  if (isFreeMasa(masa)) {
    return res.json({ ok: true, masa, amount: 0, msg: "Masa FREE, zaten 0₺." });
  }

  const now = Date.now();
  const dk = dayKey(now);

  db.get("SELECT * FROM sessions WHERE masa=?", [masa], (eS, s) => {
    let fee = 0;

    if (s) {
      const end = s.end_time && s.end_time > 0 ? s.end_time : s.last_seen || now;
fee =
  s.end_time && s.end_time > 0
    ? Number(s.final_fee) || feeAtTime(masa, s.start_time || end, end)
    : feeAtTime(masa, s.start_time || end, end);
    }

    const sessStart = s && s.start_time ? s.start_time : 0;

    db.get(
      "SELECT COALESCE(SUM(amount),0) AS adj FROM real_adjustments WHERE day_key=? AND masa=? AND session_start=? AND kind IN ('MANUAL_FEE_ADJUST','ZERO_FEE')",
      [dk, masa, sessStart],
      (eA, rA) => {
        const adj = Number((rA || {}).adj) || 0;
        const feeAdj = Math.max(fee + adj, 0);

        if (feeAdj <= 0) {
          return res.json({ ok: true, masa, amount: 0, msg: "Zaten 0₺." });
        }

        const amount = -feeAdj;
        const note = `Masa ${masa} ücret 0 yapıldı`;

        db.run(
          "INSERT INTO real_adjustments(time, day_key, masa, amount, kind, note, session_start) VALUES(?,?,?,?,?,?,?)",
          [now, dk, masa, amount, "ZERO_FEE", note, sessStart],
          function (err) {
            if (err) return res.json({ ok: false, error: String(err) });
            return res.json({ ok: true, masa, amount });
          }
        );
      }
    );
  });
});

app.post("/admin/session-reset", (req, res) => {
  setNoStore(res);
  return requireEveryCafeMaintenance(res, () => {

  const masa = parseInt((req.body || {}).masa, 10);
  if (!masa || masa < 1 || masa > MASA_SAYISI) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

  autoApprovePendingRewardsForMasa(masa, "session reseti", (approveErr) => {
    if (approveErr) {
      return res.json({
        ok: false,
        error: "Bekleyen ödül otomatik onaylanamadı: " + String(approveErr)
      });
    }

    const now = Date.now();

    db.get("SELECT * FROM sessions WHERE masa=?", [masa], (e1, row) => {
      if (e1) return res.json({ ok: false, error: String(e1) });

const nextStep = () => {
  clearForceNewSession(masa, () => {
    db.run("DELETE FROM masalar WHERE masa=?", [masa], (err) => {

      logErr("/admin/reset-masa delete masalar", err);

      if (!err) {
        addLiveLog(
          "reset",
          `🔄 Masa ${masa} sıfırlandı`
        );
      }

      return res.json({ ok: true, masa });
    });
  });
};

      if (row && (!row.end_time || row.end_time === 0)) {
        return finalizeEndedSessionToAdjustments({ ...row, end_time: now }, now, (err) => {
          if (err) return res.json({ ok: false, error: String(err) });
          nextStep();
        });
      }

      return nextStep();
    });
  });
  });
});

app.post("/admin/hard-reset-masa", (req, res) => {
  setNoStore(res);
  return requireEveryCafeMaintenance(res, () => {

  const masa = parseInt((req.body || {}).masa, 10);
  if (!masa || masa < 1 || masa > MASA_SAYISI) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

  autoApprovePendingRewardsForMasa(
    masa,
    "tam temizleme",
    (approveErr, approvedRewards) => {
      if (approveErr) {
        return res.json({
          ok: false,
          error:
            "Bekleyen ödül otomatik onaylanamadığı için tam temizleme durduruldu: " +
            String(approveErr)
        });
      }

  db.serialize(() => {
    db.run("BEGIN IMMEDIATE TRANSACTION", (e0) => {
      if (e0) return res.json({ ok: false, error: String(e0) });

      db.run("DELETE FROM masalar WHERE masa=?", [masa], (e1) => {
        if (e1) {
          db.run("ROLLBACK");
          return res.json({ ok: false, error: String(e1) });
        }

        db.run("DELETE FROM sessions WHERE masa=?", [masa], (e2) => {
          if (e2) {
            db.run("ROLLBACK");
            return res.json({ ok: false, error: String(e2) });
          }

          db.run("DELETE FROM session_locks WHERE masa=?", [masa], (e3) => {
            if (e3) {
              db.run("ROLLBACK");
              return res.json({ ok: false, error: String(e3) });
            }

            db.run("DELETE FROM force_new_sessions WHERE masa=?", [masa], (e4) => {
              if (e4) {
                db.run("ROLLBACK");
                return res.json({ ok: false, error: String(e4) });
              }

              db.run("DELETE FROM spins WHERE masa=?", [masa], (e5) => {
                if (e5) {
                  db.run("ROLLBACK");
                  return res.json({ ok: false, error: String(e5) });
                }

                db.run(
                  `UPDATE product_sales
                   SET voided=1, voided_at=?
                   WHERE masa=? AND sale_type='TABLE' AND status='OPEN' AND voided=0`,
                  [Date.now(), masa],
                  (productVoidErr) => {
                    if (productVoidErr) {
                      db.run("ROLLBACK");
                      return res.json({ ok: false, error: String(productVoidErr) });
                    }

                    // RAM temizliği
                    delete aktifMasalar[masa];
                    delete masaPingStats[masa];
                    delete latestRewardMap[masa];
                    offlineCount[masa] = 0;
                    lastOfflineState[masa] = false;
                    delete masaCloseLocks[masa];
                    sessionLocks.delete(masa);
                    blockedMasalar.delete(masa);
                    delete tokenTracker[masa];

                    db.run("DELETE FROM blocked_masalar WHERE masa=?", [masa], (e6) => {
                      if (e6) {
                        db.run("ROLLBACK");
                        return res.json({ ok: false, error: String(e6) });
                      }

                      db.run("COMMIT", (e7) => {
                        if (e7) {
                          db.run("ROLLBACK");
                          return res.json({ ok: false, error: String(e7) });
                        }

                        return res.json({
                          ok: true,
                          masa,
                          msg: "Masa tamamen temizlendi; açık ürün hesabı iptal edildi",
                          autoApprovedRewards: (approvedRewards || []).map((x) => ({
                            reward: x.reward,
                            costApplied: x.costApplied
                          }))
                        });
                      });
                    });
                  }
                );
              });
            });
          });
        });
      });
    });
  });
    }
  );
  });
});

function closePrepare(masa, res, paymentMethod) {
  autoApprovePendingRewardsForMasa(masa, "masa kapanışı", (approveErr, approvedRewards) => {
    if (approveErr) {
      return res.json({
        ok: false,
        error: "Bekleyen ödül otomatik onaylanamadı: " + String(approveErr)
      });
    }

    const now = Date.now();

    setLock(masa, now + LOCK_MS);

    finalizeAndPrepareSession(masa, now, (err, _closed, paymentInfo) => {
      if (err) {
        return res.json({ ok: false, error: String(err) });
      }

      const sendSuccess = () => res.json({
          ok: true,
          masa,
          lockedMs: LOCK_MS,
          freeModeRemoved: !isFreeMasa(masa),
          payment: paymentInfo || null,
          autoApprovedRewards: (approvedRewards || []).map((x) => ({
            reward: x.reward,
            costApplied: x.costApplied
          }))
        });

      // Ücretsiz test masasında YENİ MÜŞTERİ denirse ayrıca Kapat'a basmak
      // gerekmesin: temizlik tamamlandıktan sonra ücretsiz işaretini de kaldır.
      if (!isFreeMasa(masa)) return sendSuccess();

      db.run(
        "UPDATE free_masalar SET enabled=0, set_time=? WHERE masa=?",
        [Date.now(), masa],
        (disableErr) => {
          if (disableErr) {
            logErr("new customer disable free masa", disableErr);
            return res.json({ ok: false, error: String(disableErr) });
          }

          freeMasalar.delete(masa);
          addLiveLog(
            "free_new_customer_close",
            `🔵 Masa ${masa} yeni müşteri işlemiyle ücretsiz moddan çıkarıldı`
          );
          return sendSuccess();
        }
      );
    }, {
      paymentMethod: normalizePaymentMethod(paymentMethod, "PENDING"),
      closeReason: "NEW_CUSTOMER"
    });
  });
}


app.post("/admin/new-customer", (req, res) => {
  setNoStore(res);
  return requireEveryCafeMaintenance(res, () => {
  const masa = parseInt((req.body || {}).masa, 10);
  if (!masa || masa < 1 || masa > MASA_SAYISI) return res.json({ ok: false, error: "Geçersiz masa" });
  const paymentMethod = normalizePaymentMethod((req.body || {}).paymentMethod, "PENDING");
  closePrepare(masa, res, paymentMethod);
  });
});

app.get("/admin/sessions", (req, res) => {
  setNoStore(res);

  const now = Date.now();
  const dk = dayKey(now);

  db.all("SELECT * FROM sessions", (err, rows) => {
    if (err) {
      logErr("/admin/sessions select sessions", err);
      return res.json([]);
    }

    const map = {};
    (rows || []).forEach((r) => (map[r.masa] = r));

    db.all(
      `
      SELECT masa, session_start, COALESCE(SUM(amount),0) as adj
      FROM real_adjustments
      WHERE day_key=?
        AND kind IN ('MANUAL_FEE_ADJUST','ZERO_FEE')
      GROUP BY masa, session_start
      `,
      [dk],
      (eAdj, adjRows) => {
        if (eAdj) {
          logErr("/admin/sessions select adjustments", eAdj);
          return res.json([]);
        }

const adjMap = {};

(adjRows || []).forEach((r) => {
  adjMap[`${r.masa}:${r.session_start}`] = Number(r.adj) || 0;
});

        const out = [];

        for (let masa = 1; masa <= MASA_SAYISI; masa++) {
          if (isFreeMasa(masa)) {
            const lastSeen = aktifMasalar[masa] || 0;
            const online = !isActuallyOffline(masa, lastSeen, now);

            out.push({
              masa,
              online,
              started: false,
              minutes: 0,
              fee: 0,
              free: 1,
              adj: 0,
              feeAdj: 0,
              zeroed: 0,
              start_time: 0,
              last_seen: lastSeen || 0,
              end_time: 0,
              final_fee: 0
            });
            continue;
          }

          const s = map[masa];

          if (!s) {
            const lastSeen = aktifMasalar[masa] || 0;
            const online = !isActuallyOffline(masa, lastSeen, now);

            out.push({
              masa,
              online,
              started: online ? 1 : 0,
              minutes: 0,
              fee: 0,
              free: 0,
              adj: 0,
              feeAdj: 0,
              zeroed: 0,
              start_time: online ? lastSeen : 0,
              last_seen: lastSeen || 0,
              end_time: 0,
              final_fee: 0
            });
            continue;
          }

          let online = false;
          if (!s.end_time || s.end_time === 0) {
const ls = aktifMasalar[masa] || 0;
online = !isActuallyOffline(masa, ls, now);
          }

          const end =
            s.end_time && s.end_time > 0
              ? s.end_time
              : s.last_seen || now;

          let minutes = Math.floor((end - (s.start_time || end)) / 60000);
          if (minutes < 0) minutes = 0;

        const fee =
  s.end_time && s.end_time > 0
    ? Number(s.final_fee) || feeAtTime(masa, s.start_time || end, end)
    : feeAtTime(masa, s.start_time || end, end);

          const sessStart = s && s.start_time ? s.start_time : 0;
          const adj = adjMap[`${masa}:${sessStart}`] || 0;
          const feeAdj = Math.max(fee + adj, 0);

          const zeroed = feeAdj === 0 && adj < 0 ? 1 : 0;

          out.push({
            masa,
            online,
            started: true,
            start_time: s.start_time || aktifMasalar[masa] || 0,
            last_seen: s.last_seen || aktifMasalar[masa] || 0,
            end_time: s.end_time || 0,
            minutes,
            fee,
            free: 0,
            adj,
            feeAdj,
            zeroed,
            final_fee: Number(s.final_fee) || 0
          });
        }

        return res.json(out);
      }
    );
  });
});

app.get("/admin/stats", (req, res) => {
  setNoStore(res);

  const now = Date.now();
  const todayKeyStr = dayKey(now);
  const todayStart = dayStartTs(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
const d = new Date(now);

const monthStart = new Date(
  d.getFullYear(),
  d.getMonth(),
  1
).getTime();

  db.all("SELECT * FROM spins_log", (err, rows) => {
    if (err) {
      logErr("/admin/stats spins_log", err);
      return res.status(500).json({ ok: false });
    }
    if (!rows) rows = [];

    let toplam = rows.length;
    let bugunToplam = 0;
    let bugunOnaylananOdul = 0;
    let icecek = 0;
    let dakika = 0;
    let vipSpin = 0;
    let normalSpin = 0;
    let toplamMaliyet = 0;
    let bugunMaliyet = 0;
    let gelir = 0;
    let bugunGelir = 0;

    rows.forEach((s) => {
      const reward = (s.reward || "").toLowerCase();
      const isToday = dayKey(s.time) === todayKeyStr;
      const pricing = getPricingForTs(s.masa, s.time || now);

      if (isToday) bugunToplam++;
      if (
        isToday &&
        Number(s.used) === 1 &&
        !BOS_ODULLER.includes(String(s.reward || "").trim().toLocaleLowerCase("tr-TR"))
      ) {
        bugunOnaylananOdul++;
      }

      if (pricing.isVip) vipSpin++;
      else normalSpin++;

      gelir += pricing.opening;
if (isToday) bugunGelir += pricing.opening;


if (reward.includes("dakika")) {
  dakika++;
}

      if (
        reward.includes("kola") ||
        reward.includes("çay") ||
        reward.includes("soda") ||
        reward.includes("crax") ||
        reward.includes("gofret") ||
        reward.includes("enerji") ||
        reward.includes("anahtarlık") ||
        reward.includes("anahtarlik")
      ) {
        icecek++;
      }
    });

    let kar = gelir;
    let bugunKar = bugunGelir;

    db.all("SELECT * FROM sessions", (err2, sessions) => {
      if (err2) {
        logErr("/admin/stats sessions", err2);
        return res.status(500).json({ ok: false });
      }
      if (!sessions) sessions = [];

      const activeSessions = (sessions || []).filter((s) => !s.end_time || s.end_time === 0);

      const liveRealBrutGelir = sumRealRevenueInRangeFromSessions(activeSessions, 0, now, now);
      const liveBugunRealBrutGelir = sumRealRevenueInRangeFromSessions(activeSessions, todayStart, now, now);
      const liveDunRealBrutGelir = sumRealRevenueInRangeFromSessions(activeSessions, yesterdayStart, todayStart, now);
      const liveHaftaRealBrutGelir = sumRealRevenueInRangeFromSessions(activeSessions, weekStart, now, now);
      const liveAyRealBrutGelir = sumRealRevenueInRangeFromSessions(activeSessions, monthStart, now, now);

      db.all("SELECT time, amount, kind, masa, session_start, note FROM real_adjustments", (eAdj, adjRows) => {
        if (eAdj) {
          logErr("/admin/stats real_adjustments", eAdj);
          return res.status(500).json({ ok: false });
        }

        adjRows = adjRows || [];

        const finalizedSessionTotal = sumFinalizedRevenueInRange(adjRows, 0, Infinity);
        const finalizedSessionToday = sumFinalizedRevenueInRange(adjRows, todayStart, now);
        const finalizedSessionYesterday = sumFinalizedRevenueInRange(adjRows, yesterdayStart, todayStart);
        const finalizedSessionWeek = sumFinalizedRevenueInRange(adjRows, weekStart, now);
        const finalizedSessionMonth = sumFinalizedRevenueInRange(adjRows, monthStart, now);

        let feeAdjustTotal = 0;
        let feeAdjustToday = 0;
        let feeAdjustYesterday = 0;
        let feeAdjustWeek = 0;
        let feeAdjustMonth = 0;

        let spinCostTotal = 0;
        let spinCostToday = 0;
        let spinCostYesterday = 0;
        let spinCostWeek = 0;
        let spinCostMonth = 0;

        (adjRows || []).forEach((a) => {
          const t =
  a.time ||
  a.session_start ||
  0;

const tt = Number(t) || 0;
          const amt = Number(a.amount) || 0;
          const kind = String(a.kind || "");

if (kind === "SESSION_FINALIZE") {
  return;
}

 if (kind === "MANUAL_FEE_ADJUST" || kind === "ZERO_FEE") {

  feeAdjustTotal += amt;

  if (tt >= todayStart)
    feeAdjustToday += amt;

  if (tt >= yesterdayStart && tt < todayStart)
    feeAdjustYesterday += amt;

  if (tt >= weekStart && tt < now)
    feeAdjustWeek += amt;

  if (tt >= monthStart && tt < now)
    feeAdjustMonth += amt;

  return;
}

if (
  String(kind).trim() === "SPIN_TIME_COST" ||
  String(kind).trim() === "SPIN_ITEM_COST"
) {

  const shownCost = spinAdjustmentCost(a);

  spinCostTotal += shownCost;

  if (tt >= todayStart)
    spinCostToday += shownCost;

  if (tt >= yesterdayStart && tt < todayStart)
    spinCostYesterday += shownCost;

  if (tt >= weekStart && tt < now)
    spinCostWeek += shownCost;

  if (tt >= monthStart && tt < now)
    spinCostMonth += shownCost;

  return;
}
        });

        const brutGelir = liveRealBrutGelir + finalizedSessionTotal;
        const bugunBrutGelir = liveBugunRealBrutGelir + finalizedSessionToday;
        const dunBrutGelir = liveDunRealBrutGelir + finalizedSessionYesterday;
        const haftaBrutGelir = liveHaftaRealBrutGelir + finalizedSessionWeek;
        const ayBrutGelir = liveAyRealBrutGelir + finalizedSessionMonth;

        const adminDuzeltmeleri = feeAdjustTotal;
        const bugunAdminDuzeltmeleri = feeAdjustToday;
        const dunAdminDuzeltmeleri = feeAdjustYesterday;
        const haftaAdminDuzeltmeleri = feeAdjustWeek;
        const ayAdminDuzeltmeleri = feeAdjustMonth;

        const spinMaliyeti = spinCostTotal;
        const bugunSpinMaliyeti = spinCostToday;
        const dunSpinMaliyeti = spinCostYesterday;
        const haftaSpinMaliyeti = spinCostWeek;
        const aySpinMaliyeti = spinCostMonth;

toplamMaliyet = spinMaliyeti;
bugunMaliyet = bugunSpinMaliyeti;
kar = gelir - toplamMaliyet;
bugunKar = bugunGelir - bugunMaliyet;

const gercekGelir =
  brutGelir +
  adminDuzeltmeleri;

const bugunGercekGelir =
  bugunBrutGelir +
  bugunAdminDuzeltmeleri;

const dunGercekGelir =
  dunBrutGelir +
  dunAdminDuzeltmeleri;

const haftaGercekGelir =
  haftaBrutGelir +
  haftaAdminDuzeltmeleri;

const ayGercekGelir =
  ayBrutGelir +
  ayAdminDuzeltmeleri;

        return res.json({
          toplam,
          bugunToplam,
          bugunOnaylananOdul,
          icecek,
          dakika,
          vipSpin,
          normalSpin,
          toplamMaliyet,
          bugunMaliyet,
          gelir,
          bugunGelir,
          kar,
          bugunKar,

          brutGelir,
          bugunBrutGelir,
          dunBrutGelir,
          haftaBrutGelir,
          ayBrutGelir,

          adminDuzeltmeleri,
          bugunAdminDuzeltmeleri,
          dunAdminDuzeltmeleri,
          haftaAdminDuzeltmeleri,
          ayAdminDuzeltmeleri,

          spinMaliyeti,
          bugunSpinMaliyeti,
          dunSpinMaliyeti,
          haftaSpinMaliyeti,
          aySpinMaliyeti,

          gercekGelir,
          bugunGercekGelir,
          dunGercekGelir,
          haftaGercekGelir,
          ayGercekGelir,

          realBrutGelir: brutGelir,
          bugunRealBrutGelir: bugunBrutGelir,
          dunRealBrutGelir: dunBrutGelir,
          haftaRealBrutGelir: haftaBrutGelir,
          ayRealBrutGelir: ayBrutGelir,

          realGelir: gercekGelir,
          bugunRealGelir: bugunGercekGelir,
          dunRealGelir: dunGercekGelir,
          haftaRealGelir: haftaGercekGelir,
          ayRealGelir: ayGercekGelir,

          spinCostTotal: spinMaliyeti,
          spinCostToday: bugunSpinMaliyeti,
          spinCostYesterday: dunSpinMaliyeti,
          spinCostWeek: haftaSpinMaliyeti,
          spinCostMonth: aySpinMaliyeti,

          cafeDayStart: todayStart,
          spinSure: 45,

          globalSpinCount,
          buyukOdulHedefNormal: BUYUK_ODUL_HEDEF,
          buyukOdulHedefVip: BUYUK_ODUL_HEDEF_VIP,
          buyukOdulHedefMin: Math.min(BUYUK_ODUL_HEDEF, BUYUK_ODUL_HEDEF_VIP),
          ucretBlokToleransDakika: 2,
          manualFeeAdjustment: true
        });
      });
    });
  });
});
app.get("/admin/monthly-report", (req, res) => {
  setNoStore(res);
  const rawMonth = String(req.query.month || "").trim();
  const match = rawMonth.match(/^(\d{4})-(\d{2})$/);
  const now = Date.now();
  const current = new Date(now);
  const year = match ? Number(match[1]) : current.getFullYear();
  const monthIndex = match ? Number(match[2]) - 1 : current.getMonth();
  if (!Number.isInteger(year) || monthIndex < 0 || monthIndex > 11) {
    return res.status(400).json({ ok: false, error: "Geçerli ay seç" });
  }

  // Kafe günü 20:00-20:00 çalıştığı için aylık aralık da aynı sınırla hesaplanır.
  const startTs = new Date(year, monthIndex, 1, 20, 0, 0, 0).getTime();
  const nextMonthStartTs = new Date(year, monthIndex + 1, 1, 20, 0, 0, 0).getTime();
  const endTs = Math.min(nextMonthStartTs, now + 1);
  if (startTs > now) {
    return res.json({ ok: true, month: rawMonth, startTs, endTs: startTs, stats: null, future: true });
  }

  getRangeStats(startTs, endTs, (statsErr, stats) => {
    if (statsErr) return res.status(500).json({ ok: false, error: String(statsErr) });
    db.all("SELECT * FROM payments WHERE voided=0 ORDER BY id DESC", (paymentErr, payments) => {
      if (paymentErr) return res.status(500).json({ ok: false, error: String(paymentErr) });
      getCardSettlementGroupsFromDb(payments || [], now, (settlementErr, groups) => {
        if (settlementErr) return res.status(500).json({ ok: false, error: String(settlementErr) });
        const actualCommission = Math.round(
          actualCardCommissionForRange(payments || [], groups || [], startTs, endTs) * 100
        ) / 100;
        const normalized = {
          ...stats,
          kartKomisyonu: actualCommission,
          netIsletmeSonucu:
            (Number(stats.genelGelir) || 0) -
            (Number(stats.giderler) || 0) -
            actualCommission -
            (Number(stats.spinMaliyeti) || 0)
        };
        res.json({
          ok: true,
          month: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
          startTs,
          endTs,
          partial: endTs < nextMonthStartTs,
          stats: normalized
        });
      });
    });
  });
});

app.get("/admin/yearly-report", (req, res) => {
  setNoStore(res);
  const rawYear = String(req.query.year || "").trim();
  const year = Number(rawYear || new Date().getFullYear());
  const now = Date.now();
  const currentYear = new Date(now).getFullYear();
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return res.status(400).json({ ok: false, error: "Geçerli yıl seç" });
  }
  const startTs = new Date(year, 0, 1, 20, 0, 0, 0).getTime();
  const nextYearStartTs = new Date(year + 1, 0, 1, 20, 0, 0, 0).getTime();
  const endTs = Math.min(nextYearStartTs, now + 1);
  if (startTs > now) {
    return res.json({ ok: true, year, startTs, endTs: startTs, stats: null, future: true });
  }

  getRangeStats(startTs, endTs, (statsErr, stats) => {
    if (statsErr) return res.status(500).json({ ok: false, error: String(statsErr) });
    db.all("SELECT * FROM payments WHERE voided=0 ORDER BY id DESC", (paymentErr, payments) => {
      if (paymentErr) return res.status(500).json({ ok: false, error: String(paymentErr) });
      getCardSettlementGroupsFromDb(payments || [], now, (settlementErr, groups) => {
        if (settlementErr) return res.status(500).json({ ok: false, error: String(settlementErr) });
        const actualCommission = Math.round(
          actualCardCommissionForRange(payments || [], groups || [], startTs, endTs) * 100
        ) / 100;
        res.json({
          ok: true,
          year,
          startTs,
          endTs,
          partial: year === currentYear && endTs < nextYearStartTs,
          stats: {
            ...stats,
            kartKomisyonu: actualCommission,
            netIsletmeSonucu:
              (Number(stats.genelGelir) || 0) -
              (Number(stats.giderler) || 0) -
              actualCommission -
              (Number(stats.spinMaliyeti) || 0)
          }
        });
      });
    });
  });
});

app.get("/admin/financial-range-report", (req, res) => {
  setNoStore(res);
  const parseDate = (value) => {
    const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(year, month, day, 0, 0, 0, 0);
    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
  };
  const startDate = parseDate(req.query.start);
  const endDate = parseDate(req.query.end || req.query.start);
  if (!startDate || !endDate || endDate.getTime() < startDate.getTime()) {
    return res.status(400).json({ ok: false, error: "Geçerli başlangıç ve bitiş tarihi seç" });
  }
  const startTs = startDate.getTime();
  // Mali rapor takvim gününe göre 00:00 - sonraki gün 00:00 hesaplanır.
  const endTs = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1, 0, 0, 0, 0).getTime();
  const now = Date.now();
  const effectiveEndTs = Math.min(endTs, now + 1);
  if (startTs > now) return res.json({ ok: true, startTs, endTs: startTs, stats: null, future: true });

  getRangeStats(startTs, effectiveEndTs, (statsErr, stats) => {
    if (statsErr) return res.status(500).json({ ok: false, error: String(statsErr) });
    db.all("SELECT * FROM payments WHERE voided=0 ORDER BY id DESC", (paymentErr, payments) => {
      if (paymentErr) return res.status(500).json({ ok: false, error: String(paymentErr) });
      getCardSettlementGroupsFromDb(payments || [], now, (settlementErr, groups) => {
        if (settlementErr) return res.status(500).json({ ok: false, error: String(settlementErr) });
        const actualCommission = Math.round(
          actualCardCommissionForRange(payments || [], groups || [], startTs, effectiveEndTs) * 100
        ) / 100;
        db.get(
          `SELECT
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(category,'')) LIKE '%teknik%' THEN total ELSE 0 END),0) AS technical_total,
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(category,'')) LIKE '%teknik%' THEN 0 ELSE total END),0) AS food_drink_total
           FROM product_sales
           WHERE voided=0 AND time>=? AND time<?`,
          [startTs, effectiveEndTs],
          (vatErr, vatRow) => {
            if (vatErr) return res.status(500).json({ ok: false, error: String(vatErr) });
            const gross20 = (Number(stats.gercekGelir) || 0) + (Number(vatRow && vatRow.technical_total) || 0);
            const gross10 = Number(vatRow && vatRow.food_drink_total) || 0;
            const splitVat = (gross, rate) => {
              const base = Math.round((gross / (1 + rate)) * 100) / 100;
              return { matrah: base, kdv: Math.round((gross - base) * 100) / 100, toplam: Math.round(gross * 100) / 100 };
            };
            const vat20 = splitVat(gross20, 0.20);
            const vat10 = splitVat(gross10, 0.10);
            res.json({
              ok: true,
              startTs,
              endTs: effectiveEndTs,
              partial: effectiveEndTs < endTs,
              startLabel: String(req.query.start),
              endLabel: String(req.query.end || req.query.start),
              vat: {
                rate20: vat20,
                rate10: vat10,
                toplamKdv: Math.round((vat20.kdv + vat10.kdv) * 100) / 100,
                toplamMatrah: Math.round((vat20.matrah + vat10.matrah) * 100) / 100
              },
              stats: {
                ...stats,
                kartKomisyonu: actualCommission,
                netIsletmeSonucu:
                  (Number(stats.genelGelir) || 0) -
                  (Number(stats.giderler) || 0) -
                  actualCommission -
                  (Number(stats.spinMaliyeti) || 0)
              }
            });
          }
        );
      });
    });
  });
});

app.get("/admin/daily-report", (req, res) => {
  setNoStore(res);

  db.get(
    `
    SELECT *
    FROM daily_reports
    ORDER BY report_ts DESC
    LIMIT 1
    `,
    (err, row) => {

      if (err) {
        logErr("/admin/daily-report", err);
        return res.status(500).json({ error: "db" });
      }

      return res.json(row || {});
    }
  );
});
app.get("/admin/live-log", (req, res) => {
  res.json({
    ok: true,
    startedAt: PRO_SERVER_STARTED_AT,
    list: liveLogs
  });
});
// v3.1.26: Yönetim Merkezi'nden manuel restart başlamadan hemen önce
// mevcut Node oturumunun Canlı Sistem Günlüğü belleğini gerçekten temizle.
// Böylece restart handoff yavaşlasa bile eski oturum satırları arayüzde veya
// aynı Node belleğinde yeniden görünmez; yeni Node zaten boş liveLogs ile açılır.
app.post("/admin/live-log/reset-session", (req, res) => {
  liveLogs.length = 0;
  res.json({
    ok: true,
    startedAt: PRO_SERVER_STARTED_AT,
    clearedAt: Date.now()
  });
});
app.get("/admin/diagnostics", (req, res) => {

  db.get(
    "SELECT COUNT(*) AS count FROM sessions WHERE end_time=0",
    (err, row) => {

      if (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }

      res.json({
        ok: true,

        ramSessions: Object.keys(aktifMasalar).length,
        ramPingStats: Object.keys(masaPingStats).length,

        dbSessions: row.count,

        cleanupCount: diagnostics.cleanupCount,
        finalizeCount: diagnostics.finalizeCount,
        offlineCloseCount: diagnostics.offlineCloseCount,

        lastCleanup: diagnostics.lastCleanup,
        lastFinalize: diagnostics.lastFinalize,
        lastPing: diagnostics.lastPing,

        lastCleanupMasa: diagnostics.lastCleanupMasa,
        lastFinalizeMasa: diagnostics.lastFinalizeMasa
      });

    }
  );

});

app.post("/admin/reset-masa", (req, res) => {
  setNoStore(res);

  const masa = parseInt((req.body || {}).masa, 10);
  if (!masa || masa < 1 || masa > MASA_SAYISI) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

  autoApprovePendingRewardsForMasa(masa, "masa sıfırlama", (approveErr) => {
    if (approveErr) {
      return res.json({
        ok: false,
        error: "Bekleyen ödül otomatik onaylanamadı: " + String(approveErr)
      });
    }

    const now = Date.now();

    db.get("SELECT * FROM sessions WHERE masa=?", [masa], (e0, row) => {
      const continueReset = () => {
        db.run("DELETE FROM masalar WHERE masa=?", [masa], (e1) => {
          logErr("/admin/reset-masa delete masalar", e1);

          const todayStart = dayStartTs(Date.now());
          db.run("DELETE FROM spins WHERE masa=? AND time>=?", [masa, todayStart], (e2) => {
            logErr("/admin/reset-masa delete spins", e2);
            res.json({ ok: true, masa });
          });
        });
      };

      if (!e0 && row && (!row.end_time || row.end_time === 0)) {
        return finalizeEndedSessionToAdjustments({ ...row, end_time: now }, now, (err) => {
          if (err) return res.json({ ok: false, error: String(err) });
          continueReset();
        });
      }

      continueReset();
    });
  });
});
app.post("/admin/transfer-session", async (req, res) => {
  setNoStore(res);

  const from = parseInt(req.body?.from, 10);
  const to = parseInt(req.body?.to, 10);

  if (
    !from || !to ||
    from < 1 || from > MASA_SAYISI ||
    to < 1 || to > MASA_SAYISI
  ) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

  if (from === to) {
    return res.json({ ok: false, error: "Aynı masa olamaz" });
  }

  if (isFreeMasa(from) || isFreeMasa(to)) {
    return res.json({
      ok: false,
      error: "FREE masa ile oturum transferi yapılamaz"
    });
  }

  const dbRunAsync = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ changes: this.changes || 0, lastID: this.lastID });
      });
    });

  const dbGetAsync = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });

  const unlockTransfer = () => {
    sessionLocks.delete(from);
    sessionLocks.delete(to);
    db.run(
      "DELETE FROM session_locks WHERE masa IN (?,?)",
      [from, to],
      (err) => logErr("transfer unlock", err)
    );
  };

  // Transfer sırasında iki bilgisayardan gelebilecek ping/spin isteklerini durdur.
  setLock(from, Date.now() + LOCK_MS);
  setLock(to, Date.now() + LOCK_MS);

  let transactionStarted = false;

  try {
    await dbRunAsync("BEGIN IMMEDIATE TRANSACTION");
    transactionStarted = true;

    // Kontroller transaction içinde tekrar yapılıyor; böylece kontrol ile
    // taşıma arasında hedefte yeni session açılması engelleniyor.
    const source = await dbGetAsync(
      "SELECT * FROM sessions WHERE masa=? AND (end_time=0 OR end_time IS NULL)",
      [from]
    );

    if (!source) {
      throw new Error("Kaynak masada aktif oturum bulunamadı");
    }

    const target = await dbGetAsync(
      "SELECT masa FROM sessions WHERE masa=?",
      [to]
    );

    if (target) {
      throw new Error("Hedef masada oturum var; önce hedef masayı sıfırlayın");
    }

    const sessionUpdate = await dbRunAsync(
      "UPDATE sessions SET masa=? WHERE masa=? AND start_time=?",
      [to, from, source.start_time]
    );

    if (sessionUpdate.changes !== 1) {
      throw new Error("Oturum taşınamadı");
    }

    // Müşteri masa değiştiriyorsa çark hakkı da müşteriyi takip eder.
    // Kaynakta index hiç açılmadıysa `masalar` satırı yoktur ve hedefte de
    // yeni sayaç başlamaz. Varsa kalan süre/hazır hak aynen taşınır.
    await dbRunAsync("DELETE FROM masalar WHERE masa=?", [to]);
    await dbRunAsync(
      "UPDATE masalar SET masa=? WHERE masa=?",
      [to, from]
    );

    // Yalnızca henüz onaylanmamış ödüller müşteriyi takip eder.
    // Kullanılmış ve geçmiş spin kayıtlarının masa numarası değiştirilmez.
    await dbRunAsync(
      "UPDATE spins SET masa=? WHERE masa=? AND used=0",
      [to, from]
    );
    await dbRunAsync(
      "UPDATE spins_log SET masa=? WHERE masa=? AND used=0 AND time>=?",
      [to, from, dayStartTs(Date.now())]
    );

    // Aktif session'a ait manuel ücret hareketlerini de yeni masaya taşı.
    await dbRunAsync(
      "UPDATE real_adjustments SET masa=? WHERE masa=? AND session_start=?",
      [to, from, source.start_time]
    );

    // Açık ürün hesabı da müşteriyle birlikte hedef masaya taşınır.
    await dbRunAsync(
      `UPDATE product_sales
       SET masa=?, session_start=?
       WHERE masa=? AND status='OPEN' AND voided=0`,
      [to, source.start_time, from]
    );

    await dbRunAsync("COMMIT");
    transactionStarted = false;

    const sourceLastSeen = aktifMasalar[from] || source.last_seen || Date.now();
    aktifMasalar[to] = sourceLastSeen;
    delete aktifMasalar[from];

    masaPingStats[to] = masaPingStats[from] || {
      last: 0,
      avg: PING_INTERVAL_MS,
      lastSeen: 0,
      netSpeed: 0
    };
    masaPingStats[from] = {
      last: 0,
      avg: PING_INTERVAL_MS,
      lastSeen: 0,
      netSpeed: 0
    };

    latestRewardMap[to] = latestRewardMap[from] || null;
    delete latestRewardMap[from];

    offlineCount[to] = offlineCount[from] || 0;
    offlineCount[from] = 0;
    lastOfflineState[to] = lastOfflineState[from] || false;
    lastOfflineState[from] = false;

    unlockTransfer();
    masaCloseLocks[from] = Date.now() + 30000;
    masaCloseLocks[to] = Date.now() + 10000;

    addLiveLog("transfer", `🔄 Masa transferi: ${from} → ${to}`);
    console.log(`🔄 Masa transfer: ${from} → ${to}`);

    return res.json({ ok: true, from, to });
  } catch (err) {
    if (transactionStarted) {
      try {
        await dbRunAsync("ROLLBACK");
      } catch (rollbackErr) {
        logErr("transfer rollback", rollbackErr);
      }
    }

    unlockTransfer();
    logErr("/admin/transfer-session", err);

    return res.json({
      ok: false,
      error: err.message || "Transfer başarısız"
    });
  }
});
app.post("/admin/reset", (req, res) => {
  setNoStore(res);

  blockIfAnyPendingReward(res, () => {
    const now = Date.now();

    db.all("SELECT * FROM sessions WHERE end_time=0 OR end_time IS NULL", (e0, rows) => {
      if (e0) return res.json({ ok: false, error: String(e0) });
      rows = rows || [];

      const finalizeNext = (i) => {
if (i >= rows.length) {

  sendEndOfDayTelegramReport((err) => {
    if (err) {
      logErr("daily telegram report", err);
    } else {
      console.log("📊 Gün sonu raporu gönderildi");
    }

    db.run("DELETE FROM masalar", (err2) => {
      if (err2) {
        logErr("cron delete masalar", err2);
        return res.status(500).json({ ok: false, error: String(err2) });
      }
      console.log("🧹 Günlük reset tamamlandı");
      return res.json({ ok: true });
    });
  });

  return;
}
        const r = rows[i];
        finalizeEndedSessionToAdjustments({ ...r, end_time: now }, now, () => {
          finalizeNext(i + 1);
        });
      };

      finalizeNext(0);
    });
  });
});

app.post("/admin/reset-spins-today", (req, res) => {
  setNoStore(res);

  blockIfAnyPendingReward(res, () => {

    db.run("DELETE FROM spins", (e1) => {

      logErr("/admin/reset-spins-today spins", e1);

      db.run("DELETE FROM spins_log", (e2) => {

        logErr("/admin/reset-spins-today spins_log", e2);

        res.json({ ok: true });

      });

    });

  });
});

app.post("/admin/reset-all", (req, res) => {
  setNoStore(res);

  blockIfAnyPendingReward(res, () => {
    db.serialize(() => {
      db.run("DELETE FROM masalar", (e1) => {
        if (e1) return res.status(500).json({ ok: false, error: String(e1) });
        db.run("DELETE FROM spins", (e2) => {
          if (e2) return res.status(500).json({ ok: false, error: String(e2) });
          db.run("DELETE FROM sessions", (e3) => {
            if (e3) return res.status(500).json({ ok: false, error: String(e3) });
            db.run("DELETE FROM spins_log", (e4) => {
              if (e4) return res.status(500).json({ ok: false, error: String(e4) });

              db.run("DELETE FROM product_sales", (productErr) => {
                if (productErr) return res.status(500).json({ ok: false, error: String(productErr) });
                db.run("DELETE FROM payments", (paymentErr) => {
                  if (paymentErr) return res.status(500).json({ ok: false, error: String(paymentErr) });
                  db.run("DELETE FROM accounting_entries", (accountingErr) => {
                    if (accountingErr) return res.status(500).json({ ok: false, error: String(accountingErr) });
                    db.run("DELETE FROM account_transfers", (transferErr) => {
                      if (transferErr) return res.status(500).json({ ok: false, error: String(transferErr) });
                    db.run("DELETE FROM daily_reports", (reportErr) => {
                      if (reportErr) return res.status(500).json({ ok: false, error: String(reportErr) });

              db.run("DELETE FROM real_adjustments", (e5) => logErr("/admin/reset-all delete adjustments", e5));
              db.run("DELETE FROM session_locks", (e6) => logErr("/admin/reset-all delete locks", e6));
              db.run("DELETE FROM force_new_sessions", (e7) => logErr("/admin/reset-all delete force_new_sessions", e7));
              db.run("DELETE FROM blocked_masalar", (e8) => logErr("/admin/reset-all delete blocked_masalar", e8));
              db.run("DELETE FROM session_history", (e9) => logErr("/admin/reset-all delete session_history", e9));
              db.run("DELETE FROM spin_page_sessions", (e10) => logErr("/admin/reset-all delete spin_page_sessions", e10));
              db.run("DELETE FROM spin_ready_notifications", (e11) => logErr("/admin/reset-all delete spin_ready_notifications", e11));
              sessionLocks = new Map();
              blockedMasalar = new Set();
              aktifMasalar = {};
              tokenTracker = {};
              globalSpinCount = 0;

              db.run(
                "INSERT INTO settings(key,value) VALUES('global_spin_count','0') ON CONFLICT(key) DO UPDATE SET value='0'",
                (e9) => logErr("/admin/reset-all reset global_spin_count", e9)
              );

              return res.json({ ok: true });
                    });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

app.post("/admin/force-ready", (req, res) => {
  setNoStore(res);

  const masa = parseInt((req.body || {}).masa, 10);
  if (!masa || masa < 1 || masa > MASA_SAYISI) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

  const now = Date.now();
  const SURE = getSpinSureMs();

  const newStart = now - SURE - 1000;

  db.run(
    "INSERT INTO masalar (masa, start_time) VALUES (?,?) ON CONFLICT(masa) DO UPDATE SET start_time=excluded.start_time",
    [masa, newStart],
    (e) => {
      if (e) return res.json({ ok: false, error: String(e) });
      return res.json({ ok: true, masa });
    }
  );
});

app.get("/admin/token-status", (req, res) => {
  setNoStore(res);

  const now = Date.now();
  const list = [];
  const ipMap = {};

  for (let masa = 1; masa <= MASA_SAYISI; masa++) {
    const rows = (tokenTracker[masa] || []).filter((x) => now - x.time <= 24 * 60 * 60 * 1000);
    const ips = [...new Set(rows.map((x) => x.ip))];

    let status = "OFFLINE";
    if (rows.length > 0 && ips.length === 1) status = "OK";
    if (ips.length > 1) status = "MULTI";

    list.push({
      masa,
      status,
      ipCount: ips.length,
      ips,
      lastIP: rows.length ? rows[rows.length - 1].ip : "-",
      lastSeen: rows.length ? rows[rows.length - 1].time : 0,
      blocked: blockedMasalar.has(masa),
      expectedIp: MASA_IPS[masa] || "-"
    });

    ips.forEach((ip) => {
      if (!ipMap[ip]) ipMap[ip] = [];
      ipMap[ip].push(masa);
    });
  }

  const conflicts = Object.entries(ipMap)
    .filter(([ip, masalar]) => ip !== "-" && masalar.length > 1)
    .map(([ip, masalar]) => ({
      ip,
      masalar
    }));

  return res.json({ ok: true, list, conflicts });
});

app.post("/admin/block-masa", (req, res) => {
  setNoStore(res);

  const masa = parseInt((req.body || {}).masa, 10);
  const minutes = parseInt((req.body || {}).minutes, 10) || 30;

  if (!masa || masa < 1 || masa > MASA_SAYISI) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

  const untilTime = Date.now() + minutes * 60 * 1000;

  setBlockedMasa(masa, untilTime, "Admin block", (err) => {
    if (err) return res.json({ ok: false, error: String(err) });
    return res.json({ ok: true, masa, untilTime });
  });
});

app.post("/admin/unblock-masa", (req, res) => {
  setNoStore(res);

  const masa = parseInt((req.body || {}).masa, 10);

  if (!masa || masa < 1 || masa > MASA_SAYISI) {
    return res.json({ ok: false, error: "Geçersiz masa" });
  }

  clearBlockedMasa(masa, (err) => {
    if (err) return res.json({ ok: false, error: String(err) });
    return res.json({ ok: true, masa });
  });
});

app.get("/admin/send-daily-report", (req, res) => {
  setNoStore(res);

  sendEndOfDayTelegramReport((err, stats) => {
    if (err) {
      return res.json({ ok: false, error: String(err) });
    }

    return res.json({ ok: true, stats });
  });
});

function nextRolloverTimestamp(nowTs) {
  const now = Number(nowTs) || Date.now();
  const next = new Date(now);
  next.setHours(20, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function saveRolloverStatus(status, cb) {
  db.run(
    "INSERT INTO settings(key,value) VALUES('last_daily_rollover',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [JSON.stringify(status)],
    (err) => {
      if (err) logErr("saveRolloverStatus", err);
      if (cb) cb(err);
    }
  );
}

function recordClosedRolloverResult(masa, sessionStart, sessionEnd, totalFee) {
  db.get("SELECT value FROM settings WHERE key='last_daily_rollover'", (statusErr, row) => {
    if (statusErr || !row || !row.value) {
      if (statusErr) logErr("recordClosedRolloverResult status", statusErr);
      return;
    }

    let status;
    try {
      status = JSON.parse(row.value);
    } catch (parseErr) {
      logErr("recordClosedRolloverResult parse", parseErr);
      return;
    }

    const boundaryTs = Number(status.rolloverTs) || 0;
    const transferred = Array.isArray(status.onlineMasalar) ? status.onlineMasalar : [];
    if (
      status.status !== "success" ||
      !boundaryTs ||
      !transferred.map(Number).includes(Number(masa)) ||
      Number(sessionStart) >= boundaryTs ||
      Number(sessionEnd) <= boundaryTs
    ) return;

    db.all(
      `SELECT time, amount FROM real_adjustments
       WHERE masa=? AND session_start=?
       AND kind IN ('MANUAL_FEE_ADJUST','ZERO_FEE')`,
      [masa, sessionStart],
      (adjErr, adjustments) => {
        if (adjErr) {
          logErr("recordClosedRolloverResult adjustments", adjErr);
          return;
        }

        const beforeAdjustment = (adjustments || []).reduce((sum, item) => {
          return Number(item.time) < boundaryTs ? sum + (Number(item.amount) || 0) : sum;
        }, 0);
        const beforeFee = Math.max(
          feeAtTime(Number(masa), Number(sessionStart), boundaryTs) + beforeAdjustment,
          0
        );
        const finalTotal = Math.max(Number(totalFee) || 0, 0);
        const afterFee = finalTotal - beforeFee;

        // Devreden masanın ürünleri de satışın yazıldığı zamana göre iki
        // kafe gününe ayrılır; kapanış satırı yalnız bilgisayar ücretini göstermez.
        db.get(
          `SELECT
             COALESCE(SUM(CASE WHEN time < ? THEN total ELSE 0 END),0) AS before_product,
             COALESCE(SUM(CASE WHEN time >= ? THEN total ELSE 0 END),0) AS after_product
           FROM product_sales
           WHERE masa=? AND session_start=? AND sale_type='TABLE'
             AND voided=0 AND time<=?`,
          [boundaryTs, boundaryTs, masa, sessionStart, sessionEnd],
          (productErr, productRow) => {
            if (productErr) logErr("recordClosedRolloverResult products", productErr);
            const beforeProduct = Number(productRow && productRow.before_product) || 0;
            const afterProduct = Number(productRow && productRow.after_product) || 0;
            const beforeTotal = beforeFee + beforeProduct;
            const afterTotal = afterFee + afterProduct;

            const result = {
              masa: Number(masa),
              sessionStart: Number(sessionStart),
              closedAt: Number(sessionEnd),
              beforeFee,
              afterFee,
              totalFee: finalTotal,
              beforeProduct,
              afterProduct,
              beforeTotal,
              afterTotal,
              totalWithProducts: beforeTotal + afterTotal
            };

            const closedMasalar = Array.isArray(status.closedMasalar)
              ? status.closedMasalar.filter((x) =>
                  !(Number(x.masa) === Number(masa) && Number(x.sessionStart) === Number(sessionStart))
                )
              : [];
            closedMasalar.push(result);
            status.closedMasalar = closedMasalar;

            saveRolloverStatus(status, (saveErr) => {
              if (saveErr) return;
              addLiveLog(
                "rollover_session_closed",
                `♻️ Devreden Masa ${masa} kapandı • Eski gün ${beforeTotal.toFixed(2)} TL • Yeni gün ${afterTotal.toFixed(2)} TL • Toplam ${(beforeTotal + afterTotal).toFixed(2)} TL`
              );
            });
          }
        );
      }
    );
  });
}

app.get("/admin/rollover-status", (req, res) => {
  setNoStore(res);
  const serverNow = Date.now();
  db.get(
    "SELECT value FROM settings WHERE key='last_daily_rollover'",
    (err, row) => {
      if (err) {
        logErr("/admin/rollover-status", err);
        return res.json({ ok: false, error: String(err) });
      }
      let last = null;
      if (row && row.value) {
        try {
          last = JSON.parse(row.value);
        } catch (parseErr) {
          logErr("/admin/rollover-status parse", parseErr);
        }
      }
      const sendStatus = () => res.json({
        ok: true,
        serverNow,
        nextRolloverTs: nextRolloverTimestamp(serverNow),
        last
      });

      // Eski kayıtlar yalnızca masa gelirini saklamış olabilir. Şeritte her
      // zaman o kafe gününün masa + ürün/hizmet toplamını göster.
      const rolloverTs = Number(last && last.rolloverTs) || 0;
      if (!last || !rolloverTs) return sendStatus();
      return getRangeStats(dayStartTs(rolloverTs - 1), rolloverTs, (statsErr, stats) => {
        if (!statsErr && stats) {
          // Devir şeridindeki ciro, masa oturumu ile o gün satılan tüm
          // ürün/hizmetlerin toplamıdır. Ayrı alanlar da arayüzde doğrulanır.
          last.previousDayMasaRevenue = Number(stats.gercekGelir) || 0;
          last.previousDayProductRevenue = Number(stats.productGeliri) || 0;
          last.previousDayRevenue =
            last.previousDayMasaRevenue + last.previousDayProductRevenue;
          last.previousDayGrossRevenue = last.previousDayRevenue;
        }

        // Daha önce yalnız oturum ücretiyle kaydedilmiş kapanış satırlarını
        // da ürün/hizmet satışlarıyla zenginleştir; sayfa yenilenince güncel
        // toplam görülür.
        const closed = Array.isArray(last.closedMasalar) ? last.closedMasalar : [];
        if (!closed.length) return sendStatus();
        const pairs = closed.map(() => "(?,?)").join(",");
        const pairParams = closed.flatMap((item) => [Number(item.masa) || 0, Number(item.sessionStart) || 0]);
        return db.all(
          `SELECT masa, session_start,
             COALESCE(SUM(CASE WHEN time < ? THEN total ELSE 0 END),0) AS before_product,
             COALESCE(SUM(CASE WHEN time >= ? THEN total ELSE 0 END),0) AS after_product
           FROM product_sales
           WHERE sale_type='TABLE' AND voided=0
             AND (masa, session_start) IN (${pairs})
           GROUP BY masa, session_start`,
          [rolloverTs, rolloverTs, ...pairParams],
          (productErr, rows) => {
            if (productErr) {
              logErr("/admin/rollover-status closed products", productErr);
              return sendStatus();
            }
            const productMap = new Map(
              (rows || []).map((item) => [
                `${Number(item.masa)}:${Number(item.session_start)}`,
                item
              ])
            );
            last.closedMasalar = closed.map((item) => {
              const products = productMap.get(`${Number(item.masa)}:${Number(item.sessionStart)}`) || {};
              const beforeProduct = Number(products.before_product) || 0;
              const afterProduct = Number(products.after_product) || 0;
              const beforeFee = Number(item.beforeFee) || 0;
              const afterFee = Number(item.afterFee) || 0;
              return {
                ...item,
                beforeProduct,
                afterProduct,
                beforeTotal: beforeFee + beforeProduct,
                afterTotal: afterFee + afterProduct,
                totalWithProducts: beforeFee + afterFee + beforeProduct + afterProduct
              };
            });
            return sendStatus();
          }
        );
      });
    }
  );
});

let dailyRolloverInProgress = false;

// Gün sonunda EveryCafe'nin gider hariç tüm gerçek tahsilat kaynaklarını
// karşılaştırır: masa oturumları, Doğrudan Satış (SessionType=26), üye
// tahsilatları ve bilet/e-pin/teknik gibi bağımsız Payments gelirleri.
function runEveryCafeDailyReconciliation(startTs, endTs, cb = () => {}) {
  getEveryCafeConfig((configErr, config) => {
    if (configErr) return cb(configErr);
    if (!config.enabled || !config.startAt) return cb(null, { skipped: true });
    const sourceStart = Math.max(Number(startTs) || 0, config.startAt);
    readEveryCafePaymentAuditSnapshot(sourceStart, (sourceErr, snapshot) => {
      if (sourceErr) return cb(sourceErr);
      const sourceSummary = summarizeEveryCafeSourceSnapshot(snapshot, startTs, endTs);
      const sourceCount = Number(sourceSummary.count) || 0;
      const sourceTotal = Number(sourceSummary.total) || 0;
      db.all(
        `SELECT total_amount FROM payments
         WHERE voided=0 AND (
           (source='EVERYCAFE' AND external_source='EVERYCAFE' AND session_end>=? AND session_end<?)
           OR (source='EVERYCAFE_DIRECT' AND external_source='EVERYCAFE_DIRECT' AND created_at>=? AND created_at<?)
           OR (source='EVERYCAFE_MEMBER' AND external_source='EVERYCAFE_MEMBER' AND created_at>=? AND created_at<?)
           OR (source='EVERYCAFE_OTHER' AND external_source='EVERYCAFE_OTHER' AND created_at>=? AND created_at<?)
         )`,
        [startTs, endTs, startTs, endTs, startTs, endTs, startTs, endTs],
        (paymentErr, paymentRows) => {
          if (paymentErr) return cb(paymentErr);
          const localTotal = Math.round((paymentRows || []).reduce((sum, row) => sum + (Number(row.total_amount) || 0), 0) * 100) / 100;
          const difference = Math.round((sourceTotal - localTotal) * 100) / 100;
          const result = {
            startTs, endTs,
            sourceCount,
            localCount: (paymentRows || []).length,
            sourceTotal, localTotal, difference,
            sourceBreakdown: {
              tableTotal: Number(sourceSummary.tableTotal) || 0,
              direct: Number(sourceSummary.directCount) || 0,
              members: Number(sourceSummary.memberCount) || 0,
              other: Number(sourceSummary.otherCount) || 0,
              products: Number(sourceSummary.productOrderCount) || 0
            },
            ok: Math.abs(difference) <= 0.01 && sourceCount === (paymentRows || []).length,
            checkedAt: Date.now()
          };
          lastEveryCafeDailyAudit = result;
          if (!result.ok) {
            const text = `🚨 EveryCafe gün sonu uyuşmazlığı • Kaynak: ${sourceTotal.toFixed(2)} ₺ (${sourceCount}) • KafePin: ${localTotal.toFixed(2)} ₺ (${(paymentRows || []).length})`;
            addLiveLog("everycafe_audit", text);
            const auditKey = `everycafe-daily-audit:${dayKey(Math.max(endTs - 1, 0))}`;
            if (TELEGRAM_ENABLED && shouldSendTelegramDedup(auditKey, 12 * 60 * 60 * 1000)) {
              sendTelegramMessage(text, () => {});
            }
          } else {
            addLiveLog("everycafe_audit", `✅ EveryCafe gün sonu uyumlu • ${sourceTotal.toFixed(2)} ₺ • ${sourceCount} işlem`);
          }
          cb(null, result);
        }
      );
    });
  });
}

function getRolloverBoundaryForNow(nowTs = Date.now()) {
  const now = Number(nowTs) || Date.now();
  const boundary = new Date(now);
  boundary.setHours(20, 0, 0, 0);
  return now >= boundary.getTime() ? boundary.getTime() : 0;
}

function getLatestExpectedRolloverBoundary(nowTs = Date.now()) {
  const now = Number(nowTs) || Date.now();
  const boundary = new Date(now);
  boundary.setHours(20, 0, 0, 0);
  if (boundary.getTime() > now) boundary.setDate(boundary.getDate() - 1);
  return boundary.getTime();
}

function getNextMissedRolloverBoundary(last, nowTs = Date.now()) {
  const latestExpected = getLatestExpectedRolloverBoundary(nowTs);
  if (!latestExpected) return 0;
  const lastTs = Number(last && last.rolloverTs) || 0;

  // Hata kaydi belirli bir gun sonuna aitse once ayni siniri yeniden dene.
  if (last && last.status === "error" && lastTs > 0 && lastTs <= latestExpected) return lastTs;

  // Hic kayit yoksa geriye sinirsiz tarama yapma; yalniz en son beklenen gunu onar.
  if (!lastTs) return latestExpected;
  if (last && last.status === "success" && lastTs >= latestExpected) return 0;

  const next = new Date(lastTs);
  next.setDate(next.getDate() + 1);
  next.setHours(20, 0, 0, 0);
  return Math.min(next.getTime(), latestExpected);
}

function getMissedRolloverRepairLabel(boundaryTs, nowTs = Date.now()) {
  const now = new Date(Number(nowTs) || Date.now());
  const boundary = new Date(Number(boundaryTs) || 0);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const sameCalendarDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameCalendarDay(boundary, yesterday)) return "Dünün Gün Sonunu Şimdi Al";
  const label = boundary.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${label} Gün Sonunu Şimdi Al`;
}

function runHistoricalDailyRolloverRepair(boundaryTs, cb = () => {}) {
  const boundary = Number(boundaryTs) || 0;
  if (!boundary) return cb(new Error("Gecersiz gun sonu siniri"));
  const reportTs = Math.max(boundary - 1, 0);
  const startTs = dayStartTs(reportTs);

  getRangeStats(startTs, boundary, (statsErr, stats) => {
    if (statsErr) return cb(statsErr);
    saveDailyReport(reportTs, stats, (saveErr) => {
      if (saveErr) return cb(saveErr);

      const baseStatus = {
        status: "success",
        rolloverTs: boundary,
        onlineMasalar: [],
        transferredCount: 0,
        previousDayRevenue: Number(stats.genelGelir || stats.gercekGelir || stats.net) || 0,
        previousDayGrossRevenue: Number(stats.genelGelir || stats.brutGelir || stats.brut) || 0,
        telegramSent: false,
        telegramStatus: TELEGRAM_ENABLED ? "pending" : "disabled",
        source: "manual_repair",
        historicalRepair: true,
        repairedAt: Date.now()
      };

      saveRolloverStatus(baseStatus, (statusErr) => {
        if (statusErr) return cb(statusErr);
        addLiveLog(
          "daily_rollover_repair",
          `🛠️ Eksik gün sonu şimdi alındı • ${new Date(boundary).toLocaleString("tr-TR")} • Toplam ${Number(stats.genelGelir || 0).toFixed(2)} ₺`
        );
        runEveryCafeDailyReconciliation(startTs, boundary, (auditErr) => {
          if (auditErr) logErr("manual rollover EveryCafe karşılaştırması", auditErr);
        });
        if (TELEGRAM_ENABLED) {
          const msg = buildDailyTelegramReport(reportTs, stats);
          sendRolloverTelegramWithRetry(msg, baseStatus);
        }
        cb(null, { boundaryTs: boundary, stats, label: getMissedRolloverRepairLabel(boundary) });
      });
    });
  });
}

app.post("/admin/rollover/repair-missed", (req, res) => {
  setNoStore(res);
  if (dailyRolloverInProgress) return res.status(409).json({ ok: false, error: "Gün sonu işlemi zaten devam ediyor" });
  const now = Date.now();
  db.get("SELECT value FROM settings WHERE key='last_daily_rollover'", (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: String(err.message || err) });
    let last = null;
    try { last = row && row.value ? JSON.parse(row.value) : null; } catch (_err) {}
    const boundaryTs = getNextMissedRolloverBoundary(last, now);
    if (!boundaryTs) return res.json({ ok: true, alreadyComplete: true, message: "Eksik gün sonu yok" });
    dailyRolloverInProgress = true;
    runHistoricalDailyRolloverRepair(boundaryTs, (repairErr, result) => {
      dailyRolloverInProgress = false;
      if (repairErr) {
        saveRolloverStatus({
          status: "error",
          rolloverTs: boundaryTs,
          onlineMasalar: [],
          transferredCount: 0,
          previousDayRevenue: 0,
          telegramSent: false,
          telegramStatus: "not_attempted",
          error: String(repairErr.message || repairErr),
          source: "manual_repair"
        });
        addLiveLog("daily_rollover_repair", `⚠️ Eksik gün sonu alınamadı • ${String(repairErr.message || repairErr).slice(0, 160)}`);
        return res.status(500).json({ ok: false, error: String(repairErr.message || repairErr) });
      }
      autoHealthLast.checkedAt = 0;
      runAutomaticHealthCheck(() => {
        res.json({
          ok: true,
          repaired: true,
          boundaryTs,
          label: result && result.label,
          total: Number(result && result.stats && result.stats.genelGelir) || 0,
          telegram: TELEGRAM_ENABLED ? "pending" : "disabled"
        });
      });
    });
  });
});

function sendRolloverTelegramWithRetry(msg, baseStatus, attempt = 1) {
  sendTelegramMessage(msg, (telegramErr) => {
    if (!telegramErr) {
      saveRolloverStatus({
        ...baseStatus,
        telegramSent: true,
        telegramStatus: "sent",
        telegramAttempts: attempt
      });
      addLiveLog("daily_report", "🌙 Gün sonu raporu Telegram'a gönderildi");
      moveLiveMonitorToBottomSoon();
      return;
    }

    logErr(`daily rollover telegram attempt ${attempt}`, telegramErr);
    if (attempt < 3) {
      saveRolloverStatus({
        ...baseStatus,
        telegramStatus: "pending",
        telegramAttempts: attempt,
        telegramError: String(telegramErr.message || telegramErr)
      });
      setTimeout(() => {
        sendRolloverTelegramWithRetry(msg, baseStatus, attempt + 1);
      }, attempt * 5000);
      return;
    }

    saveRolloverStatus({
      ...baseStatus,
      telegramStatus: "failed",
      telegramAttempts: attempt,
      telegramError: String(telegramErr.message || telegramErr)
    });
  });
}

function runReliableDailyRollover(boundaryTs, source = "cron") {
  if (dailyRolloverInProgress) return;
  dailyRolloverInProgress = true;

  const onlineMasalar = Object.entries(aktifMasalar)
    .filter(([masa, lastSeen]) => {
      return !isActuallyOffline(Number(masa), lastSeen, boundaryTs);
    })
    .map(([masa]) => Number(masa));

  console.log("🔥 GÜN SONU DEVİR SINIRI:", new Date(boundaryTs).toLocaleString("tr-TR"), source);
  console.log("♻️ Kesintisiz devredilen masalar:", onlineMasalar);

  const reportTs = Math.max(boundaryTs - 1, 0);
  const startTs = dayStartTs(reportTs);

  getRangeStats(startTs, boundaryTs, (err, stats) => {
    if (err) {
      dailyRolloverInProgress = false;
      logErr("daily rollover stats", err);
      saveRolloverStatus({
        status: "error",
        rolloverTs: boundaryTs,
        onlineMasalar,
        transferredCount: onlineMasalar.length,
        previousDayRevenue: 0,
        telegramSent: false,
        telegramStatus: "not_attempted",
        error: String(err.message || err),
        source
      });
      return;
    }

    saveDailyReport(reportTs, stats, (saveErr) => {
      if (saveErr) {
        dailyRolloverInProgress = false;
        saveRolloverStatus({
          status: "error",
          rolloverTs: boundaryTs,
          onlineMasalar,
          transferredCount: onlineMasalar.length,
          previousDayRevenue: Number(stats.genelGelir || stats.gercekGelir || stats.net) || 0,
          telegramSent: false,
          telegramStatus: "not_attempted",
          error: String(saveErr.message || saveErr),
          source
        });
        return;
      }

      const baseStatus = {
        status: "success",
        rolloverTs: boundaryTs,
        onlineMasalar,
        transferredCount: onlineMasalar.length,
        previousDayRevenue: Number(stats.genelGelir || stats.gercekGelir || stats.net) || 0,
        previousDayGrossRevenue: Number(stats.genelGelir || stats.brutGelir || stats.brut) || 0,
        telegramSent: false,
        telegramStatus: TELEGRAM_ENABLED ? "pending" : "disabled",
        source
      };

      // Devir önce kalıcı olarak kaydedilir; Telegram sonucu devri engellemez.
      saveRolloverStatus(baseStatus, () => {
        dailyRolloverInProgress = false;

        addLiveLog(
          "daily_rollover",
          onlineMasalar.length
            ? `♻️ Gün devri tamamlandı • Açık masalar kesintisiz devam ediyor: ${onlineMasalar.join(", ")}`
            : "♻️ Gün devri tamamlandı • Devreden açık masa yok"
        );
        console.log("✅ Kesintisiz gün sonu devri kaydedildi.");

        runEveryCafeDailyReconciliation(startTs, boundaryTs, (auditErr) => {
          if (auditErr) logErr("EveryCafe gün sonu karşılaştırması", auditErr);
        });

        if (!TELEGRAM_ENABLED) return;

        const msg = buildDailyTelegramReport(reportTs, stats);
        sendRolloverTelegramWithRetry(msg, baseStatus);
      });
    });
  });
}

function ensureTodayRollover() {
  const boundaryTs = getRolloverBoundaryForNow(Date.now());
  if (!boundaryTs || dailyRolloverInProgress) return;

  db.get("SELECT value FROM settings WHERE key='last_daily_rollover'", (err, row) => {
    if (err) {
      logErr("ensureTodayRollover", err);
      return;
    }

    let last = null;
    try {
      last = row && row.value ? JSON.parse(row.value) : null;
    } catch (parseErr) {
      logErr("ensureTodayRollover parse", parseErr);
    }

    if (last && last.status === "success" && Number(last.rolloverTs) >= boundaryTs) return;
    runReliableDailyRollover(boundaryTs, "catch_up");
  });
}

cron.schedule("0 20 * * *", () => {
  const boundaryTs = getRolloverBoundaryForNow(Date.now()) || Date.now();
  runReliableDailyRollover(boundaryTs, "cron");
}, { timezone: "Europe/Istanbul" });

// Server 20.00'den sonra açılırsa veya cron anı kaçarsa devri otomatik tamamlar.
setTimeout(ensureTodayRollover, 5000);
setInterval(ensureTodayRollover, 60 * 1000);

// EveryCafe açıkken yalnızca salt-okunur bağlantıyla yeni kapanışları kontrol eder.
setTimeout(() => {
  clearInvalidShortOfflinePendingSessions((cleanupErr, cleanupResult) => {
    if (cleanupErr) return logErr("EveryCafe bekleme ödeme temizliği", cleanupErr);
    if (cleanupResult && cleanupResult.cleared) {
      addLiveLog("everycafe_waiting", `EveryCafe bekleme kaynaklı ${cleanupResult.cleared} hatalı ödeme temizlendi`);
    }
  });
}, 1000);

// v3.0.16: Ürün/kategori/fiyat katalogu program açılışında veya zamanlayıcıyla
// ASLA değiştirilmez. Burada yalnız daha önce elle senkronlanmış yerel EveryCafe
// katalog önbelleği okunur; gerçek EveryCafe DB'sine katalog için dokunulmaz.
// Katalog değişikliği yalnız /admin/everycafe/catalog-sync-now ile, yani
// kullanıcının "Şimdi Senkronla" komutuyla gerçekleşir.
setTimeout(() => {
  refreshEveryCafeCatalogCache((err) => {
    if (err) logErr("EveryCafe yerel katalog önbelleği", err);
  });
}, 1500);

setTimeout(() => {
  syncEveryCafeActiveSessions((activeErr, activeResult) => {
    if (activeErr || (activeResult && activeResult.reason === "disabled")) return;
    syncEveryCafeClosedSessions((closeErr) => {
      if (closeErr) logErr("EveryCafe başlangıç senkronu", closeErr);
      else recordEveryCafeSyncSuccess();
    });
  });
}, 2000);

setTimeout(() => {
  reconcileEveryCafeClosedRewardApprovals((err, result) => {
    if (err) return logErr("EveryCafe reward approval recovery", err);
    if (result && result.approved) {
      addLiveLog("everycafe_reward_recovery", `EveryCafe kapanis odulleri otomatik onaylandi: ${result.approved}`);
    }
  });
}, 5000);

setInterval(() => {
  syncEveryCafeActiveSessions((activeErr, activeResult) => {
    if (activeErr) {
      recordEveryCafeSyncFailure("aktif masa", activeErr);
      return logErr("EveryCafe aktif masa sync", activeErr);
    }
    if (activeResult && activeResult.reason === "disabled") return;
    checkEveryCafeSpinReadyNotifications((notifyErr) => {
      if (notifyErr) logErr("EveryCafe çark hazır bildirimi", notifyErr);
    });
    syncEveryCafeClosedSessions((err, result) => {
      if (err) {
        recordEveryCafeSyncFailure("kapanış", err);
        return logErr("EveryCafe live sync", err);
      }
      if (result && result.reason === "disabled") return;
      recordEveryCafeSyncSuccess();
      if (result && result.imported) console.log(`EveryCafe: ${result.imported} yeni oturum aktarıldı`);
      scanEveryCafeSourceReconciliation({force:false}).catch((scanErr)=>logErr("EveryCafe silinen kayıt taraması",scanErr));
    });
  });
}, EVERYCAFE_SYNC_MS);


// Panel acik olmasa da temel sistem sagligini duzenli kontrol et.
setTimeout(() => runAutomaticHealthCheck(() => {}), 90 * 1000);
setInterval(() => runAutomaticHealthCheck(() => {}), AUTO_HEALTH_INTERVAL_MS);

if (process.env.DEBUG_QUEUE === "1") {
  setInterval(() => {
    for (const [masa] of finalizeQueues.entries()) {
      console.log(`Masa ${masa} queue aktif`);
    }
  }, 60000);
}


// ================= RESET RUNTIME =================
for (let i = 1; i <= MASA_SAYISI; i++) {

  delete aktifMasalar[i];

  masaPingStats[i] = {
    last: 0,
    avg: 0,
    netSpeed: 0
  };

  latestRewardMap[i] = null;

  offlineCount[i] = 0;
  lastOfflineState[i] = false;
}
console.log("✅ Runtime state temizlendi");


// STABLE: Manager restore sonucu sunucu acildiktan sonra yazabilir. Sabit 8 saniyelik
// tek kontrol yerine sonucu 3 dakika izleyip complete/error satirini kesin gunluge aktar.
function startRestoreResultWatcher() {
  const restoreResultPath = path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro", "restore-result.json");
  const deadline = Date.now() + 180000;
  let done = false;
  const check = () => {
    if (done) return;
    try {
      if (fs.existsSync(restoreResultPath)) {
        const rr = JSON.parse(fs.readFileSync(restoreResultPath, "utf8").replace(/^\uFEFF/, ""));
        if (rr && rr.phase === "complete" && rr.ok === true) {
          addLiveLog("pro_restore", "✅ Yedekten geri yükleme tamamlandı • sunucu stabil");
          try { fs.unlinkSync(restoreResultPath); } catch (_err) {}
          done = true;
          return;
        }
        if (rr && rr.phase === "error") {
          addLiveLog("pro_restore", `⚠️ Geri yükleme motoru hata bildirdi • ${String(rr.message || "bilinmeyen").slice(0, 180)}`);
          try { fs.unlinkSync(restoreResultPath); } catch (_err) {}
          done = true;
          return;
        }
      }
    } catch (_err) {}
    if (Date.now() < deadline) setTimeout(check, 1000);
  };
  setTimeout(check, 500);
}

// ================= SERVER START =================

const server = app.listen(port, "0.0.0.0", () => {
  console.log("KafePin çalışıyor:");
  console.log("Local  : http://localhost:3000");
  console.log("Network: http://192.168.1.100:3000");

  addLiveLog("system", "🟢 Sunucu başlatıldı");
  startRestoreResultWatcher();
  // v3.1.2 STABLE R2: SERVER STARTUP HICBIR ZAMAN Server Manager'i
  // yeniden kaydetmez/oldurmez. Restore sirasinda Manager health beklerken control
  // portu bilerek mesgul olabilir; server startup'tan ensure calistirmak aktif Manager'i
  // yanlislikla yeniden baslatip restore dongusu yaratabiliyordu. Manager surum esleme
  // yalniz kurucu ve update uygulanmadan ONCE/sonra update handoff asamasinda yapilir.
  // Bu callback sadece uygulama servislerini baslatir.
  // v3.1.2 STABLE: server restart/restore/update sonrasinda desktop setup otomatik
  // calistirilmaz. Masaustu kurulumu yalniz FINAL veya Yeni Kafe kurucusunun isidir.
});

setTimeout(repairLatestStoredDailyReport, 4000);

if (TELEGRAM_ENABLED) {
    // Kayıtlı message_id korunur; server yeniden başlayınca yeni mesaj
    // oluşturmak yerine mevcut canlı durum mesajı güncellenir.
    setTimeout(sendLiveMonitor, 5000);
    // Sunucu kapalıyken gönderilmiş rapor/bildirim varsa canlı durum eski
    // message_id ile yukarıda kalabilir. İlk güncellemeden sonra tek sefer
    // alta taşıyarak Telegram'da her zaman son mesaj olmasını garanti eder.
    setTimeout(moveLiveMonitorToBottomSoon, 8000);
}

const TELEGRAM_LIVE_UPDATE_MS = 20 * 1000;
setInterval(() => {

    if (TELEGRAM_ENABLED) {
        sendLiveMonitor();
    }

}, TELEGRAM_LIVE_UPDATE_MS);

// server error
server.on("error", (err) => {
    console.error("SERVER ERROR:", err);
});

// 🔥 aktifMasalar temizlik
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const masa of Object.keys(aktifMasalar)) {
    if (now - aktifMasalar[masa] > CLEANUP_MS) {

      addLiveLog("disconnect", `🔌 Masa ${masa} bağlantısı koptu`);

      delete aktifMasalar[masa];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 aktifMasalar temizlendi: ${cleaned} kayıt`);
  }
}, 10000); // Her 10 saniyede bir kontrol et
