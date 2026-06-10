// Repro/verify for crash-scene preservation aging by bridge.log mtime, NOT the dir mtime (v0.8.3 / F1).
// A long-lived server's run-dir mtime is its CREATION time (entries are added once at startup), so a
// crash days later still leaves an OLD dir mtime — the pre-fix sweep aged the post-mortem by that dir
// mtime and reclaimed the evidence immediately. The fix ages the crash scene by bridge.log's own mtime
// (the file written up to the crash). Drives the real `cleanup` CLI against a synthetic
// AGENT_BRIDGE_STATE_DIR (no bridge server / model needed).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");

const nowS = Date.now() / 1000;
const oldS = nowS - 8 * 86_400; // ~8 days ago (past the default 7-day retention), in seconds for utimes

let ok = true;
const check = (label, cond) => { console.log(`[check] ${label}: ${cond ? "OK" : "FAIL"}`); if (!cond) ok = false; };

// Each scenario gets its own state dir + its own `cleanup` run (env differs per scenario).
function scenario(tag, env, build, assert) {
  const STATE = fs.mkdtempSync(path.join(os.tmpdir(), `ab-reclaim-${tag}-`));
  const LOGS = path.join(STATE, "logs");
  fs.mkdirSync(LOGS, { recursive: true });
  // Create a run dir with a bridge.log; control dir mtime and bridge.log mtime independently so we can
  // prove WHICH one the sweep ages by. No "owner" file => ownerPid null (skips ownerStillRunning).
  const mk = (name, bridgeLog, { logRecent }) => {
    const dir = path.join(LOGS, name);
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, "bridge.log");
    fs.writeFileSync(log, bridgeLog);
    fs.utimesSync(log, logRecent ? nowS : oldS, logRecent ? nowS : oldS);
    fs.utimesSync(dir, oldS, oldS); // dir is ALWAYS old (the long-lived-server shape)
    return dir;
  };
  const dirs = build(mk);
  const res = spawnSync(process.execPath, [BRIDGE, "cleanup"], { env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE, ...env }, encoding: "utf8" });
  console.log(`--- scenario ${tag} (${JSON.stringify(env)}) ---`);
  if (res.stderr) process.stdout.write(`[stderr] ${res.stderr}`);
  assert(d => fs.existsSync(d), dirs);
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}
}

// Scenario A — default retention (7 days).
scenario("default", {}, mk => ({
  // (1) crash scene: dir old, bridge.log FRESH -> MUST be preserved (the F1 fix; pre-fix wrongly reclaimed)
  crashFresh: mk("mcp-crash-fresh", "[t] Agent Bridge shutdown code=1 reason=boom\n", { logRecent: true }),
  // (2) crash scene: dir old AND bridge.log old -> genuinely aged out -> MUST be reclaimed
  crashAged: mk("mcp-crash-aged", "[t] Agent Bridge shutdown code=1 reason=old\n", { logRecent: false }),
  // (3) clean exit (code=0), old, ownerless -> MUST be reclaimed (control: proves the sweep ran)
  cleanOld: mk("mcp-clean-old", "[t] Agent Bridge shutdown code=0\n", { logRecent: false }),
}), (exists, d) => {
  check("A: fresh crash scene preserved (aged by bridge.log mtime, not dir mtime)", exists(d.crashFresh));
  check("A: truly-aged crash scene reclaimed", !exists(d.crashAged));
  check("A: clean old ownerless dir reclaimed (sweep ran)", !exists(d.cleanOld));
});

// Scenario B — retention disabled (LOG_RETENTION_DAYS=0): crash scenes are kept FOREVER regardless of
// age, but non-crash old ownerless dirs are still reclaimed (their gate is the 60s brand-new window).
scenario("retention0", { AGENT_BRIDGE_LOG_RETENTION_DAYS: "0" }, mk => ({
  crashAged: mk("mcp-crash-aged", "[t] Agent Bridge shutdown code=1 reason=old\n", { logRecent: false }),
  cleanOld: mk("mcp-clean-old", "[t] Agent Bridge shutdown code=0\n", { logRecent: false }),
}), (exists, d) => {
  check("B: aged crash scene PRESERVED under retention=0 (keep-forever)", exists(d.crashAged));
  check("B: clean old ownerless dir still reclaimed under retention=0", !exists(d.cleanOld));
});

if (ok) { console.log("[harness] >>> PASS: crash scenes aged by bridge.log mtime; retention=0 keeps them forever; clean/aged dirs reclaimed"); process.exit(0); }
console.log("[harness] >>> FAIL"); process.exit(1);
