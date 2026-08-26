from pathlib import Path
import re


RECOVERY_BLOCK = r'''function readProUpdateSupervisorLock() {
  const file = process.platform === "win32"
    ? path.join(process.env.ProgramData || "C:\\ProgramData", "KafePinPro", "update-supervisor.lock")
    : path.join(__dirname, "logs", "kafepin-pro-update-supervisor.lock");
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (_err) { return null; }
}

function isProcessAlive(pid) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (value === process.pid) return true;
  try { process.kill(value, 0); return true; } catch (_err) { return false; }
}

function writeProUpdateRecoveryState(stage, message, extra = {}) {
  try { writeProUpdateState(stage, message, { running: false, recovery: true, ...extra }); } catch (_err) {}
  try { addLiveLog("pro_update", `🛡️ Fail-safe update lock recovery • ${message}`); } catch (_err) {}
}

function getProUpdateInstallSnapshot() {
  const lock = readProUpdateInstallLock();
  if (!lock) return null;
  const currentVersion = getProVersion();
  const state = readProUpdateState() || {};
  const supervisor = readProUpdateSupervisorLock();
  const lockAgeMs = Math.max(0, Date.now() - Number(lock.startedAt || 0));
  const stateAgeMs = Math.max(0, Date.now() - Number(state.time || 0));
  const targetInstalled = compareProVersions(currentVersion, lock.targetVersion) >= 0;
  const maxAgeMs = PRO_UPDATE_INSTALL_LOCK_MAX_AGE_MS;
  const ownerAlive = isProcessAlive(lock.ownerPid);
  const supervisorAlive = Boolean(supervisor && String(supervisor.targetVersion || "") === String(lock.targetVersion || "") && isProcessAlive(supervisor.pid));
  const stateRunning = state.running !== false && !["success", "error", "idle"].includes(String(state.stage || ""));
  const freshState = stateRunning && stateAgeMs <= maxAgeMs;
  const activeOwner = ownerAlive || supervisorAlive || freshState;
  const activation = readProUpdateActivation();
  const desktopVerified = Boolean(activation && (activation.desktopLaunched === true || activation.desktopPreserved === true));
  const activationVerified = Boolean(activation && activation.ok === true &&
    String(activation.targetVersion || "") === String(lock.targetVersion || "") &&
    activation.serverVerified === true && activation.mp3Verified === true && desktopVerified);

  if (targetInstalled && proUpdateServerHealthy) {
    clearProUpdateInstallLock(lock.targetVersion);
    clearProUpdateDesktopReopenMarker(lock.targetVersion);
    writeProUpdateRecoveryState("success", `v${lock.targetVersion} kurulu ve server/DB saglikli; kalan lock temizlendi`, { version: lock.targetVersion, verifiedAfterRestart: true });
    return null;
  }
  if (String(state.stage || "") === "error" || state.running === false) {
    clearProUpdateInstallLock(lock.targetVersion);
    clearProUpdateDesktopReopenMarker(lock.targetVersion);
    writeProUpdateRecoveryState("error", `Onceki guncelleme basarisiz; stale lock temizlendi (v${lock.targetVersion})`, { version: lock.targetVersion, interrupted: true });
    return null;
  }
  if (!activeOwner && lockAgeMs >= maxAgeMs) {
    clearProUpdateInstallLock(lock.targetVersion);
    clearProUpdateDesktopReopenMarker(lock.targetVersion);
    writeProUpdateRecoveryState("error", `Aktif updater/supervisor yok ve lock zaman asimina ugradi; temizlendi (v${lock.targetVersion})`, { version: lock.targetVersion, interrupted: true, staleLock: true });
    return null;
  }

  return {
    ...lock,
    currentVersion,
    restartedAfterLock: Number(lock.sourceServerStartedAt || 0) > 0 && PRO_SERVER_STARTED_AT > Number(lock.sourceServerStartedAt || 0),
    stableAfterRestart: Date.now() - PRO_SERVER_STARTED_AT >= 10000,
    targetInstalled,
    activationVerified,
    activation,
    ownerAlive,
    supervisorAlive,
    stateAgeMs,
    lockAgeMs,
    maxAgeMs
  };
}
'''


def patch_server(text: str) -> str:
    text = text.replace(
        'const PRO_UPDATE_STALE_MAX_MS = 60 * 60 * 1000;',
        'const PRO_UPDATE_STALE_MAX_MS = 60 * 60 * 1000;\nconst PRO_UPDATE_INSTALL_LOCK_MAX_AGE_MS = 30 * 60 * 1000;\nlet proUpdateServerHealthy = false;',
        1,
    )
    text = text.replace(
        '    sourceServerStartedAt: PRO_SERVER_STARTED_AT\n',
        '    sourceServerStartedAt: PRO_SERVER_STARTED_AT,\n    ownerPid: process.pid,\n    owner: "kafepin-server"\n',
        1,
    )
    start = text.index('function getProUpdateInstallSnapshot() {')
    end = text.index('// Guncelleyici, sunucu kapaliyken tamamlanan kurulumu', start)
    text = text[:start] + RECOVERY_BLOCK + '\n' + text[end:]
    anchor = '  startRestoreResultWatcher();\n'
    replacement = anchor + '''  // Fail-safe update lock recovery: server/DB healthy oldugunda kalan lock otomatik kapanir.
  setTimeout(() => {
    try {
      db.get("SELECT 1 AS ok", [], (err) => {
        if (!err) {
          proUpdateServerHealthy = true;
          getProUpdateInstallSnapshot();
        }
      });
    } catch (_err) {}
  }, 12000);\n'''
    if text.count(anchor) != 1:
        raise SystemExit(f'listen recovery anchor count={text.count(anchor)}')
    text = text.replace(anchor, replacement, 1)
    return text


if __name__ == '__main__':
    import sys
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2] if len(sys.argv) > 2 else sys.argv[1])
    patched = patch_server(source.read_text(encoding='utf-8-sig'))
    destination.write_text(patched, encoding='utf-8')
    print('FAILSAFE_SERVER_PATCH_OK')
