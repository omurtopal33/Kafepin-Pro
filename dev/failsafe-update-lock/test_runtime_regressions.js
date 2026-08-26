"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");

function makeRunner(spawn) {
  return function runChildTracked(command, args, timeoutMs, callback) {
    let finished = false;
    let stderr = "";
    let stdout = "";
    let child = null;
    let timer = null;
    const done = (err) => {
      if (finished) return;
      finished = true;
      if (timer) { clearTimeout(timer); timer = null; }
      callback(err, { stdout, stderr });
    };
    try { child = spawn(command, args, { windowsHide: true }); }
    catch (err) { return done(err); }
    child.stdout && child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr && child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", err => done(err));
    child.on("close", code => code === 0 ? done(null) : done(new Error(`exit ${code}`)));
    if (!finished) {
      timer = setTimeout(() => { try { child.kill(); } catch (_) {} done(new Error("timeout")); }, timeoutMs);
    }
  };
}

function child(exitDelay, code = 0) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
  if (exitDelay >= 0) setTimeout(() => c.emit("close", code), exitDelay);
  return c;
}

async function one(name, spawn, timeout, expectedError) {
  const run = makeRunner(spawn);
  let calls = 0;
  let actual = null;
  run("powershell.exe", [], timeout, err => { calls += 1; actual = err; });
  await new Promise(resolve => setTimeout(resolve, Math.max(timeout + 35, 50)));
  assert.strictEqual(calls, 1, `${name}: callback count`);
  assert.strictEqual(Boolean(actual), expectedError, `${name}: error result`);
  process.stdout.write(`PASS ${name}\n`);
}

(async () => {
  await one("immediate child exit", () => child(0, 0), 100, false);
  await one("slow child timeout", () => child(-1), 25, true);
  await one("late close after timeout", () => child(100, 0), 15, true);
})().catch(err => { console.error(err); process.exitCode = 1; });
