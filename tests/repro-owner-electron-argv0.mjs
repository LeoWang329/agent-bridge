// Regression: an MCP-server OWNER that is not launched as `node` must still count as ALIVE.
//
// Bug (found 2026-10-20 while applying DSH direction B): `ownerStillRunning()` used to require the
// owner's argv0 to look like node/node.exe. An Electron host (DSH Desktop launches the bridge as
// "DeepSeek Harness.exe ...agent-bridge.mjs mcp" with ELECTRON_RUN_AS_NODE) therefore read as DEAD.
// A second/nested bridge's startup sweep then classified the outer bridge's live backend children as
// reaping orphans and terminated them (observed: a delegated agent mounting this bridge from the
// workspace `.mcp.json` -> the outer OMP child died ~5s after ready).
//
// This test drives the real `cleanup` CLI against a synthetic AGENT_BRIDGE_STATE_DIR and a fake owner
// whose executable is a RENAMED COPY of node (argv0 != node). The record must be SKIPPED (owner alive),
// not removed/reaped. Pre-fix this test fails: skippedRunningOwners=0 and the record is deleted.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// AB_TEST_BRIDGE lets this repro point at another copy of the script (e.g. an older clone) to prove the
// test actually discriminates; default = the working tree under test.
const BRIDGE = process.env.AB_TEST_BRIDGE || path.resolve(HERE, "../scripts/agent-bridge.mjs");
const IS_WINDOWS = process.platform === "win32";

let ok = true;
const check = (label, cond, detail = "") => {
  console.log(`[check] ${label}: ${cond ? "OK" : "FAIL"}${cond || !detail ? "" : ` (${detail})`}`);
  if (!cond) ok = false;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function killQuietly(child) {
  try { if (child && child.exitCode === null && !child.killed) child.kill(); } catch {}
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code !== "ESRCH"; }
}

async function waitAlive(pid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (alive(pid)) return true;
    await sleep(50);
  }
  return false;
}

// A long-lived helper process whose command line ends with `agent-bridge.mjs mcp` but whose argv0 is
// NOT node: copy this node binary under another name and run the helper script with it.
function makeFakeHost(tmp, tag) {
  const helper = path.join(tmp, "agent-bridge.mjs");
  fs.writeFileSync(helper, "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{}, 1000);\n");
  const exeName = IS_WINDOWS ? `fake-electron-${tag}.exe` : `fake-electron-${tag}`;
  const exe = path.join(tmp, exeName);
  fs.copyFileSync(process.execPath, exe);
  if (!IS_WINDOWS) fs.chmodSync(exe, 0o755);
  const child = spawn(exe, [helper, "mcp"], { stdio: "ignore", windowsHide: true });
  return { child, helper, exe };
}

function writeRecord(stateDir, { ownerPid, victimPid }) {
  const pids = path.join(stateDir, "pids");
  fs.mkdirSync(pids, { recursive: true });
  const nowIso = new Date().toISOString();
  const file = path.join(pids, "sess-electron-owner.json");
  fs.writeFileSync(file, JSON.stringify({
    id: "sess-electron-owner",
    agent: "omp",
    ownerPid,
    cwd: process.cwd(),
    createdAt: nowIso,
    processes: [{ role: "omp-rpc", pid: victimPid, command: "omp --mode rpc", spawnedAt: nowIso }],
    updatedAt: nowIso,
  }, null, 2));
  return file;
}

function runCleanup(stateDir) {
  const res = spawnSync(process.execPath, [BRIDGE, "cleanup", "--json"], {
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: stateDir },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (res.stderr) process.stdout.write(`[stderr] ${res.stderr}`);
  const out = (res.stdout || "").trim();
  if (!out) throw new Error(`cleanup produced no stdout (exit=${res.status})`);
  try { return JSON.parse(out); } catch (e) { throw new Error(`cleanup stdout is not JSON: ${e.message}\n${out.slice(0, 800)}`); }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-owner-argv0-"));
  const stateDir = path.join(tmp, "state");
  const children = [];
  try {
    // ── Scenario A (the regression): owner alive but argv0 is NOT node ───────────────────────────
    const host = makeFakeHost(tmp, "a");
    children.push(host.child);
    check("A: fake owner (non-node argv0, command contains agent-bridge.mjs mcp) is alive", await waitAlive(host.child.pid),
      "the renamed-node fake host failed to start");
    const victim = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore", windowsHide: true });
    children.push(victim);
    check("A: victim process is alive", await waitAlive(victim.pid));
    const recordFile = writeRecord(stateDir, { ownerPid: host.child.pid, victimPid: victim.pid });

    const summaryA = runCleanup(stateDir);
    const cpA = summaryA.childProcesses ?? summaryA;
    check("A: cleanup DID run (record accounted for)", cpA.records >= 1, JSON.stringify(summaryA));
    check("A: live non-node owner recognized -> skippedRunningOwners >= 1", Number(cpA.skippedRunningOwners) >= 1,
      `got ${JSON.stringify(cpA)}`);
    check("A: owner's pid record was NOT removed", fs.existsSync(recordFile));

    // ── Scenario B (control): the same record with a DEAD owner must be reapable ─────────────────
    killQuietly(host.child);
    await sleep(300);
    check("B: fake owner is gone after SIGTERM", !alive(host.child.pid));
    const summaryB = runCleanup(stateDir);
    const cpB = summaryB.childProcesses ?? summaryB;
    check("B: dead-owner record is removed (no live owner to protect it)", !fs.existsSync(recordFile),
      JSON.stringify(cpB));
  } finally {
    for (const c of children) killQuietly(c);
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  if (ok) {
    console.log("[harness] >>> PASS: cleanup recognizes a live non-node (Electron-host) bridge owner and leaves its pid record/children alone");
    process.exit(0);
  }
  console.log("[harness] >>> FAIL");
  process.exit(1);
}

main().catch(e => { console.error("[harness] CRASH", e); process.exit(1); });
