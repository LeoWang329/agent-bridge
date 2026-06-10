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

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "ab-reclaim-"));
const LOGS = path.join(STATE, "logs");
fs.mkdirSync(LOGS, { recursive: true });

const nowS = Date.now() / 1000;
const oldS = nowS - 8 * 86_400; // ~8 days ago (past the default 7-day retention), in seconds for utimes

// Create a run dir with a bridge.log; control the dir mtime and the bridge.log mtime independently so
// we can prove WHICH one the sweep ages by. No "owner" file => ownerPid null (skips ownerStillRunning).
function mk(name, bridgeLog, { logRecent }) {
  const dir = path.join(LOGS, name);
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "bridge.log");
  fs.writeFileSync(log, bridgeLog);
  fs.utimesSync(log, logRecent ? nowS : oldS, logRecent ? nowS : oldS);
  fs.utimesSync(dir, oldS, oldS); // dir is ALWAYS old (the long-lived-server shape)
  return dir;
}

// (1) crash scene: dir old, bridge.log FRESH -> MUST be preserved (the F1 fix; pre-fix this was wrongly reclaimed)
const crashFresh = mk("mcp-crash-fresh", "[t] Agent Bridge shutdown code=1 reason=boom\n", { logRecent: true });
// (2) crash scene: dir old AND bridge.log old -> genuinely aged out -> MUST be reclaimed
const crashAged = mk("mcp-crash-aged", "[t] Agent Bridge shutdown code=1 reason=old\n", { logRecent: false });
// (3) clean exit (code=0), old, ownerless -> MUST be reclaimed (control: proves the sweep actually runs)
const cleanOld = mk("mcp-clean-old", "[t] Agent Bridge shutdown code=0\n", { logRecent: false });

const res = spawnSync(process.execPath, [BRIDGE, "cleanup"], { env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE }, encoding: "utf8" });
process.stdout.write(res.stdout || "");
if (res.stderr) process.stdout.write(`[stderr] ${res.stderr}`);

const exists = d => fs.existsSync(d);
let ok = true;
const check = (label, cond) => { console.log(`[check] ${label}: ${cond ? "OK" : "FAIL"}`); if (!cond) ok = false; };

check("fresh crash scene preserved (aged by bridge.log mtime, not dir mtime)", exists(crashFresh));
check("truly-aged crash scene reclaimed", !exists(crashAged));
check("clean old ownerless dir reclaimed (sweep ran)", !exists(cleanOld));

try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}

if (ok) { console.log("[harness] >>> PASS: crash scene aged by bridge.log mtime; aged/clean dirs reclaimed"); process.exit(0); }
console.log("[harness] >>> FAIL"); process.exit(1);
