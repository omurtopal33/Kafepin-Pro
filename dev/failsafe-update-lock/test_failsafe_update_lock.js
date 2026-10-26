"use strict";

const assert = require("assert");
const { decideRecovery } = require("./recovery_logic");

const now = 1_000_000;
const base = { locked: true, targetVersion: "4.0.3", startedAt: now - 60_000 };
const run = (name, input, expected) => {
  const actual = decideRecovery({ now, maxAgeMs: 300_000, lock: base, ...input });
  assert.strictEqual(actual.action, expected, `${name}: ${actual.action}`);
  process.stdout.write(`PASS ${name}\n`);
};

run("normal active update", { state: { running: true, stage: "copy", time: now - 10_000 }, ownerAlive: true }, "keep");
run("interrupted update", { lock: { ...base, startedAt: now - 600_000 }, state: { running: true, stage: "restart_pending", time: now - 600_000 } }, "clear-error");
run("dead PID stale lock", { lock: { ...base, startedAt: now - 600_000 }, state: { running: true, stage: "copy", time: now - 600_000 }, ownerAlive: false, supervisorAlive: false }, "clear-error");
run("fresh active supervisor", { state: { running: true, stage: "copy", time: now - 10_000 }, supervisorAlive: true }, "keep");
run("successful install leftover lock", { currentVersion: "4.0.3", serverHealthy: true, state: { running: true, stage: "restart_pending", time: now - 20_000 } }, "finalize");
run("failed update restores UI", { state: { running: false, stage: "error", time: now - 10_000 } }, "clear-error");
