"use strict";

const TERMINAL_STAGES = new Set(["success", "error", "idle"]);

function isVersion(value) {
  return /^\d+(\.\d+){1,3}$/.test(String(value || ""));
}

function compareVersions(a, b) {
  const aa = String(a || "0").split(".").map(Number);
  const bb = String(b || "0").split(".").map(Number);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const left = Number(aa[i] || 0);
    const right = Number(bb[i] || 0);
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

function decideRecovery(input) {
  const now = Number(input.now || Date.now());
  const maxAgeMs = Number(input.maxAgeMs || 30 * 60 * 1000);
  const lock = input.lock;
  const state = input.state || {};
  if (!lock || lock.locked !== true || !isVersion(lock.targetVersion)) {
    return { action: "none", reason: "no-valid-lock" };
  }

  const ageMs = Math.max(0, now - Number(lock.startedAt || 0));
  const stateAgeMs = Math.max(0, now - Number(state.time || 0));
  const stateRunning = state.running !== false && !TERMINAL_STAGES.has(String(state.stage || ""));
  const ownerAlive = Boolean(input.ownerAlive);
  const supervisorAlive = Boolean(input.supervisorAlive);
  const freshActivity = stateRunning && stateAgeMs <= maxAgeMs;
  const active = ownerAlive || supervisorAlive || freshActivity;
  const targetInstalled = compareVersions(input.currentVersion, lock.targetVersion) >= 0;

  if (targetInstalled && input.serverHealthy) {
    return { action: "finalize", reason: "target-installed-server-healthy", ageMs };
  }
  if (String(state.stage || "") === "error" || state.running === false) {
    return { action: "clear-error", reason: "previous-update-failed", ageMs };
  }
  if (active && ageMs < maxAgeMs) {
    return { action: "keep", reason: "active-update", ageMs };
  }
  if (ageMs >= maxAgeMs && !ownerAlive && !supervisorAlive) {
    return { action: "clear-error", reason: "stale-lock-no-live-owner", ageMs };
  }
  if (ageMs >= maxAgeMs && !freshActivity) {
    return { action: "clear-error", reason: "expired-update-heartbeat", ageMs };
  }
  return { action: "keep", reason: "legitimate-active-update", ageMs };
}

module.exports = { decideRecovery, compareVersions };
